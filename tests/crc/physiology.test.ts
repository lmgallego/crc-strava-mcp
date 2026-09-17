import { describe, expect, it } from "vitest";

import { computeTimeInZones, DEFAULT_POWER_ZONES_PCT_FTP } from "../../src/crc/analytics/zones.ts";
import {
    summariseHrAndCadence,
    summariseSignal,
} from "../../src/crc/analytics/streamSummary.ts";
import { computeTorqueCadence, torqueNm } from "../../src/crc/analytics/torqueCadence.ts";
import { computeWorkAboveFtp } from "../../src/crc/analytics/workAboveFtp.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";

/** Construye streams a partir de bloques (duración, watts, cadencia, FC). */
function build(blocks: [number, number, number?, number?][], gaps: [number, number][] = []) {
    const time: number[] = [];
    const watts: number[] = [];
    const cadence: number[] = [];
    const hr: number[] = [];
    let t = 0;
    for (const [dur, w, c, h] of blocks) {
        for (let i = 0; i < dur; i++) {
            const drop = gaps.some(([g0, gd]) => t >= g0 && t < g0 + gd);
            if (!drop) {
                time.push(t);
                watts.push(w);
                cadence.push(c ?? 90);
                hr.push(h ?? 140);
            }
            t++;
        }
    }
    return buildAlignedStreams(time, { watts, cadence, heartrate: hr });
}

describe("zones · cobertura completa", () => {
    it("la suma de segundos por zona es igual a los segundos clasificados", () => {
        const a = build([
            [600, 100],
            [600, 200],
            [600, 300],
            [600, 400],
        ]);
        const r = computeTimeInZones(a, { kind: "power", reference: 250 });

        const suma = r.zones.reduce((s, z) => s + z.seconds, 0);
        expect(suma).toBe(r.classified_seconds);
        expect(r.classified_seconds + r.unclassified_seconds).toBe(r.valid_seconds);
        expect(r.valid_seconds).toBe(2400);
    });

    it("la suma cuadra también con huecos no válidos", () => {
        const a = build([[1800, 200]], [[600, 300]]);
        const r = computeTimeInZones(a, { kind: "power", reference: 250 });

        const suma = r.zones.reduce((s, z) => s + z.seconds, 0);
        expect(suma).toBe(r.classified_seconds);
        expect(r.valid_seconds).toBe(1500);
        expect(suma).toBe(1500);
    });

    it("los porcentajes suman 100", () => {
        const a = build([
            [300, 120],
            [300, 260],
        ]);
        const r = computeTimeInZones(a, { kind: "power", reference: 250 });

        const total = r.zones.reduce((s, z) => s + z.percent_valid_time, 0);
        expect(total).toBeCloseTo(100, 1);
    });
});

