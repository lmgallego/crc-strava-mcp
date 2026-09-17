/**
 * Curva de potencia (sección 7.4 de la especificación).
 *
 * Función pura sobre `AlignedStreams`: sin dependencias de Strava ni de MCP.
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";

/** Duraciones por defecto: 1, 5, 10, 15, 30 s y 1, 2, 3, 5, 8, 10, 12, 20, 30, 40, 60, 90 min. */
export const DEFAULT_DURATIONS_S: readonly number[] = [
    1, 5, 10, 15, 30, 60, 120, 180, 300, 480, 600, 720, 1200, 1800, 2400, 3600, 5400,
];

export interface PowerCurveOptions {
    durations?: readonly number[];
    /** Peso vigente en la fecha de la actividad. Sin él no hay W/kg. */
    weightKg?: number | null;
}

export interface PowerCurveEntry {
    duration_s: number;
    best_power_w: number | null;
    best_power_wkg: number | null;
    /** Inicio de la mejor ventana, en el tiempo original de la actividad. */
    start_time_s: number | null;
    /** Fin de la mejor ventana (incluido), en tiempo original. */
    end_time_s: number | null;
    /** `false` si la actividad no da para una ventana completa de esa duración. */
    available: boolean;
}

export interface PowerCurveResult {
    entries: Record<number, PowerCurveEntry>;
    durations: number[];
    method: Record<string, string>;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

/**
 * Mejor media sostenida para cada duración.
 *
 * Es la mejor MEDIA de la ventana, no el pico de la serie: un esfuerzo de 3 min
 * a 340 W no produce un mejor 5 min de 340 W, porque la ventana de 300 s
 * arrastra obligatoriamente recuperación.
 *
 * Las ventanas deben estar completas y no cruzar segundos no válidos. Como
 * `AlignedStreams` ya está en una rejilla de 1 s, una ventana de N segundos son
 * N posiciones consecutivas: no se asume nada sobre la frecuencia del stream
 * original, que puede ser irregular.
 */
export function computePowerCurve(
    aligned: AlignedStreams,
    options: PowerCurveOptions = {},
): PowerCurveResult {
    const durations = [...(options.durations ?? DEFAULT_DURATIONS_S)].sort((a, b) => a - b);
    const weight = options.weightKg ?? null;
    const offset = aligned.meta.start_offset_s;

    const method: Record<string, string> = {
        algorithm:
            "Media móvil sobre la rejilla de 1 s. Se toma la mejor media sostenida " +
            "(no el pico instantáneo). Solo ventanas completas que no cruzan segundos no válidos.",
        time_base:
            "start_time_s y end_time_s se expresan en el tiempo original de la actividad.",
    };

    const entries: Record<number, PowerCurveEntry> = {};
    const watts = aligned.watts;

    for (const d of durations) {
        if (!watts || d <= 0) {
            entries[d] = empty(d);
            continue;
        }
        entries[d] = bestMean(watts, aligned.valid, d, weight, offset);
    }

    return { entries, durations, method };
}

function empty(duration: number): PowerCurveEntry {
    return {
        duration_s: duration,
        best_power_w: null,
        best_power_wkg: null,
        start_time_s: null,
        end_time_s: null,
        available: false,
    };
}

/** Mejor media de `duration` segundos consecutivos, todos válidos. */
function bestMean(
    watts: readonly number[],
    valid: readonly boolean[],
    duration: number,
    weight: number | null,
    offset: number,
): PowerCurveEntry {
    const n = watts.length;
    if (duration > n) return empty(duration);

    let sum = 0;
    let invalid = 0;
    let best: number | null = null;
    let bestStart = -1;

    for (let i = 0; i < n; i++) {
        sum += watts[i]!;
        if (!valid[i]) invalid++;

        if (i >= duration) {
            sum -= watts[i - duration]!;
            if (!valid[i - duration]) invalid--;
        }

        if (i >= duration - 1 && invalid === 0) {
            const mean = sum / duration;
            if (best === null || mean > best) {
                best = mean;
                bestStart = i - duration + 1;
            }
        }
    }

    if (best === null) return empty(duration);

    return {
        duration_s: duration,
        best_power_w: round(best, 2),
        best_power_wkg: weight ? round(best / weight, 3) : null,
        start_time_s: bestStart + offset,
        end_time_s: bestStart + duration - 1 + offset,
        available: true,
    };
}
