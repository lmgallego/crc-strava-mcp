import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";
import type { ActivityStreams } from "../../src/crc/sources/strava.ts";
import {
    decouplingTool,
    timeInZonesTool,
    torqueCadenceTool,
    workAboveFtpTool,
} from "../../src/crc/tools/physiologyTools.ts";

let streamsResult: ActivityStreams;
let profileFile = "";

// La fuente se mockea entera: cachea en disco y contaminaría el ~/.config real.
vi.mock("../../src/crc/sources/strava.ts", () => ({
    fetchActivityStreams: async () => streamsResult,
}));

vi.mock("../../src/crc/profile/profileStore.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/crc/profile/profileStore.ts")>();
    return { ...actual, loadProfile: (f?: string) => actual.loadProfile(f ?? profileFile) };
});

/** 40 min a 200 W, 90 rpm, con FC que deriva de 140 a 150. */
function setStreams(
    opts: { watts?: boolean; hr?: boolean; cadence?: boolean; deviceWatts?: boolean | null } = {},
) {
    const n = 2400;
    const time = Array.from({ length: n }, (_, i) => i);
    const watts = Array.from({ length: n }, () => 200);
    const cadence = Array.from({ length: n }, () => 90);
    const hr = Array.from({ length: n }, (_, i) => (i < n / 2 ? 140 : 150));

    streamsResult = {
        activity_id: "123",
        athlete_id: "42",
        device_watts: opts.deviceWatts === undefined ? true : opts.deviceWatts,
        start_date: "2026-06-15T09:00:00Z",
        aligned: buildAlignedStreams(time, {
            watts: opts.watts === false ? undefined : watts,
            heartrate: opts.hr === false ? undefined : hr,
            cadence: opts.cadence === false ? undefined : cadence,
        }),
        from_cache: false,
        available_types: ["time", "watts", "heartrate", "cadence"],
    };
}

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

const FTP_ENTRY = {
    metric: "ftp_w",
    value: 250,
    unit: "W",
    effective_from: "2026-01-01",
    effective_to: null,
    source: "manual",
};
const LTHR_ENTRY = {
    metric: "hr_threshold_bpm",
    value: 165,
    unit: "bpm",
    effective_from: "2026-01-01",
    effective_to: null,
    source: "manual",
};
const HRMAX_ENTRY = {
    metric: "hr_max_bpm",
    value: 190,
    unit: "bpm",
    effective_from: "2026-01-01",
    effective_to: null,
    source: "manual",
};

let dir: string;
let prevToken: string | undefined;

beforeEach(async () => {
    prevToken = process.env.STRAVA_ACCESS_TOKEN;
    process.env.STRAVA_ACCESS_TOKEN = "test-token";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crc-fisio-"));
    setStreams();
    await useProfile([FTP_ENTRY, HRMAX_ENTRY, LTHR_ENTRY]);
});

afterEach(async () => {
    process.env.STRAVA_ACCESS_TOKEN = prevToken;
    await fs.rm(dir, { recursive: true, force: true });
});

async function useProfile(metrics: unknown[]) {
    const file = path.join(dir, "profile.json");
    await fs.writeFile(file, JSON.stringify({ metrics }), "utf8");
    profileFile = file;
}

