/**
 * Tiempo en zonas (sección 7.6 de la especificación).
 *
 * Función pura sobre `AlignedStreams`.
 *
 * Fronteras: cada zona es el intervalo SEMIABIERTO [lower, upper). La última
 * zona no tiene tope (`upper: null`) y la primera empieza en 0. Así cada valor
 * cae en exactamente una zona: ningún segundo se cuenta dos veces ni se pierde.
 * Un valor justo en la frontera pertenece a la zona superior.
 */
import type { AlignedStreams } from "../streams/alignedStreams.js";

export type ZoneKind = "power" | "heartrate" | "custom";

export interface ZoneDefinition {
    name: string;
    /** Límite inferior incluido. */
    lower: number;
    /** Límite superior EXCLUIDO. `null` = sin tope. */
    upper: number | null;
}

export interface ZoneResult {
    name: string;
    lower: number;
    upper: number | null;
    seconds: number;
    minutes: number;
    percent_valid_time: number;
    /** Solo si hay potencia: trabajo acumulado en esa zona. */
    work_kj: number | null;
}

export interface TimeInZonesResult {
    available: boolean;
    kind: ZoneKind;
    /** Unidad de los límites ya resueltos a valores absolutos. */
    unit: string;
    zones: ZoneResult[];
    /** Segundos válidos con valor de la señal: base de los porcentajes. */
    classified_seconds: number;
    /** Segundos válidos SIN valor de la señal (no asignables a ninguna zona). */
    unclassified_seconds: number;
    valid_seconds: number;
    method: Record<string, string>;
    reason: string | null;
}

/** Zonas de potencia por % de FTP (modelo de 7 zonas de Coggan). */
export const DEFAULT_POWER_ZONES_PCT_FTP: ZoneDefinition[] = [
    { name: "Z1 recuperación activa", lower: 0, upper: 0.55 },
    { name: "Z2 resistencia", lower: 0.55, upper: 0.75 },
    { name: "Z3 tempo", lower: 0.75, upper: 0.9 },
    { name: "Z4 umbral", lower: 0.9, upper: 1.05 },
    { name: "Z5 VO2max", lower: 1.05, upper: 1.2 },
    { name: "Z6 capacidad anaeróbica", lower: 1.2, upper: 1.5 },
    { name: "Z7 neuromuscular", lower: 1.5, upper: null },
];

/** Zonas de FC por % de la FC máxima. */
export const DEFAULT_HR_ZONES_PCT_MAX: ZoneDefinition[] = [
    { name: "Z1", lower: 0, upper: 0.6 },
    { name: "Z2", lower: 0.6, upper: 0.7 },
    { name: "Z3", lower: 0.7, upper: 0.8 },
    { name: "Z4", lower: 0.8, upper: 0.9 },
    { name: "Z5", lower: 0.9, upper: null },
];

export interface TimeInZonesOptions {
    kind?: ZoneKind;
    /** Zonas con límites ABSOLUTOS (W o bpm). Tienen prioridad. */
    zones?: ZoneDefinition[];
    /** Zonas RELATIVAS: los límites se multiplican por `reference`. */
    relativeZones?: ZoneDefinition[];
    /** Referencia para las zonas relativas: FTP en W o FC máx en bpm. */
    reference?: number | null;
}

const round = (v: number, d: number): number => {
    const f = 10 ** d;
    return Math.round(v * f) / f;
};

/**
 * Reparte los segundos válidos entre zonas.
 *
 * La señal la elige `kind`: `power` usa watts, `heartrate` usa heartrate y
 * `custom` exige zonas absolutas explícitas sobre la potencia.
 */
