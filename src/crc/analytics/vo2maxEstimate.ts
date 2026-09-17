/**
 * VO2max estimado a partir del mejor 5 min (sección 7.11).
 *
 * Función pura: recibe números, devuelve números.
 *
 * VO2max [ml·kg⁻¹·min⁻¹] = 16.6 + 8.87 × P5min [W/kg]
 */

export const VO2MAX_MODEL = {
    intercept: 16.6,
    slope: 8.87,
    input: "mejor potencia media de 5 min en W/kg",
    output: "ml·kg⁻¹·min⁻¹",
    /**
     * Modelo publicado para un test máximo de 5 min en ciclistas de carretera.
     *
     * ponytail: la referencia bibliográfica exacta (autores y PMID) está
     * PENDIENTE DE VERIFICAR en PubMed, como pide el estudio de viabilidad.
     * No se escribe aquí un PMID sin comprobarlo: una cita inventada es peor
     * que ninguna.
     */
    reference: "Modelo publicado para 5-minute maximal test en ciclistas de carretera (referencia pendiente de verificar en PubMed).",
    reference_verified: false,
} as const;

/** Etiqueta obligatoria de la salida. Nunca `lab_vo2max`. */
export const VO2MAX_LABEL = "estimated_vo2max";

export interface Vo2maxInput {
    /** Mejor potencia media de 5 min, en W. */
    best5MinPowerW: number;
    /** Peso vigente en la fecha DEL ESFUERZO, en kg. */
    weightKg: number;
    /**
     * `true` solo si hay evidencia de que el esfuerzo fue máximo (por ejemplo,
     * un test declarado). Por defecto `false`: un mejor 5 min observado en un
     * rodaje no equivale a un 5MT máximo.
     */
    maximalEffortEvidence?: boolean;
}

export interface Vo2maxResult {
    best_5min_power_w: number;
    weight_kg: number;
    relative_power_wkg: number;
    estimated_vo2max: number;
    label: string;
    model_reference: string;
    model: { intercept: number; slope: number; formula: string };
    method: Record<string, string>;
    warnings: string[];
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

/** Aplica el modelo publicado. Expuesta aparte para poder testear la ecuación. */
export function vo2maxFromWkg(wkg: number): number {
    return VO2MAX_MODEL.intercept + VO2MAX_MODEL.slope * wkg;
}

export function estimateVo2max(input: Vo2maxInput): Vo2maxResult {
    const { best5MinPowerW, weightKg } = input;

    if (!Number.isFinite(best5MinPowerW) || best5MinPowerW <= 0) {
        throw new Error(`best5MinPowerW debe ser > 0 (recibido: ${best5MinPowerW}).`);
    }
    if (!Number.isFinite(weightKg) || weightKg <= 0) {
        throw new Error(`weightKg debe ser > 0 (recibido: ${weightKg}).`);
    }

    const wkg = best5MinPowerW / weightKg;
    const vo2 = vo2maxFromWkg(wkg);

    const warnings: string[] = [];
    if (!input.maximalEffortEvidence) {
        warnings.push(
            "El mejor 5 min observado NO equivale necesariamente a un test máximo de 5 min: " +
                "sin evidencia de esfuerzo máximo, este VO2max es un suelo, no una medida.",
        );
    }
    warnings.push(
        "Valor ESTIMADO con un modelo de regresión, no medido en laboratorio.",
    );

    return {
        best_5min_power_w: round(best5MinPowerW, 2),
        weight_kg: weightKg,
        relative_power_wkg: round(wkg, 4),
        estimated_vo2max: round(vo2, 2),
        label: VO2MAX_LABEL,
        model_reference: VO2MAX_MODEL.reference,
        model: {
            intercept: VO2MAX_MODEL.intercept,
            slope: VO2MAX_MODEL.slope,
            formula: "VO2max = 16.6 + 8.87 × P5min[W/kg]",
        },
        method: {
            model: "VO2max [ml·kg⁻¹·min⁻¹] = 16.6 + 8.87 × (mejor 5 min / peso).",
            weight:
                "El peso es el vigente en la fecha DEL ESFUERZO, no el actual ni el de otra actividad.",
            label: "La salida se etiqueta estimated_vo2max; nunca lab_vo2max.",
            power_source: "Requiere potencia medida: con device_watts=false no se calcula.",
        },
        warnings,
    };
}

/** Factor estándar para estimar FTP desde el mejor 20 min. */
export const FTP_FROM_20MIN_FACTOR = 0.95;

export interface FtpEstimateResult {
    best_20min_power_w: number;
    factor: number;
    estimated_ftp_w: number;
    /** Valor de `source` con el que debe guardarse si el usuario confirma. */
    suggested_source: string;
    method: Record<string, string>;
    warnings: string[];
}

/**
 * FTP estimado = mejor 20 min × 0,95.
 *
 * Devuelve una PROPUESTA. Persistirla exige una llamada aparte a
 * `crc-set-performance-profile` (D12): calcular y persistir van separados.
 */
export function estimateFtpFrom20Min(
    best20MinPowerW: number,
    options: { maximalEffortEvidence?: boolean } = {},
): FtpEstimateResult {
    if (!Number.isFinite(best20MinPowerW) || best20MinPowerW <= 0) {
        throw new Error(`best20MinPowerW debe ser > 0 (recibido: ${best20MinPowerW}).`);
    }

    const warnings: string[] = [];
    if (!options.maximalEffortEvidence) {
        warnings.push(
            "El mejor 20 min observado NO es un test de 20 minutos: sin evidencia de esfuerzo " +
                "máximo, este FTP es una cota inferior, no una medida.",
        );
    }
    warnings.push(
        "Propuesta NO guardada. Para persistirla, llama a crc-set-performance-profile con " +
            'source "estimated_20min".',
    );

    return {
        best_20min_power_w: round(best20MinPowerW, 2),
        factor: FTP_FROM_20MIN_FACTOR,
        estimated_ftp_w: round(best20MinPowerW * FTP_FROM_20MIN_FACTOR, 2),
        suggested_source: "estimated_20min",
        method: {
            formula: `FTP ≈ mejor 20 min × ${FTP_FROM_20MIN_FACTOR}.`,
            persistence:
                "Esta herramienta NO escribe en el perfil. Guardar exige una llamada explícita " +
                "y separada a crc-set-performance-profile.",
            power_source: "Requiere potencia medida: con device_watts=false no se estima.",
        },
        warnings,
    };
}
