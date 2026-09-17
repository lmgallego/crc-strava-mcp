/**
 * Desacople aeróbico (sección 7.5 de la especificación).
 *
 * Función pura sobre `AlignedStreams`.
 *
 * Este módulo NO interpreta el resultado: devuelve el número y los filtros
 * aplicados. Llamar "fatiga" o "adaptación" a un porcentaje es una lectura
 * clínica que depende del contexto del entrenamiento, y no le corresponde.
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";

export interface DecouplingOptions {
    /** FTP vigente. Necesario solo para los filtros relativos de potencia. */
    ftpW?: number | null;
    /** Minutos iniciales que se descartan (calentamiento). Por defecto 0. */
    warmupExclusionMin?: number;
    /** Si `true`, solo cuentan los segundos con `moving === true`. */
    movingOnly?: boolean;
    /** Descarta potencia por debajo de este % del FTP (0.56 = 56 %). */
    powerMinPctFtp?: number;
    /** Descarta potencia por encima de este % del FTP. */
    powerMaxPctFtp?: number;
    /** Duración mínima de muestra filtrada para que el cálculo valga. */
    minValidDuration?: number;
    /**
     * Desfase de la FC respecto a la potencia, en segundos.
     * Queda en el contrato pero v0.1 NO lo aplica: aplicarlo cambiaría el
     * resultado y exige validarlo antes contra datos reales.
     */
    hrLagS?: number;
}

export const DEFAULT_MIN_VALID_DURATION_S = 600;

