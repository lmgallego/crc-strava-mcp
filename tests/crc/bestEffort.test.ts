/**
 * Golden tests del barrido temporal y de la ecuación de VO2max contra la
 * fixture 09-periodo, derivada analíticamente en Python.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    bestEffortInPeriod,
    type ActivityRef,
    type BestEffortProviders,
    type EffortStreams,
} from "../../src/crc/analytics/bestEffort.ts";
import {
    estimateFtpFrom20Min,
    estimateVo2max,
    vo2maxFromWkg,
    VO2MAX_MODEL,
} from "../../src/crc/analytics/vo2maxEstimate.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";

const FIXTURES = path.join(__dirname, "fixtures");

const streams = JSON.parse(
    readFileSync(path.join(FIXTURES, "09-periodo.streams.json"), "utf8"),
) as Record<
    string,
    {
        activity_id: string;
        start_date: string;
        device_watts: boolean;
        streams: { time: { data: number[] }; watts: { data: number[] } };
    }
>;

const expected = JSON.parse(
    readFileSync(path.join(FIXTURES, "09-periodo.expected.json"), "utf8"),
) as {
    now: string;
    inputs: { weight_kg: number; window_days: number };
    expected: {
        in_window: string[];
        eligible: string[];
        best_300s: { activity_id: string; power_w: number; start_time_s: number };
        best_1200s: { activity_id: string; power_w: number; start_time_s: number };
        vo2max: {
            best_5min_power_w: number;
            relative_power_wkg: number;
            estimated_vo2max: number;
            source_activity_id: string;
        };
        ftp: { best_20min_power_w: number; estimated_ftp_w: number; source_activity_id: string };
    };
};

const NOW = new Date(`${expected.now}T12:00:00Z`);

/** Proveedores de prueba: filtran por fecha igual que haría la fuente real. */
function providers(calls: string[] = []): BestEffortProviders {
    return {
        listActivities: async (fromIso, toIso, max) => {
            const out: ActivityRef[] = [];
            for (const a of Object.values(streams)) {
                const day = a.start_date.slice(0, 10);
                if (day < fromIso || day > toIso) continue;
                out.push({
                    activity_id: a.activity_id,
                    start_date: a.start_date,
                    device_watts: a.device_watts,
                });
            }
            out.sort((x, y) => y.start_date.localeCompare(x.start_date));
            return out.slice(0, max);
        },
        loadStreams: async (id): Promise<EffortStreams> => {
            calls.push(id);
            const a = streams[id]!;
            return {
                activity_id: a.activity_id,
                start_date: a.start_date,
                device_watts: a.device_watts,
                aligned: buildAlignedStreams(a.streams.time.data, { watts: a.streams.watts.data }),
            };
        },
    };
}

describe("bestEffortInPeriod · golden", () => {
    it("encuentra el mejor 5 min del periodo", async () => {
        const r = await bestEffortInPeriod(300, 90, { now: NOW, providers: providers() });
        const want = expected.expected.best_300s;

        expect(r.available).toBe(true);
        expect(r.best!.power_w).toBeCloseTo(want.power_w, 2);
        expect(r.best!.activity_id).toBe(want.activity_id);
        expect(r.best!.start_time_s).toBe(want.start_time_s);
    });

    it("encuentra el mejor 20 min, que está en OTRA actividad", async () => {
        const r = await bestEffortInPeriod(1200, 90, { now: NOW, providers: providers() });
        const want = expected.expected.best_1200s;

        expect(r.best!.power_w).toBeCloseTo(want.power_w, 2);
        expect(r.best!.activity_id).toBe(want.activity_id);
        // La gracia de la fixture: no es la misma que la del mejor 5 min.
        expect(want.activity_id).not.toBe(expected.expected.best_300s.activity_id);
    });

    it("descarta la actividad con potencia estimada pese a tener el pico más alto", async () => {
        const r = await bestEffortInPeriod(300, 90, { now: NOW, providers: providers() });

        // 1003 tiene 400 W en 5 min, pero device_watts = false.
        expect(r.best!.activity_id).not.toBe("1003");
        expect(r.best!.power_w).toBeLessThan(400);
        expect(r.skipped.map((s) => s.activity_id)).toContain("1003");
        expect(r.skipped.find((s) => s.activity_id === "1003")!.reason).toContain("estimada");
    });

    it("descarta la actividad fuera de la ventana pese a tener 450 W", async () => {
        const r = await bestEffortInPeriod(1200, 90, { now: NOW, providers: providers() });

        expect(r.best!.activity_id).not.toBe("1004");
        expect(r.best!.power_w).toBeLessThan(450);
    });

    it("ni siquiera descarga los streams de las actividades no elegibles", async () => {
        const calls: string[] = [];
        await bestEffortInPeriod(300, 90, { now: NOW, providers: providers(calls) });

        // 1003 se descarta por device_watts antes de gastar una llamada a la API.
        expect(calls).not.toContain("1003");
        expect(calls).not.toContain("1004");
        expect(calls.sort()).toEqual(["1001", "1002"]);
    });

    it("una ventana más amplia sí alcanza la actividad antigua", async () => {
        const r = await bestEffortInPeriod(1200, 200, { now: NOW, providers: providers() });

        expect(r.best!.activity_id).toBe("1004");
        expect(r.best!.power_w).toBeCloseTo(450, 2);
    });
});

