import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";
import type { ActivityStreams } from "../../src/crc/sources/strava.ts";
import {
    analyzeCyclingActivityTool,
    compareActivitiesTool,
} from "../../src/crc/tools/orchestrationTools.ts";

/** Actividades disponibles para los mocks, por id. */
let catalogo: Record<string, ActivityStreams> = {};
let profileFile = "";
let athleteId: string | number = 42;
/** Cuántas veces se ha pedido cada actividad: verifica el uso de caché. */
let fetchCalls: string[] = [];

vi.mock("../../src/crc/sources/strava.ts", () => ({
    fetchActivityStreams: async (id: string) => {
        fetchCalls.push(id);
        const a = catalogo[id];
        if (!a) throw new Error(`Actividad ${id} no encontrada`);
        return a;
    },
}));

vi.mock("../../src/stravaClient.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/stravaClient.ts")>();
    return { ...actual, getAuthenticatedAthlete: async () => ({ id: athleteId }) };
});

vi.mock("../../src/crc/profile/profileStore.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/crc/profile/profileStore.ts")>();
    return { ...actual, loadProfile: (f?: string) => actual.loadProfile(f ?? profileFile) };
});

/**
 * Actividad sintética de 30 min a 200 W, 90 rpm, FC 140->150, con un perfil de
 * altitud que incluye una subida al 6 % en la primera mitad (para que el módulo
 * de subidas tenga datos con los que trabajar).
 */
function makeActivity(
    id: string,
    opts: {
        date?: string;
        athlete?: string;
        watts?: boolean;
        hr?: boolean;
        cadence?: boolean;
        elevation?: boolean;
        power?: number;
        deviceWatts?: boolean | null;
    } = {},
): ActivityStreams {
    const n = 1800;
    const time = Array.from({ length: n }, (_, i) => i);
    const power = opts.power ?? 200;
    const watts = Array.from({ length: n }, () => power);
    const cadence = Array.from({ length: n }, () => 90);
    const hr = Array.from({ length: n }, (_, i) => (i < n / 2 ? 140 : 150));
    // 5 m/s. Sube al 6 % la primera mitad y llanea el resto.
    const distance = Array.from({ length: n }, (_, i) => i * 5);
    const altitude = Array.from({ length: n }, (_, i) =>
        i < n / 2 ? 100 + i * 5 * 0.06 : 100 + (n / 2) * 5 * 0.06,
    );

    return {
        activity_id: id,
        athlete_id: opts.athlete ?? "42",
        device_watts: opts.deviceWatts === undefined ? true : opts.deviceWatts,
        start_date: opts.date ?? "2026-06-15T09:00:00Z",
        details: {
            name: `Actividad ${id}`,
            sport_type: "Ride",
            distance_m: 30000,
            moving_time_s: n,
            elapsed_time_s: n,
            total_elevation_gain_m: 300,
            trainer: false,
        },
        aligned: buildAlignedStreams(time, {
            watts: opts.watts === false ? undefined : watts,
            heartrate: opts.hr === false ? undefined : hr,
            cadence: opts.cadence === false ? undefined : cadence,
            distance: opts.elevation === false ? undefined : distance,
            altitude: opts.elevation === false ? undefined : altitude,
        }),
        from_cache: false,
        available_types: ["time", "watts", "heartrate", "cadence"],
    };
}

const parse = (r: { content: { text: string }[] }) => JSON.parse(r.content[0]!.text);

const entry = (metric: string, value: number, unit: string, from: string, to: string | null = null) => ({
    metric,
    value,
    unit,
    effective_from: from,
    effective_to: to,
    source: "manual",
});

let dir: string;
let prevToken: string | undefined;

