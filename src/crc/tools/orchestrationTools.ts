/**
 * `crc-analyze-cycling-activity` (7.10) y `crc-compare-activities` (7.9).
 *
 * ORQUESTADORAS: no contienen ninguna fórmula. Componen los módulos de
 * `analytics/` y agregan sus bloques `quality`. Si aquí apareciera un cálculo,
 * estaría duplicando algo que ya existe.
 */
import { z } from "zod";

import { detectClimbs } from "../analytics/climbDetection.js";
import { computeDecoupling } from "../analytics/decoupling.js";
import { computePowerMetrics } from "../analytics/powerMetrics.js";
import { summariseHrAndCadence } from "../analytics/streamSummary.js";
import { computeTimeInZones } from "../analytics/zones.js";
import { resolveMetric } from "../profile/profileResolver.js";
import { loadProfile, type MetricName } from "../profile/profileStore.js";
import { describeProvenance } from "../profile/provenance.js";
import { fetchActivityStreams, type ActivityStreams } from "../sources/strava.js";
import {
    CrcErrorCode,
    crcToolResponse,
    crcUnavailable,
    type CrcError,
} from "../schemas/crcToolResponse.js";
import { stravaId } from "../schemas/mcpSchemas.js";
import { computeStreamQuality } from "../streams/streamQuality.js";
import { getAuthenticatedAthlete } from "../../stravaClient.js";

export const CRC_VERSION = "0.1.0";

/** Tope de actividades por comparación (límites de API). */
export const MAX_COMPARE_ACTIVITIES = 10;

/** Estado de una celda: distingue un 0 legítimo de un dato ausente. */
type Cell = { value: number | null; status: "ok" | "missing_data"; reason?: string };

const ok = (value: number | null): Cell =>
    value === null
        ? { value: null, status: "missing_data", reason: "No calculable." }
        : { value, status: "ok" };

const missing = (reason: string): Cell => ({ value: null, status: "missing_data", reason });

interface ResolvedParams {
    ftp: number | null;
    weight: number | null;
    hrMax: number | null;
    sources: Record<string, unknown>;
    errors: CrcError[];
    warnings: string[];
    ftpEstimated: boolean;
}

/** Resuelve los parámetros del perfil vigentes EN LA FECHA DE LA ACTIVIDAD. */
async function resolveAt(
    activity: ActivityStreams,
    overrides: { ftp_w?: number; weight_kg?: number } = {},
): Promise<ResolvedParams> {
    const out: ResolvedParams = {
        ftp: overrides.ftp_w ?? null,
        weight: overrides.weight_kg ?? null,
        hrMax: null,
        sources: {},
        errors: [],
        warnings: [],
        ftpEstimated: false,
    };

    if (out.ftp !== null) out.sources["ftp_w"] = { source: "override", value: out.ftp };
    if (out.weight !== null) out.sources["weight_kg"] = { source: "override", value: out.weight };

    if (!activity.start_date) {
        out.warnings.push("La actividad no trae fecha: no se resuelve el perfil por fecha.");
        return out;
    }

    const profile = await loadProfile();
    const wanted: [MetricName, "ftp" | "weight" | "hrMax"][] = [
        ["ftp_w", "ftp"],
        ["weight_kg", "weight"],
        ["hr_max_bpm", "hrMax"],
    ];

    for (const [metric, key] of wanted) {
        if (out[key] !== null) continue;
        const r = resolveMetric(profile, metric, activity.start_date);
        if (r.found) {
            out[key] = r.value;
            const entry = { source: r.source, effective_from: r.effective_from, value: r.value };
            out.sources[metric] = entry;
            const prov = describeProvenance(metric, entry);
            if (prov.estimated) {
                out.warnings.push(...prov.warnings);
                if (metric === "ftp_w") out.ftpEstimated = true;
            }
        } else if (metric !== "hr_max_bpm") {
            // La FC máxima es opcional: su ausencia solo quita las zonas de FC.
            out.errors.push({
                code: metric === "ftp_w" ? CrcErrorCode.MISSING_FTP : CrcErrorCode.MISSING_WEIGHT,
                message: r.message,
            });
            out.warnings.push(r.message);
        }
    }

    return out;
}

// --- crc-analyze-cycling-activity ----------------------------------------

