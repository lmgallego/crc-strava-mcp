/**
 * Bloque `quality` común a todas las salidas CRC.
 *
 * Función pura sobre `AlignedStreams`: no depende de Strava ni de MCP.
 */
import type { AlignedStreams, Gap } from "./alignedStreams.js";
import { NUMERIC_SIGNALS } from "./alignedStreams.js";

/**
 * Origen de la potencia.
 * - `measured`: medidor real (`device_watts === true` en Strava).
 * - `estimated`: potencia estimada por la plataforma. Con ella NO se calculan
 *   power curve ni VO2max (decisión 4 de la especificación).
 * - `none`: no hay stream de potencia.
 */
export type PowerSource = "measured" | "estimated" | "none";

export interface SignalQuality {
    available: boolean;
    /** % de segundos válidos de la rejilla con valor real o interpolado. */
    coverage_pct: number;
    missing_samples: number;
    filled_seconds: number;
}

export interface StreamQuality {
    valid_seconds: number;
    total_seconds: number;
    /** % de la rejilla marcado como válido. */
    coverage_pct: number;
    gap_count: number;
    gap_seconds: number;
    longest_gap_s: number;
    /** Solo los huecos que NO se rellenaron (los que invalidan ventanas). */
    unfilled_gaps: Gap[];
    power_source: PowerSource;
    power_available: boolean;
    heartrate_available: boolean;
    signals: Record<string, SignalQuality>;
    warnings: string[];
}

export interface QualityOptions {
    /**
     * `device_watts` de la actividad. `true` = medidor real, `false` = estimada.
     * Si no se indica y hay stream de potencia, se marca `estimated` por
     * prudencia y se avisa: asumir `measured` sin evidencia inflaría la
     * confianza en VO2max y power curve.
     */
    deviceWatts?: boolean | null;
    /** Cobertura mínima (%) por debajo de la cual se avisa. Por defecto 80. */
    minCoveragePct?: number;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** Calcula el bloque `quality` a partir de unos streams ya alineados. */
export function computeStreamQuality(
    aligned: AlignedStreams,
    options: QualityOptions = {},
): StreamQuality {
    const minCoverage = options.minCoveragePct ?? 80;
    const total = aligned.meta.grid_seconds;
    const validSeconds = aligned.meta.valid_seconds;
    const coverage = total > 0 ? round1((validSeconds / total) * 100) : 0;

    const warnings: string[] = [...aligned.meta.warnings];

    const unfilled = aligned.meta.gaps.filter((g) => !g.filled);
    const gapSeconds = aligned.meta.gaps.reduce((s, g) => s + g.duration_s, 0);
    const longestGap = aligned.meta.gaps.reduce((m, g) => Math.max(m, g.duration_s), 0);

    const signals: Record<string, SignalQuality> = {};
    for (const name of [...NUMERIC_SIGNALS, "moving"]) {
        const meta = aligned.meta.signals[name];
        const available = meta?.present ?? false;
        signals[name] = {
            available,
            // Cobertura de la señal: segundos con valor real sobre la rejilla.
            coverage_pct: available && total > 0 ? round1(((total - (meta?.filled_seconds ?? 0)) / total) * 100) : 0,
            missing_samples: meta?.missing_samples ?? 0,
            filled_seconds: meta?.filled_seconds ?? 0,
        };
    }

    const powerAvailable = signals["watts"]?.available ?? false;
    const powerSource = resolvePowerSource(powerAvailable, options.deviceWatts);

    if (powerAvailable && options.deviceWatts == null) {
        warnings.push(
            "No se conoce device_watts: la potencia se trata como estimada. " +
                "Power curve y VO2max no deben calcularse sin confirmar que es medida.",
        );
    }
    if (powerSource === "estimated") {
        warnings.push(
            "Potencia estimada por la plataforma: no se calculan power curve ni VO2max.",
        );
    }
    if (coverage < minCoverage) {
        warnings.push(
            `Cobertura de ${coverage} % por debajo del mínimo de ${minCoverage} %: resultados poco fiables.`,
        );
    }

    return {
        valid_seconds: validSeconds,
        total_seconds: total,
        coverage_pct: coverage,
        gap_count: aligned.meta.gaps.length,
        gap_seconds: gapSeconds,
        longest_gap_s: longestGap,
        unfilled_gaps: unfilled,
        power_source: powerSource,
        power_available: powerAvailable,
        heartrate_available: signals["heartrate"]?.available ?? false,
        signals,
        warnings,
    };
}

function resolvePowerSource(available: boolean, deviceWatts?: boolean | null): PowerSource {
    if (!available) return "none";
    return deviceWatts === true ? "measured" : "estimated";
}
