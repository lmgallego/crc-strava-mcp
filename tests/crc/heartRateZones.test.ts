/**
 * Zonas de FC de Coggan ancladas al umbral, y estimación del umbral.
 *
 * Contra las fixtures 14-17, cuyos segundos por zona están fijados por
 * construcción de los bloques.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    cogganHeartRateZones,
    computeTimeInZones,
    COGGAN_HR_CUTS_PCT_LTHR,
} from "../../src/crc/analytics/zones.ts";
import {
    estimateHrThresholdFrom20Min,
    HR_THRESHOLD_LIMITATIONS,
    LTHR_FROM_20MIN_FACTOR,
} from "../../src/crc/analytics/vo2maxEstimate.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";
import { computePowerCurve } from "../../src/crc/analytics/powerCurve.ts";

const FIXTURES = path.join(__dirname, "fixtures");

function load(name: string) {
    const s = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.streams.json`), "utf8"));
    const e = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.expected.json`), "utf8"));
    return {
        expected: e,
        aligned: buildAlignedStreams(s.streams.time.data, {
            heartrate: s.streams.heartrate.data,
            watts: s.streams.watts?.data,
        }),
    };
}

/** Reparte con las zonas de Coggan de la fixture (LTHR 165, FC máx 190). */
function zonasDe(name: string) {
    const { expected, aligned } = load(name);
    const zones = cogganHeartRateZones(
        expected.inputs.hr_threshold_bpm,
        expected.inputs.hr_max_bpm,
    );
    return {
        expected,
        zones,
        result: computeTimeInZones(aligned, {
            kind: "heartrate",
            zones,
            allowClosedTopZone: true,
        }),
    };
}

describe("cogganHeartRateZones · construcción", () => {
    const z = cogganHeartRateZones(165, 190);

    it("produce las cinco zonas de Coggan", () => {
        expect(z).toHaveLength(5);
        expect(z.map((x) => x.name.slice(0, 2))).toEqual(["Z1", "Z2", "Z3", "Z4", "Z5"]);
    });

    it("los límites son latidos enteros", () => {
        for (const zona of z) {
            expect(Number.isInteger(zona.lower)).toBe(true);
            if (zona.upper !== null) expect(Number.isInteger(zona.upper)).toBe(true);
        }
    });

    it("coinciden con los cortes calculados a mano para LTHR 165", () => {
        // 0.69→114, 0.84→139, 0.95→157, 1.05→173 (+1 = 174), tope 190+1
        expect(z[0]).toEqual({ name: "Z1 recuperación", lower: 0, upper: 114 });
        expect(z[1]).toEqual({ name: "Z2 aeróbico", lower: 114, upper: 139 });
        expect(z[2]).toEqual({ name: "Z3 tempo", lower: 139, upper: 157 });
        expect(z[3]).toEqual({ name: "Z4 umbral", lower: 157, upper: 174 });
        expect(z[4]).toEqual({ name: "Z5 VO2max", lower: 174, upper: 191 });
    });

    it("son contiguas: el tope de cada una es el suelo de la siguiente", () => {
        for (let i = 0; i < z.length - 1; i++) {
            expect(z[i]!.upper, `${z[i]!.name} y ${z[i + 1]!.name}`).toBe(z[i + 1]!.lower);
        }
    });

    it("sin FC máxima, la Z5 queda abierta", () => {
        const abierta = cogganHeartRateZones(165);
        expect(abierta[4]!.upper).toBeNull();
    });

    it("el LTHR cae en Z4, que es lo que significa el umbral", () => {
        const z4 = z[3]!;
        expect(165).toBeGreaterThanOrEqual(z4.lower);
        expect(165).toBeLessThan(z4.upper!);
    });

    it("rechaza un umbral no válido", () => {
        expect(() => cogganHeartRateZones(0)).toThrow(/umbral/);
        expect(() => cogganHeartRateZones(Number.NaN)).toThrow(/umbral/);
    });

    it("los porcentajes de corte son los de Coggan", () => {
        expect(COGGAN_HR_CUTS_PCT_LTHR).toEqual({
            z1_z2: 0.69,
            z2_z3: 0.84,
            z3_z4: 0.95,
            z4_top: 1.05,
        });
    });
});

describe("14-zonas-pulso · reparto por las cinco zonas", () => {
    const { expected, result } = zonasDe("14-zonas-pulso");
    const want = expected.expected.seconds_by_zone;

    it("cada zona recibe los segundos construidos", () => {
        for (const [i, clave] of ["Z1", "Z2", "Z3", "Z4", "Z5"].entries()) {
            expect(result.zones[i]!.seconds, clave).toBe(want[clave]);
        }
    });

    it("la suma por zona iguala los segundos válidos", () => {
        const suma = result.zones.reduce((s, z) => s + z.seconds, 0);
        expect(suma).toBe(expected.expected.valid_seconds);
        expect(suma).toBe(result.classified_seconds);
        expect(result.unclassified_seconds).toBe(0);
    });

    it("los porcentajes suman 100", () => {
        const total = result.zones.reduce((s, z) => s + z.percent_valid_time, 0);
        expect(total).toBeCloseTo(100, 1);
    });
});

describe("15-zonas-frontera · ningún latido se pierde ni se cuenta dos veces", () => {
    const { expected, result } = zonasDe("15-zonas-frontera");
    const want = expected.expected.seconds_by_zone;

    it("el latido del corte pertenece a la zona superior", () => {
        // 60 s en el último latido de Z1 y 60 s en el primero de Z2, etc.
        expect(result.zones[0]!.seconds).toBe(want["Z1"]); // solo el anterior al corte
        expect(result.zones[1]!.seconds).toBe(want["Z2"]); // corte + anterior al siguiente
        expect(result.zones[2]!.seconds).toBe(want["Z3"]);
        expect(result.zones[3]!.seconds).toBe(want["Z4"]);
        expect(result.zones[4]!.seconds).toBe(want["Z5"]);
    });

    it("no queda ningún segundo sin clasificar", () => {
        const suma = result.zones.reduce((s, z) => s + z.seconds, 0);
        expect(suma).toBe(expected.expected.valid_seconds);
        expect(result.unclassified_seconds).toBe(0);
    });

    it("la FC máxima exacta entra en Z5", () => {
        const z5 = result.zones[4]!;
        expect(z5.upper).toBe(expected.expected.boundary_values.hr_max + 1);
        expect(z5.seconds).toBeGreaterThan(0);
    });
});

describe("16-zonas-sobre-maxima · lo que supera la FC máxima no se inventa", () => {
    const { expected, result } = zonasDe("16-zonas-sobre-maxima");

    it("los segundos por encima de la máxima quedan sin clasificar", () => {
        expect(result.unclassified_seconds).toBe(expected.expected.unclassified_seconds);
        // No se suman a Z5 como si fueran esfuerzo real.
        expect(result.zones[4]!.seconds).toBe(0);
    });

    it("la suma por zona iguala los clasificados, no los válidos", () => {
        const suma = result.zones.reduce((s, z) => s + z.seconds, 0);
        expect(suma).toBe(result.classified_seconds);
        expect(result.classified_seconds + result.unclassified_seconds).toBe(
            expected.expected.valid_seconds,
        );
    });

    it("el método lo declara en lugar de callarlo", () => {
        expect(JSON.stringify(result.method).toLowerCase()).toContain("sin clasificar");
    });
});
