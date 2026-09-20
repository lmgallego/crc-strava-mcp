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

/**
 * Cortes de las zonas de Coggan de FC, en fracción del umbral (LTHR):
 * Z1 hasta 68 %, Z2 69-83 %, Z3 84-94 %, Z4 95-105 %, Z5 por encima.
 *
 * Se guardan los CORTES, no los extremos de cada zona: cada corte es un único
 * número que sirve de tope de una zona y de suelo de la siguiente, así que por
 * construcción no puede haber hueco ni solape entre ellas.
 */
export const COGGAN_HR_CUTS_PCT_LTHR = {
    z1_z2: 0.69,
    z2_z3: 0.84,
    z3_z4: 0.95,
    /** Último bpm que todavía es Z4; Z5 empieza en el siguiente. */
    z4_top: 1.05,
} as const;

/**
 * Zonas de Coggan de FC en bpm ENTEROS, ancladas al umbral.
 *
 * Los límites se redondean a bpm porque un pulsómetro no da decimales: hablar
 * de "zona 4 a partir de 161,5 ppm" no significa nada sobre el terreno.
 *
 * `hrMax` cierra la Z5 por arriba cuando se conoce. Los valores por encima de
 * la FC máxima registrada quedan SIN CLASIFICAR (aparecen en
 * `unclassified_seconds`), que es lo correcto: son o un artefacto del sensor o
 * una FC máxima desactualizada, y en ninguno de los dos casos conviene
 * sumarlos a la zona más dura como si fueran esfuerzo real.
 */
export function cogganHeartRateZones(lthr: number, hrMax?: number | null): ZoneDefinition[] {
    if (!Number.isFinite(lthr) || lthr <= 0) {
        throw new Error(`El umbral de FC debe ser > 0 (recibido: ${lthr}).`);
    }

    const c = COGGAN_HR_CUTS_PCT_LTHR;
    const z1z2 = Math.round(c.z1_z2 * lthr);
    const z2z3 = Math.round(c.z2_z3 * lthr);
    const z3z4 = Math.round(c.z3_z4 * lthr);
    // Z4 incluye su tope, así que Z5 arranca un latido más arriba.
    const z4z5 = Math.round(c.z4_top * lthr) + 1;

    const top =
        hrMax != null && Number.isFinite(hrMax) && hrMax >= z4z5
            ? // +1 porque el intervalo es [lower, upper) y la FC máxima cuenta.
              Math.round(hrMax) + 1
            : null;

    return [
        { name: "Z1 recuperación", lower: 0, upper: z1z2 },
        { name: "Z2 aeróbico", lower: z1z2, upper: z2z3 },
        { name: "Z3 tempo", lower: z2z3, upper: z3z4 },
        { name: "Z4 umbral", lower: z3z4, upper: z4z5 },
        { name: "Z5 VO2max", lower: z4z5, upper: top },
    ];
}

export interface TimeInZonesOptions {
    kind?: ZoneKind;
    /** Zonas con límites ABSOLUTOS (W o bpm). Tienen prioridad. */
    zones?: ZoneDefinition[];
    /** Zonas RELATIVAS: los límites se multiplican por `reference`. */
    relativeZones?: ZoneDefinition[];
    /** Referencia para las zonas relativas: FTP en W o FC máx en bpm. */
    reference?: number | null;
    /**
     * Permite que la última zona tenga tope en lugar de quedar abierta.
     *
     * Por defecto se exige abierta, para que ningún valor se quede fuera por
     * olvido. Las zonas de FC ancladas a la FC máxima son la excepción
     * legítima: ahí el techo es deliberado y lo que lo supera se reporta en
     * `unclassified_seconds`.
     */
    allowClosedTopZone?: boolean;
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

    assertContiguous(zones, options.allowClosedTopZone ?? false);

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

    if (unclassified > 0 && classified > 0) {
        method["unclassified"] =
            `${unclassified} s válidos quedaron SIN CLASIFICAR: o la señal faltaba en ese ` +
            "segundo, o superaba el techo de la última zona. No se reparten entre las zonas " +
            "existentes; se reportan en unclassified_seconds.";
    }

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
function assertContiguous(zones: ZoneDefinition[], allowClosedTop: boolean): void {
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
    if (sorted[sorted.length - 1]!.upper !== null && !allowClosedTop) {
        throw new Error(
            "La última zona debe quedar abierta (upper: null), o hay que pedir " +
                "allowClosedTopZone para aceptar un techo explícito.",
        );
    }
}