describe("zones · fronteras semiabiertas", () => {
    it("un valor en la frontera cae en la zona superior, sin contarse dos veces", () => {
        // 250 W con FTP 250 = 100 % -> frontera entre Z4 (0.9-1.05) y ... es Z4,
        // porque 1.0 está dentro de [0.9, 1.05). La frontera exacta es 0.9*250=225.
        const a = build([[10, 225]]);
        const r = computeTimeInZones(a, { kind: "power", reference: 250 });

        const z3 = r.zones.find((z) => z.name.startsWith("Z3"))!;
        const z4 = r.zones.find((z) => z.name.startsWith("Z4"))!;
        expect(z3.seconds).toBe(0);
        expect(z4.seconds).toBe(10);
        expect(r.zones.reduce((s, z) => s + z.seconds, 0)).toBe(10);
    });

    it("la última zona no tiene tope y recoge los valores extremos", () => {
        const a = build([[10, 5000]]);
        const r = computeTimeInZones(a, { kind: "power", reference: 250 });

        expect(r.zones[r.zones.length - 1]!.seconds).toBe(10);
        expect(r.zones[r.zones.length - 1]!.upper).toBeNull();
    });

    it("el 0 entra en la primera zona", () => {
        const a = build([[10, 0]]);
        const r = computeTimeInZones(a, { kind: "power", reference: 250 });

        expect(r.zones[0]!.seconds).toBe(10);
    });

    it("rechaza zonas con hueco entre ellas", () => {
        const a = build([[10, 100]]);
        expect(() =>
            computeTimeInZones(a, {
                kind: "custom",
                zones: [
                    { name: "A", lower: 0, upper: 100 },
                    { name: "B", lower: 150, upper: null },
                ],
            }),
        ).toThrow(/no contiguas/);
    });

    it("rechaza zonas solapadas", () => {
        const a = build([[10, 100]]);
        expect(() =>
            computeTimeInZones(a, {
                kind: "custom",
                zones: [
                    { name: "A", lower: 0, upper: 150 },
                    { name: "B", lower: 100, upper: null },
                ],
            }),
        ).toThrow(/no contiguas/);
    });

    it("rechaza que la última zona tenga tope", () => {
        const a = build([[10, 100]]);
        expect(() =>
            computeTimeInZones(a, {
                kind: "custom",
                zones: [{ name: "A", lower: 0, upper: 100 }],
            }),
        ).toThrow(/abierta/);
    });
});

describe("zones · modos", () => {
    it("acepta límites absolutos en vatios", () => {
        const a = build([
            [100, 50],
            [100, 150],
        ]);
        const r = computeTimeInZones(a, {
            kind: "power",
            zones: [
                { name: "baja", lower: 0, upper: 100 },
                { name: "alta", lower: 100, upper: null },
            ],
        });

        expect(r.zones[0]!.seconds).toBe(100);
        expect(r.zones[1]!.seconds).toBe(100);
    });

    it("calcula zonas de FC con la FC máxima como referencia", () => {
        const a = build([[600, 200, 90, 190]]);
        const r = computeTimeInZones(a, { kind: "heartrate", reference: 200 });

        expect(r.unit).toBe("bpm");
        expect(r.zones[r.zones.length - 1]!.seconds).toBe(600); // 190/200 = 95 %
    });

    it("sin FC no hay zonas de FC", () => {
        const a = buildAlignedStreams([0, 1, 2], { watts: [100, 100, 100] });
        const r = computeTimeInZones(a, { kind: "heartrate", reference: 190 });

        expect(r.available).toBe(false);
        expect(r.reason).toContain("frecuencia cardíaca");
    });

    it("sin referencia no se pueden usar las zonas relativas por defecto", () => {
        const a = build([[10, 100]]);
        const r = computeTimeInZones(a, { kind: "power" });

        expect(r.available).toBe(false);
        expect(r.reason).toContain("FTP");
    });

    it("incluye work_kj por zona cuando hay potencia", () => {
        const a = build([[100, 200]]);
        const r = computeTimeInZones(a, { kind: "power", reference: 250 });

        const conTiempo = r.zones.filter((z) => z.seconds > 0);
        expect(conTiempo).toHaveLength(1);
        expect(conTiempo[0]!.work_kj).toBeCloseTo(20, 3); // 100 s × 200 W = 20 kJ
    });

    it("las zonas por defecto son las 7 de Coggan", () => {
        expect(DEFAULT_POWER_ZONES_PCT_FTP).toHaveLength(7);
    });
});