describe("crc-aerobic-decoupling", () => {
    it("calcula el desacople y declara los filtros", async () => {
        const r = parse(await decouplingTool.execute({ activityId: "123" }));

        expect(r.available).toBe(true);
        // EF1 = 200/140, EF2 = 200/150 -> 6.667 %
        expect(r.metrics.decoupling_pct).toBeCloseTo(6.6667, 2);
        expect(r.inputs.filters.hr_lag_applied).toBe(false);
        expect(r.quality.first_half_seconds).toBe(1200);
    });

    it("no interpreta el resultado en las métricas", async () => {
        const r = parse(await decouplingTool.execute({ activityId: "123" }));
        const texto = JSON.stringify(r.metrics).toLowerCase();

        expect(texto).not.toContain("fatiga");
        expect(texto).not.toContain("adaptaci");
    });

    it("sin FC no está disponible: MISSING_HR", async () => {
        setStreams({ hr: false });
        const result = await decouplingTool.execute({ activityId: "123" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("MISSING_HR");
        expect(result).not.toHaveProperty("isError");
    });

    it("los filtros relativos al FTP lo resuelven del perfil", async () => {
        const r = parse(
            await decouplingTool.execute({ activityId: "123", power_min_pct_ftp: 0.5 }),
        );

        expect(r.inputs.ftp_w).toBe(250);
        expect(r.inputs.filters.power_min_w).toBe(125);
    });

    it("sin FTP vigente, los filtros relativos dan MISSING_FTP", async () => {
        await useProfile([]);
        const r = parse(
            await decouplingTool.execute({ activityId: "123", power_min_pct_ftp: 0.5 }),
        );

        expect(r.errors.map((e: { code: string }) => e.code)).toContain("MISSING_FTP");
    });

    it("sin filtros de potencia NO exige FTP", async () => {
        await useProfile([]);
        const r = parse(await decouplingTool.execute({ activityId: "123" }));

        expect(r.available).toBe(true);
        expect(r.metrics.decoupling_pct).toBeCloseTo(6.6667, 2);
    });
});

describe("crc-time-in-zones", () => {
    it("reparte el tiempo en zonas de potencia con el FTP del perfil", async () => {
        const r = parse(await timeInZonesTool.execute({ activityId: "123" }));

        expect(r.available).toBe(true);
        expect(r.inputs.reference).toBe(250);
        const suma = r.metrics.zones.reduce((s: number, z: { seconds: number }) => s + z.seconds, 0);
        expect(suma).toBe(r.metrics.classified_seconds);
    });

    it("las zonas de FC se anclan al UMBRAL, no a la FC máxima", async () => {
        await useProfile([FTP_ENTRY, HRMAX_ENTRY, LTHR_ENTRY]);
        const r = parse(await timeInZonesTool.execute({ activityId: "123", kind: "heartrate" }));

        expect(r.available).toBe(true);
        expect(r.inputs.unit).toBe("bpm");
        expect(r.inputs.reference).toBe(165);
        expect(r.inputs.reference_metric).toBe("hr_threshold_bpm");
        // La FC máxima solo cierra la Z5 por arriba.
        expect(r.inputs.hr_max_bpm).toBe(190);
    });

    it("sin umbral en el perfil: MISSING_HR_THRESHOLD", async () => {
        await useProfile([FTP_ENTRY, HRMAX_ENTRY]);
        const result = await timeInZonesTool.execute({ activityId: "123", kind: "heartrate" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors.map((e: { code: string }) => e.code)).toContain("MISSING_HR_THRESHOLD");
        expect(result).not.toHaveProperty("isError");
    });

    it("las zonas absolutas funcionan sin FTP: no dan MISSING_FTP", async () => {
        await useProfile([]);
        const r = parse(
            await timeInZonesTool.execute({
                activityId: "123",
                zones: [
                    { name: "baja", lower: 0, upper: 150 },
                    { name: "alta", lower: 150, upper: null },
                ],
            }),
        );

        expect(r.available).toBe(true);
        expect(r.errors).toEqual([]);
        expect(r.metrics.zones[1].seconds).toBe(2400);
    });

    it("las zonas relativas sin FTP dan MISSING_FTP", async () => {
        await useProfile([]);
        const result = await timeInZonesTool.execute({ activityId: "123" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors.map((e: { code: string }) => e.code)).toContain("MISSING_FTP");
        expect(result).not.toHaveProperty("isError");
    });

    it("sin FC no hay zonas de FC", async () => {
        setStreams({ hr: false });
        const r = parse(await timeInZonesTool.execute({ activityId: "123", kind: "heartrate" }));

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("MISSING_HR");
    });
});

describe("crc-torque-cadence", () => {
    it("funciona sin FTP ni peso", async () => {
        await useProfile([]);
        const r = parse(await torqueCadenceTool.execute({ activityId: "123" }));

        expect(r.available).toBe(true);
        expect(r.errors).toEqual([]);
        const bin90 = r.metrics.bins.find((b: { lower_rpm: number }) => b.lower_rpm === 90);
        expect(bin90.seconds).toBe(2400);
        expect(bin90.mean_torque_nm).toBeCloseTo(21.221, 2);
    });

    it("acepta bins configurables", async () => {
        const r = parse(
            await torqueCadenceTool.execute({ activityId: "123", bin_width_rpm: 5 }),
        );
        expect(r.inputs.bin_width_rpm).toBe(5);
    });

    it("sin cadencia no está disponible", async () => {
        setStreams({ cadence: false });
        const result = await torqueCadenceTool.execute({ activityId: "123" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(result).not.toHaveProperty("isError");
    });
});

describe("crc-work-above-ftp", () => {
    it("usa el FTP del perfil y reparte por rangos", async () => {
        const r = parse(await workAboveFtpTool.execute({ activityId: "123" }));

        expect(r.available).toBe(true);
        expect(r.inputs.ftp_w).toBe(250);
        // 200 W está por debajo del FTP: ningún rango acumula tiempo.
        expect(r.metrics.ranges.every((x: { seconds: number }) => x.seconds === 0)).toBe(true);
    });

    it("sin FTP vigente: MISSING_FTP y available:false", async () => {
        await useProfile([]);
        const result = await workAboveFtpTool.execute({ activityId: "123" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors.map((e: { code: string }) => e.code)).toContain("MISSING_FTP");
        expect(result).not.toHaveProperty("isError");
    });

    it("el override de FTP evita consultar el perfil", async () => {
        await useProfile([]);
        const r = parse(await workAboveFtpTool.execute({ activityId: "123", ftp_w: 150 }));

        expect(r.available).toBe(true);
        // 200 W con FTP 150 = 133 % -> segundo rango.
        expect(r.metrics.ranges[1].seconds).toBe(2400);
        expect(r.inputs.parameter_sources.ftp_w.source).toBe("override");
    });

    it("declara gap_tolerance_s en inputs", async () => {
        const r = parse(
            await workAboveFtpTool.execute({ activityId: "123", gap_tolerance_s: 5 }),
        );
        expect(r.inputs.gap_tolerance_s).toBe(5);
    });
});
