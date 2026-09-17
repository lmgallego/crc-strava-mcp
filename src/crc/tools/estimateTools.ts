/**
 * `crc-estimate-vo2max` (sección 7.11) y `crc-estimate-ftp` (D12).
 *
 * Ambas consumen `bestEffortInPeriod`: un único barrido compartido.
 *
 * `crc-estimate-ftp` NO PERSISTE. Guardar exige una llamada separada a
 * `crc-set-performance-profile`: calcular y persistir van en tools distintas,
 * que es lo que garantiza que nada se guarde en silencio.
 */
import { z } from "zod";

import { bestEffortInPeriod, DEFAULT_MAX_ACTIVITIES, DEFAULT_WINDOW_DAYS } from "../analytics/bestEffort.js";
import { computePowerCurve } from "../analytics/powerCurve.js";
import { estimateFtpFrom20Min, estimateVo2max } from "../analytics/vo2maxEstimate.js";
import { resolveMetric } from "../profile/profileResolver.js";
import { loadProfile } from "../profile/profileStore.js";
import {
    fetchActivityStreams,
    stravaBestEffortProviders,
    type ActivityStreams,
} from "../sources/strava.js";
import {
    CrcErrorCode,
    crcToolResponse,
    crcUnavailable,
    type CrcError,
} from "../schemas/crcToolResponse.js";
import { flexibleBoolean, stravaId } from "../schemas/mcpSchemas.js";
import { computeStreamQuality } from "../streams/streamQuality.js";

export const CRC_VERSION = "0.1.0";

/** Duraciones de los dos esfuerzos que usan estas herramientas. */
const VO2MAX_DURATION_S = 300;
const FTP_DURATION_S = 1200;

// --- crc-estimate-vo2max --------------------------------------------------