export function computeTimeInZones(
    aligned: AlignedStreams,
    options: TimeInZonesOptions = {},
): TimeInZonesResult {
    const kind = options.kind ?? "power";
    const unit = kind === "heartrate" ? "bpm" : "W";

    const method: Record<string, string> = {
        boundaries:
            "Intervalos semiabiertos [lower, upper): un valor en la frontera cae en la zona superior. " +
            "La última zona no tiene tope y la primera empieza en 0.",
        coverage:
            "La suma de segundos de todas las zonas es igual a classified_seconds. " +
            "Los segundos válidos sin valor de la señal van a unclassified_seconds.",
        basis: "Solo se consideran segundos con valid[i] === true.",
    };

    const validSeconds = aligned.valid.reduce((s, v) => s + (v ? 1 : 0), 0);

    const fail = (reason: string): TimeInZonesResult => ({
        available: false,
        kind,
        unit,
        zones: [],
        classified_seconds: 0,
        unclassified_seconds: 0,
        valid_seconds: validSeconds,
        method,
        reason,
    });

    const signal = kind === "heartrate" ? aligned.heartrate : aligned.watts;
    if (!signal) {
        return fail(
            kind === "heartrate"
                ? "La actividad no tiene stream de frecuencia cardíaca."
                : "La actividad no tiene stream de potencia.",
        );
    }

    // --- Resolución de las zonas a valores absolutos ----------------------
    let zones: ZoneDefinition[];
    if (options.zones && options.zones.length > 0) {
        zones = options.zones;
        method["limits"] = "Límites absolutos proporcionados explícitamente.";
    } else if (options.relativeZones && options.relativeZones.length > 0) {
        if (!options.reference) {
            return fail("Zonas relativas pedidas sin referencia (FTP o FC máxima).");
        }
        zones = toAbsolute(options.relativeZones, options.reference);
        method["limits"] = `Límites relativos multiplicados por la referencia (${options.reference} ${unit}).`;
    } else if (kind === "custom") {
        return fail("kind 'custom' exige zonas explícitas.");
    } else {
        if (!options.reference) {
            return fail(
                kind === "power"
                    ? "Sin FTP vigente no se pueden usar las zonas de potencia por defecto. Pasa zonas absolutas."
                    : "Sin FC máxima no se pueden usar las zonas de FC por defecto. Pasa zonas absolutas.",
            );
        }
        const defaults =
            kind === "power" ? DEFAULT_POWER_ZONES_PCT_FTP : DEFAULT_HR_ZONES_PCT_MAX;
        zones = toAbsolute(defaults, options.reference);
        method["limits"] = `Zonas por defecto relativas a ${options.reference} ${unit}.`;
    }

    assertContiguous(zones);

    // --- Reparto ----------------------------------------------------------
    const seconds = new Array(zones.length).fill(0) as number[];
    const work = new Array(zones.length).fill(0) as number[];
    const watts = aligned.watts;

    let classified = 0;
    let unclassified = 0;

    for (let i = 0; i < aligned.time.length; i++) {
        if (!aligned.valid[i]) continue;

        const value = signal[i];
        if (value == null || !Number.isFinite(value)) {
            unclassified++;
            continue;
        }

        const z = zoneIndex(zones, value);
        if (z < 0) {
            unclassified++;
            continue;
        }

        seconds[z]!++;
        classified++;
        if (watts) {
            const p = watts[i]!;
            if (Number.isFinite(p)) work[z]! += p;
        }
    }

    const results: ZoneResult[] = zones.map((z, i) => ({
        name: z.name,
        lower: round(z.lower, 4),
        upper: z.upper === null ? null : round(z.upper, 4),
        seconds: seconds[i]!,
        minutes: round(seconds[i]! / 60, 2),
        percent_valid_time: classified > 0 ? round((seconds[i]! / classified) * 100, 2) : 0,
        work_kj: watts ? round(work[i]! / 1000, 2) : null,
    }));

    return {
        available: true,
        kind,
        unit,
        zones: results,
        classified_seconds: classified,
        unclassified_seconds: unclassified,
        valid_seconds: validSeconds,
        method,
        reason: null,
    };
}

function toAbsolute(zones: ZoneDefinition[], reference: number): ZoneDefinition[] {
    return zones.map((z) => ({
        name: z.name,
        lower: z.lower * reference,
        upper: z.upper === null ? null : z.upper * reference,
    }));
}

/** Índice de la zona que contiene `value`, o -1. */
function zoneIndex(zones: ZoneDefinition[], value: number): number {
    for (let i = 0; i < zones.length; i++) {
        const z = zones[i]!;
        if (value >= z.lower && (z.upper === null || value < z.upper)) return i;
    }
    return -1;
}

/**
 * Las zonas deben cubrir [0, ∞) sin solapes ni huecos: si no, habría segundos
 * imposibles de clasificar o clasificables dos veces.
 */
function assertContiguous(zones: ZoneDefinition[]): void {
    if (zones.length === 0) throw new Error("Hay que definir al menos una zona.");

    const sorted = [...zones].sort((a, b) => a.lower - b.lower);
    if (sorted[0]!.lower > 0) {
        throw new Error(`La primera zona debe empezar en 0 (empieza en ${sorted[0]!.lower}).`);
    }
    for (let i = 0; i < sorted.length - 1; i++) {
        const cur = sorted[i]!;
        const next = sorted[i + 1]!;
        if (cur.upper === null) {
            throw new Error(`Solo la última zona puede no tener tope (${cur.name} no lo tiene).`);
        }
        if (cur.upper !== next.lower) {
            throw new Error(
                `Zonas no contiguas: ${cur.name} acaba en ${cur.upper} y ${next.name} empieza en ${next.lower}.`,
            );
        }
    }
    if (sorted[sorted.length - 1]!.upper !== null) {
        throw new Error("La última zona debe quedar abierta (upper: null).");
    }
}
