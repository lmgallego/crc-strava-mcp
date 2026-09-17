import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";
import { powerCurveTool, powerMetricsTool } from "../../src/crc/tools/powerTools.ts";
import type { ActivityStreams } from "../../src/crc/sources/strava.ts";

let streamsResult: ActivityStreams;

vi.mock("../../src/crc/sources/strava.ts", () => ({
    fetchActivityStreams: async () => streamsResult,
}));

/**
 * El perfil se redirige a un archivo temporal: las tools llaman a
 * `loadProfile()` sin argumento, que por defecto apunta al home del usuario.
 */
let profileFile = "";

vi.mock("../../src/crc/profile/profileStore.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/crc/profile/profileStore.ts")>();
    return {
        ...actual,
        loadProfile: (file?: string) => actual.loadProfile(file ?? profileFile),
    };
});

/** Serie constante de 180 W durante 20 min: NP = media = 180 por definición. */
const N = 1200;
const TIME = Array.from({ length: N }, (_, i) => i);
const WATTS = Array.from({ length: N }, () => 180);

/**
 * Se mockea la fuente entera, no axios: `fetchActivityStreams` cachea en disco
 * por activityId, así que con un mock de axios las llamadas siguientes leerían
 * la caché (y además escribirían en el ~/.config real del usuario).
 * La integración con Strava se prueba aparte, en stravaSource.test.ts.
 */
function mockStrava(opts: { deviceWatts?: boolean | null; watts?: number[] | null } = {}) {
    const watts = opts.watts === null ? undefined : (opts.watts ?? WATTS);
    streamsResult = {
        activity_id: "123",
        athlete_id: "42",
        device_watts: opts.deviceWatts === undefined ? true : opts.deviceWatts,
        start_date: "2026-06-15T09:00:00Z",
        aligned: buildAlignedStreams(TIME, watts ? { watts } : {}),
        from_cache: false,
        available_types: watts ? ["time", "watts"] : ["time"],
    };
}

function parse(result: { content: { text: string }[] }) {
    return JSON.parse(result.content[0]!.text);
}

let dir: string;
let prevToken: string | undefined;

beforeEach(async () => {
    prevToken = process.env.STRAVA_ACCESS_TOKEN;
    process.env.STRAVA_ACCESS_TOKEN = "test-token";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crc-power-"));
});

