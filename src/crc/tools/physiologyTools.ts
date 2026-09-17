/**
 * Wrappers MCP de fisiología de campo: desacople, zonas, torque/cadencia y
 * trabajo por encima del FTP (secciones 7.5 a 7.8).
 *
 * Finos por diseño: validación Zod -> source -> analytics -> `crcToolResponse`.
 */
import { z } from "zod";

import { computeDecoupling } from "../analytics/decoupling.js";
import { computeTorqueCadence } from "../analytics/torqueCadence.js";
import { computeWorkAboveFtp, DEFAULT_RANGES_PCT_FTP } from "../analytics/workAboveFtp.js";
import { computeTimeInZones, type ZoneDefinition } from "../analytics/zones.js";
import { resolveMetric } from "../profile/profileResolver.js";
import { describeProvenance } from "../profile/provenance.js";
import { loadProfile } from "../profile/profileStore.js";
import { fetchActivityStreams, type ActivityStreams } from "../sources/strava.js";
import {
    CrcErrorCode,
    crcToolResponse,
    crcUnavailable,
    type CrcError,
} from "../schemas/crcToolResponse.js";
import { flexibleBoolean, stravaId } from "../schemas/mcpSchemas.js";
import { computeStreamQuality, type StreamQuality } from "../streams/streamQuality.js";

export const CRC_VERSION = "0.1.0";

const activityIdInput = stravaId.describe("ID de la actividad de Strava.");

/** Resuelve una métrica del perfil por la fecha de la actividad. */
async function resolveFromProfile(
    activity: ActivityStreams,
    metric: "ftp_w" | "weight_kg" | "hr_max_bpm",
): Promise<{
    value: number | null;
    source: unknown;
    error: CrcError | null;
    estimated: boolean;
    warnings: string[];
}> {
    if (!activity.start_date) {
        return {
            value: null,
            source: null,
            estimated: false,
            warnings: [],
            error: {
                code: metric === "ftp_w" ? CrcErrorCode.MISSING_FTP : CrcErrorCode.INVALID_PROFILE,
                message: "La actividad no trae fecha: no se puede resolver el perfil por fecha.",
            },
        };
    }

    const profile = await loadProfile();
    const r = resolveMetric(profile, metric, activity.start_date);
    if (r.found) {
        const entry = { source: r.source, effective_from: r.effective_from, value: r.value };
        // Un valor estimado contamina todo lo que se derive de él (D12).
        const prov = describeProvenance(metric, entry);
        return {
            value: r.value,
            source: entry,
            error: null,
            estimated: prov.estimated,
            warnings: prov.warnings,
        };
    }

    const code =
        metric === "ftp_w"
            ? CrcErrorCode.MISSING_FTP
            : metric === "weight_kg"
              ? CrcErrorCode.MISSING_WEIGHT
              : CrcErrorCode.INVALID_PROFILE;
    return {
        value: null,
        source: null,
        estimated: false,
        warnings: [],
        error: { code, message: r.message },
    };
}

// --- crc-aerobic-decoupling ----------------------------------------------

