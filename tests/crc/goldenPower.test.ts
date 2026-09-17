/**
 * Golden tests de potencia contra las fixtures sintéticas de
 * `tests/crc/fixtures/`, cuyos valores esperados están derivados
 * analíticamente (ver el README de esa carpeta).
 *
 * Los `.expected.json` son LA REFERENCIA: si un test falla, se corrige el
 * código, nunca la fixture ni la tolerancia.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { computePowerMetrics } from "../../src/crc/analytics/powerMetrics.ts";
import { computePowerCurve } from "../../src/crc/analytics/powerCurve.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";

const FIXTURES = path.join(__dirname, "fixtures");

/** Tolerancias acordadas para el sprint. */
const TOL = {
    np_w: 1, // NP ±1 W
    tss_pct: 1, // TSS ±1 %
    kj_pct: 0.5, // kJ ±0,5 %
    curve_w: 1, // power curve ±1 W
    // No fijadas explícitamente; estrictas porque son aritmética directa.
    avg_w: 0.5,
    vi: 0.01,
    if: 0.005,
    wkg: 0.02,
};

interface FixtureStreams {
    activity_id: string;
    device_watts: boolean;
    streams: Record<string, { data: (number | null)[] }>;
}

interface FixtureExpected {
    fixture: string;
    description: string;
    inputs: { ftp_w: number; weight_kg: number };
    expected: {
        valid_seconds: number;
        average_power_w: number;
        normalized_power_w: number;
        variability_index: number;
        intensity_factor: number;
        tss: number;
        work_kj: number;
        average_wkg: number;
        power_curve: Record<
            string,
            { best_power_w: number; best_power_wkg: number; start_time_s: number }
        >;
    };
}

const NAMES = [
    "01-steady-endurance",
    "02-sweetspot",
    "03-vo2max",
    "04-paradas",
    "05-descenso-ceros",
] as const;

function load(name: string) {
    const streams = JSON.parse(
        readFileSync(path.join(FIXTURES, `${name}.streams.json`), "utf8"),
    ) as FixtureStreams;
    const expected = JSON.parse(
        readFileSync(path.join(FIXTURES, `${name}.expected.json`), "utf8"),
    ) as FixtureExpected;

    const s = streams.streams;
    const aligned = buildAlignedStreams(s["time"]!.data as number[], {
        watts: s["watts"]?.data,
        heartrate: s["heartrate"]?.data,
        cadence: s["cadence"]?.data,
    });

    return { streams, expected, aligned };
}

/** Diferencia relativa en %, para las tolerancias porcentuales. */
const pctDiff = (actual: number, expected: number): number =>
    expected === 0 ? (actual === 0 ? 0 : Infinity) : (Math.abs(actual - expected) / Math.abs(expected)) * 100;

