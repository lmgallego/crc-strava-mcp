/**
 * Criterio de aceptación: ninguna respuesta pública puede contener `NaN` ni
 * `Infinity`.
 *
 * Recorre TODAS las tools CRC con entradas adversas —las que de verdad producen
 * divisiones por cero y ventanas imposibles— y comprueba el texto devuelto.
 *
 * Se inspecciona el TEXTO crudo, no el objeto parseado: `JSON.parse` nunca
 * devuelve `NaN`, así que mirar el objeto no probaría nada. Un `NaN` solo puede
 * escaparse interpolado dentro de una cadena (`` `${valor}` ``), y eso es
 * justo lo que este test caza.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";
import type { ActivityStreams } from "../../src/crc/sources/strava.ts";
import {
    getPerformanceProfileTool,
    setPerformanceProfileTool,
} from "../../src/crc/tools/performanceProfileTools.ts";
import { powerCurveTool, powerMetricsTool } from "../../src/crc/tools/powerTools.ts";
import {
    decouplingTool,
    timeInZonesTool,
    torqueCadenceTool,
    workAboveFtpTool,
} from "../../src/crc/tools/physiologyTools.ts";
import { estimateFtpTool, estimateVo2maxTool } from "../../src/crc/tools/estimateTools.ts";
import {
    analyzeCyclingActivityTool,
    compareActivitiesTool,
} from "../../src/crc/tools/orchestrationTools.ts";

let catalogo: Record<string, ActivityStreams> = {};
let profileFile = "";

vi.mock("../../src/crc/sources/strava.ts", () => ({
    fetchActivityStreams: async (id: string) => {
        const a = catalogo[id];
        if (!a) throw new Error(`Actividad ${id} no encontrada`);
        return a;
    },
    stravaBestEffortProviders: () => ({
        listActivities: async () => [],
        loadStreams: async () => {
            throw new Error("sin red");
        },
    }),
}));

vi.mock("../../src/stravaClient.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/stravaClient.ts")>();
    return { ...actual, getAuthenticatedAthlete: async () => ({ id: 42 }) };
});

vi.mock("../../src/crc/profile/profileStore.ts", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../src/crc/profile/profileStore.ts")>();
    return { ...actual, loadProfile: (f?: string) => actual.loadProfile(f ?? profileFile) };
});

function activity(
    id: string,
    opts: {
        n?: number;
        watts?: number[] | null;
        hr?: number[] | null;
        cadence?: number[] | null;
        date?: string;
        deviceWatts?: boolean | null;
    } = {},
): ActivityStreams {
    const n = opts.n ?? 1800;
    const time = Array.from({ length: n }, (_, i) => i);
    return {
        activity_id: id,
        athlete_id: "42",
        device_watts: opts.deviceWatts === undefined ? true : opts.deviceWatts,
        start_date: opts.date ?? "2026-06-15T09:00:00Z",
        details: {
            name: `A${id}`,
            sport_type: "Ride",
            distance_m: 0,
            moving_time_s: n,
            elapsed_time_s: n,
            total_elevation_gain_m: 0,
            trainer: false,
        },
        aligned: buildAlignedStreams(time, {
            watts: opts.watts === null ? undefined : (opts.watts ?? Array.from({ length: n }, () => 0)),
            heartrate: opts.hr === null ? undefined : opts.hr,
            cadence: opts.cadence === null ? undefined : opts.cadence,
        }),
        from_cache: false,
        available_types: ["time", "watts"],
    };
}

const zeros = (n: number) => Array.from({ length: n }, () => 0);

let dir: string;
let prevToken: string | undefined;

beforeEach(async () => {
    prevToken = process.env.STRAVA_ACCESS_TOKEN;
    process.env.STRAVA_ACCESS_TOKEN = "test-token";
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crc-nan-"));
    profileFile = path.join(dir, "profile.json");
});

afterEach(async () => {
    process.env.STRAVA_ACCESS_TOKEN = prevToken;
    await fs.rm(dir, { recursive: true, force: true });
});

async function writeProfile(metrics: unknown[]) {
    await fs.writeFile(profileFile, JSON.stringify({ metrics }), "utf8");
}

/** Comprueba el texto devuelto por una tool. */
function assertNoNonFinite(label: string, result: { content: { text: string }[] }) {
    const texto = result.content[0]!.text;

    // 1) Ningún token NaN/Infinity, ni suelto ni interpolado en una cadena.
    expect(texto, `${label}: el texto contiene NaN`).not.toMatch(/\bNaN\b/);
    expect(texto, `${label}: el texto contiene Infinity`).not.toMatch(/\bInfinity\b/);
    expect(texto, `${label}: el texto contiene -Infinity`).not.toMatch(/-Infinity/);

    // 2) Si es JSON (no un error de entrada), ningún número no finito.
    if (!texto.startsWith("❌")) {
        const obj = JSON.parse(texto);
        const malos: string[] = [];
        const walk = (node: unknown, ruta: string): void => {
            if (typeof node === "number") {
                if (!Number.isFinite(node)) malos.push(ruta);
            } else if (Array.isArray(node)) {
                node.forEach((v, i) => walk(v, `${ruta}[${i}]`));
            } else if (node && typeof node === "object") {
                for (const [k, v] of Object.entries(node)) walk(v, `${ruta}.${k}`);
            }
        };
        walk(obj, label);
        expect(malos, `${label}: valores no finitos en ${malos.join(", ")}`).toEqual([]);
    }
}

/**
 * Escenarios adversos: los que producen 0/0, divisiones por cero y ventanas
 * imposibles. Una actividad normal no probaría nada.
 */