describe("bestEffortInPeriod · límites y robustez", () => {
    it("respeta el tope de actividades y avisa", async () => {
        const r = await bestEffortInPeriod(300, 90, {
            now: NOW,
            maxActivities: 1,
            providers: providers(),
        });

        expect(r.listed_activities).toBe(1);
        expect(r.warnings.join(" ")).toContain("tope");
    });

    it("una actividad que falla no rompe el barrido", async () => {
        const base = providers();
        const r = await bestEffortInPeriod(300, 90, {
            now: NOW,
            providers: {
                listActivities: base.listActivities,
                loadStreams: async (id) => {
                    if (id === "1001") throw new Error("503 de Strava");
                    return base.loadStreams(id);
                },
            },
        });

        expect(r.available).toBe(true);
        expect(r.best!.activity_id).toBe("1002");
        expect(r.skipped.find((s) => s.activity_id === "1001")!.reason).toContain("503");
    });

    it("sin actividades en la ventana no está disponible, sin lanzar", async () => {
        const r = await bestEffortInPeriod(300, 1, { now: NOW, providers: providers() });

        expect(r.available).toBe(false);
        expect(r.best).toBeNull();
        expect(r.reason).toContain("actividades");
    });

    it("una duración mayor que cualquier actividad no encuentra nada", async () => {
        const r = await bestEffortInPeriod(99999, 90, { now: NOW, providers: providers() });

        expect(r.available).toBe(false);
        expect(r.reason).toContain("esfuerzo válido");
    });

    it("rechaza parámetros inválidos", async () => {
        await expect(
            bestEffortInPeriod(0, 90, { now: NOW, providers: providers() }),
        ).rejects.toThrow(/duration_s/);
        await expect(
            bestEffortInPeriod(300, 0, { now: NOW, providers: providers() }),
        ).rejects.toThrow(/days/);
    });
});

describe("vo2maxEstimate · la ecuación", () => {
    it("aplica 16.6 + 8.87 × W/kg exactamente (caso a mano)", () => {
        // 360 W / 72 kg = 5 W/kg -> 16.6 + 8.87*5 = 16.6 + 44.35 = 60.95
        const r = estimateVo2max({ best5MinPowerW: 360, weightKg: 72 });

        expect(r.relative_power_wkg).toBe(5);
        expect(r.estimated_vo2max).toBe(60.95);
    });

    it("segundo caso a mano: 4 W/kg -> 52.08", () => {
        // 16.6 + 8.87*4 = 16.6 + 35.48 = 52.08
        expect(vo2maxFromWkg(4)).toBeCloseTo(52.08, 10);
    });

    it("coincide con el valor derivado en la fixture", () => {
        const want = expected.expected.vo2max;
        const r = estimateVo2max({
            best5MinPowerW: want.best_5min_power_w,
            weightKg: expected.inputs.weight_kg,
        });

        expect(r.relative_power_wkg).toBeCloseTo(want.relative_power_wkg, 4);
        expect(r.estimated_vo2max).toBeCloseTo(want.estimated_vo2max, 2);
    });

    it("los coeficientes del modelo son los publicados", () => {
        expect(VO2MAX_MODEL.intercept).toBe(16.6);
        expect(VO2MAX_MODEL.slope).toBe(8.87);
    });

    it("etiqueta estimated_vo2max y nunca lab_vo2max", () => {
        const r = estimateVo2max({ best5MinPowerW: 360, weightKg: 72 });

        expect(r.label).toBe("estimated_vo2max");
        // Se inspeccionan los DATOS, no `method`: ahí la palabra aparece a
        // propósito, en la frase que prohíbe usarla como etiqueta.
        const { method, ...datos } = r;
        expect(JSON.stringify(datos)).not.toContain("lab_vo2max");
        expect(r.model_reference).toBeTruthy();
    });

    it("avisa de que el mejor 5 min no equivale a un test máximo", () => {
        const sin = estimateVo2max({ best5MinPowerW: 360, weightKg: 72 });
        expect(sin.warnings.join(" ")).toContain("NO equivale");

        const con = estimateVo2max({
            best5MinPowerW: 360,
            weightKg: 72,
            maximalEffortEvidence: true,
        });
        expect(con.warnings.join(" ")).not.toContain("NO equivale");
        // Pero sigue siendo una estimación, con evidencia o sin ella.
        expect(con.warnings.join(" ")).toContain("ESTIMADO");
    });

    it("rechaza entradas imposibles", () => {
        expect(() => estimateVo2max({ best5MinPowerW: 0, weightKg: 72 })).toThrow(/best5Min/);
        expect(() => estimateVo2max({ best5MinPowerW: 360, weightKg: 0 })).toThrow(/weightKg/);
    });
});

describe("estimateFtpFrom20Min", () => {
    it("aplica el factor 0,95 (caso a mano)", () => {
        // 300 × 0.95 = 285
        const r = estimateFtpFrom20Min(300);
        expect(r.estimated_ftp_w).toBe(285);
        expect(r.factor).toBe(0.95);
    });

    it("coincide con el valor derivado en la fixture", () => {
        const want = expected.expected.ftp;
        const r = estimateFtpFrom20Min(want.best_20min_power_w);
        expect(r.estimated_ftp_w).toBeCloseTo(want.estimated_ftp_w, 2);
    });

    it("sugiere el source estimated_20min, nunca manual", () => {
        const r = estimateFtpFrom20Min(300);
        expect(r.suggested_source).toBe("estimated_20min");
        expect(JSON.stringify(r)).not.toContain('"manual"');
    });

    it("avisa de que no persiste y de cómo guardarlo", () => {
        const r = estimateFtpFrom20Min(300);
        const texto = r.warnings.join(" ");

        expect(texto).toContain("NO guardada");
        expect(texto).toContain("crc-set-performance-profile");
    });
});
