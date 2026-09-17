/**
 * Métricas de potencia (sección 7.3 de la especificación).
 *
 * Función pura sobre `AlignedStreams`: sin dependencias de Strava ni de MCP.
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";

/** Ventana de la media móvil para NP, en segundos. */
export const NP_WINDOW_S = 30;

export interface PowerMetricsOptions {
    /** FTP vigente en la fecha de la actividad. Sin él no hay IF ni TSS. */
    ftpW?: number | null;
    /** Peso vigente en la fecha de la actividad. Sin él no hay W/kg. */
    weightKg?: number | null;
}

export interface PowerMetricsResult {
    /** Segundos válidos: base de la media, del trabajo y de la duración del TSS. */
    valid_seconds: number;
    average_power_w: number | null;
    normalized_power_w: number | null;
    variability_index: number | null;
    intensity_factor: number | null;
    tss: number | null;
    work_kj: number | null;
    average_wkg: number | null;
    /** Ventanas de 30 s completas utilizadas para NP. */
    np_windows: number;
    inputs: {
        ftp_w: number | null;
        weight_kg: number | null;
        duration_s: number;
        duration_basis: string;
    };
    method: Record<string, string>;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

/**
 * Calcula las métricas de potencia sobre streams ya alineados.
 *
 * Reglas:
 * - Solo cuentan los segundos con `valid[i] === true`.
 * - La media móvil de 30 s solo se usa si la ventana está COMPLETA y no cruza
 *   ningún segundo no válido: una ventana a caballo de una parada mezclaría
 *   tramos que no son consecutivos en la realidad.
 * - La duración del TSS son los segundos válidos, declarado en `inputs`.
 */
export function computePowerMetrics(
    aligned: AlignedStreams,
    options: PowerMetricsOptions = {},
): PowerMetricsResult {
    const ftp = options.ftpW ?? null;
    const weight = options.weightKg ?? null;

    const watts = aligned.watts;
    const valid = aligned.valid;

    const method: Record<string, string> = {
        np: `Media móvil de ${NP_WINDOW_S} s elevada a la cuarta, promediada y con raíz cuarta. Solo ventanas completas que no cruzan segundos no válidos.`,
        duration: "Segundos válidos de la rejilla de 1 s.",
        work: "Integración de la potencia en los segundos válidos (1 W·s = 1 J), dividida entre 1000.",
        vi: "NP / potencia media.",
        if: "NP / FTP.",
        tss: "duration_s × NP × IF / (FTP × 3600) × 100.",
    };

    // Sin stream de potencia no hay ninguna métrica que calcular.
    if (!watts) {
        const validSeconds = countValid(valid);
        return {
            valid_seconds: validSeconds,
            average_power_w: null,
            normalized_power_w: null,
            variability_index: null,
            intensity_factor: null,
            tss: null,
            work_kj: null,
            average_wkg: null,
            np_windows: 0,
            inputs: {
                ftp_w: ftp,
                weight_kg: weight,
                duration_s: validSeconds,
                duration_basis: "segundos válidos",
            },
            method,
        };
    }

    // --- Media y trabajo: solo segundos válidos ---------------------------
    let sum = 0;
    let n = 0;
    for (let i = 0; i < watts.length; i++) {
        if (!valid[i]) continue;
        sum += watts[i]!;
        n++;
    }

    const averagePower = n > 0 ? sum / n : null;
    // Cada segundo válido aporta 1 s: 1 W durante 1 s = 1 J.
    const workKj = n > 0 ? sum / 1000 : null;

    // --- NP: media móvil de 30 s ------------------------------------------
    const { np, windows } = normalizedPower(watts, valid);

    const vi = np !== null && averagePower ? np / averagePower : null;
    const intensityFactor = np !== null && ftp ? np / ftp : null;
    const tss =
        np !== null && intensityFactor !== null && ftp
            ? (n * np * intensityFactor) / (ftp * 3600) * 100
            : null;
    const averageWkg = averagePower !== null && weight ? averagePower / weight : null;

    return {
        valid_seconds: n,
        average_power_w: averagePower === null ? null : round(averagePower, 2),
        normalized_power_w: np === null ? null : round(np, 2),
        variability_index: vi === null ? null : round(vi, 4),
        intensity_factor: intensityFactor === null ? null : round(intensityFactor, 4),
        tss: tss === null ? null : round(tss, 2),
        work_kj: workKj === null ? null : round(workKj, 2),
        average_wkg: averageWkg === null ? null : round(averageWkg, 3),
        np_windows: windows,
        inputs: {
            ftp_w: ftp,
            weight_kg: weight,
            duration_s: n,
            duration_basis: "segundos válidos",
        },
        method,
    };
}

/**
 * NP estándar: media móvil de 30 s, cuarta potencia, media, raíz cuarta.
 *
 * Solo entran ventanas de 30 segundos consecutivos TODOS válidos. Una ventana
 * que cruzara un hueco largo promediaría instantes separados por minutos.
 */
export function normalizedPower(
    watts: readonly number[],
    valid: readonly boolean[],
): { np: number | null; windows: number } {
    const w = NP_WINDOW_S;
    if (watts.length < w) return { np: null, windows: 0 };

    let sum = 0; // suma móvil de la ventana actual
    let invalid = 0; // segundos no válidos dentro de la ventana
    let quartic = 0; // acumulado de (media)^4
    let windows = 0;

    for (let i = 0; i < watts.length; i++) {
        sum += watts[i]!;
        if (!valid[i]) invalid++;

        if (i >= w) {
            sum -= watts[i - w]!;
            if (!valid[i - w]) invalid--;
        }

        if (i >= w - 1 && invalid === 0) {
            const mean = sum / w;
            quartic += mean ** 4;
            windows++;
        }
    }

    if (windows === 0) return { np: null, windows: 0 };
    return { np: (quartic / windows) ** 0.25, windows };
}

function countValid(valid: readonly boolean[]): number {
    let n = 0;
    for (const v of valid) if (v) n++;
    return n;
}