const ESCENARIOS: { nombre: string; preparar: () => Promise<void> }[] = [
    {
        nombre: "actividad entera a 0 W (VI = 0/0)",
        preparar: async () => {
            catalogo = { "1": activity("1", { watts: zeros(1800), hr: zeros(1800), cadence: zeros(1800) }) };
            await writeProfile([
                { metric: "ftp_w", value: 250, unit: "W", effective_from: "2026-01-01", source: "manual" },
                { metric: "weight_kg", value: 72, unit: "kg", effective_from: "2026-01-01", source: "manual" },
                { metric: "hr_max_bpm", value: 190, unit: "bpm", effective_from: "2026-01-01", source: "manual" },
            ]);
        },
    },
    {
        nombre: "actividad de 1 segundo (ventanas imposibles)",
        preparar: async () => {
            catalogo = { "1": activity("1", { n: 1, watts: [200], hr: [150], cadence: [90] }) };
            await writeProfile([
                { metric: "ftp_w", value: 250, unit: "W", effective_from: "2026-01-01", source: "manual" },
                { metric: "weight_kg", value: 72, unit: "kg", effective_from: "2026-01-01", source: "manual" },
                { metric: "hr_max_bpm", value: 190, unit: "bpm", effective_from: "2026-01-01", source: "manual" },
            ]);
        },
    },
    {
        nombre: "FC a 0 (EF = P/0) y cadencia a 0",
        preparar: async () => {
            catalogo = {
                "1": activity("1", {
                    watts: Array.from({ length: 1800 }, () => 200),
                    hr: zeros(1800),
                    cadence: zeros(1800),
                }),
            };
            await writeProfile([
                { metric: "ftp_w", value: 250, unit: "W", effective_from: "2026-01-01", source: "manual" },
                { metric: "weight_kg", value: 72, unit: "kg", effective_from: "2026-01-01", source: "manual" },
                { metric: "hr_max_bpm", value: 190, unit: "bpm", effective_from: "2026-01-01", source: "manual" },
            ]);
        },
    },
    {
        nombre: "perfil vacío (sin FTP, peso ni FC máx)",
        preparar: async () => {
            catalogo = {
                "1": activity("1", {
                    watts: Array.from({ length: 1800 }, () => 200),
                    hr: Array.from({ length: 1800 }, () => 150),
                    cadence: Array.from({ length: 1800 }, () => 90),
                }),
            };
            await writeProfile([]);
        },
    },
    {
        nombre: "sin ningún stream salvo tiempo",
        preparar: async () => {
            catalogo = { "1": activity("1", { watts: null, hr: null, cadence: null }) };
            await writeProfile([
                { metric: "ftp_w", value: 250, unit: "W", effective_from: "2026-01-01", source: "manual" },
            ]);
        },
    },
];

describe.each(ESCENARIOS)("sin NaN ni Infinity · $nombre", ({ preparar }) => {
    beforeEach(async () => {
        await preparar();
        catalogo["2"] = { ...catalogo["1"]!, activity_id: "2", start_date: "2026-07-20T09:00:00Z" };
    });

    it("crc-get-performance-profile", async () => {
        assertNoNonFinite("get-profile", await getPerformanceProfileTool.execute({ date: "2026-06-15" }));
    });

    it("crc-calculate-power-metrics", async () => {
        assertNoNonFinite("power-metrics", await powerMetricsTool.execute({ activityId: "1" }));
    });

    it("crc-power-curve", async () => {
        assertNoNonFinite("power-curve", await powerCurveTool.execute({ activityId: "1" }));
    });

    it("crc-aerobic-decoupling", async () => {
        assertNoNonFinite("decoupling", await decouplingTool.execute({ activityId: "1" }));
    });

    it("crc-time-in-zones (potencia)", async () => {
        assertNoNonFinite("zones-power", await timeInZonesTool.execute({ activityId: "1" }));
    });

    it("crc-time-in-zones (FC)", async () => {
        assertNoNonFinite(
            "zones-hr",
            await timeInZonesTool.execute({ activityId: "1", kind: "heartrate" }),
        );
    });

    it("crc-torque-cadence", async () => {
        assertNoNonFinite("torque", await torqueCadenceTool.execute({ activityId: "1" }));
    });

    it("crc-work-above-ftp", async () => {
        assertNoNonFinite("work-above-ftp", await workAboveFtpTool.execute({ activityId: "1" }));
    });

    it("crc-estimate-vo2max", async () => {
        assertNoNonFinite(
            "vo2max",
            await estimateVo2maxTool.execute({ mode: "activity", activityId: "1" }),
        );
    });

    it("crc-estimate-ftp", async () => {
        assertNoNonFinite(
            "estimate-ftp",
            await estimateFtpTool.execute({ mode: "activity", activityId: "1" }),
        );
    });

    it("crc-analyze-cycling-activity", async () => {
        assertNoNonFinite("analyze", await analyzeCyclingActivityTool.execute({ activityId: "1" }));
    });

    it("crc-compare-activities", async () => {
        assertNoNonFinite(
            "compare",
            await compareActivitiesTool.execute({ activityIds: ["1", "2"] }),
        );
    });
});

describe("sin NaN ni Infinity · escritura del perfil", () => {
    it("crc-set-performance-profile con valores límite", async () => {
        await writeProfile([]);
        assertNoNonFinite(
            "set-profile",
            await setPerformanceProfileTool.execute({
                metric: "ftp_w",
                value: 250,
                effective_from: "2026-01-01",
            }),
        );
    });

    it("crc-set-performance-profile con un valor fuera de rango", async () => {
        await writeProfile([]);
        assertNoNonFinite(
            "set-profile-invalido",
            await setPerformanceProfileTool.execute({
                metric: "ftp_w",
                value: 99999,
                effective_from: "2026-01-01",
            }),
        );
    });
});
