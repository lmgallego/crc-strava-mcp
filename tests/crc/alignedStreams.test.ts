import { describe, expect, it } from "vitest";

import { buildAlignedStreams, DEFAULT_GAP_FILL_S } from "../../src/crc/streams/alignedStreams.ts";

describe("buildAlignedStreams · rejilla y alineación", () => {
    it("deja la rejilla a 1 s empezando en 0 y todas las señales con la misma longitud", () => {
        const a = buildAlignedStreams([0, 1, 2, 3], {
            watts: [100, 110, 120, 130],
            heartrate: [140, 141, 142, 143],
        });

        expect(a.time).toEqual([0, 1, 2, 3]);
        expect(a.watts).toHaveLength(4);
        expect(a.heartrate).toHaveLength(4);
        expect(a.valid).toEqual([true, true, true, true]);
        expect(a.meta.valid_seconds).toBe(4);
    });

    it("normaliza el offset cuando time no empieza en 0", () => {
        const a = buildAlignedStreams([10, 11, 12], { watts: [1, 2, 3] });

        expect(a.time).toEqual([0, 1, 2]);
        expect(a.meta.start_offset_s).toBe(10);
        expect(a.watts).toEqual([1, 2, 3]);
    });

    it("mantiene watts[i] y heartrate[i] en el mismo instante con muestreo irregular", () => {
        // Muestras en t = 0, 5, 10: dos huecos de 4 s.
        const a = buildAlignedStreams([0, 5, 10], {
            watts: [100, 200, 300],
            heartrate: [150, 160, 170],
        });

        expect(a.time).toHaveLength(11);
        // En cada ancla, ambas señales corresponden a la misma muestra original.
        expect(a.watts![0]).toBe(100);
        expect(a.heartrate![0]).toBe(150);
        expect(a.watts![5]).toBe(200);
        expect(a.heartrate![5]).toBe(160);
        expect(a.watts![10]).toBe(300);
        expect(a.heartrate![10]).toBe(170);
    });
});

describe("buildAlignedStreams · huecos", () => {
    it("rellena por interpolación un hueco corto (<= gap_fill_s) y lo cuenta como válido", () => {
        // Muestras en t = 0 y t = 3 -> hueco de 2 s, dentro del límite por defecto (3).
        const a = buildAlignedStreams([0, 3], { watts: [100, 400] });

        expect(a.valid).toEqual([true, true, true, true]);
        expect(a.meta.valid_seconds).toBe(4);
        expect(a.watts).toEqual([100, 200, 300, 400]);
        expect(a.meta.gaps).toEqual([{ from_s: 1, to_s: 2, duration_s: 2, filled: true }]);
    });

    it("marca no válido un hueco largo (> gap_fill_s) sin interpolar", () => {
        // Muestras en t = 0 y t = 10 -> hueco de 9 s.
        const a = buildAlignedStreams([0, 10], { watts: [100, 400] });

        expect(a.valid[0]).toBe(true);
        expect(a.valid[10]).toBe(true);
        for (let i = 1; i <= 9; i++) {
            expect(a.valid[i], `segundo ${i} debería ser no válido`).toBe(false);
        }
        expect(a.meta.valid_seconds).toBe(2);
        expect(a.meta.gaps[0]).toEqual({ from_s: 1, to_s: 9, duration_s: 9, filled: false });
        // No se inventa una rampa: se arrastra el último valor conocido.
        expect(a.watts!.slice(1, 10)).toEqual(new Array(9).fill(100));
        expect(a.meta.warnings.join(" ")).toContain("no válidos");
    });

    it("respeta un gap_fill_s personalizado", () => {
        const estricto = buildAlignedStreams([0, 3], { watts: [100, 400] }, { gapFillS: 1 });
        expect(estricto.valid).toEqual([true, false, false, true]);

        const laxo = buildAlignedStreams([0, 10], { watts: [100, 400] }, { gapFillS: 15 });
        expect(laxo.valid.every(Boolean)).toBe(true);
    });

    it("distingue varios huecos y los reporta por separado", () => {
        const a = buildAlignedStreams([0, 2, 12], { watts: [1, 2, 3] });

        expect(a.meta.gaps).toEqual([
            { from_s: 1, to_s: 1, duration_s: 1, filled: true },
            { from_s: 3, to_s: 11, duration_s: 9, filled: false },
        ]);
    });
});

