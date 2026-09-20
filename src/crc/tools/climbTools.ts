/**
 * `crc-detect-climbs` — primera herramienta de la v0.2.
 *
 * Wrapper fino: validación Zod -> source -> `analytics/climbDetection` ->
 * `crcToolResponse`. Ninguna fórmula vive aquí.
 */
import { z } from "zod";

import {
    detectClimbs,
    linearTrend,
    MIN_CLIMBS_FOR_TREND,
    DEFAULT_MAX_FLAT_RUN_M,
    DEFAULT_MIN_AVG_GRADE_PCT,
    DEFAULT_MIN_ELEVATION_GAIN_M,
    DEFAULT_MIN_LENGTH_M,
    type Climb,
} from "../analytics/climbDetection.js";
import { bestEffortsInPeriod } from "../analytics/bestEffort.js";
import { summariseSignal } from "../analytics/streamSummary.js";
import { sliceAlignedStreams } from "../streams/alignedStreams.js";
import { resolveMetric } from "../profile/profileResolver.js";
import { loadProfile } from "../profile/profileStore.js";
import { describeProvenance } from "../profile/provenance.js";
import { fetchActivityStreams, stravaBestEffortProviders } from "../sources/strava.js";
import { CrcErrorCode, crcToolResponse, crcUnavailable } from "../schemas/crcToolResponse.js";
import { stravaId } from "../schemas/mcpSchemas.js";
import { computeStreamQuality } from "../streams/streamQuality.js";

export const CRC_VERSION = "0.1.0";

/**
 * Ventana por defecto para comparar con el mejor histórico.
 *
 * 42 días son seis semanas: suficiente para que haya esfuerzos comparables y
 * corto para que sigan reflejando la forma actual.
 */
export const DEFAULT_MMP_WINDOW_DAYS = 42;
export const DEFAULT_MMP_MAX_ACTIVITIES = 30;

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
        compare_to_best: z
            .boolean()
            .optional()
            .describe(
                "Compara la potencia de cada subida con el mejor esfuerzo histórico de esa " +
                    "misma duración. Requiere potencia medida y cuesta llamadas a la API.",
            ),
        mmp_window_days: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Ventana del histórico. Por defecto ${DEFAULT_MMP_WINDOW_DAYS} días.`),
        mmp_max_activities: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(`Tope de actividades del barrido. Por defecto ${DEFAULT_MMP_MAX_ACTIVITIES}.`),
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
        compare_to_best?: boolean;
        mmp_window_days?: number;
        mmp_max_activities?: number;
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
                powerIsMeasured: quality.power_source === "measured",
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

            // --- FC media por subida, para la tendencia ----------------------
            const climbs: Climb[] = c.climbs;
            const hrPorSubida: (number | null)[] = climbs.map((climb) => {
                if (!activity.aligned.heartrate) return null;
                const from = climb.start_time_s - activity.aligned.meta.start_offset_s;
                const to = climb.end_time_s - activity.aligned.meta.start_offset_s;
                const s = summariseSignal(sliceAlignedStreams(activity.aligned, from, to), "heartrate");
                return s.available ? s.mean : null;
            });

            // --- Comparación con el mejor histórico --------------------------
            let mmpInfo: Record<string, unknown> | null = null;
            if (args.compare_to_best) {
                if (quality.power_source !== "measured") {
                    warnings.push(
                        `No se compara con el histórico: la potencia es ${quality.power_source} ` +
                            "y solo tiene sentido comparar potencia medida.",
                    );
                } else if (climbs.length === 0) {
                    warnings.push("No se compara con el histórico: no se detectó ninguna subida.");
                } else {
                    const ventana = args.mmp_window_days ?? DEFAULT_MMP_WINDOW_DAYS;
                    // Una sola pasada para todas las duraciones: una llamada por
                    // subida repetiría el barrido entero.
                    const duraciones = [...new Set(climbs.map((x) => x.duration_s))].filter(
                        (d) => d > 0,
                    );
                    const mejores = await bestEffortsInPeriod(duraciones, ventana, {
                        // La propia actividad NO cuenta: si contara, una subida
                        // récord daría 100 % en vez de superarlo.
                        excludeActivityIds: [activity.activity_id],
                        maxActivities: args.mmp_max_activities ?? DEFAULT_MMP_MAX_ACTIVITIES,
                        providers: stravaBestEffortProviders(),
                    });

                    for (const climb of climbs) {
                        const r = mejores[climb.duration_s];
                        if (!r?.available || !r.best || climb.average_power_w === null) continue;
                        climb.mmp_comparison = {
                            percent_of_best:
                                Math.round((climb.average_power_w / r.best.power_w) * 1000) / 10,
                            duration_s: climb.duration_s,
                            best_power_w: r.best.power_w,
                            best_activity_id: r.best.activity_id,
                            best_activity_date: r.best.activity_date,
                            window_days: ventana,
                        };
                    }

                    const cualquiera = mejores[duraciones[0]!];
                    mmpInfo = {
                        window_days: ventana,
                        excluded_activity_id: activity.activity_id,
                        durations_compared: duraciones,
                        analysed_activities: cualquiera?.analysed_activities ?? 0,
                        listed_activities: cualquiera?.listed_activities ?? 0,
                        compared: climbs.filter((x) => x.mmp_comparison !== null).length,
                    };
                    warnings.push(...(cualquiera?.warnings ?? []));
                }
            }

            // --- Tendencia entre subidas -------------------------------------
            // Coeficientes en crudo: la lectura la hace quien los reciba.
            const tendencia = {
                average_power_w: linearTrend(climbs.map((x) => x.average_power_w)),
                heartrate_bpm: linearTrend(hrPorSubida),
                min_climbs_required: MIN_CLIMBS_FOR_TREND,
                climbs_available: climbs.length,
                x_axis: "índice de subida dentro de la actividad (0, 1, 2…)",
            };

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
                    method: {
                        ...c.method,
                        trends:
                            "Regresión lineal de la potencia media y de la FC media sobre el " +
                            `índice de subida. Mínimo ${MIN_CLIMBS_FOR_TREND} subidas. Se devuelven ` +
                            "los coeficientes en crudo, sin interpretarlos.",
                        mmp:
                            "Potencia media de la subida frente al mejor esfuerzo del atleta en " +
                            "esa misma duración, excluyendo la actividad analizada.",
                    },
                    metrics: {
                        climb_count: c.climb_count,
                        total_elevation_gain_m: c.total_elevation_gain_m,
                        climbs,
                        mean_heartrate_by_climb: hrPorSubida,
                        trends: tendencia,
                        mmp: mmpInfo,
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
