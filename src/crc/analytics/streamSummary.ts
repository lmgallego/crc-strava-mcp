/**
 * Resúmenes descriptivos por señal (FC, cadencia, altitud…).
 *
 * Lo pide la sección 7.10 ("HR/cadence summaries") y no existía en `analytics/`:
 * es estadística descriptiva, no una fórmula fisiológica. Todo lo que sea NP,
 * TSS, zonas, torque o desacople vive en su propio módulo y se consume desde
 * ahí, nunca se reimplementa aquí.
 *
 * Función pura sobre `AlignedStreams`.
 */
import type { AlignedStreams, NumericSignal } from "../streams/alignedStreams.js";

export interface SignalSummary {
    available: boolean;
    /** Segundos válidos con valor numérico de esa señal. */
    seconds: number;
    mean: number | null;
    max: number | null;
    min: number | null;
    method: string;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

/**
 * Media, máximo y mínimo de una señal sobre los segundos válidos.
 *
 * `zeroCountsAsData` distingue dos casos que no son iguales:
 * - Cadencia 0 = rueda libre; incluirla en la media hunde el valor y no
 *   describe cómo pedalea el ciclista, así que por defecto se excluye.
 * - Potencia o FC 0 sí son datos legítimos en su contexto.
 * En ambos casos el 0 se cuenta o no de forma explícita, nunca por accidente.
 */
export function summariseSignal(
    aligned: AlignedStreams,
    signal: NumericSignal,
    options: { zeroCountsAsData?: boolean } = {},
): SignalSummary {
    const zeroCounts = options.zeroCountsAsData ?? true;
    const data = aligned[signal];

    const method = zeroCounts
        ? "Media, máximo y mínimo sobre los segundos válidos, incluyendo los ceros."
        : "Media, máximo y mínimo sobre los segundos válidos con valor > 0 (los ceros se excluyen).";

    if (!data) {
        return { available: false, seconds: 0, mean: null, max: null, min: null, method };
    }

    let sum = 0;
    let n = 0;
    let max = Number.NEGATIVE_INFINITY;
    let min = Number.POSITIVE_INFINITY;

    for (let i = 0; i < data.length; i++) {
        if (!aligned.valid[i]) continue;
        const v = data[i]!;
        if (!Number.isFinite(v)) continue;
        if (!zeroCounts && v <= 0) continue;

        sum += v;
        n++;
        if (v > max) max = v;
        if (v < min) min = v;
    }

    if (n === 0) {
        return { available: false, seconds: 0, mean: null, max: null, min: null, method };
    }

    return {
        available: true,
        seconds: n,
        mean: round(sum / n, 2),
        max: round(max, 2),
        min: round(min, 2),
        method,
    };
}

export interface StreamSummaries {
    heartrate: SignalSummary;
    cadence: SignalSummary;
}

/** Resúmenes de FC y cadencia, que son los que pide la sección 7.10. */
export function summariseHrAndCadence(aligned: AlignedStreams): StreamSummaries {
    return {
        heartrate: summariseSignal(aligned, "heartrate"),
        // La cadencia se resume sin los ceros: la rueda libre no describe pedaleo.
        cadence: summariseSignal(aligned, "cadence", { zeroCountsAsData: false }),
    };
}