describe("torqueCadence", () => {
    it("aplica la fórmula P / (2π × rpm/60)", () => {
        // 200 W a 90 rpm -> 200 / (2π*1.5) = 21.22 N·m
        expect(torqueNm(200, 90)).toBeCloseTo(21.221, 3);
    });

    it("agrupa en bins de 10 rpm por defecto", () => {
        const a = build([
            [60, 200, 85],
            [60, 200, 95],
        ]);
        const r = computeTorqueCadence(a);

        const b80 = r.bins.find((b) => b.lower_rpm === 80)!;
        const b90 = r.bins.find((b) => b.lower_rpm === 90)!;
        expect(b80.seconds).toBe(60);
        expect(b90.seconds).toBe(60);
        expect(b80.mean_torque_nm).toBeCloseTo(torqueNm(200, 85), 3);
    });

    it("excluye cadencia <= 0: la rueda libre no transmite par", () => {
        const a = build([
            [100, 200, 90],
            [100, 0, 0],
        ]);
        const r = computeTorqueCadence(a);

        expect(r.analysed_seconds).toBe(100);
        expect(r.excluded_seconds).toBe(100);
        // El bin 0-10 rpm no recoge los segundos de rueda libre.
        expect(r.bins[0]!.seconds).toBe(0);
    });

    it("el torque a cadencia baja es mayor que a cadencia alta con la misma potencia", () => {
        const a = build([
            [60, 250, 50],
            [60, 250, 100],
        ]);
        const r = computeTorqueCadence(a);

        const bajo = r.bins.find((b) => b.lower_rpm === 50)!;
        const alto = r.bins.find((b) => b.lower_rpm === 100)!;
        expect(bajo.mean_torque_nm!).toBeGreaterThan(alto.mean_torque_nm! * 1.9);
    });

    it("acepta bins configurables", () => {
        const a = build([[60, 200, 92]]);
        const r = computeTorqueCadence(a, { binWidthRpm: 5 });

        expect(r.bins.find((b) => b.lower_rpm === 90)!.seconds).toBe(60);
    });

    it("sin cadencia no está disponible", () => {
        const a = buildAlignedStreams([0, 1], { watts: [200, 200] });
        const r = computeTorqueCadence(a);

        expect(r.available).toBe(false);
        expect(r.reason).toContain("cadencia");
    });

    it("reporta trabajo por bin", () => {
        const a = build([[100, 200, 90]]);
        const r = computeTorqueCadence(a);

        expect(r.bins.find((b) => b.lower_rpm === 90)!.work_kj).toBeCloseTo(20, 3);
    });
});

