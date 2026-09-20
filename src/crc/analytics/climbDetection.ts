/**
 * Detección de subidas (primera herramienta de la v0.2).
 *
 * Función pura sobre `AlignedStreams`: sin dependencias de Strava ni de MCP.
 *
 * No interpreta: devuelve los tramos detectados y sus métricas. La
 * categorización es una escala propia y se declara como tal.
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";
import { sliceAlignedStreams } from "../streams/alignedStreams.js";
import { computePowerMetrics } from "./powerMetrics.js";

// --- Umbrales por defecto -------------------------------------------------
// Son convención de este proyecto, no un estándar. El razonamiento de cada uno
// está en D39 de docs/decisiones.md.

/** Desnivel positivo mínimo acumulado para considerar que hay subida. */
export const DEFAULT_MIN_ELEVATION_GAIN_M = 30;
/** Pendiente media mínima del conjunto. */
export const DEFAULT_MIN_AVG_GRADE_PCT = 3;
/** Longitud mínima de la subida. */
export const DEFAULT_MIN_LENGTH_M = 500;
/** Tramo llano o en bajada tolerado dentro de una subida, en metros seguidos. */
export const DEFAULT_MAX_FLAT_RUN_M = 200;
/** Ventana de la media móvil que suaviza la altitud, en segundos. */
export const DEFAULT_SMOOTHING_WINDOW_S = 15;
/**
 * Banda muerta del barómetro: variaciones de altitud menores se consideran
 * ruido y no acumulan desnivel.
 */
export const DEFAULT_ELEVATION_NOISE_M = 1;
/** Distancia sobre la que se mide la pendiente máxima SOSTENIDA. */
export const DEFAULT_SUSTAINED_GRADE_DISTANCE_M = 200;
/** Distancia de la ventana con que se estima la pendiente local. */
export const DEFAULT_GRADE_WINDOW_M = 50;

export interface ClimbDetectionOptions {
    /**
     * `true` solo si la potencia es medida (`device_watts === true`).
     * Sin esto no se calcula el índice de eficiencia: con potencia estimada
     * el cociente heredaría el error del modelo de Strava.
     */
    powerIsMeasured?: boolean;
    minElevationGainM?: number;
    minAvgGradePct?: number;
    minLengthM?: number;
    maxFlatRunM?: number;
    smoothingWindowS?: number;
    elevationNoiseM?: number;
    sustainedGradeDistanceM?: number;
    gradeWindowM?: number;
    /** Para las métricas de potencia de cada subida. */
    ftpW?: number | null;
    weightKg?: number | null;
}

/** Escala propia de dificultad. NO es la categorización de ninguna federación. */
export type ClimbTier = "corta" | "suave" | "media" | "dura" | "muy dura";

export interface Climb {
    /** Inicio y fin en el tiempo original de la actividad. */
    start_time_s: number;
    end_time_s: number;
    duration_s: number;
    distance_m: number;
    elevation_gain_m: number;
    avg_grade_pct: number;
    /** Mejor pendiente media sostenida, NO el pico instantáneo. */
    max_sustained_grade_pct: number | null;
    /** Metros de ascenso por hora. */
    vam_m_per_h: number;
    /** Escala propia: producto distancia(km) × pendiente media(%). */
    difficulty_score: number;
    difficulty_tier: ClimbTier;
    difficulty_scale: string;
    average_power_w: number | null;
    normalized_power_w: number | null;
    average_wkg: number | null;
    /** VAM / (W/kg). Solo con potencia medida y peso vigente. */
    efficiency_index: number | null;
}