export interface DecouplingResult {
    available: boolean;
    first_half_ef: number | null;
    second_half_ef: number | null;
    decoupling_pct: number | null;
    valid_seconds: number;
    first_half_seconds: number;
    second_half_seconds: number;
    first_half_mean_power_w: number | null;
    first_half_mean_hr_bpm: number | null;
    second_half_mean_power_w: number | null;
    second_half_mean_hr_bpm: number | null;
    excluded_seconds: number;
    filters_applied: Record<string, unknown>;
    method: Record<string, string>;
    /** Motivo de `available: false`. */
    reason: string | null;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

/**
 * Compara la eficiencia potencia/FC entre las dos mitades de la muestra.
 *
 * Las mitades se parten por TIEMPO VÁLIDO de la muestra ya filtrada, no por
 * índice de la rejilla: con un hueco asimétrico, el punto medio de la rejilla
 * cae en un sitio distinto que el punto medio del tiempo realmente pedaleado,
 * y el desacople resultante sería otro.
 */
export function computeDecoupling(
    aligned: AlignedStreams,
    options: DecouplingOptions = {},
): DecouplingResult {
    const ftp = options.ftpW ?? null;
    const warmupMin = options.warmupExclusionMin ?? 0;
    const movingOnly = options.movingOnly ?? false;
    const minDuration = options.minValidDuration ?? DEFAULT_MIN_VALID_DURATION_S;
    const hrLag = options.hrLagS ?? 0;

    const method: Record<string, string> = {
        ef: "EF = media(potencia) / media(FC) de cada mitad.",
        halves:
            "Mitades por tiempo válido de la muestra filtrada (cada segundo válido cuenta 1), " +
            "no por índice de la rejilla.",
        decoupling: "(EF_primera - EF_segunda) / EF_primera × 100.",
        filter_order: "Los filtros se aplican ANTES de partir en mitades.",
        hr_lag: "hr_lag_s está en el contrato pero v0.1 no lo aplica.",
        interpretation:
            "Sin interpretación: el módulo devuelve el valor, no lo etiqueta como fatiga ni adaptación.",
    };

    const powerMin = options.powerMinPctFtp != null && ftp ? options.powerMinPctFtp * ftp : null;
    const powerMax = options.powerMaxPctFtp != null && ftp ? options.powerMaxPctFtp * ftp : null;

    const filters: Record<string, unknown> = {
        warmup_exclusion_min: warmupMin,
        moving_only: movingOnly,
        power_min_pct_ftp: options.powerMinPctFtp ?? null,
        power_max_pct_ftp: options.powerMaxPctFtp ?? null,
        power_min_w: powerMin,
        power_max_w: powerMax,
        min_valid_duration: minDuration,
        hr_lag_s: hrLag,
        hr_lag_applied: false,
    };

    const empty = (reason: string): DecouplingResult => ({
        available: false,
        first_half_ef: null,
        second_half_ef: null,
        decoupling_pct: null,
        valid_seconds: 0,
        first_half_seconds: 0,
        second_half_seconds: 0,
        first_half_mean_power_w: null,
        first_half_mean_hr_bpm: null,
        second_half_mean_power_w: null,
        second_half_mean_hr_bpm: null,
        excluded_seconds: 0,
        filters_applied: filters,
        method,
        reason,
    });

    const watts = aligned.watts;
    const hr = aligned.heartrate;
    if (!watts) return empty("La actividad no tiene stream de potencia.");
    if (!hr) return empty("La actividad no tiene stream de frecuencia cardíaca.");

    if ((options.powerMinPctFtp != null || options.powerMaxPctFtp != null) && !ftp) {
        return empty("Se han pedido filtros de potencia relativos al FTP, pero no hay FTP vigente.");
    }

    // --- Filtrado ---------------------------------------------------------
    const warmupSeconds = Math.round(warmupMin * 60);
    const powers: number[] = [];
    const hrs: number[] = [];
    let considered = 0;

    for (let i = 0; i < aligned.time.length; i++) {
        if (!aligned.valid[i]) continue;
        considered++;

        const t = aligned.time[i]!;
        if (t < warmupSeconds) continue;
        if (movingOnly && aligned.moving && !aligned.moving[i]) continue;

        const p = watts[i]!;
        const h = hr[i]!;
        // La FC de 0 no es un dato utilizable: dividir por ella da Infinity.
        if (!Number.isFinite(p) || !Number.isFinite(h) || h <= 0) continue;
        if (powerMin !== null && p < powerMin) continue;
        if (powerMax !== null && p > powerMax) continue;

        powers.push(p);
        hrs.push(h);
    }

    const n = powers.length;
    const excluded = considered - n;

    if (n < 2) return empty("No quedan suficientes muestras tras aplicar los filtros.");
    if (n < minDuration) {
        return {
            ...empty(
                `La muestra filtrada dura ${n} s, por debajo del mínimo de ${minDuration} s.`,
            ),
            valid_seconds: n,
            excluded_seconds: excluded,
        };
    }

    // --- Mitades por tiempo válido ----------------------------------------
    const half = Math.floor(n / 2);
    const mean = (a: number[], from: number, to: number): number => {
        let s = 0;
        for (let i = from; i < to; i++) s += a[i]!;
        return s / (to - from);
    };

    const p1 = mean(powers, 0, half);
    const h1 = mean(hrs, 0, half);
    const p2 = mean(powers, half, n);
    const h2 = mean(hrs, half, n);

    const ef1 = p1 / h1;
    const ef2 = p2 / h2;
    const decoupling = ef1 === 0 ? null : ((ef1 - ef2) / ef1) * 100;

    return {
        available: true,
        first_half_ef: round(ef1, 6),
        second_half_ef: round(ef2, 6),
        decoupling_pct: decoupling === null ? null : round(decoupling, 4),
        valid_seconds: n,
        first_half_seconds: half,
        second_half_seconds: n - half,
        first_half_mean_power_w: round(p1, 4),
        first_half_mean_hr_bpm: round(h1, 4),
        second_half_mean_power_w: round(p2, 4),
        second_half_mean_hr_bpm: round(h2, 4),
        excluded_seconds: excluded,
        filters_applied: filters,
        method,
        reason: null,
    };
}