describe("workAboveFtp", () => {
    const FTP = 250;

    it("reparte los segundos entre los tres rangos por defecto", () => {
        const a = build([
            [600, 200], // por debajo del FTP: fuera
            [300, 275], // 110 %
            [200, 325], // 130 %
            [100, 400], // 160 %
        ]);
        const r = computeWorkAboveFtp(a, { ftpW: FTP });

        expect(r.ranges[0]!.seconds).toBe(300);
        expect(r.ranges[1]!.seconds).toBe(200);
        expect(r.ranges[2]!.seconds).toBe(100);
    });

    it("distingue trabajo total del excedente sobre el FTP", () => {
        const a = build([[100, 350]]); // 140 % -> segundo rango
        const r = computeWorkAboveFtp(a, { ftpW: FTP });

        expect(r.ranges[1]!.work_kj).toBeCloseTo(35, 3); // 100 × 350 / 1000
        expect(r.ranges[1]!.work_above_ftp_kj).toBeCloseTo(10, 3); // 100 × 100 / 1000
    });

    it("cuenta esfuerzos separados", () => {
        const a = build([
            [60, 275],
            [120, 150],
            [60, 275],
        ]);
        const r = computeWorkAboveFtp(a, { ftpW: FTP });

        expect(r.ranges[0]!.effort_count).toBe(2);
        expect(r.ranges[0]!.mean_effort_duration_s).toBe(60);
        expect(r.ranges[0]!.max_effort_duration_s).toBe(60);
    });

    it("gap_tolerance_s une microcortes dentro de un mismo esfuerzo", () => {
        // 60 s a 110 % FTP, 2 s por debajo, 60 s arriba: con tolerancia 2 es UN esfuerzo.
        const a = build([
            [60, 275],
            [2, 100],
            [60, 275],
        ]);
        const r = computeWorkAboveFtp(a, { ftpW: FTP, gapToleranceS: 2 });

        expect(r.ranges[0]!.effort_count).toBe(1);
        // La duración cuenta solo los segundos dentro del rango, no el microcorte.
        expect(r.ranges[0]!.max_effort_duration_s).toBe(120);
    });

    it("caso límite: un corte de justo un segundo más que la tolerancia parte el esfuerzo", () => {
        const a = build([
            [60, 275],
            [3, 100],
            [60, 275],
        ]);
        const r = computeWorkAboveFtp(a, { ftpW: FTP, gapToleranceS: 2 });

        expect(r.ranges[0]!.effort_count).toBe(2);
        expect(r.ranges[0]!.max_effort_duration_s).toBe(60);
    });

    it("con tolerancia 0 cualquier corte parte el esfuerzo", () => {
        const a = build([
            [60, 275],
            [1, 100],
            [60, 275],
        ]);
        const r = computeWorkAboveFtp(a, { ftpW: FTP, gapToleranceS: 0 });

        expect(r.ranges[0]!.effort_count).toBe(2);
    });

    it("un tramo no válido rompe el esfuerzo aunque sea corto", () => {
        // Hueco de 10 s sin muestras en mitad de un esfuerzo.
        const a = build([[200, 275]], [[100, 10]]);
        const r = computeWorkAboveFtp(a, { ftpW: FTP, gapToleranceS: 30 });

        expect(r.ranges[0]!.effort_count).toBe(2);
    });

    it("rechaza un FTP no positivo", () => {
        const a = build([[10, 300]]);
        expect(() => computeWorkAboveFtp(a, { ftpW: 0 })).toThrow(/ftpW/);
    });

    it("sin potencia no está disponible", () => {
        const a = buildAlignedStreams([0, 1], { heartrate: [140, 141] });
        const r = computeWorkAboveFtp(a, { ftpW: FTP });

        expect(r.available).toBe(false);
    });

    it("las fronteras no cuentan un segundo dos veces", () => {
        // Exactamente 120 % -> frontera entre el primer y el segundo rango.
        const a = build([[100, 300]]);
        const r = computeWorkAboveFtp(a, { ftpW: FTP });

        const total = r.ranges.reduce((s, x) => s + x.seconds, 0);
        expect(total).toBe(100);
        expect(r.ranges[0]!.seconds).toBe(0); // 1.2 no entra en [1.0, 1.2)
        expect(r.ranges[1]!.seconds).toBe(100);
    });
});

describe("streamSummary", () => {
    it("resume media, máximo y mínimo sobre segundos válidos", () => {
        const a = build([
            [100, 200, 90, 140],
            [100, 200, 90, 160],
        ]);
        const hr = summariseSignal(a, "heartrate");

        expect(hr.available).toBe(true);
        expect(hr.seconds).toBe(200);
        expect(hr.mean).toBeCloseTo(150, 2);
        expect(hr.max).toBe(160);
        expect(hr.min).toBe(140);
    });

    it("excluye los tramos no válidos", () => {
        const a = build([[1800, 200, 90, 150]], [[600, 300]]);
        const hr = summariseSignal(a, "heartrate");

        expect(hr.seconds).toBe(1500);
    });

    it("la cadencia se resume sin los ceros de rueda libre", () => {
        const a = build([
            [100, 200, 90],
            [100, 0, 0],
        ]);
        const s = summariseHrAndCadence(a);

        // Con los ceros la media sería 45; sin ellos, 90.
        expect(s.cadence.mean).toBe(90);
        expect(s.cadence.seconds).toBe(100);
        expect(s.cadence.method).toContain("excluyen");
    });

    it("la FC sí incluye los ceros si los hubiera, por ser dato legítimo", () => {
        const a = build([[100, 200, 90, 150]]);
        const s = summariseHrAndCadence(a);
        expect(s.heartrate.method).toContain("incluyendo");
    });

    it("una señal ausente no está disponible", () => {
        const a = buildAlignedStreams([0, 1], { watts: [100, 100] });
        expect(summariseSignal(a, "heartrate").available).toBe(false);
    });
});