describe("buildAlignedStreams · ceros legítimos", () => {
    it("trata el 0 como dato real, no como ausencia", () => {
        // Rueda libre: 0 W durante varios segundos, con FC alta.
        const a = buildAlignedStreams([0, 1, 2, 3], {
            watts: [250, 0, 0, 240],
            heartrate: [160, 159, 158, 158],
            cadence: [90, 0, 0, 88],
        });

        expect(a.watts).toEqual([250, 0, 0, 240]);
        expect(a.cadence).toEqual([90, 0, 0, 88]);
        expect(a.valid).toEqual([true, true, true, true]);
        // Un 0 no cuenta como muestra ausente ni como relleno.
        expect(a.meta.signals["watts"]).toEqual({
            present: true,
            missing_samples: 0,
            filled_seconds: 0,
        });
    });

    it("interpola correctamente hacia y desde cero", () => {
        const a = buildAlignedStreams([0, 2], { watts: [100, 0] });
        expect(a.watts).toEqual([100, 50, 0]);
    });
});

describe("buildAlignedStreams · señales ausentes y nulls", () => {
    it("omite las señales que no vienen y las marca present:false", () => {
        const a = buildAlignedStreams([0, 1, 2], { watts: [1, 2, 3] });

        expect(a.watts).toBeDefined();
        expect(a.heartrate).toBeUndefined();
        expect(a.cadence).toBeUndefined();
        expect(a.meta.signals["heartrate"]).toEqual({
            present: false,
            missing_samples: 0,
            filled_seconds: 0,
        });
    });

    it("rellena los nulls sueltos de una señal y los contabiliza", () => {
        const a = buildAlignedStreams([0, 1, 2], { heartrate: [150, null, 154] });

        expect(a.heartrate).toEqual([150, 152, 154]);
        expect(a.meta.signals["heartrate"]!.missing_samples).toBe(1);
        expect(a.meta.signals["heartrate"]!.present).toBe(true);
    });

    it("considera ausente una señal que viene entera a null", () => {
        const a = buildAlignedStreams([0, 1, 2], { watts: [null, null, null] });
        expect(a.meta.signals["watts"]!.present).toBe(false);
    });

    it("alinea moving arrastrando el último valor, sin interpolar", () => {
        const a = buildAlignedStreams([0, 4], { moving: [true, false] }, { gapFillS: 5 });
        expect(a.moving).toEqual([true, true, true, true, false]);
    });
});

describe("buildAlignedStreams · entradas inválidas", () => {
    it("rechaza un time vacío", () => {
        expect(() => buildAlignedStreams([], {})).toThrow(/time/);
    });

    it("rechaza un time sin muestras utilizables", () => {
        expect(() => buildAlignedStreams([null, undefined, NaN], {})).toThrow(/utilizable/);
    });

    it("descarta muestras que no avanzan en el tiempo y avisa", () => {
        const a = buildAlignedStreams([0, 1, 1, 0, 2], { watts: [10, 20, 99, 99, 30] });

        expect(a.time).toEqual([0, 1, 2]);
        expect(a.watts).toEqual([10, 20, 30]);
        expect(a.meta.warnings.join(" ")).toContain("descartaron");
    });

    it("rechaza un gapFillS inválido", () => {
        expect(() => buildAlignedStreams([0, 1], {}, { gapFillS: -1 })).toThrow(/gapFillS/);
        expect(() => buildAlignedStreams([0, 1], {}, { gapFillS: 1.5 })).toThrow(/gapFillS/);
    });

    it("el valor por defecto de gap_fill_s es 3 s", () => {
        expect(DEFAULT_GAP_FILL_S).toBe(3);
        expect(buildAlignedStreams([0, 1], {}).meta.gap_fill_s).toBe(3);
    });
});