export const decouplingTool = {
    name: "crc-aerobic-decoupling",
    description:
        "Desacople aeróbico: compara la eficiencia potencia/FC entre las dos mitades de la " +
        "muestra filtrada. Devuelve el valor y los filtros aplicados, SIN interpretarlo.",
    inputSchema: z.object({
        activityId: activityIdInput,
        ftp_w: z.number().positive().optional().describe("FTP en W. Por defecto, del perfil CRC."),
        warmup_exclusion_min: z
            .number()
            .min(0)
            .optional()
            .describe("Minutos iniciales a descartar. Por defecto 0."),
        moving_only: flexibleBoolean.optional().describe("Solo segundos en movimiento."),
        power_min_pct_ftp: z
            .number()
            .positive()
            .optional()
            .describe("Descarta potencia por debajo de este % del FTP (0.56 = 56 %)."),
        power_max_pct_ftp: z
            .number()
            .positive()
            .optional()
            .describe("Descarta potencia por encima de este % del FTP."),
        min_valid_duration: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Duración mínima de la muestra filtrada, en segundos. Por defecto 600."),
        hr_lag_s: z
            .number()
            .min(0)
            .optional()
            .describe("Desfase FC-potencia. En el contrato, pero v0.1 NO lo aplica."),
    }),
    execute: async (args: {
        activityId: string;
        ftp_w?: number;
        warmup_exclusion_min?: number;
        moving_only?: boolean;
        power_min_pct_ftp?: number;
        power_max_pct_ftp?: number;
        min_valid_duration?: number;
        hr_lag_s?: number;
    }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });

            if (!quality.power_available) {
                return json(
                    unavailable("crc-aerobic-decoupling", activity, quality, {
                        code: CrcErrorCode.MISSING_POWER,
                        message: "La actividad no tiene stream de potencia.",
                    }),
                );
            }
            if (!quality.heartrate_available) {
                return json(
                    unavailable("crc-aerobic-decoupling", activity, quality, {
                        code: CrcErrorCode.MISSING_HR,
                        message: "La actividad no tiene stream de FC: el desacople no es calculable.",
                    }),
                );
            }

            const errors: CrcError[] = [];
            const provenanceWarnings: string[] = [];
            let ftpEstimated = false;
            let ftp = args.ftp_w ?? null;
            let ftpSource: unknown = ftp !== null ? { source: "override", value: ftp } : null;

            const needsFtp = args.power_min_pct_ftp != null || args.power_max_pct_ftp != null;
            if (ftp === null && needsFtp) {
                const r = await resolveFromProfile(activity, "ftp_w");
                ftp = r.value;
                ftpSource = r.source;
                provenanceWarnings.push(...r.warnings);
                ftpEstimated = r.estimated;
                if (r.error) errors.push(r.error);
            }

            const d = computeDecoupling(activity.aligned, {
                ftpW: ftp,
                warmupExclusionMin: args.warmup_exclusion_min,
                movingOnly: args.moving_only,
                powerMinPctFtp: args.power_min_pct_ftp,
                powerMaxPctFtp: args.power_max_pct_ftp,
                minValidDuration: args.min_valid_duration,
                hrLagS: args.hr_lag_s,
            });

            if (!d.available) {
                return json(
                    crcUnavailable({
                        tool: "crc-aerobic-decoupling",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id, ftp_w: ftp },
                        method: d.method,
                        code: CrcErrorCode.INSUFFICIENT_DURATION,
                        message: d.reason ?? "No calculable.",
                        quality: { ...quality, warnings: [...quality.warnings, d.reason ?? ""] },
                        errors,
                    }),
                );
            }

            return json(
                crcToolResponse({
                    tool: "crc-aerobic-decoupling",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        ftp_w: ftp,
                        parameter_sources: { ftp_w: ftpSource },
                        filters: d.filters_applied,
                    },
                    method: d.method,
                    metrics: {
                        first_half_ef: d.first_half_ef,
                        second_half_ef: d.second_half_ef,
                        decoupling_pct: d.decoupling_pct,
                        first_half_mean_power_w: d.first_half_mean_power_w,
                        first_half_mean_hr_bpm: d.first_half_mean_hr_bpm,
                        second_half_mean_power_w: d.second_half_mean_power_w,
                        second_half_mean_hr_bpm: d.second_half_mean_hr_bpm,
                    },
                    quality: {
                        ...quality,
                        ftp_estimated: ftpEstimated,
                        warnings: [...quality.warnings, ...provenanceWarnings],
                        filtered_valid_seconds: d.valid_seconds,
                        first_half_seconds: d.first_half_seconds,
                        second_half_seconds: d.second_half_seconds,
                        excluded_seconds: d.excluded_seconds,
                    },
                    errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-aerobic-decoupling");
        }
    },
};

// --- crc-time-in-zones ----------------------------------------------------

const zoneSchema = z.object({
    name: z.string(),
    lower: z.number().min(0),
    upper: z.number().positive().nullable(),
});

