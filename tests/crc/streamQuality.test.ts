import { describe, expect, it } from "vitest";

import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";
import { computeStreamQuality } from "../../src/crc/streams/streamQuality.ts";

describe("computeStreamQuality", () => {
    it("reporta cobertura total cuando no hay huecos", () => {
        const a = buildAlignedStreams([0, 1, 2, 3], { watts: [1, 2, 3, 4] });
        const q = computeStreamQuality(a, { deviceWatts: true });

        expect(q.valid_seconds).toBe(4);
        expect(q.total_seconds).toBe(4);
        expect(q.coverage_pct).toBe(100);
        expect(q.gap_count).toBe(0);
        expect(q.longest_gap_s).toBe(0);
        expect(q.unfilled_gaps).toEqual([]);
    });

    it("cuenta huecos, su duración y el más largo", () => {
        const a = buildAlignedStreams([0, 2, 12], { watts: [1, 2, 3] });
        const q = computeStreamQuality(a);

        expect(q.gap_count).toBe(2);
        expect(q.gap_seconds).toBe(10);
        expect(q.longest_gap_s).toBe(9);
        expect(q.unfilled_gaps).toHaveLength(1);
        expect(q.unfilled_gaps[0]!.duration_s).toBe(9);
        expect(q.valid_seconds).toBe(4);
        expect(q.coverage_pct).toBe(30.8);
    });

    it("marca la disponibilidad por señal", () => {
        const a = buildAlignedStreams([0, 1, 2], { watts: [1, 2, 3], heartrate: [140, 141, 142] });
        const q = computeStreamQuality(a, { deviceWatts: true });

        expect(q.signals["watts"]!.available).toBe(true);
        expect(q.signals["heartrate"]!.available).toBe(true);
        expect(q.signals["cadence"]!.available).toBe(false);
        expect(q.power_available).toBe(true);
        expect(q.heartrate_available).toBe(true);
    });
});

describe("computeStreamQuality · power_source", () => {
    it("measured cuando device_watts es true", () => {
        const a = buildAlignedStreams([0, 1], { watts: [200, 210] });
        expect(computeStreamQuality(a, { deviceWatts: true }).power_source).toBe("measured");
    });

    it("estimated cuando device_watts es false, con aviso", () => {
        const a = buildAlignedStreams([0, 1], { watts: [200, 210] });
        const q = computeStreamQuality(a, { deviceWatts: false });

        expect(q.power_source).toBe("estimated");
        expect(q.warnings.join(" ")).toContain("VO2max");
    });

    it("estimated por prudencia si device_watts es desconocido", () => {
        const a = buildAlignedStreams([0, 1], { watts: [200, 210] });
        const q = computeStreamQuality(a);

        expect(q.power_source).toBe("estimated");
        expect(q.warnings.join(" ")).toContain("device_watts");
    });

    it("none cuando no hay stream de potencia", () => {
        const a = buildAlignedStreams([0, 1], { heartrate: [140, 141] });
        const q = computeStreamQuality(a, { deviceWatts: true });

        expect(q.power_source).toBe("none");
        expect(q.power_available).toBe(false);
    });
});

describe("computeStreamQuality · warnings", () => {
    it("avisa cuando la cobertura cae por debajo del mínimo", () => {
        const a = buildAlignedStreams([0, 50], { watts: [100, 200] });
        const q = computeStreamQuality(a, { deviceWatts: true });

        expect(q.coverage_pct).toBeLessThan(80);
        expect(q.warnings.join(" ")).toContain("Cobertura");
    });

    it("arrastra los warnings de la alineación", () => {
        const a = buildAlignedStreams([0, 1, 1, 2], { watts: [1, 2, 9, 3] });
        const q = computeStreamQuality(a, { deviceWatts: true });

        expect(q.warnings.join(" ")).toContain("descartaron");
    });

    it("no avisa de cobertura con un mínimo relajado", () => {
        const a = buildAlignedStreams([0, 50], { watts: [100, 200] });
        const q = computeStreamQuality(a, { deviceWatts: true, minCoveragePct: 0 });

        expect(q.warnings.join(" ")).not.toContain("Cobertura");
    });
});
