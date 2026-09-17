/**
 * Trabajo por encima del FTP (sección 7.8 de la especificación).
 *
 * Función pura sobre `AlignedStreams`. Requiere FTP vigente para la fecha.
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";

/** Rangos por defecto, en fracción de FTP. El último queda abierto. */
export const DEFAULT_RANGES_PCT_FTP: { name: string; lower: number; upper: number | null }[] = [
    { name: "100-120 %", lower: 1.0, upper: 1.2 },
    { name: "120-150 %", lower: 1.2, upper: 1.5 },
    { name: ">150 %", lower: 1.5, upper: null },
];

/**
 * Segundos de corte que se toleran dentro de un mismo esfuerzo.
 *
 * Sin esto, un pedaleo real que baje un segundo por debajo del umbral partiría
 * un intervalo de 5 min en dos esfuerzos, inflando `effort_count` y hundiendo
 * `mean_effort_duration_s`.
 */
export const DEFAULT_GAP_TOLERANCE_S = 2;

export interface WorkAboveFtpOptions {
    ftpW: number;
    ranges?: { name: string; lower: number; upper: number | null }[];
    /** Microcortes de hasta N s no rompen el esfuerzo. Por defecto 2. */
    gapToleranceS?: number;
}

export interface WorkRangeResult {
    name: string;
    lower_pct_ftp: number;
    upper_pct_ftp: number | null;
    lower_w: number;
    upper_w: number | null;
    seconds: number;
    percent_valid_time: number;
    /** Trabajo total realizado en esos segundos. */
    work_kj: number;
    /** Solo el excedente sobre el FTP: Σ(P − FTP)/1000. */
    work_above_ftp_kj: number;
    effort_count: number;
    mean_effort_duration_s: number | null;
    max_effort_duration_s: number | null;
}

export interface WorkAboveFtpResult {
    available: boolean;
    ftp_w: number;
    ranges: WorkRangeResult[];
    valid_seconds: number;
    gap_tolerance_s: number;
    method: Record<string, string>;
    reason: string | null;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

export function computeWorkAboveFtp(
    aligned: AlignedStreams,
    options: WorkAboveFtpOptions,
): WorkAboveFtpResult {
    const ftp = options.ftpW;
    const ranges = options.ranges ?? DEFAULT_RANGES_PCT_FTP;
    const gapTolerance = options.gapToleranceS ?? DEFAULT_GAP_TOLERANCE_S;

    const method: Record<string, string> = {
        boundaries:
            "Rangos semiabiertos [lower, upper) en fracción de FTP; el último no tiene tope.",
        work_kj: "Trabajo total en los segundos del rango: Σ P / 1000.",
        work_above_ftp_kj: "Solo el excedente sobre el umbral: Σ (P − FTP) / 1000.",
        efforts:
            `Un esfuerzo es un tramo de segundos dentro del rango. Un corte de hasta ` +
            `${gapTolerance} s no lo parte; a partir de ahí empieza un esfuerzo nuevo.`,
        effort_duration:
            "La duración del esfuerzo cuenta solo sus segundos dentro del rango, no los del microcorte.",
        basis: "Solo se consideran segundos con valid[i] === true.",
    };

    const validSeconds = aligned.valid.reduce((s, v) => s + (v ? 1 : 0), 0);

    if (!Number.isFinite(ftp) || ftp <= 0) {
        throw new Error(`ftpW debe ser > 0 (recibido: ${ftp}).`);
    }

    const watts = aligned.watts;
    if (!watts) {
        return {
            available: false,
            ftp_w: ftp,
            ranges: [],
            valid_seconds: validSeconds,
            gap_tolerance_s: gapTolerance,
            method,
            reason: "La actividad no tiene stream de potencia.",
        };
    }

    const results: WorkRangeResult[] = ranges.map((r) => {
        const lowerW = r.lower * ftp;
        const upperW = r.upper === null ? null : r.upper * ftp;

        let seconds = 0;
        let work = 0;
        let above = 0;

        // Seguimiento de esfuerzos con tolerancia a microcortes.
        const efforts: number[] = [];
        let current = 0; // segundos dentro del rango del esfuerzo en curso
        let gap = 0; // segundos consecutivos fuera del rango

        const closeEffort = (): void => {
            if (current > 0) efforts.push(current);
            current = 0;
        };

        for (let i = 0; i < aligned.time.length; i++) {
            if (!aligned.valid[i]) {
                // Un tramo no válido rompe el esfuerzo: no sabemos qué pasó ahí.
                closeEffort();
                gap = 0;
                continue;
            }

            const p = watts[i]!;
            const inRange =
                Number.isFinite(p) && p >= lowerW && (upperW === null || p < upperW);

            if (inRange) {
                seconds++;
                work += p;
                above += p - ftp;
                current++;
                gap = 0;
            } else if (current > 0) {
                gap++;
                if (gap > gapTolerance) {
                    closeEffort();
                    gap = 0;
                }
            }
        }
        closeEffort();

        const count = efforts.length;
        const total = efforts.reduce((s, d) => s + d, 0);

        return {
            name: r.name,
            lower_pct_ftp: r.lower,
            upper_pct_ftp: r.upper,
            lower_w: round(lowerW, 2),
            upper_w: upperW === null ? null : round(upperW, 2),
            seconds,
            percent_valid_time: validSeconds > 0 ? round((seconds / validSeconds) * 100, 2) : 0,
            work_kj: round(work / 1000, 3),
            work_above_ftp_kj: round(above / 1000, 3),
            effort_count: count,
            mean_effort_duration_s: count > 0 ? round(total / count, 2) : null,
            max_effort_duration_s: count > 0 ? Math.max(...efforts) : null,
        };
    });

    return {
        available: true,
        ftp_w: ftp,
        ranges: results,
        valid_seconds: validSeconds,
        gap_tolerance_s: gapTolerance,
        method,
        reason: null,
    };
}
