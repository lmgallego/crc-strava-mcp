import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";
import type { ActivityStreams } from "../../src/crc/sources/strava.ts";
import { estimateFtpTool, estimateVo2maxTool } from "../../src/crc/tools/estimateTools.ts";
import { powerMetricsTool } from "../../src/crc/tools/powerTools.ts";

let streamsResult: ActivityStreams;
let profileFile = "";

vi.mock("../../src/crc/sources/strava.ts", () => ({
    fetchActivityStreams: async () => streamsResult,
    stravaBestEffortProviders: () => ({
        listActivities: async () => [],
        loadStreams: async () => {
            throw new Error("sin red en tests");
        },
    }),
}));

vi.mock("../../src/crc/profile/profileStore.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/crc/profile/profileStore.ts")>();
    return { ...actual, loadProfile: (f?: string) => actual.loadProfile(f ?? profileFile) };
});

/** 30 min: 10 a 200 W, 5 a 360 W (el mejor 5 min) y 15 a 200 W. */
function setStreams(opts: { deviceWatts?: boolean | null; date?: string } = {}) {
    const blocks: [number, number][] = [
        [600, 200],
        [300, 360],
        [900, 200],
    ];
    const time: number[] = [];
    const watts: number[] = [];
    let t = 0;
    for (const [dur, w] of blocks) {
        for (let i = 0; i < dur; i++) {
            time.push(t++);
            watts.push(w);
        }
    }
    streamsResult = {
        activity_id: "500",
        athlete_id: "42",
        device_watts: opts.deviceWatts === undefined ? true : opts.deviceWatts,
        start_date: opts.date ?? "2026-06-15T09:00:00Z",
        aligned: buildAlignedStreams(time, { watts }),
        from_cache: false,
        available_types: ["time", "watts"],
    };
}

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

const weightEntry = (value: number, from: string, to: string | null = null) => ({
    metric: "weight_kg",
    value,
    unit: "kg",
    effective_from: from,
    effective_to: to,
    source: "manual",
});

let dir: string;
let prevToken: string | undefined;

beforeEach(async () => {
    prevToken = process.env.STRAVA_ACCESS_TOKEN;
    process.env.STRAVA_ACCESS_TOKEN = "test-token";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crc-est-"));
    setStreams();
    await useProfile([weightEntry(72, "2026-01-01")]);
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

describe("crc-estimate-vo2max", () => {
    it("calcula el VO2max del mejor 5 min de la actividad", async () => {
        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.available).toBe(true);
        // 360 W / 72 kg = 5 W/kg -> 60.95
        expect(r.metrics.best_5min_power_w).toBeCloseTo(360, 1);
        expect(r.metrics.relative_power_wkg).toBeCloseTo(5, 3);
        expect(r.metrics.estimated_vo2max).toBeCloseTo(60.95, 2);
        expect(r.metrics.effort_start).toBe(600);
    });

    it("etiqueta siempre como estimación y registra la referencia", async () => {
        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.metrics.label).toBe("estimated_vo2max");
        expect(r.metrics).not.toHaveProperty("lab_vo2max");
        expect(r.metrics.model_reference).toBeTruthy();
    });

    it("quality advierte de que el mejor 5 min no es un test máximo", async () => {
        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.quality.maximal_effort_evidence).toBe(false);
        expect(r.quality.warnings.join(" ")).toContain("NO equivale");
    });

    it("usa el peso vigente en la FECHA DEL ESFUERZO, no el actual", async () => {
        // Pesaba 80 kg cuando hizo la actividad; hoy pesa 70.
        await useProfile([
            weightEntry(80, "2026-01-01", "2026-06-30"),
            weightEntry(70, "2026-07-01"),
        ]);
        setStreams({ date: "2026-06-15T09:00:00Z" });

        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.metrics.weight_kg).toBe(80);
        expect(r.metrics.relative_power_wkg).toBeCloseTo(4.5, 3);
        expect(r.inputs.weight_source.effective_from).toBe("2026-01-01");
    });

    it("sin peso vigente para esa fecha: MISSING_WEIGHT", async () => {
        await useProfile([weightEntry(72, "2026-08-01")]); // posterior a la actividad
        const result = await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("MISSING_WEIGHT");
        expect(result).not.toHaveProperty("isError");
    });

    it("rechaza la potencia estimada", async () => {
        setStreams({ deviceWatts: false });
        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("MISSING_POWER");
    });

    it("el override de peso evita consultar el perfil", async () => {
        await useProfile([]);
        const r = parse(
            await estimateVo2maxTool.execute({
                mode: "activity",
                activityId: "500",
                weight_kg: 60,
            }),
        );

        expect(r.metrics.weight_kg).toBe(60);
        expect(r.metrics.relative_power_wkg).toBeCloseTo(6, 3);
    });
});