beforeEach(async () => {
    prevToken = process.env.STRAVA_ACCESS_TOKEN;
    process.env.STRAVA_ACCESS_TOKEN = "test-token";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crc-orq-"));
    catalogo = { "1": makeActivity("1") };
    athleteId = 42;
    fetchCalls = [];
    await useProfile([
        entry("ftp_w", 250, "W", "2026-01-01"),
        entry("weight_kg", 72, "kg", "2026-01-01"),
        entry("hr_max_bpm", 190, "bpm", "2026-01-01"),
    ]);
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

describe("crc-analyze-cycling-activity", () => {
    it("compone todos los módulos con datos completos", async () => {
        const r = parse(await analyzeCyclingActivityTool.execute({ activityId: "1" }));
        const m = r.metrics.modules;

        expect(r.available).toBe(true);
        expect(m.activity_details.available).toBe(true);
        expect(m.activity_details.name).toBe("Actividad 1");
        expect(m.power_metrics.available).toBe(true);
        expect(m.heartrate_summary.available).toBe(true);
        expect(m.cadence_summary.available).toBe(true);
        expect(m.power_zones.available).toBe(true);
        expect(m.heartrate_zones.available).toBe(true);
        expect(m.decoupling.available).toBe(true);
        expect(m.climbs.available).toBe(true);
        expect(m.climbs.climb_count).toBeGreaterThan(0);
        expect(r.quality.modules_available).toBe(r.quality.modules_total);
    });

    it("una actividad SIN FC sigue devolviendo todo lo demás", async () => {
        catalogo["1"] = makeActivity("1", { hr: false });
        const result = await analyzeCyclingActivityTool.execute({ activityId: "1" });
        const r = parse(result);
        const m = r.metrics.modules;

        // Lo que depende de la FC queda no disponible...
        expect(m.heartrate_summary.available).toBe(false);
        expect(m.heartrate_zones.available).toBe(false);
        expect(m.decoupling.available).toBe(false);

        // ...y el resto se devuelve igual.
        expect(m.power_metrics.available).toBe(true);
        expect(m.power_metrics.normalized_power_w).toBeCloseTo(200, 1);
        expect(m.power_metrics.tss).not.toBeNull();
        expect(m.cadence_summary.available).toBe(true);
        expect(m.power_zones.available).toBe(true);
        expect(m.activity_details.available).toBe(true);

        // El análisis global sigue siendo válido y no usa isError.
        expect(r.available).toBe(true);
        expect(result).not.toHaveProperty("isError");
    });

    it("sin FTP vigente devuelve NP, kJ y VI pero no IF ni TSS", async () => {
        await useProfile([entry("weight_kg", 72, "kg", "2026-01-01")]);
        const r = parse(await analyzeCyclingActivityTool.execute({ activityId: "1" }));
        const pm = r.metrics.modules.power_metrics;

        expect(pm.available).toBe(true);
        expect(pm.normalized_power_w).toBeCloseTo(200, 1);
        expect(pm.work_kj).toBeGreaterThan(0);
        expect(pm.variability_index).toBeCloseTo(1, 2);

        expect(pm.intensity_factor).toBeNull();
        expect(pm.tss).toBeNull();
        expect(pm.unavailable_metrics).toEqual(["intensity_factor", "tss"]);

        // Las zonas de potencia también necesitan FTP.
        expect(r.metrics.modules.power_zones.available).toBe(false);
        expect(r.errors.map((e: { code: string }) => e.code)).toContain("MISSING_FTP");
    });

    it("quality agrega las advertencias de cada módulo", async () => {
        catalogo["1"] = makeActivity("1", { hr: false });
        const r = parse(await analyzeCyclingActivityTool.execute({ activityId: "1" }));
        const texto = r.quality.warnings.join(" ");

        expect(texto).toContain("heartrate_summary");
        expect(texto).toContain("decoupling");
    });

    it("propaga el aviso de FTP estimado al quality del conjunto", async () => {
        await useProfile([
            {
                metric: "ftp_w",
                value: 250,
                unit: "W",
                effective_from: "2026-01-01",
                effective_to: null,
                source: "estimated_20min",
            },
            entry("weight_kg", 72, "kg", "2026-01-01"),
        ]);
        const r = parse(await analyzeCyclingActivityTool.execute({ activityId: "1" }));

        expect(r.quality.ftp_estimated).toBe(true);
        expect(r.quality.warnings.join(" ")).toContain("ESTIMACIÓN");
    });

    it("sin altitud, el módulo de subidas queda no disponible y el resto sigue", async () => {
        catalogo["1"] = makeActivity("1", { elevation: false });
        const r = parse(await analyzeCyclingActivityTool.execute({ activityId: "1" }));

        expect(r.metrics.modules.climbs.available).toBe(false);
        expect(r.metrics.modules.climbs.reason).toContain("altitud");
        expect(r.metrics.modules.power_metrics.available).toBe(true);
        expect(r.metrics.modules.decoupling.available).toBe(true);
        expect(r.available).toBe(true);
    });

    it("una actividad sin potencia mantiene FC y cadencia", async () => {
        catalogo["1"] = makeActivity("1", { watts: false });
        const r = parse(await analyzeCyclingActivityTool.execute({ activityId: "1" }));
        const m = r.metrics.modules;

        expect(m.power_metrics.available).toBe(false);
        expect(m.decoupling.available).toBe(false);
        expect(m.heartrate_summary.available).toBe(true);
        expect(m.heartrate_zones.available).toBe(true);
        expect(m.cadence_summary.available).toBe(true);
    });
});

describe("crc-compare-activities", () => {
    beforeEach(() => {
        catalogo = {
            "1": makeActivity("1", { date: "2026-02-10T09:00:00Z", power: 200 }),
            "2": makeActivity("2", { date: "2026-08-10T09:00:00Z", power: 200 }),
        };
    });

    it("cada actividad usa el FTP vigente EN SU FECHA, no el actual", async () => {
        // FTP 200 hasta junio, 250 a partir de julio.
        await useProfile([
            entry("ftp_w", 200, "W", "2026-01-01", "2026-06-30"),
            entry("ftp_w", 250, "W", "2026-07-01"),
            entry("weight_kg", 72, "kg", "2026-01-01"),
        ]);

        const r = parse(await compareActivitiesTool.execute({ activityIds: ["1", "2"] }));
        const [a1, a2] = r.metrics.activities;

        expect(a1.ftp_w).toBe(200);
        expect(a2.ftp_w).toBe(250);

        // Misma potencia (200 W) pero distinto FTP -> distinto IF.
        expect(a1.metrics.intensity_factor.value).toBeCloseTo(1.0, 2);
        expect(a2.metrics.intensity_factor.value).toBeCloseTo(0.8, 2);
        // Si se hubiera usado el FTP actual para ambas, los dos serían 0.8.
        expect(a1.metrics.intensity_factor.value).not.toBeCloseTo(0.8, 2);
    });

    it("distingue un cero legítimo de un dato ausente", async () => {
        // Actividad a 0 W: la media es 0, que es un dato real.
        catalogo["2"] = makeActivity("2", { date: "2026-08-10T09:00:00Z", power: 0 });
        const r = parse(await compareActivitiesTool.execute({ activityIds: ["1", "2"] }));
        const cero = r.metrics.activities.find((a: { activity_id: string }) => a.activity_id === "2");

        expect(cero.metrics.average_power_w.value).toBe(0);
        expect(cero.metrics.average_power_w.status).toBe("ok");

        // En cambio, sin FC el dato está ausente, no es 0.
        catalogo["2"] = makeActivity("2", { date: "2026-08-10T09:00:00Z", hr: false });
        const r2 = parse(await compareActivitiesTool.execute({ activityIds: ["1", "2"] }));
        const sinFc = r2.metrics.activities.find(
            (a: { activity_id: string }) => a.activity_id === "2",
        );

        expect(sinFc.metrics.mean_hr_bpm.value).toBeNull();
        expect(sinFc.metrics.mean_hr_bpm.status).toBe("missing_data");
        expect(sinFc.metrics.mean_hr_bpm.reason).toContain("FC");
    });

    it("rechaza actividades de otro atleta", async () => {
        catalogo["3"] = makeActivity("3", { athlete: "999" });
        const r = parse(await compareActivitiesTool.execute({ activityIds: ["1", "2", "3"] }));

        expect(r.metrics.activities).toHaveLength(2);
        expect(r.quality.rejected).toHaveLength(1);
        expect(r.quality.rejected[0].activity_id).toBe("3");
        expect(r.quality.rejected[0].reason).toContain("no pertenece al atleta autenticado");
    });

    it("todas las filas comparten el mismo conjunto de métricas", async () => {
        catalogo["2"] = makeActivity("2", { date: "2026-08-10T09:00:00Z", hr: false });
        const r = parse(await compareActivitiesTool.execute({ activityIds: ["1", "2"] }));

        const claves = r.metrics.activities.map((a: { metrics: object }) =>
            Object.keys(a.metrics).sort(),
        );
        expect(claves[0]).toEqual(claves[1]);
        expect(claves[0]).toEqual([...r.metrics.metric_keys].sort());
    });

    it("no repite descargas al comparar la misma actividad dos veces", async () => {
        fetchCalls = [];
        await compareActivitiesTool.execute({ activityIds: ["1", "2", "1"] });

        // El id repetido se descarta antes de pedirlo.
        expect(fetchCalls.filter((id) => id === "1")).toHaveLength(1);
    });

    it("con menos de 2 actividades utilizables no compara", async () => {
        catalogo["3"] = makeActivity("3", { athlete: "999" });
        const result = await compareActivitiesTool.execute({ activityIds: ["3", "1"] });
        const r = parse(result);

        expect(r.available).toBe(false);
        expect(r.errors[0].code).toBe("INSUFFICIENT_DURATION");
        expect(result).not.toHaveProperty("isError");
    });

    it("una actividad que falla al descargarse no tumba la comparación", async () => {
        const r = parse(
            await compareActivitiesTool.execute({ activityIds: ["1", "2", "999"] }),
        );

        expect(r.metrics.activities).toHaveLength(2);
        expect(r.quality.rejected[0].activity_id).toBe("999");
    });

    it("el esquema acepta de 2 a 10 actividades", () => {
        const shape = compareActivitiesTool.inputSchema.shape.activityIds;
        expect(shape.safeParse(["1"]).success).toBe(false);
        expect(shape.safeParse(["1", "2"]).success).toBe(true);
        expect(
            shape.safeParse(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]).success,
        ).toBe(true);
        expect(
            shape.safeParse(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]).success,
        ).toBe(false);
    });

    it("declara en method que no recalcula con el FTP actual", async () => {
        const r = parse(await compareActivitiesTool.execute({ activityIds: ["1", "2"] }));
        expect(r.method.parameters).toContain("EN SU FECHA");
        expect(r.method.missing_data).toContain("missing_data");
    });
});