describe.each(NAMES)("golden · %s", (name) => {
    const { expected, aligned } = load(name);
    const exp = expected.expected;
    const ftp = expected.inputs.ftp_w;
    const kg = expected.inputs.weight_kg;

    describe("powerMetrics", () => {
        const m = computePowerMetrics(aligned, { ftpW: ftp, weightKg: kg });

        it("segundos válidos", () => {
            expect(m.valid_seconds).toBe(exp.valid_seconds);
        });

        it(`potencia media (±${TOL.avg_w} W)`, () => {
            expect(Math.abs(m.average_power_w! - exp.average_power_w)).toBeLessThanOrEqual(
                TOL.avg_w,
            );
        });

        it(`NP (±${TOL.np_w} W)`, () => {
            expect(
                Math.abs(m.normalized_power_w! - exp.normalized_power_w),
            ).toBeLessThanOrEqual(TOL.np_w);
        });

        it(`VI (±${TOL.vi})`, () => {
            expect(Math.abs(m.variability_index! - exp.variability_index)).toBeLessThanOrEqual(
                TOL.vi,
            );
        });

        it(`IF (±${TOL.if})`, () => {
            expect(Math.abs(m.intensity_factor! - exp.intensity_factor)).toBeLessThanOrEqual(
                TOL.if,
            );
        });

        it(`TSS (±${TOL.tss_pct} %)`, () => {
            expect(pctDiff(m.tss!, exp.tss)).toBeLessThanOrEqual(TOL.tss_pct);
        });

        it(`trabajo kJ (±${TOL.kj_pct} %)`, () => {
            expect(pctDiff(m.work_kj!, exp.work_kj)).toBeLessThanOrEqual(TOL.kj_pct);
        });

        it(`W/kg medios (±${TOL.wkg})`, () => {
            expect(Math.abs(m.average_wkg! - exp.average_wkg)).toBeLessThanOrEqual(TOL.wkg);
        });
    });

    describe("powerCurve", () => {
        const durations = Object.keys(exp.power_curve).map(Number);
        const curve = computePowerCurve(aligned, { durations, weightKg: kg });

        for (const [durStr, want] of Object.entries(exp.power_curve)) {
            const dur = Number(durStr);

            it(`mejor media de ${dur} s (±${TOL.curve_w} W)`, () => {
                const got = curve.entries[dur];
                expect(got, `falta la duración ${dur}`).toBeDefined();
                expect(
                    Math.abs(got!.best_power_w! - want.best_power_w),
                ).toBeLessThanOrEqual(TOL.curve_w);
            });

            it(`inicio del mejor ${dur} s`, () => {
                expect(curve.entries[dur]!.start_time_s).toBe(want.start_time_s);
            });

            it(`W/kg del mejor ${dur} s`, () => {
                expect(
                    Math.abs(curve.entries[dur]!.best_power_wkg! - want.best_power_wkg),
                ).toBeLessThanOrEqual(TOL.wkg);
            });
        }
    });
});

describe("golden · invariantes que dan sentido a cada fixture", () => {
    it("01: con potencia constante NP = media y VI = 1 por definición", () => {
        const { aligned, expected } = load("01-steady-endurance");
        const m = computePowerMetrics(aligned, { ftpW: expected.inputs.ftp_w });

        expect(Math.abs(m.normalized_power_w! - m.average_power_w!)).toBeLessThanOrEqual(0.01);
        expect(Math.abs(m.variability_index! - 1)).toBeLessThanOrEqual(0.001);
    });

    it("03: el mejor 5 min NO es el pico de 340 W (ningún bloque sostiene 300 s)", () => {
        const { aligned, expected } = load("03-vo2max");
        const curve = computePowerCurve(aligned, { durations: [60, 300] });

        // El pico de 60 s sí llega a 340 W...
        expect(curve.entries[60]!.best_power_w).toBeGreaterThan(330);
        // ...pero en 300 s la ventana obliga a incluir recuperación.
        expect(curve.entries[300]!.best_power_w).toBeLessThan(340);
        expect(
            Math.abs(curve.entries[300]!.best_power_w! - expected.expected.power_curve["300"]!.best_power_w),
        ).toBeLessThanOrEqual(TOL.curve_w);
    });

    it("04: las ventanas no cruzan los huecos, así que NP sigue siendo 190", () => {
        const { aligned } = load("04-paradas");
        const m = computePowerMetrics(aligned, { ftpW: 250 });

        // Si el código cruzara el hueco o rellenara con ceros, NP bajaría.
        expect(Math.abs(m.normalized_power_w! - 190)).toBeLessThanOrEqual(TOL.np_w);
        expect(m.valid_seconds).toBe(4755);
    });

    it("05: los ceros del descenso entran en la media, no se tratan como ausencia", () => {
        const { aligned } = load("05-descenso-ceros");
        const m = computePowerMetrics(aligned, { ftpW: 250 });

        expect(Math.abs(m.average_power_w! - 166)).toBeLessThanOrEqual(TOL.avg_w);
        // Si los ceros se descartaran, la media subiría hacia ~207.
        expect(m.average_power_w!).toBeLessThan(180);
    });
});