describe("crc-estimate-ftp · D12", () => {
    it("propone el FTP como mejor 20 min × 0,95", async () => {
        const r = parse(await estimateFtpTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.available).toBe(true);
        // Mejor 20 min de la serie: 1200 s que incluyen los 300 s a 360 W.
        // (600·200 + 300·360 + 300·200)/1200 = 240 W -> 240 × 0.95 = 228
        expect(r.metrics.best_20min_power_w).toBeCloseTo(240, 1);
        expect(r.metrics.estimated_ftp_w).toBeCloseTo(228, 1);
    });

    it("NO PERSISTE: el perfil sigue intacto tras llamarla", async () => {
        await useProfile([weightEntry(72, "2026-01-01")]);
        const antes = await fs.readFile(path.join(dir, "profile.json"), "utf8");

        await estimateFtpTool.execute({ mode: "activity", activityId: "500" });

        const despues = await fs.readFile(path.join(dir, "profile.json"), "utf8");
        expect(despues).toBe(antes);
        expect(JSON.parse(despues).metrics.some((m: { metric: string }) => m.metric === "ftp_w")).toBe(
            false,
        );
    });

    it("marca persisted:false y dice cómo guardarlo", async () => {
        const r = parse(await estimateFtpTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.metrics.persisted).toBe(false);
        expect(r.metrics.to_persist.tool).toBe("crc-set-performance-profile");
        expect(r.metrics.to_persist.source).toBe("estimated_20min");
        expect(r.metrics.to_persist.metric).toBe("ftp_w");
    });

    it("la herramienta no expone ninguna vía de escritura", async () => {
        // El contrato no admite nada parecido a "guardar".
        const keys = Object.keys(estimateFtpTool.inputSchema.shape);
        for (const prohibido of ["save", "persist", "write", "overwrite", "confirm"]) {
            expect(keys).not.toContain(prohibido);
        }
    });

    it("devuelve la actividad y la fecha de origen", async () => {
        const r = parse(await estimateFtpTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.metrics.source_activity_id).toBe("500");
        expect(r.metrics.effort_date).toBe("2026-06-15T09:00:00Z");
        expect(r.metrics.to_persist.effective_from).toBe("2026-06-15");
    });

    it("avisa de que el mejor 20 min no es un test de 20 minutos", async () => {
        const r = parse(await estimateFtpTool.execute({ mode: "activity", activityId: "500" }));
        expect(r.quality.warnings.join(" ")).toContain("NO es un test");
    });

    it("rechaza la potencia estimada", async () => {
        setStreams({ deviceWatts: false });
        const r = parse(await estimateFtpTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("MISSING_POWER");
    });
});

describe("propagación del FTP estimado (D12)", () => {
    const ftpEntry = (source: string) => ({
        metric: "ftp_w",
        value: 250,
        unit: "W",
        effective_from: "2026-01-01",
        effective_to: null,
        source,
    });

    it("powerMetrics marca ftp_estimated y avisa cuando viene de estimated_20min", async () => {
        await useProfile([ftpEntry("estimated_20min"), weightEntry(72, "2026-01-01")]);
        const r = parse(await powerMetricsTool.execute({ activityId: "500" }));

        expect(r.quality.ftp_estimated).toBe(true);
        expect(r.quality.warnings.join(" ")).toContain("ESTIMACIÓN");
        // IF y TSS se calculan igual, pero quedan marcados.
        expect(r.metrics.intensity_factor).not.toBeNull();
        expect(r.metrics.tss).not.toBeNull();
    });

    it("con un FTP manual no marca nada", async () => {
        await useProfile([ftpEntry("manual"), weightEntry(72, "2026-01-01")]);
        const r = parse(await powerMetricsTool.execute({ activityId: "500" }));

        expect(r.quality.ftp_estimated).toBe(false);
        expect(r.quality.warnings.join(" ")).not.toContain("ESTIMACIÓN");
    });

    it("un FTP pasado por override tampoco se marca como estimado", async () => {
        await useProfile([weightEntry(72, "2026-01-01")]);
        const r = parse(await powerMetricsTool.execute({ activityId: "500", ftp_w: 250 }));

        expect(r.quality.ftp_estimated).toBe(false);
    });
});

describe("crc-estimate-vo2max · límites del modelo (D28)", () => {
    it("quality incluye las dos limitaciones del estudio", async () => {
        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.quality.model_limitations).toHaveLength(2);
        const texto = r.quality.model_limitations.join(" ");
        expect(texto).toContain("VARONES");
        expect(texto).toContain("0,61-0,77");
    });

    it("las limitaciones también viajan en warnings", async () => {
        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));
        expect(r.quality.warnings.join(" ")).toContain("46 ciclistas");
    });

    it("model_reference lleva la cita completa verificada", async () => {
        const r = parse(await estimateVo2maxTool.execute({ mode: "activity", activityId: "500" }));

        expect(r.metrics.model_reference).toContain("Sitko");
        expect(r.metrics.model_reference).toContain("PMID 34225254");
        expect(r.metrics.model_reference).not.toContain("pendiente");
    });
});