export const timeInZonesTool = {
    name: "crc-time-in-zones",
    description:
        "Tiempo en zonas de potencia, FC o personalizadas. Las fronteras son semiabiertas " +
        "[inferior, superior), así que ningún segundo se cuenta dos veces ni se pierde.",
    inputSchema: z.object({
        activityId: activityIdInput,
        kind: z
            .enum(["power", "heartrate", "custom"])
            .optional()
            .describe("Señal a repartir. Por defecto 'power'."),
        zones: z
            .array(zoneSchema)
            .optional()
            .describe("Zonas con límites ABSOLUTOS (W o bpm). La última con upper:null."),
        relative_zones: z
            .array(zoneSchema)
            .optional()
            .describe("Zonas relativas: los límites se multiplican por la referencia."),
        reference: z
            .number()
            .positive()
            .optional()
            .describe("Referencia de las zonas relativas: FTP en W o FC máx en bpm."),
    }),
    execute: async (args: {
        activityId: string;
        kind?: "power" | "heartrate" | "custom";
        zones?: ZoneDefinition[];
        relative_zones?: ZoneDefinition[];
        reference?: number;
    }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });
            const kind = args.kind ?? "power";

            const errors: CrcError[] = [];
            const provenanceWarnings: string[] = [];
            let referenceEstimated = false;
            let reference = args.reference ?? null;
            let refSource: unknown = reference !== null ? { source: "override" } : null;

            // Las zonas absolutas no necesitan referencia; las relativas sí.
            const needsReference = !args.zones || args.zones.length === 0;
            if (reference === null && needsReference) {
                const metric = kind === "heartrate" ? "hr_max_bpm" : "ftp_w";
                const r = await resolveFromProfile(activity, metric);
                reference = r.value;
                refSource = r.source;
                provenanceWarnings.push(...r.warnings);
                referenceEstimated = r.estimated;
                if (r.error) errors.push(r.error);
            }

            const z = computeTimeInZones(activity.aligned, {
                kind,
                zones: args.zones,
                relativeZones: args.relative_zones,
                reference,
            });

            if (!z.available) {
                const code = !quality.heartrate_available && kind === "heartrate"
                    ? CrcErrorCode.MISSING_HR
                    : !quality.power_available && kind !== "heartrate"
                      ? CrcErrorCode.MISSING_POWER
                      : kind === "heartrate"
                        ? CrcErrorCode.INVALID_PROFILE
                        : CrcErrorCode.MISSING_FTP;

                return json(
                    crcUnavailable({
                        tool: "crc-time-in-zones",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id, kind, reference },
                        method: z.method,
                        code,
                        message: z.reason ?? "No calculable.",
                        quality: { ...quality, warnings: [...quality.warnings, z.reason ?? ""] },
                        errors,
                    }),
                );
            }

            return json(
                crcToolResponse({
                    tool: "crc-time-in-zones",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        kind,
                        reference,
                        unit: z.unit,
                        parameter_sources: { reference: refSource },
                    },
                    method: z.method,
                    metrics: {
                        zones: z.zones,
                        classified_seconds: z.classified_seconds,
                        unclassified_seconds: z.unclassified_seconds,
                    },
                    quality: {
                        ...quality,
                        reference_estimated: referenceEstimated,
                        warnings: [...quality.warnings, ...provenanceWarnings],
                    },
                    errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-time-in-zones");
        }
    },
};

// --- crc-torque-cadence ---------------------------------------------------

export const torqueCadenceTool = {
    name: "crc-torque-cadence",
    description:
        "Distribución de torque por bins de cadencia. torque = P / (2π × rpm/60). " +
        "Excluye cadencia <= 0 y muestras sin potencia válida. No necesita FTP ni peso.",
    inputSchema: z.object({
        activityId: activityIdInput,
        bin_width_rpm: z
            .number()
            .positive()
            .optional()
            .describe("Anchura de los bins en rpm. Por defecto 10."),
        max_cadence_rpm: z
            .number()
            .positive()
            .optional()
            .describe("Cadencia máxima considerada. Por defecto 150."),
    }),
    execute: async (args: {
        activityId: string;
        bin_width_rpm?: number;
        max_cadence_rpm?: number;
    }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });

            const t = computeTorqueCadence(activity.aligned, {
                binWidthRpm: args.bin_width_rpm,
                maxCadenceRpm: args.max_cadence_rpm,
            });

            if (!t.available) {
                return json(
                    crcUnavailable({
                        tool: "crc-torque-cadence",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id },
                        method: t.method,
                        code: CrcErrorCode.MISSING_POWER,
                        message: t.reason ?? "No calculable.",
                        quality: { ...quality, warnings: [...quality.warnings, t.reason ?? ""] },
                    }),
                );
            }

            return json(
                crcToolResponse({
                    tool: "crc-torque-cadence",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        bin_width_rpm: args.bin_width_rpm ?? 10,
                    },
                    method: t.method,
                    metrics: {
                        bins: t.bins,
                        mean_torque_nm: t.mean_torque_nm,
                        max_torque_nm: t.max_torque_nm,
                    },
                    quality: {
                        ...quality,
                        analysed_seconds: t.analysed_seconds,
                        excluded_seconds: t.excluded_seconds,
                    },
                }),
            );
        } catch (err) {
            return failure(err, "crc-torque-cadence");
        }
    },
};

