/**
 * Wrappers MCP de potencia: `crc-calculate-power-metrics` y `crc-power-curve`.
 *
 * Finos por diseño: validación Zod -> source -> analytics -> `crcToolResponse`.
 * Toda la matemática vive en `../analytics/`.
 */
import { z } from "zod";

import { computePowerCurve, DEFAULT_DURATIONS_S } from "../analytics/powerCurve.js";
import { computePowerMetrics } from "../analytics/powerMetrics.js";
import { resolveMetric } from "../profile/profileResolver.js";
import { loadProfile } from "../profile/profileStore.js";
import { fetchActivityStreams, type ActivityStreams } from "../sources/strava.js";
import {
    CrcErrorCode,
    crcToolResponse,
    crcUnavailable,
    type CrcError,
} from "../schemas/crcToolResponse.js";
import { stravaId } from "../schemas/mcpSchemas.js";
import { computeStreamQuality } from "../streams/streamQuality.js";

export const CRC_VERSION = "0.1.0";

const commonInput = {
    activityId: stravaId.describe("ID de la actividad de Strava."),
    ftp_w: z
        .number()
        .positive()
        .optional()
        .describe("FTP en W. Si se omite, se resuelve del perfil CRC por la fecha de la actividad."),
    weight_kg: z
        .number()
        .positive()
        .optional()
        .describe("Peso en kg. Si se omite, se resuelve del perfil CRC por la fecha de la actividad."),
};

/** Resuelve FTP y peso: override explícito > perfil por fecha > ausente. */
async function resolveParams(
    activity: ActivityStreams,
    override: { ftp_w?: number; weight_kg?: number },
) {
    const errors: CrcError[] = [];
    const warnings: string[] = [];
    const sources: Record<string, unknown> = {};

    let ftp: number | null = override.ftp_w ?? null;
    let weight: number | null = override.weight_kg ?? null;

    if (ftp !== null) sources["ftp_w"] = { source: "override", value: ftp };
    if (weight !== null) sources["weight_kg"] = { source: "override", value: weight };

    const needsProfile = ftp === null || weight === null;
    if (needsProfile) {
        if (!activity.start_date) {
            warnings.push(
                "La actividad no trae fecha de inicio: no se puede resolver el perfil por fecha.",
            );
        } else {
            const profile = await loadProfile();

            if (ftp === null) {
                const r = resolveMetric(profile, "ftp_w", activity.start_date);
                if (r.found) {
                    ftp = r.value;
                    sources["ftp_w"] = {
                        source: r.source,
                        effective_from: r.effective_from,
                        value: r.value,
                    };
                } else {
                    errors.push({ code: CrcErrorCode.MISSING_FTP, message: r.message });
                    warnings.push(r.message);
                }
            }

            if (weight === null) {
                const r = resolveMetric(profile, "weight_kg", activity.start_date);
                if (r.found) {
                    weight = r.value;
                    sources["weight_kg"] = {
                        source: r.source,
                        effective_from: r.effective_from,
                        value: r.value,
                    };
                } else {
                    errors.push({ code: CrcErrorCode.MISSING_WEIGHT, message: r.message });
                    warnings.push(r.message);
                }
            }
        }
    }

    if (ftp === null && !errors.some((e) => e.code === CrcErrorCode.MISSING_FTP)) {
        errors.push({
            code: CrcErrorCode.MISSING_FTP,
            message: "No hay FTP disponible: IF y TSS no se calculan.",
        });
    }
    if (weight === null && !errors.some((e) => e.code === CrcErrorCode.MISSING_WEIGHT)) {
        errors.push({
            code: CrcErrorCode.MISSING_WEIGHT,
            message: "No hay peso disponible: no se calculan W/kg.",
        });
    }

    return { ftp, weight, errors, warnings, sources };
}

// --- crc-calculate-power-metrics -----------------------------------------