export const estimateVo2maxTool = {
    name: "crc-estimate-vo2max",
    description:
        "VO2max estimado a partir del mejor 5 min: 16.6 + 8.87 × W/kg. Modo 'activity' " +
        "(una actividad) o 'rolling_period' (mejor 5 min de los últimos N días). Requiere " +
        "potencia medida y peso vigente en la fecha del esfuerzo. Siempre etiquetado como " +
        "estimación, nunca como medida de laboratorio.",
    inputSchema: z.object({
        mode: z
            .enum(["activity", "rolling_period"])
            .optional()
            .describe("'activity' analiza una actividad; 'rolling_period' barre un periodo."),
        activityId: stravaId.optional().describe("Actividad a analizar en modo 'activity'."),
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Ventana en días para 'rolling_period'. Por defecto ${DEFAULT_WINDOW_DAYS}.`),
        max_activities: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Tope de actividades a analizar. Por defecto ${DEFAULT_MAX_ACTIVITIES}.`),
        weight_kg: z
            .number()
            .positive()
            .optional()
            .describe("Peso en kg. Por defecto, el vigente en la fecha del esfuerzo."),
        maximal_effort_evidence: flexibleBoolean
            .optional()
            .describe("true solo si consta que el esfuerzo fue máximo (p. ej. un test)."),
    }),
    execute: async (args: {
        mode?: "activity" | "rolling_period";
        activityId?: string;
        days?: number;
        max_activities?: number;
        weight_kg?: number;
        maximal_effort_evidence?: boolean;
    }) => {
        try {
            const mode = args.mode ?? (args.activityId ? "activity" : "rolling_period");
            const errors: CrcError[] = [];
            const warnings: string[] = [];

            const effort = await findBestEffort(VO2MAX_DURATION_S, mode, args, warnings);
            if ("failure" in effort) return json(effort.failure);

            // El peso es el de la fecha DEL ESFUERZO, no el de hoy.
            const weight = await resolveWeightAt(effort.activity_date, args.weight_kg, errors);
            if (weight === null) {
                return json(
                    crcUnavailable({
                        tool: "crc-estimate-vo2max",
                        version: CRC_VERSION,
                        activity_id: effort.activity_id,
                        inputs: { mode, effort_date: effort.activity_date },
                        code: CrcErrorCode.MISSING_WEIGHT,
                        message:
                            `No hay peso vigente para ${effort.activity_date.slice(0, 10)}, ` +
                            "la fecha del esfuerzo. El VO2max relativo no es calculable.",
                        quality: { warnings },
                        errors,
                    }),
                );
            }

            const v = estimateVo2max({
                best5MinPowerW: effort.power_w,
                weightKg: weight.value,
                maximalEffortEvidence: args.maximal_effort_evidence,
            });

            return json(
                crcToolResponse({
                    tool: "crc-estimate-vo2max",
                    version: CRC_VERSION,
                    activity_id: effort.activity_id,
                    inputs: {
                        mode,
                        days: mode === "rolling_period" ? (args.days ?? DEFAULT_WINDOW_DAYS) : null,
                        weight_kg: weight.value,
                        weight_source: weight.source,
                        maximal_effort_evidence: args.maximal_effort_evidence ?? false,
                    },
                    method: { ...v.method, ...effort.method },
                    metrics: {
                        best_5min_power_w: v.best_5min_power_w,
                        weight_kg: v.weight_kg,
                        relative_power_wkg: v.relative_power_wkg,
                        estimated_vo2max: v.estimated_vo2max,
                        source_activity_id: effort.activity_id,
                        effort_start: effort.start_time_s,
                        effort_date: effort.activity_date,
                        model_reference: v.model_reference,
                        label: v.label,
                    },
                    quality: {
                        ...effort.quality,
                        maximal_effort_evidence: args.maximal_effort_evidence ?? false,
                        weight_estimated: weight.estimated,
                        warnings: [...warnings, ...v.warnings, ...effort.warnings],
                    },
                    errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-estimate-vo2max");
        }
    },
};

// --- crc-estimate-ftp -----------------------------------------------------

export const estimateFtpTool = {
    name: "crc-estimate-ftp",
    description:
        "Propone un FTP a partir del mejor 20 min del historial (× 0,95), para quien no " +
        "conoce el suyo. NO GUARDA NADA: devuelve la propuesta con la actividad y la fecha " +
        'de origen. Para persistirla hay que llamar aparte a crc-set-performance-profile con source "estimated_20min".',
    inputSchema: z.object({
        mode: z
            .enum(["activity", "rolling_period"])
            .optional()
            .describe("'activity' analiza una actividad; 'rolling_period' barre un periodo."),
        activityId: stravaId.optional().describe("Actividad a analizar en modo 'activity'."),
        days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Ventana en días. Por defecto ${DEFAULT_WINDOW_DAYS}.`),
        max_activities: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Tope de actividades a analizar. Por defecto ${DEFAULT_MAX_ACTIVITIES}.`),
        maximal_effort_evidence: flexibleBoolean
            .optional()
            .describe("true solo si consta que el esfuerzo de 20 min fue máximo."),
    }),
    execute: async (args: {
        mode?: "activity" | "rolling_period";
        activityId?: string;
        days?: number;
        max_activities?: number;
        maximal_effort_evidence?: boolean;
    }) => {
        try {
            const mode = args.mode ?? (args.activityId ? "activity" : "rolling_period");
            const warnings: string[] = [];

            const effort = await findBestEffort(FTP_DURATION_S, mode, args, warnings);
            if ("failure" in effort) return json(effort.failure);

            const f = estimateFtpFrom20Min(effort.power_w, {
                maximalEffortEvidence: args.maximal_effort_evidence,
            });

            return json(
                crcToolResponse({
                    tool: "crc-estimate-ftp",
                    version: CRC_VERSION,
                    activity_id: effort.activity_id,
                    inputs: {
                        mode,
                        days: mode === "rolling_period" ? (args.days ?? DEFAULT_WINDOW_DAYS) : null,
                        maximal_effort_evidence: args.maximal_effort_evidence ?? false,
                    },
                    method: { ...f.method, ...effort.method },
                    metrics: {
                        best_20min_power_w: f.best_20min_power_w,
                        factor: f.factor,
                        estimated_ftp_w: f.estimated_ftp_w,
                        source_activity_id: effort.activity_id,
                        effort_start: effort.start_time_s,
                        effort_date: effort.activity_date,
                        // La propuesta NO se ha guardado: esto dice cómo hacerlo.
                        persisted: false,
                        to_persist: {
                            tool: "crc-set-performance-profile",
                            metric: "ftp_w",
                            value: f.estimated_ftp_w,
                            unit: "W",
                            source: f.suggested_source,
                            effective_from: effort.activity_date.slice(0, 10),
                        },
                    },
                    quality: {
                        ...effort.quality,
                        maximal_effort_evidence: args.maximal_effort_evidence ?? false,
                        warnings: [...warnings, ...f.warnings, ...effort.warnings],
                    },
                }),
            );
        } catch (err) {
            return failure(err, "crc-estimate-ftp");
        }
    },
};

// --- helpers --------------------------------------------------------------

interface FoundEffort {
    power_w: number;
    activity_id: string;
    activity_date: string;
    start_time_s: number;
    end_time_s: number;
    method: Record<string, string>;
    quality: Record<string, unknown>;
    warnings: string[];
}

/** Busca el mejor esfuerzo, en una actividad o barriendo un periodo. */
async function findBestEffort(
    durationS: number,
    mode: "activity" | "rolling_period",
    args: { activityId?: string; days?: number; max_activities?: number },
    warnings: string[],
): Promise<FoundEffort | { failure: unknown }> {
    const toolName = durationS === VO2MAX_DURATION_S ? "crc-estimate-vo2max" : "crc-estimate-ftp";

    if (mode === "activity") {
        if (!args.activityId) {
            return {
                failure: crcUnavailable({
                    tool: toolName,
                    version: CRC_VERSION,
                    inputs: { mode },
                    code: CrcErrorCode.INSUFFICIENT_DURATION,
                    message: "El modo 'activity' necesita activityId.",
                    quality: { warnings: [] },
                }),
            };
        }

        const activity: ActivityStreams = await fetchActivityStreams(args.activityId);
        const quality = computeStreamQuality(activity.aligned, {
            deviceWatts: activity.device_watts,
        });

        if (quality.power_source !== "measured") {
            return {
                failure: crcUnavailable({
                    tool: toolName,
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: { mode, activityId: activity.activity_id },
                    code: CrcErrorCode.MISSING_POWER,
                    message:
                        `La potencia es ${quality.power_source}: solo se estima con potencia medida.`,
                    quality: { ...quality },
                }),
            };
        }

        const curve = computePowerCurve(activity.aligned, { durations: [durationS] });
        const entry = curve.entries[durationS];
        if (!entry?.available || entry.best_power_w === null) {
            return {
                failure: crcUnavailable({
                    tool: toolName,
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: { mode, activityId: activity.activity_id },
                    code: CrcErrorCode.INSUFFICIENT_DURATION,
                    message: `La actividad no tiene ninguna ventana válida de ${durationS} s.`,
                    quality: { ...quality },
                }),
            };
        }

        return {
            power_w: entry.best_power_w,
            activity_id: activity.activity_id,
            activity_date: activity.start_date ?? "",
            start_time_s: entry.start_time_s ?? 0,
            end_time_s: entry.end_time_s ?? 0,
            method: curve.method,
            quality: { ...quality },
            warnings,
        };
    }

    // rolling_period: barrido compartido.
    const result = await bestEffortInPeriod(durationS, args.days ?? DEFAULT_WINDOW_DAYS, {
        maxActivities: args.max_activities,
        providers: stravaBestEffortProviders(),
    });

    if (!result.available || !result.best) {
        return {
            failure: crcUnavailable({
                tool: toolName,
                version: CRC_VERSION,
                inputs: { mode, days: result.window.days, window: result.window },
                method: result.method,
                code: CrcErrorCode.INSUFFICIENT_DURATION,
                message: result.reason ?? "No se encontró ningún esfuerzo válido.",
                quality: {
                    listed_activities: result.listed_activities,
                    analysed_activities: result.analysed_activities,
                    skipped: result.skipped,
                    warnings: result.warnings,
                },
            }),
        };
    }

    return {
        power_w: result.best.power_w,
        activity_id: result.best.activity_id,
        activity_date: result.best.activity_date,
        start_time_s: result.best.start_time_s,
        end_time_s: result.best.end_time_s,
        method: result.method,
        quality: {
            window: result.window,
            listed_activities: result.listed_activities,
            analysed_activities: result.analysed_activities,
            skipped: result.skipped,
        },
        warnings: [...warnings, ...result.warnings],
    };
}

/** Peso vigente en la fecha del esfuerzo (no la de hoy). */
async function resolveWeightAt(
    effortDate: string,
    override: number | undefined,
    errors: CrcError[],
): Promise<{ value: number; source: unknown; estimated: boolean } | null> {
    if (override != null) {
        return { value: override, source: { source: "override" }, estimated: false };
    }
    if (!effortDate) {
        errors.push({
            code: CrcErrorCode.MISSING_WEIGHT,
            message: "No se conoce la fecha del esfuerzo: no se puede resolver el peso vigente.",
        });
        return null;
    }

    const profile = await loadProfile();
    const r = resolveMetric(profile, "weight_kg", effortDate);
    if (!r.found) {
        errors.push({ code: CrcErrorCode.MISSING_WEIGHT, message: r.message });
        return null;
    }

    return {
        value: r.value,
        source: { source: r.source, effective_from: r.effective_from },
        estimated: false,
    };
}

function json(payload: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** isError solo para fallos de entrada o de red (decisión 6). */
function failure(err: unknown, tool: string) {
    const message = err instanceof Error ? err.message : String(err);
    return {
        content: [{ type: "text" as const, text: `❌ ${tool}: ${message}` }],
        isError: true as const,
    };
}
