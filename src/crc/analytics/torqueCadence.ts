/**
 * Torque y cadencia (sección 7.7 de la especificación).
 *
 * Función pura sobre `AlignedStreams`.
 *
 * torque [N·m] = Potencia [W] / (2π × cadencia [rpm] / 60)
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";

/** Anchura por defecto de los bins de cadencia, en rpm. */
export const DEFAULT_BIN_WIDTH_RPM = 10;

export interface TorqueCadenceOptions {
    /** Anchura de los bins en rpm. Por defecto 10. */
    binWidthRpm?: number;
    /** Cadencia máxima a considerar. Por encima se agrupa en el último bin. */
    maxCadenceRpm?: number;
}

export interface CadenceBin {
    /** Límite inferior incluido, en rpm. */
    lower_rpm: number;
    /** Límite superior EXCLUIDO, en rpm. `null` = sin tope. */
    upper_rpm: number | null;
    seconds: number;
    percent_valid_time: number;
    mean_power_w: number | null;
    mean_torque_nm: number | null;
    max_torque_nm: number | null;
    work_kj: number;
}

export interface TorqueCadenceResult {
    available: boolean;
    bins: CadenceBin[];
    /** Segundos con cadencia > 0 y potencia válida: base de los porcentajes. */
    analysed_seconds: number;
    /** Segundos válidos descartados por cadencia <= 0 o potencia no válida. */
    excluded_seconds: number;
    valid_seconds: number;
    mean_torque_nm: number | null;
    max_torque_nm: number | null;
    method: Record<string, string>;
    reason: string | null;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

/** Torque a partir de potencia y cadencia. Exige cadencia > 0. */
export function torqueNm(powerW: number, cadenceRpm: number): number {
    return powerW / ((2 * Math.PI * cadenceRpm) / 60);
}

export function computeTorqueCadence(
    aligned: AlignedStreams,
    options: TorqueCadenceOptions = {},
): TorqueCadenceResult {
    const binWidth = options.binWidthRpm ?? DEFAULT_BIN_WIDTH_RPM;
    const maxCadence = options.maxCadenceRpm ?? 150;

    const method: Record<string, string> = {
        formula: "torque [N·m] = P [W] / (2π × cadencia [rpm] / 60).",
        exclusions:
            "Se descartan los segundos con cadencia <= 0 (no hay torque definido: la rueda libre " +
            "no transmite par) y los que no tienen potencia válida.",
        bins: `Bins semiabiertos [lower, upper) de ${binWidth} rpm. El último recoge todo lo que supere ${maxCadence} rpm.`,
        basis: "Solo se consideran segundos con valid[i] === true.",
    };

    const validSeconds = aligned.valid.reduce((s, v) => s + (v ? 1 : 0), 0);

    const fail = (reason: string): TorqueCadenceResult => ({
        available: false,
        bins: [],
        analysed_seconds: 0,
        excluded_seconds: 0,
        valid_seconds: validSeconds,
        mean_torque_nm: null,
        max_torque_nm: null,
        method,
        reason,
    });

    const watts = aligned.watts;
    const cadence = aligned.cadence;
    if (!watts) return fail("La actividad no tiene stream de potencia.");
    if (!cadence) return fail("La actividad no tiene stream de cadencia.");
    if (!Number.isFinite(binWidth) || binWidth <= 0) {
        throw new Error(`binWidthRpm debe ser > 0 (recibido: ${binWidth}).`);
    }

    const binCount = Math.ceil(maxCadence / binWidth);
    const seconds = new Array(binCount).fill(0) as number[];
    const powerSum = new Array(binCount).fill(0) as number[];
    const torqueSum = new Array(binCount).fill(0) as number[];
    const torqueMax = new Array(binCount).fill(Number.NEGATIVE_INFINITY) as number[];

    let analysed = 0;
    let excluded = 0;
    let globalTorqueSum = 0;
    let globalTorqueMax = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < aligned.time.length; i++) {
        if (!aligned.valid[i]) continue;

        const p = watts[i]!;
        const c = cadence[i]!;
        // Cadencia 0 es rueda libre: no hay par, no un par de valor cero.
        if (!Number.isFinite(p) || !Number.isFinite(c) || c <= 0) {
            excluded++;
            continue;
        }

        const t = torqueNm(p, c);
        const idx = Math.min(Math.floor(c / binWidth), binCount - 1);

        seconds[idx]!++;
        powerSum[idx]! += p;
        torqueSum[idx]! += t;
        if (t > torqueMax[idx]!) torqueMax[idx] = t;

        analysed++;
        globalTorqueSum += t;
        if (t > globalTorqueMax) globalTorqueMax = t;
    }

    const bins: CadenceBin[] = [];
    for (let i = 0; i < binCount; i++) {
        const isLast = i === binCount - 1;
        const s = seconds[i]!;
        bins.push({
            lower_rpm: i * binWidth,
            upper_rpm: isLast ? null : (i + 1) * binWidth,
            seconds: s,
            percent_valid_time: analysed > 0 ? round((s / analysed) * 100, 2) : 0,
            mean_power_w: s > 0 ? round(powerSum[i]! / s, 2) : null,
            mean_torque_nm: s > 0 ? round(torqueSum[i]! / s, 3) : null,
            max_torque_nm: s > 0 ? round(torqueMax[i]!, 3) : null,
            work_kj: round(powerSum[i]! / 1000, 3),
        });
    }

    return {
        available: analysed > 0,
        bins,
        analysed_seconds: analysed,
        excluded_seconds: excluded,
        valid_seconds: validSeconds,
        mean_torque_nm: analysed > 0 ? round(globalTorqueSum / analysed, 3) : null,
        max_torque_nm: analysed > 0 ? round(globalTorqueMax, 3) : null,
        method,
        reason: analysed > 0 ? null : "No hay ningún segundo con cadencia > 0 y potencia válida.",
    };
}