export interface ClimbDetectionResult {
    available: boolean;
    climbs: Climb[];
    climb_count: number;
    total_elevation_gain_m: number;
    thresholds: Record<string, number>;
    method: Record<string, string>;
    warnings: string[];
    /** Motivo de `available: false`. */
    reason: string | null;
    /** Código de error cuando falta elevación. */
    code: "MISSING_ELEVATION" | null;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

const roundOrNull = (v: number | null, d: number): number | null =>
    v === null ? null : round(v, d);

/**
 * Media móvil centrada con ventana simétrica truncada en los bordes.
 *
 * La simetría importa: sobre una rampa constante devuelve la propia rampa sin
 * deformarla, así que suavizar no cambia la pendiente de una subida real.
 * Solo aplana el ruido, que es lo que se busca.
 */
export function smoothAltitude(
    altitude: readonly number[],
    valid: readonly boolean[],
    windowS: number,
): number[] {
    const n = altitude.length;
    const half = Math.floor(windowS / 2);
    const out = new Array<number>(n);

    for (let i = 0; i < n; i++) {
        // Ventana simétrica: se recorta por igual a ambos lados en los bordes.
        const r = Math.min(half, i, n - 1 - i);
        let sum = 0;
        let count = 0;
        for (let j = i - r; j <= i + r; j++) {
            if (!valid[j]) continue;
            const v = altitude[j]!;
            if (!Number.isFinite(v)) continue;
            sum += v;
            count++;
        }
        out[i] = count > 0 ? sum / count : (altitude[i] ?? 0);
    }
    return out;
}

/**
 * Desnivel positivo acumulado con banda muerta (histéresis).
 *
 * Sumar toda diferencia positiva sobre una señal con ruido inventa desnivel:
 * un llano con ±1 m de ruido barométrico puede "ganar" cientos de metros en una
 * hora. Solo se acumula cuando la altitud supera el último mínimo de referencia
 * en más de `noiseM`.
 */
export function elevationGainWithDeadband(
    altitude: readonly number[],
    from: number,
    to: number,
    noiseM: number,
): number {
    let gain = 0;
    let reference = altitude[from] ?? 0;
    let peak = reference;

    for (let i = from + 1; i <= to; i++) {
        const a = altitude[i]!;
        if (a > peak) peak = a;
        if (a < reference) {
            // Nuevo mínimo: se reinicia la referencia de subida.
            reference = a;
            peak = a;
            continue;
        }
        if (peak - reference > noiseM) {
            gain += peak - reference;
            reference = peak;
        }
    }
    return gain;
}

export function detectClimbs(
    aligned: AlignedStreams,
    options: ClimbDetectionOptions = {},
): ClimbDetectionResult {
    const minGain = options.minElevationGainM ?? DEFAULT_MIN_ELEVATION_GAIN_M;
    const minGrade = options.minAvgGradePct ?? DEFAULT_MIN_AVG_GRADE_PCT;
    const minLength = options.minLengthM ?? DEFAULT_MIN_LENGTH_M;
    const maxFlatRun = options.maxFlatRunM ?? DEFAULT_MAX_FLAT_RUN_M;
    const smoothing = options.smoothingWindowS ?? DEFAULT_SMOOTHING_WINDOW_S;
    const noise = options.elevationNoiseM ?? DEFAULT_ELEVATION_NOISE_M;
    const sustainedDist = options.sustainedGradeDistanceM ?? DEFAULT_SUSTAINED_GRADE_DISTANCE_M;
    const gradeWindow = options.gradeWindowM ?? DEFAULT_GRADE_WINDOW_M;

    const thresholds = {
        min_elevation_gain_m: minGain,
        min_avg_grade_pct: minGrade,
        min_length_m: minLength,
        max_flat_run_m: maxFlatRun,
        smoothing_window_s: smoothing,
        elevation_noise_m: noise,
        sustained_grade_distance_m: sustainedDist,
        grade_window_m: gradeWindow,
    };

    const method: Record<string, string> = {
        smoothing:
            `Altitud suavizada con media móvil centrada de ${smoothing} s y ventana simétrica ` +
            "truncada en los bordes (no deforma una rampa constante).",
        elevation_gain:
            `Desnivel positivo acumulado con banda muerta de ${noise} m: las variaciones menores ` +
            "se consideran ruido barométrico y no suman.",
        grade: `Pendiente local estimada sobre ventanas de ${gradeWindow} m de distancia recorrida.`,
        edge_trim:
            "Los extremos del tramo se recortan hasta el primer y el último segundo en que la " +
            "altitud suavizada sube, para no arrastrar el llano que introduce la ventana de pendiente.",
        segmentation:
            `Una subida empieza cuando la pendiente local alcanza ${minGrade} % y termina cuando ` +
            `acumula más de ${maxFlatRun} m seguidos por debajo de ese umbral, o cuando aparece un ` +
            "tramo no válido.",
        acceptance:
            `Se conservan los tramos con al menos ${minGain} m de desnivel, ${minLength} m de ` +
            `longitud y ${minGrade} % de pendiente media.`,
        max_sustained_grade: `Mejor pendiente media sostenida en ${sustainedDist} m, no el pico instantáneo.`,
        difficulty:
            "Índice propio: pendiente_media_%² × distancia_km. La pendiente va al cuadrado " +
            "porque determina la dureza más que la distancia. NO es una categorización oficial.",
        efficiency_index:
            "EI = VAM / (W/kg). Compara subidas del MISMO ciclista entre sí; no sirve para " +
            "comparar ciclistas, porque depende de posición, bici, viento y pendiente.",
        invalid_segments: "Un tramo no válido rompe la subida: no se sabe qué ocurrió en él.",
        power: "Las métricas de potencia se calculan con powerMetrics sobre el tramo recortado.",
        interpretation: "Sin interpretación: se devuelven los tramos y sus métricas.",
    };

    const warnings: string[] = [...aligned.meta.warnings];

    const altitude = aligned.altitude;
    const distance = aligned.distance;

    if (!altitude || !distance) {
        return {
            available: false,
            climbs: [],
            climb_count: 0,
            total_elevation_gain_m: 0,
            thresholds,
            method,
            warnings,
            reason: !altitude
                ? "La actividad no tiene stream de altitud."
                : "La actividad no tiene stream de distancia.",
            code: "MISSING_ELEVATION",
        };
    }

    const n = aligned.time.length;
    const smooth = smoothAltitude(altitude, aligned.valid, smoothing);

    // --- Segmentación -----------------------------------------------------
    const candidates: { from: number; to: number }[] = [];
    let start = -1;
    let lastRising = -1;
    let flatRunM = 0;

    const closeCandidate = (): void => {
        if (start >= 0 && lastRising > start) {
            // Recorte de bordes: la pendiente local se mide sobre una ventana
            // hacia atrás, así que el tramo detectado se extiende media ventana
            // más allá del final real de la rampa. Sin recortar, una subida
            // arrastra unos metros de llano que falsean distancia, pendiente
            // media y potencia.
            let a = start;
            let b = lastRising;
            while (a < b && smooth[a + 1]! <= smooth[a]!) a++;
            while (b > a && smooth[b]! <= smooth[b - 1]!) b--;
            if (b > a) candidates.push({ from: a, to: b });
        }
        start = -1;
        lastRising = -1;
        flatRunM = 0;
    };

    for (let i = 1; i < n; i++) {
        if (!aligned.valid[i] || !aligned.valid[i - 1]) {
            // Igual que en los esfuerzos (D23): un hueco rompe el tramo.
            closeCandidate();
            continue;
        }

        const grade = localGrade(smooth, distance, i, gradeWindow);
        const stepM = (distance[i]! - distance[i - 1]!) || 0;

        if (grade >= minGrade) {
            if (start < 0) start = i - 1;
            lastRising = i;
            flatRunM = 0;
        } else if (start >= 0) {
            flatRunM += Math.max(stepM, 0);
            if (flatRunM > maxFlatRun) closeCandidate();
        }
    }
    closeCandidate();

    // --- Filtrado y métricas ---------------------------------------------
    const climbs: Climb[] = [];

    for (const c of candidates) {
        const distM = (distance[c.to] ?? 0) - (distance[c.from] ?? 0);
        const gain = elevationGainWithDeadband(smooth, c.from, c.to, noise);
        const avgGrade = distM > 0 ? (gain / distM) * 100 : 0;

        if (distM < minLength) continue;
        if (gain < minGain) continue;
        if (avgGrade < minGrade) continue;

        const durationS = c.to - c.from;
        const vam = durationS > 0 ? gain / (durationS / 3600) : 0;

        // Potencia: se recorta el tramo y se reutiliza powerMetrics.
        let avgPower: number | null = null;
        let np: number | null = null;
        let wkg: number | null = null;
        if (aligned.watts) {
            const slice = sliceAlignedStreams(aligned, c.from, c.to);
            const pm = computePowerMetrics(slice, {
                ftpW: options.ftpW ?? null,
                weightKg: options.weightKg ?? null,
            });
            avgPower = pm.average_power_w;
            np = pm.normalized_power_w;
            wkg = pm.average_wkg;
        }

        const score = difficultyScore(avgGrade, distM);

        climbs.push({
            start_time_s: c.from + aligned.meta.start_offset_s,
            end_time_s: c.to + aligned.meta.start_offset_s,
            duration_s: durationS,
            distance_m: round(distM, 1),
            elevation_gain_m: round(gain, 1),
            avg_grade_pct: round(avgGrade, 2),
            max_sustained_grade_pct: maxSustainedGrade(smooth, distance, c.from, c.to, sustainedDist),
            vam_m_per_h: round(vam, 1),
            difficulty_score: round(score, 1),
            difficulty_tier: classify(score),
            difficulty_scale: DIFFICULTY_SCALE_NOTE,
            average_power_w: avgPower,
            normalized_power_w: np,
            average_wkg: wkg,
            efficiency_index:
                options.powerIsMeasured === true && wkg !== null
                    ? roundOrNull(efficiencyIndex(vam, wkg), 2)
                    : null,
        });
    }

    return {
        available: true,
        climbs,
        climb_count: climbs.length,
        total_elevation_gain_m: round(
            climbs.reduce((s, c) => s + c.elevation_gain_m, 0),
            1,
        ),
        thresholds,
        method,
        warnings,
        reason: null,
        code: null,
    };
}

/** Pendiente local en %, sobre una ventana de distancia recorrida. */
function localGrade(
    smooth: readonly number[],
    distance: readonly number[],
    i: number,
    windowM: number,
): number {
    const target = (distance[i] ?? 0) - windowM;
    let j = i;
    while (j > 0 && (distance[j] ?? 0) > target) j--;

    const dd = (distance[i] ?? 0) - (distance[j] ?? 0);
    // Parado o casi: la pendiente no está definida, se trata como llano.
    if (dd < 1) return 0;
    return (((smooth[i] ?? 0) - (smooth[j] ?? 0)) / dd) * 100;
}

/**
 * Mejor pendiente media sostenida en `windowM` metros dentro del tramo.
 *
 * El pico instantáneo de un barómetro es ruido; lo que describe una subida es
 * el tramo más duro que se mantiene.
 */
function maxSustainedGrade(
    smooth: readonly number[],
    distance: readonly number[],
    from: number,
    to: number,
    windowM: number,
): number | null {
    let best: number | null = null;
    let j = from;

    for (let i = from; i <= to; i++) {
        while (j < i && (distance[i]! - distance[j]!) > windowM) j++;
        const dd = distance[i]! - distance[j]!;
        if (dd < windowM * 0.9) continue; // ventana aún incompleta
        const g = ((smooth[i]! - smooth[j]!) / dd) * 100;
        if (best === null || g > best) best = g;
    }

    return best === null ? null : Math.round(best * 100) / 100;
}

/**
 * Índice de dificultad PROPIO de este proyecto.
 *
 * `pendiente_media_%² × distancia_km`. La pendiente va al cuadrado porque es lo
 * que determina la dureza: doblar la pendiente cuesta mucho más que doblar la
 * distancia, y el producto lineal anterior no lo recogía (ver D63).
 */
export function difficultyScore(avgGradePct: number, distanceM: number): number {
    return avgGradePct * avgGradePct * (distanceM / 1000);
}

export const DIFFICULTY_SCALE_NOTE =
    "Escala propia de CRC (pendiente_media_%² × distancia_km). Aproximación interna: " +
    "NO es la categorización oficial de la UCI ni de ninguna otra organización ciclista, " +
    "y no debe presentarse como tal.";

/**
 * Cortes de la escala, recalibrados para la fórmula cuadrática.
 *
 * Referencias que los sitúan: 500 m al 3 % (el mínimo detectable) da 4,5;
 * 5 km al 6 % da 180; 10 km al 6 % da 360; Alpe dHuez (13,8 km al 8,1 %) da
 * unos 905; Angliru (12,5 km al 9,8 %) unos 1200.
 */
export const DIFFICULTY_CUTS = { suave: 20, media: 100, dura: 300, muy_dura: 700 } as const;

export function classify(score: number): ClimbTier {
    if (score >= DIFFICULTY_CUTS.muy_dura) return "muy dura";
    if (score >= DIFFICULTY_CUTS.dura) return "dura";
    if (score >= DIFFICULTY_CUTS.media) return "media";
    if (score >= DIFFICULTY_CUTS.suave) return "suave";
    return "corta";
}

/**
 * Índice de eficiencia: VAM [m/h] / (W/kg).
 *
 * Compara subidas del MISMO ciclista entre sí. No sirve para comparar
 * ciclistas: depende de la posición, la bici, el viento y la pendiente, y dos
 * personas con el mismo EI no rinden igual.
 */
export function efficiencyIndex(vamMPerH: number, wattsPerKg: number): number | null {
    if (!Number.isFinite(vamMPerH) || !Number.isFinite(wattsPerKg) || wattsPerKg <= 0) {
        return null;
    }
    return vamMPerH / wattsPerKg;
}

export interface TrendCoefficients {
    /** Cambio por subida, en unidades de la señal. */
    slope: number;
    intercept: number;
    /** Bondad del ajuste, 0-1. */
    r_squared: number;
    /** Subidas usadas. */
    n: number;
}

/** Subidas mínimas para que una recta signifique algo. */
export const MIN_CLIMBS_FOR_TREND = 3;

/**
 * Regresión lineal de una serie sobre el ÍNDICE de subida (0, 1, 2…).
 *
 * Devuelve los coeficientes en crudo, sin etiquetarlos. Qué significa una
 * pendiente negativa de potencia (fatiga, terreno distinto, dosificación
 * deliberada) depende del contexto del entrenamiento, y no le corresponde a
 * este módulo decidirlo.
 */
export function linearTrend(values: readonly (number | null)[]): TrendCoefficients | null {
    const pares: [number, number][] = [];
    values.forEach((v, i) => {
        if (v !== null && Number.isFinite(v)) pares.push([i, v]);
    });

    const n = pares.length;
    if (n < MIN_CLIMBS_FOR_TREND) return null;

    const mediaX = pares.reduce((acc, [x]) => acc + x, 0) / n;
    const mediaY = pares.reduce((acc, [, y]) => acc + y, 0) / n;

    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const [x, y] of pares) {
        sxy += (x - mediaX) * (y - mediaY);
        sxx += (x - mediaX) ** 2;
        syy += (y - mediaY) ** 2;
    }

    // Todas las subidas en la misma posición: no hay recta que ajustar.
    if (sxx === 0) return null;

    const slope = sxy / sxx;
    return {
        slope: Math.round(slope * 1e4) / 1e4,
        intercept: Math.round((mediaY - slope * mediaX) * 1e4) / 1e4,
        // Sin variación en Y el ajuste es perfecto por definición (recta plana).
        r_squared: syy === 0 ? 1 : Math.round(((sxy * sxy) / (sxx * syy)) * 1e4) / 1e4,
        n,
    };
}