// --- crc-work-above-ftp ---------------------------------------------------

export const workAboveFtpTool = {
    name: "crc-work-above-ftp",
    description:
        "Trabajo y esfuerzos por encima del FTP, repartidos en rangos (100-120 %, 120-150 %, " +
        ">150 % por defecto). Requiere FTP vigente para la fecha de la actividad.",
    inputSchema: z.object({
        activityId: activityIdInput,
        ftp_w: z.number().positive().optional().describe("FTP en W. Por defecto, del perfil CRC."),
        ranges: z
            .array(
                z.object({
                    name: z.string(),
                    lower: z.number().positive(),
                    upper: z.number().positive().nullable(),
                }),
            )
            .optional()
            .describe("Rangos en fracción de FTP. Por defecto 1.0-1.2, 1.2-1.5 y >1.5."),
        gap_tolerance_s: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("Microcortes de hasta N s no parten un esfuerzo. Por defecto 2."),
    }),
    execute: async (args: {
        activityId: string;
        ftp_w?: number;
        ranges?: { name: string; lower: number; upper: number | null }[];
        gap_tolerance_s?: number;
    }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });

            if (!quality.power_available) {
                return json(
                    unavailable("crc-work-above-ftp", activity, quality, {
                        code: CrcErrorCode.MISSING_POWER,
                        message: "La actividad no tiene stream de potencia.",
                    }),
                );
            }

            let ftp = args.ftp_w ?? null;
            let ftpSource: unknown = ftp !== null ? { source: "override", value: ftp } : null;
            const errors: CrcError[] = [];
            const provenanceWarnings: string[] = [];
            let ftpEstimated = false;

            if (ftp === null) {
                const r = await resolveFromProfile(activity, "ftp_w");
                ftp = r.value;
                ftpSource = r.source;
                provenanceWarnings.push(...r.warnings);
                ftpEstimated = r.estimated;
                if (r.error) errors.push(r.error);
            }

            // Sin FTP no hay nada que calcular: todos los rangos son relativos a él.
            if (ftp === null) {
                return json(
                    crcUnavailable({
                        tool: "crc-work-above-ftp",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id },
                        code: CrcErrorCode.MISSING_FTP,
                        message:
                            "No hay FTP vigente para la fecha de la actividad: los rangos son " +
                            "relativos al FTP y no pueden calcularse.",
                        quality: { ...quality },
                        errors,
                    }),
                );
            }

            const w = computeWorkAboveFtp(activity.aligned, {
                ftpW: ftp,
                ranges: args.ranges ?? DEFAULT_RANGES_PCT_FTP,
                gapToleranceS: args.gap_tolerance_s,
            });

            return json(
                crcToolResponse({
                    tool: "crc-work-above-ftp",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        ftp_w: ftp,
                        gap_tolerance_s: w.gap_tolerance_s,
                        parameter_sources: { ftp_w: ftpSource },
                    },
                    method: w.method,
                    metrics: { ranges: w.ranges },
                    quality: {
                        ...quality,
                        ftp_estimated: ftpEstimated,
                        warnings: [...quality.warnings, ...provenanceWarnings],
                    },
                    errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-work-above-ftp");
        }
    },
};

// --- helpers --------------------------------------------------------------

function unavailable(
    tool: string,
    activity: ActivityStreams,
    quality: StreamQuality,
    err: { code: CrcErrorCode; message: string },
) {
    return crcUnavailable({
        tool,
        version: CRC_VERSION,
        activity_id: activity.activity_id,
        inputs: { activityId: activity.activity_id },
        code: err.code,
        message: err.message,
        quality: { ...quality },
    });
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
