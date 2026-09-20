/**
 * Estimación del umbral de FC (LTHR) desde el mejor 20 min del historial.
 *
 * Contra la fixture 17, con el valor derivado a mano: 170 × 0,98 = 166,6 -> 167.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    estimateHrThresholdFrom20Min,
    HR_THRESHOLD_LIMITATIONS,
    LTHR_FROM_20MIN_FACTOR,
} from "../../src/crc/analytics/vo2maxEstimate.ts";
import { computePowerCurve } from "../../src/crc/analytics/powerCurve.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";

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

describe("17-estimacion-umbral · estimación del LTHR", () => {
    const { expected, aligned } = load("17-estimacion-umbral");

    it("encuentra la mejor FC media de 20 min", () => {
        // La búsqueda del mejor esfuerzo se hace sobre la señal de FC.
        const curve = computePowerCurve(
            { ...aligned, watts: aligned.heartrate },
            { durations: [1200] },
        );
        const best = curve.entries[1200]!;

        expect(best.best_power_w).toBeCloseTo(expected.expected.best_20min_hr_bpm, 1);
        expect(best.start_time_s).toBe(expected.expected.best_20min_start_time_s);
    });

    it("aplica el factor 0,98 y redondea a latidos enteros", () => {
        const r = estimateHrThresholdFrom20Min(expected.expected.best_20min_hr_bpm);

        // 170 × 0,98 = 166,6 -> 167
        expect(r.estimated_hr_threshold_bpm).toBe(expected.expected.estimated_hr_threshold_bpm);
        expect(r.estimated_hr_threshold_bpm).toBe(167);
        expect(Number.isInteger(r.estimated_hr_threshold_bpm)).toBe(true);
        expect(r.factor).toBe(LTHR_FROM_20MIN_FACTOR);
    });

    it("el factor es configurable y se declara", () => {
        const r = estimateHrThresholdFrom20Min(170, { factor: 0.95 });

        expect(r.factor).toBe(0.95);
        expect(r.estimated_hr_threshold_bpm).toBe(Math.round(170 * 0.95));
        expect(JSON.stringify(r.method)).toContain("0.95");
    });

    it("propone el source estimated_hr20min, nunca manual", () => {
        const r = estimateHrThresholdFrom20Min(170);
        expect(r.suggested_source).toBe("estimated_hr20min");
        expect(JSON.stringify(r)).not.toContain('"manual"');
    });

    it("avisa de que no persiste y de cómo guardarlo", () => {
        const texto = estimateHrThresholdFrom20Min(170).warnings.join(" ");
        expect(texto).toContain("NO guardada");
        expect(texto).toContain("crc-set-performance-profile");
    });

    it("declara los límites del método como límites, no como fallos", () => {
        const r = estimateHrThresholdFrom20Min(170);

        expect(r.limitations).toBe(HR_THRESHOLD_LIMITATIONS);
        const texto = r.limitations.join(" ").toLowerCase();
        // El contexto que desplaza la FC.
        for (const factor of ["calor", "deshidrat", "altitud", "fatiga"]) {
            expect(texto, `debería mencionar ${factor}`).toContain(factor);
        }
        // Y que el mejor 20 min puede no ser un esfuerzo de umbral.
        expect(texto).toContain("no es necesariamente un esfuerzo de umbral");
        // Redactado como límite, no como error de cálculo.
        expect(texto).not.toContain("error");
        expect(texto).not.toContain("fallo");
    });

    it("rechaza entradas imposibles", () => {
        expect(() => estimateHrThresholdFrom20Min(0)).toThrow(/best20MinHrBpm/);
        expect(() => estimateHrThresholdFrom20Min(170, { factor: 0 })).toThrow(/factor/);
    });
});
