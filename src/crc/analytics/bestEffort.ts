/**
 * Mejor esfuerzo sostenido de una duración dada dentro de una ventana temporal.
 *
 * Núcleo compartido por `crc-estimate-vo2max` (mejor 5 min) y `crc-estimate-ftp`
 * (mejor 20 min): una sola implementación del barrido, no dos.
 *
 * Sigue sin depender de Strava ni de MCP: los datos entran por los proveedores
 * de `BestEffortProviders`, que inyecta quien la llama. Así la capa de fuente
 * puede cambiar (Intervals.icu, archivos FIT) sin tocar este módulo.
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";
import { computePowerCurve } from "./powerCurve.js";

/** Ventana por defecto del barrido, en días. */
export const DEFAULT_WINDOW_DAYS = 90;

/** Tope por defecto de actividades a descargar. Barrer cuesta llamadas a la API. */
export const DEFAULT_MAX_ACTIVITIES = 30;

export interface ActivityRef {
    activity_id: string;
    /** Fecha de inicio en ISO. */
    start_date: string;
    /** `true` = medidor real. Solo se analizan estas. */
    device_watts: boolean | null;
}

export interface EffortStreams {
    activity_id: string;
    start_date: string | null;
    device_watts: boolean | null;
    aligned: AlignedStreams;
}

export interface BestEffortProviders {
    /** Actividades del periodo, de más reciente a más antigua. */
    listActivities: (fromIso: string, toIso: string, max: number) => Promise<ActivityRef[]>;
    /** Streams alineados de una actividad. DEBE usar la caché de disco. */
    loadStreams: (activityId: string) => Promise<EffortStreams>;
}

/**
 * Señal sobre la que se busca el mejor esfuerzo.
 *
 * `watts` exige potencia medida (`device_watts === true`), porque una potencia
 * estimada no sirve para estimar nada. `heartrate` no lo exige: el pulsómetro
 * es independiente del medidor de potencia, y pedirlo dejaría fuera a quien
 * rueda con pulsómetro y sin potenciómetro, que es justo a quien más le sirve
 * estimar su umbral de FC.
 */
export type EffortSignal = "watts" | "heartrate";

export interface BestEffortOptions {
    /** Señal a analizar. Por defecto `watts`. */
    signal?: EffortSignal;
    /** Ventana hacia atrás, en días. Por defecto 90. */
    days?: number;
    /**
     * Actividades que NO entran en la comparación.
     *
     * Necesario para comparar una actividad contra su histórico: si la propia
     * actividad cuenta, una subida que bate el récord da 100 % en vez de
     * superarlo, y el dato deja de significar nada.
     */
    excludeActivityIds?: readonly string[];
    /** Tope de actividades a descargar. Por defecto 30. */
    maxActivities?: number;
    /** Momento de referencia. Inyectable para que los tests sean deterministas. */
    now?: Date;
    providers: BestEffortProviders;
}

export interface BestEffort {
    power_w: number;
    activity_id: string;
    /** Fecha de la actividad que contiene el esfuerzo (ISO). */
    activity_date: string;
    /** Inicio del esfuerzo dentro de la actividad, en segundos. */
    start_time_s: number;
    end_time_s: number;
}

export interface SkippedActivity {
    activity_id: string;
    reason: string;
}

export interface BestEffortResult {
    available: boolean;
    duration_s: number;
    best: BestEffort | null;
    window: { from: string; to: string; days: number };
    /** Actividades cuyos streams se llegaron a analizar. */
    analysed_activities: number;
    /** Actividades listadas en la ventana (antes de descartar). */
    listed_activities: number;
    skipped: SkippedActivity[];
    method: Record<string, string>;
    warnings: string[];
    reason: string | null;
}

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Recorre las actividades de la ventana y devuelve el mejor esfuerzo sostenido
 * de `durationS` segundos.
 *
 * - Solo se analizan actividades con `device_watts === true`: con potencia
 *   estimada no se estima ni FTP ni VO2max.
 * - El mejor esfuerzo de cada actividad se calcula con `computePowerCurve`, que
 *   ya descarta las ventanas que cruzan tramos no válidos.
 * - Una actividad que falle al descargarse no rompe el barrido: se anota en
 *   `skipped` y se sigue.
 */
export async function bestEffortInPeriod(
    durationS: number,
    days: number = DEFAULT_WINDOW_DAYS,
    options: BestEffortOptions,
): Promise<BestEffortResult> {
    const multi = await bestEffortsInPeriod([durationS], days, options);
    return multi[durationS]!;
}

/**
 * Igual que `bestEffortInPeriod`, pero para VARIAS duraciones a la vez.
 *
 * Comparar cada subida de una actividad con su mejor histórico necesita una
 * duración distinta por subida. Llamar una vez por subida repetiría el barrido
 * entero; aquí las actividades se recorren UNA vez y de cada una se sacan todas
 * las duraciones pedidas, que es lo que `computePowerCurve` ya hace en una
 * pasada.
 */