export const powerMetricsTool = {
    name: "crc-calculate-power-metrics",
    description:
        "Calcula potencia media, NP, VI, IF, TSS, trabajo en kJ y W/kg de una actividad. " +
        "FTP y peso se resuelven del perfil CRC por la fecha de la actividad, con override " +
        "opcional. Sin FTP se devuelven igualmente NP, VI, media y kJ.",
    inputSchema: z.object(commonInput),
    execute: async (args: { activityId: string; ftp_w?: number; weight_kg?: number }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });

            if (!quality.power_available) {
                return json(
                    crcUnavailable({
                        tool: "crc-calculate-power-metrics",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id },
                        code: CrcErrorCode.MISSING_POWER,
                        message: "La actividad no tiene stream de potencia.",
                        quality: { ...quality },
                    }),
                );
            }

            const p = await resolveParams(activity, args);
            const m = computePowerMetrics(activity.aligned, { ftpW: p.ftp, weightKg: p.weight });

            return json(
                crcToolResponse({
                    tool: "crc-calculate-power-metrics",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        ftp_w: p.ftp,
                        weight_kg: p.weight,
                        duration_s: m.inputs.duration_s,
                        duration_basis: m.inputs.duration_basis,
                        parameter_sources: p.sources,
                    },
                    method: m.method,
                    metrics: {
                        average_power_w: m.average_power_w,
                        normalized_power_w: m.normalized_power_w,
                        variability_index: m.variability_index,
                        intensity_factor: m.intensity_factor,
                        tss: m.tss,
                        work_kj: m.work_kj,
                        average_wkg: m.average_wkg,
                    },
                    quality: {
                        ...quality,
                        np_windows: m.np_windows,
                        warnings: [...quality.warnings, ...p.warnings],
                    },
                    errors: p.errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-calculate-power-metrics");
        }
    },
};

// --- crc-power-curve ------------------------------------------------------

export const powerCurveTool = {
    name: "crc-power-curve",
    description:
        "Curva de potencia: mejor media sostenida para cada duración (1 s a 90 min). " +
        "Las ventanas no cruzan huecos. Requiere potencia medida: con potencia estimada " +
        "no se calcula.",
    inputSchema: z.object({
        ...commonInput,
        durations_s: z
            .array(z.number().int().positive())
            .optional()
            .describe(`Duraciones en segundos. Por defecto: ${DEFAULT_DURATIONS_S.join(", ")}.`),
    }),
    execute: async (args: {
        activityId: string;
        ftp_w?: number;
        weight_kg?: number;
        durations_s?: number[];
    }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });

            if (!quality.power_available) {
                return json(
                    crcUnavailable({
                        tool: "crc-power-curve",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id },
                        code: CrcErrorCode.MISSING_POWER,
                        message: "La actividad no tiene stream de potencia.",
                        quality: { ...quality },
                    }),
                );
            }

            // Potencia estimada: no se calcula power curve (CLAUDE.md y D8).
            if (quality.power_source !== "measured") {
                return json(
                    crcUnavailable({
                        tool: "crc-power-curve",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id },
                        code: CrcErrorCode.MISSING_POWER,
                        message:
                            `La potencia es ${quality.power_source} (device_watts=${activity.device_watts}). ` +
                            "La curva de potencia solo se calcula con potencia medida.",
                        quality: { ...quality },
                    }),
                );
            }

            const p = await resolveParams(activity, args);
            const curve = computePowerCurve(activity.aligned, {
                durations: args.durations_s,
                weightKg: p.weight,
            });

            // El FTP no interviene en la curva: no se reporta como error aquí.
            const errors = p.errors.filter((e) => e.code !== CrcErrorCode.MISSING_FTP);

            return json(
                crcToolResponse({
                    tool: "crc-power-curve",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        weight_kg: p.weight,
                        durations_s: curve.durations,
                        parameter_sources: p.sources,
                    },
                    method: curve.method,
                    metrics: { power_curve: curve.entries },
                    quality: {
                        ...quality,
                        warnings: [
                            ...quality.warnings,
                            ...p.warnings.filter((w) => !w.includes("ftp_w")),
                        ],
                    },
                    errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-power-curve");
        }
    },
};

// --- helpers --------------------------------------------------------------

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