afterEach(async () => {
    process.env.STRAVA_ACCESS_TOKEN = prevToken;
    await fs.rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/** Perfil temporal con las métricas indicadas, vigente en 2026. */
async function useProfile(metrics: unknown[]) {
    const file = path.join(dir, "profile.json");
    await fs.writeFile(file, JSON.stringify({ metrics }), "utf8");
    profileFile = file;
}

const FTP_ENTRY = {
    metric: "ftp_w",
    value: 250,
    unit: "W",
    effective_from: "2026-01-01",
    effective_to: null,
    source: "manual",
};
const WEIGHT_ENTRY = {
    metric: "weight_kg",
    value: 72,
    unit: "kg",
    effective_from: "2026-01-01",
    effective_to: null,
    source: "manual",
};

describe("crc-calculate-power-metrics", () => {
    it("resuelve FTP y peso del perfil por la fecha de la actividad", async () => {
        mockStrava();
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const r = parse(await powerMetricsTool.execute({ activityId: "123" }));

        expect(r.inputs.ftp_w).toBe(250);
        expect(r.inputs.weight_kg).toBe(72);
        expect(r.inputs.parameter_sources.ftp_w.effective_from).toBe("2026-01-01");
        expect(r.metrics.normalized_power_w).toBeCloseTo(180, 1);
        expect(r.metrics.intensity_factor).toBeCloseTo(0.72, 3);
        expect(r.available).toBe(true);
    });

    it("el override explícito gana al perfil", async () => {
        mockStrava();
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const r = parse(await powerMetricsTool.execute({ activityId: "123", ftp_w: 200 }));

        expect(r.inputs.ftp_w).toBe(200);
        expect(r.inputs.parameter_sources.ftp_w.source).toBe("override");
        expect(r.metrics.intensity_factor).toBeCloseTo(0.9, 3);
    });

    it("sin FTP: MISSING_FTP y sin IF/TSS, pero NP, VI, media y kJ sí", async () => {
        mockStrava();
        await useProfile([WEIGHT_ENTRY]);

        const r = parse(await powerMetricsTool.execute({ activityId: "123" }));

        expect(r.errors.map((e: { code: string }) => e.code)).toContain("MISSING_FTP");
        expect(r.metrics.intensity_factor).toBeNull();
        expect(r.metrics.tss).toBeNull();
        // Lo que no depende del FTP se sigue devolviendo.
        expect(r.metrics.normalized_power_w).toBeCloseTo(180, 1);
        expect(r.metrics.average_power_w).toBeCloseTo(180, 1);
        expect(r.metrics.variability_index).toBeCloseTo(1, 2);
        expect(r.metrics.work_kj).toBeGreaterThan(0);
        // Módulo no disponible != isError.
        expect(r.available).toBe(true);
    });

    it("sin peso: no hay W/kg, el resto sí", async () => {
        mockStrava();
        await useProfile([FTP_ENTRY]);

        const r = parse(await powerMetricsTool.execute({ activityId: "123" }));

        expect(r.errors.map((e: { code: string }) => e.code)).toContain("MISSING_WEIGHT");
        expect(r.metrics.average_wkg).toBeNull();
        expect(r.metrics.tss).not.toBeNull();
        expect(r.metrics.normalized_power_w).toBeCloseTo(180, 1);
    });

    it("sin stream de potencia: MISSING_POWER con available:false, sin isError", async () => {
        mockStrava({ watts: null });
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const result = await powerMetricsTool.execute({ activityId: "123" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("MISSING_POWER");
        expect(result).not.toHaveProperty("isError");
    });

    it("declara que la duración del TSS son segundos válidos", async () => {
        mockStrava();
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const r = parse(await powerMetricsTool.execute({ activityId: "123" }));

        expect(r.inputs.duration_basis).toBe("segundos válidos");
        expect(r.inputs.duration_s).toBe(N);
    });

    it("con potencia estimada sí calcula NP (solo la curva lo prohíbe)", async () => {
        mockStrava({ deviceWatts: false });
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const r = parse(await powerMetricsTool.execute({ activityId: "123" }));

        expect(r.available).toBe(true);
        expect(r.metrics.normalized_power_w).toBeCloseTo(180, 1);
        expect(r.quality.power_source).toBe("estimated");
    });
});

describe("crc-power-curve", () => {
    it("devuelve la mejor media por duración con W/kg", async () => {
        mockStrava();
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const r = parse(
            await powerCurveTool.execute({ activityId: "123", durations_s: [60, 300] }),
        );

        expect(r.metrics.power_curve["60"].best_power_w).toBeCloseTo(180, 1);
        expect(r.metrics.power_curve["60"].best_power_wkg).toBeCloseTo(2.5, 2);
        expect(r.metrics.power_curve["300"].start_time_s).toBe(0);
        expect(r.metrics.power_curve["300"].end_time_s).toBe(299);
    });

    it("rechaza la potencia estimada (D8)", async () => {
        mockStrava({ deviceWatts: false });
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const result = await powerCurveTool.execute({ activityId: "123" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("MISSING_POWER");
        expect(r.errors[0].message).toContain("estimated");
        expect(result).not.toHaveProperty("isError");
    });

    it("rechaza también cuando device_watts es desconocido", async () => {
        mockStrava({ deviceWatts: null });
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const r = parse(await powerCurveTool.execute({ activityId: "123" }));
        expect(r.available).toBe(false);
    });

    it("sin peso funciona igual pero sin W/kg", async () => {
        mockStrava();
        await useProfile([FTP_ENTRY]);

        const r = parse(await powerCurveTool.execute({ activityId: "123", durations_s: [60] }));

        expect(r.metrics.power_curve["60"].best_power_w).toBeCloseTo(180, 1);
        expect(r.metrics.power_curve["60"].best_power_wkg).toBeNull();
    });

    it("no exige FTP: no aparece MISSING_FTP", async () => {
        mockStrava();
        await useProfile([WEIGHT_ENTRY]);

        const r = parse(await powerCurveTool.execute({ activityId: "123", durations_s: [60] }));

        expect(r.errors.map((e: { code: string }) => e.code)).not.toContain("MISSING_FTP");
    });

    it("marca available:false en duraciones más largas que la actividad", async () => {
        mockStrava();
        await useProfile([FTP_ENTRY, WEIGHT_ENTRY]);

        const r = parse(await powerCurveTool.execute({ activityId: "123", durations_s: [5400] }));

        expect(r.metrics.power_curve["5400"].available).toBe(false);
        expect(r.metrics.power_curve["5400"].best_power_w).toBeNull();
    });
});
