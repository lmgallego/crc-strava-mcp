/**
 * Métricas añadidas a la detección de subidas: índice de dificultad
 * cuadrático, índice de eficiencia y tendencias entre subidas.
 *
 * Contra la fixture 18, con los valores derivados de su construcción.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    classify,
    detectClimbs,
    difficultyScore,
    efficiencyIndex,
    linearTrend,
    DIFFICULTY_CUTS,
    MIN_CLIMBS_FOR_TREND,
} from "../../src/crc/analytics/climbDetection.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";

const FIXTURES = path.join(__dirname, "fixtures");

function load(name: string) {
    const s = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.streams.json`), "utf8"));
    const e = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.expected.json`), "utf8"));
    return {
        expected: e,
        aligned: buildAlignedStreams(s.streams.time.data, {
            altitude: s.streams.altitude.data,
            distance: s.streams.distance.data,
            watts: s.streams.watts.data,
            heartrate: s.streams.heartrate.data,
        }),
    };
}

describe("efficiencyIndex", () => {
    it("es VAM / (W/kg)", () => {
        // 1080 m/h con 4 W/kg -> 270
        expect(efficiencyIndex(1080, 4)).toBeCloseTo(270, 6);
    });

    it("sube cuando se sube igual de rápido con menos vatios por kilo", () => {
        expect(efficiencyIndex(1080, 3.5)!).toBeGreaterThan(efficiencyIndex(1080, 4)!);
    });

    it("no devuelve nada con W/kg no positivos o no finitos", () => {
        expect(efficiencyIndex(1080, 0)).toBeNull();
        expect(efficiencyIndex(1080, -1)).toBeNull();
        expect(efficiencyIndex(Number.NaN, 4)).toBeNull();
    });
});

describe("linearTrend · coeficientes en crudo", () => {
    it("con valores equiespaciados, la pendiente es la diferencia constante", () => {
        const t = linearTrend([280, 260, 240])!;

        expect(t.slope).toBeCloseTo(-20, 6);
        expect(t.intercept).toBeCloseTo(280, 6);
        expect(t.r_squared).toBeCloseTo(1, 6);
        expect(t.n).toBe(3);
    });

    it("detecta tendencia creciente", () => {
        const t = linearTrend([150, 156, 162])!;
        expect(t.slope).toBeCloseTo(6, 6);
    });

    it("una serie plana da pendiente 0", () => {
        const t = linearTrend([200, 200, 200])!;
        expect(t.slope).toBeCloseTo(0, 6);
        expect(t.r_squared).toBe(1);
    });

    it(`exige al menos ${MIN_CLIMBS_FOR_TREND} valores`, () => {
        expect(linearTrend([280, 260])).toBeNull();
        expect(linearTrend([280])).toBeNull();
        expect(linearTrend([])).toBeNull();
        expect(MIN_CLIMBS_FOR_TREND).toBe(3);
    });

    it("ignora los nulos pero sigue exigiendo el mínimo", () => {
        expect(linearTrend([280, null, 260, null, 240])).not.toBeNull();
        expect(linearTrend([280, null, 260])).toBeNull();
    });

    it("NO interpreta: solo devuelve coeficientes", () => {
        const t = linearTrend([280, 260, 240])!;

        expect(Object.keys(t).sort()).toEqual(["intercept", "n", "r_squared", "slope"]);
        const texto = JSON.stringify(t).toLowerCase();
        for (const palabra of ["fatiga", "deriva", "cansancio", "trend", "↓", "↑", "peor"]) {
            expect(texto).not.toContain(palabra);
        }
    });
});

describe("18-metricas-subidas · golden", () => {
    const { expected, aligned } = load("18-metricas-subidas");
    const exp = expected.expected;
    const r = detectClimbs(aligned, {
        weightKg: expected.inputs.weight_kg,
        powerIsMeasured: true,
    });

    it("el índice de eficiencia sigue el orden derivado", () => {
        const eis = r.climbs.map((c) => c.efficiency_index!);

        for (const ei of eis) expect(ei).not.toBeNull();
        // A menos potencia con la misma VAM, mayor EI.
        expect(eis[0]!).toBeLessThan(eis[1]!);
        expect(eis[1]!).toBeLessThan(eis[2]!);
        // Y cada uno cerca del valor derivado.
        exp.efficiency_index_by_climb.forEach((want: number, i: number) => {
            expect(Math.abs(eis[i]! - want) / want).toBeLessThan(0.05);
        });
    });

    it("sin potencia medida no se calcula el índice de eficiencia", () => {
        const sinMedir = detectClimbs(aligned, {
            weightKg: expected.inputs.weight_kg,
            powerIsMeasured: false,
        });
        for (const c of sinMedir.climbs) expect(c.efficiency_index).toBeNull();
    });

    it("sin peso tampoco", () => {
        const sinPeso = detectClimbs(aligned, { powerIsMeasured: true });
        for (const c of sinPeso.climbs) expect(c.efficiency_index).toBeNull();
    });

    it("la tendencia de potencia es la pendiente derivada", () => {
        const t = linearTrend(r.climbs.map((c) => c.average_power_w))!;

        expect(t.n).toBe(3);
        expect(Math.abs(t.slope - exp.trend_power.slope)).toBeLessThan(2);
        expect(t.slope).toBeLessThan(0);
    });

    it("la salida no interpreta nada", () => {
        const texto = JSON.stringify(r.climbs).toLowerCase();
        for (const palabra of ["fatiga", "deriva", "recomend", "deberías", "empeora"]) {
            expect(texto).not.toContain(palabra);
        }
    });
});
