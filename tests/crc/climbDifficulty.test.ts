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

describe("difficultyScore · fórmula cuadrática", () => {
    it("es pendiente² × distancia_km", () => {
        // 6 % en 2 km -> 36 × 2 = 72
        expect(difficultyScore(6, 2000)).toBeCloseTo(72, 6);
        // 10 % en 5 km -> 100 × 5 = 500
        expect(difficultyScore(10, 5000)).toBeCloseTo(500, 6);
    });

    it("penaliza la pendiente más que la distancia, que es el cambio buscado", () => {
        // Misma "cantidad" en el producto lineal antiguo (6×10 = 60 = 12×5),
        // pero la más empinada debe puntuar mucho más alto.
        const suave = difficultyScore(6, 10000); // 36 × 10 = 360
        const empinada = difficultyScore(12, 5000); // 144 × 5 = 720

        expect(empinada).toBeGreaterThan(suave);
        expect(empinada / suave).toBeCloseTo(2, 6);
    });

    it("doblar la pendiente cuadruplica el índice; doblar la distancia lo dobla", () => {
        const base = difficultyScore(6, 5000);
        expect(difficultyScore(12, 5000) / base).toBeCloseTo(4, 6);
        expect(difficultyScore(6, 10000) / base).toBeCloseTo(2, 6);
    });

    it("sitúa los puertos de referencia donde se esperaría", () => {
        // Alpe d'Huez ~13,8 km al 8,1 %; Angliru ~12,5 km al 9,8 %.
        expect(classify(difficultyScore(8.1, 13800))).toBe("muy dura");
        expect(classify(difficultyScore(9.8, 12500))).toBe("muy dura");
        // Puerto medio y repecho.
        expect(classify(difficultyScore(6, 10000))).toBe("dura");
        expect(classify(difficultyScore(6, 5000))).toBe("media");
        // El mínimo detectable: 500 m al 3 % -> 4,5
        expect(classify(difficultyScore(3, 500))).toBe("corta");
    });

    it("los cortes de la escala son los declarados", () => {
        expect(DIFFICULTY_CUTS).toEqual({ suave: 20, media: 100, dura: 300, muy_dura: 700 });
        expect(classify(DIFFICULTY_CUTS.muy_dura)).toBe("muy dura");
        expect(classify(DIFFICULTY_CUTS.muy_dura - 0.1)).toBe("dura");
    });
});

describe("18-metricas-subidas · golden", () => {
    const { expected, aligned } = load("18-metricas-subidas");
    const exp = expected.expected;
    const r = detectClimbs(aligned, {
        weightKg: expected.inputs.weight_kg,
        powerIsMeasured: true,
    });

    it("detecta las tres subidas construidas", () => {
        expect(r.climb_count).toBe(exp.climb_count);
    });

    it("el índice de dificultad de cada una es el derivado", () => {
        for (const c of r.climbs) {
            expect(Math.abs(c.difficulty_score - exp.per_climb.difficulty_score)).toBeLessThan(6);
            expect(c.difficulty_tier).toBe(exp.per_climb.difficulty_tier);
        }
    });

    it("la VAM es 1080 m/h en todas", () => {
        for (const c of r.climbs) {
            expect(Math.abs(c.vam_m_per_h - exp.per_climb.vam_m_per_h)).toBeLessThan(40);
        }
    });

});