export const analyzeCyclingActivityTool = {
    name: "crc-analyze-cycling-activity",
    description:
        "Análisis completo de una actividad: detalles, métricas de potencia, resúmenes de FC y " +
        "cadencia, tiempo en zonas y desacople. Cada módulo puede quedar no disponible sin " +
        "invalidar el resto: una actividad sin FC devuelve igualmente la potencia.",
    inputSchema: z.object({
        activityId: stravaId.describe("ID de la actividad de Strava."),
        ftp_w: z.number().positive().optional().describe("FTP en W. Por defecto, del perfil CRC."),
        weight_kg: z.number().positive().optional().describe("Peso en kg. Por defecto, del perfil."),
    }),
    execute: async (args: { activityId: string; ftp_w?: number; weight_kg?: number }) => {
        try {
            const activity = await fetchActivityStreams(args.activityId);
            const quality = computeStreamQuality(activity.aligned, {
                deviceWatts: activity.device_watts,
            });
            const p = await resolveAt(activity, args);

            const warnings: string[] = [...quality.warnings, ...p.warnings];
            const modules: Record<string, unknown> = {};

            // 1) Detalles: vienen de la misma llamada que los streams.
            modules["activity_details"] = {
                available: true,
                activity_id: activity.activity_id,
                start_date: activity.start_date,
                ...activity.details,
                valid_seconds: quality.valid_seconds,
                power_source: quality.power_source,
            };

            // 2) Potencia.
            if (quality.power_available) {
                const m = computePowerMetrics(activity.aligned, {
                    ftpW: p.ftp,
                    weightKg: p.weight,
                });
                modules["power_metrics"] = {
                    available: true,
                    average_power_w: m.average_power_w,
                    normalized_power_w: m.normalized_power_w,
                    variability_index: m.variability_index,
                    intensity_factor: m.intensity_factor,
                    tss: m.tss,
                    work_kj: m.work_kj,
                    average_wkg: m.average_wkg,
                    duration_s: m.inputs.duration_s,
                    duration_basis: m.inputs.duration_basis,
                    // Sin FTP, IF y TSS quedan a null pero el resto se calcula.
                    unavailable_metrics: p.ftp === null ? ["intensity_factor", "tss"] : [],
                };
            } else {
                modules["power_metrics"] = unavailableModule(
                    "La actividad no tiene stream de potencia.",
                );
            }

            // 3) Resúmenes de FC y cadencia.
            const summaries = summariseHrAndCadence(activity.aligned);
            modules["heartrate_summary"] = summaries.heartrate.available
                ? { ...summaries.heartrate }
                : unavailableModule("La actividad no tiene stream de FC.");
            modules["cadence_summary"] = summaries.cadence.available
                ? { ...summaries.cadence }
                : unavailableModule("La actividad no tiene stream de cadencia.");

            // 4) Zonas de potencia (necesitan FTP) y de FC (necesitan FC máx).
            modules["power_zones"] = zonesModule(activity, "power", p.ftp);
            modules["heartrate_zones"] = zonesModule(activity, "heartrate", p.hrMax);

            // 5) Desacople: necesita potencia y FC.
            if (quality.power_available && quality.heartrate_available) {
                const d = computeDecoupling(activity.aligned, { ftpW: p.ftp });
                modules["decoupling"] = d.available
                    ? {
                          available: true,
                          first_half_ef: d.first_half_ef,
                          second_half_ef: d.second_half_ef,
                          decoupling_pct: d.decoupling_pct,
                          valid_seconds: d.valid_seconds,
                          filters_applied: d.filters_applied,
                      }
                    : unavailableModule(d.reason ?? "No calculable.");
            } else {
                modules["decoupling"] = unavailableModule(
                    !quality.power_available
                        ? "Sin potencia no hay desacople."
                        : "Sin FC no hay desacople.",
                );
            }

            // 6) Subidas: necesitan altitud y distancia.
            const climbs = detectClimbs(activity.aligned, {
                ftpW: p.ftp,
                weightKg: p.weight,
            });
            modules["climbs"] = climbs.available
                ? {
                      available: true,
                      climb_count: climbs.climb_count,
                      total_elevation_gain_m: climbs.total_elevation_gain_m,
                      climbs: climbs.climbs,
                      thresholds: climbs.thresholds,
                  }
                : unavailableModule(climbs.reason ?? "No calculable.");

            // Se agregan las advertencias de cada módulo en un solo bloque.
            for (const [name, mod] of Object.entries(modules)) {
                const m = mod as { available?: boolean; reason?: string };
                if (m.available === false && m.reason) warnings.push(`${name}: ${m.reason}`);
            }

            const availableCount = Object.values(modules).filter(
                (m) => (m as { available?: boolean }).available,
            ).length;

            return json(
                crcToolResponse({
                    tool: "crc-analyze-cycling-activity",
                    version: CRC_VERSION,
                    activity_id: activity.activity_id,
                    inputs: {
                        activityId: activity.activity_id,
                        start_date: activity.start_date,
                        ftp_w: p.ftp,
                        weight_kg: p.weight,
                        hr_max_bpm: p.hrMax,
                        parameter_sources: p.sources,
                    },
                    method: {
                        composition:
                            "Orquestador: compone los módulos de analytics/ sin recalcular nada.",
                        partial:
                            "Cada módulo lleva su propio available; uno no disponible no invalida el resto.",
                    },
                    metrics: { modules },
                    quality: {
                        ...quality,
                        ftp_estimated: p.ftpEstimated,
                        modules_available: availableCount,
                        modules_total: Object.keys(modules).length,
                        warnings,
                    },
                    errors: p.errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-analyze-cycling-activity");
        }
    },
};

function unavailableModule(reason: string) {
    return { available: false, reason };
}

/** Zonas de una señal, no disponibles si falta la referencia del perfil. */
function zonesModule(activity: ActivityStreams, kind: "power" | "heartrate", reference: number | null) {
    if (reference === null) {
        return unavailableModule(
            kind === "power"
                ? "Sin FTP vigente no se pueden calcular las zonas de potencia."
                : "Sin FC máxima en el perfil no se pueden calcular las zonas de FC.",
        );
    }
    const z = computeTimeInZones(activity.aligned, { kind, reference });
    return z.available
        ? {
              available: true,
              unit: z.unit,
              reference,
              zones: z.zones,
              classified_seconds: z.classified_seconds,
              unclassified_seconds: z.unclassified_seconds,
          }
        : unavailableModule(z.reason ?? "No calculable.");
}

// --- crc-compare-activities -----------------------------------------------

export const compareActivitiesTool = {
    name: "crc-compare-activities",
    description:
        `Compara de 2 a ${MAX_COMPARE_ACTIVITIES} actividades con el mismo conjunto de métricas. ` +
        "Cada actividad usa los parámetros vigentes EN SU FECHA, nunca el FTP actual. " +
        "Solo actividades del atleta autenticado.",
    inputSchema: z.object({
        activityIds: z
            .array(stravaId)
            .min(2)
            .max(MAX_COMPARE_ACTIVITIES)
            .describe(`IDs de actividad. De 2 a ${MAX_COMPARE_ACTIVITIES}.`),
    }),
    execute: async (args: { activityIds: string[] }) => {
        try {
            // Propiedad: una instancia = un atleta. Comparar actividades ajenas
            // vulneraría la regla de que los datos solo se muestran a su dueño.
            const token = process.env.STRAVA_ACCESS_TOKEN;
            if (!token) throw new Error("Falta STRAVA_ACCESS_TOKEN.");
            const me = await getAuthenticatedAthlete(token);
            const myId = me?.id == null ? null : String(me.id);

            const rows: Record<string, unknown>[] = [];
            const warnings: string[] = [];
            const errors: CrcError[] = [];
            const rejected: { activity_id: string; reason: string }[] = [];

            // Los IDs repetidos se descargarían dos veces; la caché lo evita,
            // pero además no aportan nada a una comparación.
            const ids = [...new Set(args.activityIds)];
            if (ids.length !== args.activityIds.length) {
                warnings.push("Se han descartado IDs repetidos.");
            }

            for (const id of ids) {
                let activity: ActivityStreams;
                try {
                    // Segunda llamada con el mismo id: sirve de caché.
                    activity = await fetchActivityStreams(id);
                } catch (err) {
                    rejected.push({
                        activity_id: id,
                        reason: err instanceof Error ? err.message : String(err),
                    });
                    continue;
                }

                if (myId !== null && activity.athlete_id !== null && activity.athlete_id !== myId) {
                    rejected.push({
                        activity_id: id,
                        reason:
                            "La actividad no pertenece al atleta autenticado: los datos solo se " +
                            "muestran a su propietario.",
                    });
                    continue;
                }

                const quality = computeStreamQuality(activity.aligned, {
                    deviceWatts: activity.device_watts,
                });
                // Parámetros vigentes EN LA FECHA DE ESTA ACTIVIDAD.
                const p = await resolveAt(activity);
                const hasPower = quality.power_available;

                const m = hasPower
                    ? computePowerMetrics(activity.aligned, { ftpW: p.ftp, weightKg: p.weight })
                    : null;
                const summaries = summariseHrAndCadence(activity.aligned);

                rows.push({
                    activity_id: activity.activity_id,
                    start_date: activity.start_date,
                    name: activity.details.name,
                    sport_type: activity.details.sport_type,
                    // Los parámetros usados viajan en la fila: es lo que hace
                    // auditable que no se ha recalculado con el FTP de hoy.
                    ftp_w: p.ftp,
                    weight_kg: p.weight,
                    ftp_source: p.sources["ftp_w"] ?? null,
                    ftp_estimated: p.ftpEstimated,
                    metrics: {
                        valid_seconds: ok(quality.valid_seconds),
                        average_power_w: m ? ok(m.average_power_w) : missing("Sin potencia."),
                        normalized_power_w: m ? ok(m.normalized_power_w) : missing("Sin potencia."),
                        variability_index: m ? ok(m.variability_index) : missing("Sin potencia."),
                        intensity_factor: m
                            ? p.ftp === null
                                ? missing("Sin FTP vigente para esta fecha.")
                                : ok(m.intensity_factor)
                            : missing("Sin potencia."),
                        tss: m
                            ? p.ftp === null
                                ? missing("Sin FTP vigente para esta fecha.")
                                : ok(m.tss)
                            : missing("Sin potencia."),
                        work_kj: m ? ok(m.work_kj) : missing("Sin potencia."),
                        average_wkg: m
                            ? p.weight === null
                                ? missing("Sin peso vigente para esta fecha.")
                                : ok(m.average_wkg)
                            : missing("Sin potencia."),
                        mean_hr_bpm: summaries.heartrate.available
                            ? ok(summaries.heartrate.mean)
                            : missing("Sin FC."),
                        max_hr_bpm: summaries.heartrate.available
                            ? ok(summaries.heartrate.max)
                            : missing("Sin FC."),
                        mean_cadence_rpm: summaries.cadence.available
                            ? ok(summaries.cadence.mean)
                            : missing("Sin cadencia."),
                    },
                    quality: {
                        coverage_pct: quality.coverage_pct,
                        power_source: quality.power_source,
                        warnings: [...quality.warnings, ...p.warnings],
                    },
                });

                errors.push(...p.errors);
            }

            if (rows.length < 2) {
                return json(
                    crcUnavailable({
                        tool: "crc-compare-activities",
                        version: CRC_VERSION,
                        inputs: { activityIds: ids },
                        code: CrcErrorCode.INSUFFICIENT_DURATION,
                        message:
                            `Solo ${rows.length} actividad(es) utilizable(s): se necesitan al menos 2 ` +
                            "para comparar.",
                        quality: { rejected, warnings },
                        errors,
                    }),
                );
            }

            // El mismo conjunto de métricas para todas las filas.
            const metricKeys = Object.keys(rows[0]!["metrics"] as Record<string, unknown>);

            return json(
                crcToolResponse({
                    tool: "crc-compare-activities",
                    version: CRC_VERSION,
                    inputs: { activityIds: ids, count: rows.length },
                    method: {
                        parameters:
                            "Cada actividad usa el FTP y el peso vigentes EN SU FECHA, resueltos " +
                            "del perfil. Nunca se recalcula con el valor actual.",
                        missing_data:
                            "Cada celda lleva status: 'ok' o 'missing_data'. Un 0 legítimo es " +
                            "status 'ok' con value 0; un dato ausente es 'missing_data' con value null.",
                        ownership: "Solo actividades del atleta autenticado.",
                        cache: "Los streams se leen de la caché cuando ya se habían descargado.",
                    },
                    metrics: { metric_keys: metricKeys, activities: rows },
                    quality: {
                        compared: rows.length,
                        requested: args.activityIds.length,
                        rejected,
                        warnings,
                    },
                    errors,
                }),
            );
        } catch (err) {
            return failure(err, "crc-compare-activities");
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
