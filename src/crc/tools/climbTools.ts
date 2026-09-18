/**
 * `crc-detect-climbs` — primera herramienta de la v0.2.
 *
 * Wrapper fino: validación Zod -> source -> `analytics/climbDetection` ->
 * `crcToolResponse`. Ninguna fórmula vive aquí.
 */
import { z } from "zod";

import {
    detectClimbs,
    DEFAULT_MAX_FLAT_RUN_M,
    DEFAULT_MIN_AVG_GRADE_PCT,
    DEFAULT_MIN_ELEVATION_GAIN_M,
    DEFAULT_MIN_LENGTH_M,
} from "../analytics/climbDetection.js";
import { resolveMetric } from "../profile/profileResolver.js";
import { loadProfile } from "../profile/profileStore.js";
import { describeProvenance } from "../profile/provenance.js";
import { fetchActivityStreams } from "../sources/strava.js";
import { CrcErrorCode, crcToolResponse, crcUnavailable } from "../schemas/crcToolResponse.js";
import { stravaId } from "../schemas/mcpSchemas.js";
import { computeStreamQuality } from "../streams/streamQuality.js";

export const CRC_VERSION = "0.1.0";

export const detectClimbsTool = {
    name: "crc-detect-climbs",
    description:
        "Detecta las subidas de una actividad y devuelve, por cada una, distancia, desnivel, " +
        "pendiente media y máxima sostenida, VAM y potencia. Requiere altitud y distancia. " +
        "La categorización de dificultad es una escala propia, no la de ninguna federación.",
    inputSchema: z.object({
        activityId: stravaId.describe("ID de la actividad de Strava."),
        min_elevation_gain_m: z
            .number()
            .positive()
            .optional()
            .describe(`Desnivel mínimo de una subida. Por defecto ${DEFAULT_MIN_ELEVATION_GAIN_M} m.`),
        min_avg_grade_pct: z
            .number()
            .positive()
            .optional()
            .describe(`Pendiente media mínima. Por defecto ${DEFAULT_MIN_AVG_GRADE_PCT} %.`),
        min_length_m: z
            .number()
            .positive()
            .optional()
            .describe(`Longitud mínima. Por defecto ${DEFAULT_MIN_LENGTH_M} m.`),
        max_flat_run_m: z
            .number()
            .min(0)
            .optional()
            .describe(
                `Tramo llano tolerado dentro de una subida sin partirla. Por defecto ${DEFAULT_MAX_FLAT_RUN_M} m.`,
            ),
        smoothing_window_s: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Ventana de suavizado de la altitud, en segundos. Por defecto 15."),
        ftp_w: z.number().positive().optional().describe("FTP en W. Por defecto, del perfil CRC."),
        weight_kg: z.number().positive().optional().describe("Peso en kg. Por defecto, del perfil."),
    }),
    execute: async (args: {
        activityId: string;
        min_elevation_gain_m?: number;
        min_avg_grade_pct?: number;
        min_length_m?: number;
        max_flat_run_m?: number;
        smoothing_window_s?: number;
        ftp_w?: number;
        weight_kg?: number;
    }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });

            // FTP y peso, vigentes en la fecha de la actividad.
            let ftp = args.ftp_w ?? null;
            let weight = args.weight_kg ?? null;
            const sources: Record<string, unknown> = {};
            const warnings: string[] = [...quality.warnings];
            let ftpEstimated = false;

            if ((ftp === null || weight === null) && activity.start_date) {
                const profile = await loadProfile();
                if (ftp === null) {
                    const r = resolveMetric(profile, "ftp_w", activity.start_date);
                    if (r.found) {
                        ftp = r.value;
                        const e = { source: r.source, effective_from: r.effective_from };
                        sources["ftp_w"] = e;
                        const prov = describeProvenance("FTP", e);
                        ftpEstimated = prov.estimated;
                        warnings.push(...prov.warnings);
                    }
                }
                if (weight === null) {
                    const r = resolveMetric(profile, "weight_kg", activity.start_date);
                    if (r.found) {
                        weight = r.value;
                        sources["weight_kg"] = {
                            source: r.source,
                            effective_from: r.effective_from,
                        };
                    }
                }
            }

            const c = detectClimbs(activity.aligned, {
                minElevationGainM: args.min_elevation_gain_m,
                minAvgGradePct: args.min_avg_grade_pct,
                minLengthM: args.min_length_m,
                maxFlatRunM: args.max_flat_run_m,
                smoothingWindowS: args.smoothing_window_s,
                ftpW: ftp,
                weightKg: weight,
            });

            if (!c.available) {
                return json(
                    crcUnavailable({
                        tool: "crc-detect-climbs",
                        version: CRC_VERSION,
                        activity_id: activity.activity_id,
                        inputs: { activityId: activity.activity_id },
                        method: c.method,
                        code: CrcErrorCode.MISSING_ELEVATION,
                        message: c.reason ?? "No calculable.",
                        quality: { ...quality, warnings: [...warnings, c.reason ?? ""] },
                    }),
                );
            }

            return json(
                crcToolResponse({
                    tool: "crc-detect-climbs",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        ftp_w: ftp,
                        weight_kg: weight,
                        parameter_sources: sources,
                        thresholds: c.thresholds,
                    },
                    method: c.method,
                    metrics: {
                        climb_count: c.climb_count,
                        total_elevation_gain_m: c.total_elevation_gain_m,
                        climbs: c.climbs,
                    },
                    quality: {
                        ...quality,
                        ftp_estimated: ftpEstimated,
                        warnings: [...warnings, ...c.warnings],
                    },
                }),
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: "text" as const, text: `❌ crc-detect-climbs: ${message}` }],
                isError: true as const,
            };
        }
    },
};

function json(payload: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}