export async function bestEffortsInPeriod(
    durations: readonly number[],
    days: number = DEFAULT_WINDOW_DAYS,
    options: BestEffortOptions,
): Promise<Record<number, BestEffortResult>> {
    if (durations.length === 0) {
        throw new Error("Hay que pedir al menos una duración.");
    }
    for (const d of durations) {
        if (!Number.isFinite(d) || d <= 0) {
            throw new Error(`duration_s debe ser > 0 (recibido: ${d}).`);
        }
    }
    if (!Number.isFinite(days) || days <= 0) {
        throw new Error(`days debe ser > 0 (recibido: ${days}).`);
    }

    const signal: EffortSignal = options.signal ?? "watts";
    const requiresMeasuredPower = signal === "watts";
    const maxActivities = options.maxActivities ?? DEFAULT_MAX_ACTIVITIES;
    const now = options.now ?? new Date();
    const from = new Date(now.getTime() - days * 24 * 3600 * 1000);

    const window = { from: isoDay(from), to: isoDay(now), days };

    const method: Record<string, string> = {
        search:
            `Mejor media sostenida de ${durations.join(", ")} s entre las actividades de los ` +
            `últimos ${days} días, con un tope de ${maxActivities} actividades.`,
        windows:
            "Las ventanas móviles no cruzan tramos no válidos (misma regla que la power curve).",
        signal: `Mejor media sostenida de la señal ${signal}.`,
        power_source: requiresMeasuredPower
            ? "Solo se analizan actividades con device_watts = true: la potencia estimada no sirve."
            : "No se exige potencia medida: la señal analizada no es la potencia.",
        cache: "Los streams se leen de la caché de disco cuando están disponibles.",
    };

    const warnings: string[] = [];
    const skipped: SkippedActivity[] = [];

    const excluded = new Set(options.excludeActivityIds ?? []);
    const listedRaw = await options.providers.listActivities(
        window.from,
        window.to,
        maxActivities,
    );
    const listed = listedRaw.filter((a) => !excluded.has(a.activity_id));
    if (excluded.size > 0) {
        method["exclusions"] = `Excluidas de la comparación: ${[...excluded].join(", ")}.`;
    }
    if (listed.length >= maxActivities) {
        warnings.push(
            `Se alcanzó el tope de ${maxActivities} actividades: puede haber esfuerzos mejores sin analizar.`,
        );
    }

    const best: Record<number, BestEffort | null> = {};
    for (const d of durations) best[d] = null;
    let analysed = 0;

    for (const ref of listed) {
        if (requiresMeasuredPower && ref.device_watts !== true) {
            skipped.push({
                activity_id: ref.activity_id,
                reason:
                    ref.device_watts === false
                        ? "Potencia estimada (device_watts=false)."
                        : "No se sabe si la potencia es medida (device_watts desconocido).",
            });
            continue;
        }

        let streams: EffortStreams;
        try {
            streams = await options.providers.loadStreams(ref.activity_id);
        } catch (err) {
            // Una actividad que falle no debe tumbar el barrido entero.
            skipped.push({
                activity_id: ref.activity_id,
                reason: `No se pudieron obtener los streams: ${
                    err instanceof Error ? err.message : String(err)
                }`,
            });
            continue;
        }

        if (requiresMeasuredPower && streams.device_watts !== true) {
            skipped.push({
                activity_id: ref.activity_id,
                reason: "Potencia no medida según los datos de la actividad.",
            });
            continue;
        }
        if (!streams.aligned[signal]) {
            skipped.push({
                activity_id: ref.activity_id,
                reason: `Sin stream de ${signal === "watts" ? "potencia" : "frecuencia cardíaca"}.`,
            });
            continue;
        }

        analysed++;

        // `computePowerCurve` busca la mejor media sostenida sobre `watts`. Para
        // otra señal se le pasa esa señal en el hueco de watts: la matemática de
        // la ventana móvil es la misma y así no se duplica el algoritmo.
        const source =
            signal === "watts"
                ? streams.aligned
                : { ...streams.aligned, watts: streams.aligned[signal] };
        // Todas las duraciones salen de la MISMA pasada por la actividad.
        const curve = computePowerCurve(source, { durations: [...durations] });
        let algunaValida = false;

        for (const d of durations) {
            const entry = curve.entries[d];
            if (!entry || !entry.available || entry.best_power_w === null) continue;
            algunaValida = true;

            const actual = best[d] ?? null;
            if (actual === null || entry.best_power_w > actual.power_w) {
                best[d] = {
                    power_w: entry.best_power_w,
                    activity_id: ref.activity_id,
                    activity_date: streams.start_date ?? ref.start_date,
                    start_time_s: entry.start_time_s ?? 0,
                    end_time_s: entry.end_time_s ?? 0,
                };
            }
        }

        if (!algunaValida) {
            skipped.push({
                activity_id: ref.activity_id,
                reason: `Sin ninguna ventana válida de ${durations.join(" ni ")} s.`,
            });
        }
    }

    const out: Record<number, BestEffortResult> = {};
    for (const d of durations) {
        const b = best[d] ?? null;
        out[d] = {
            available: b !== null,
            duration_s: d,
            best: b,
            window,
            analysed_activities: analysed,
            listed_activities: listed.length,
            skipped,
            method,
            warnings,
            reason:
                b !== null
                    ? null
                    : listed.length === 0
                      ? `No hay actividades en los últimos ${days} días.`
                      : `Ninguna actividad del periodo tiene un esfuerzo válido de ${d} s ` +
                        `en la señal ${signal}.`,
        };
    }
    return out;
}
