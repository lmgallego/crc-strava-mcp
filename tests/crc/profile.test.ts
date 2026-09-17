import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    resolveMetric,
    resolveMetrics,
    toIsoDay,
} from "../../src/crc/profile/profileResolver.ts";
import {
    assertNoOverlap,
    InvalidProfileError,
    loadProfile,
    saveProfile,
    setMetric,
    type PerformanceProfile,
} from "../../src/crc/profile/profileStore.ts";

let dir: string;
let file: string;

beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "crc-profile-"));
    file = path.join(dir, "crc-performance-profile.json");
});

afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
});

const ftp = (value: number, from: string, to: string | null = null) => ({
    metric: "ftp_w" as const,
    value,
    unit: "W",
    effective_from: from,
    effective_to: to,
    source: "manual",
});

describe("profileStore · lectura y escritura", () => {
    it("devuelve un perfil vacío si el archivo no existe", async () => {
        const p = await loadProfile(file);
        expect(p).toEqual({ metrics: [] });
    });

    it("guarda y relee conservando los valores", async () => {
        await saveProfile({ metrics: [ftp(320, "2026-09-01")] }, file);
        const p = await loadProfile(file);

        expect(p.metrics).toHaveLength(1);
        expect(p.metrics[0]!.value).toBe(320);
    });

    it("escribe de forma atómica y no deja temporales", async () => {
        await saveProfile({ metrics: [ftp(300, "2026-01-01")] }, file);
        const left = (await fs.readdir(dir)).filter((f) => f.includes(".tmp"));

        expect(left).toEqual([]);
        expect(JSON.parse(await fs.readFile(file, "utf8")).metrics).toHaveLength(1);
    });

    it("rechaza un JSON corrupto sin dejarlo pasar como vacío", async () => {
        await fs.writeFile(file, "{ esto no es json", "utf8");
        await expect(loadProfile(file)).rejects.toThrow(InvalidProfileError);
    });
});

describe("profileStore · validación", () => {
    it("rechaza una unidad que no corresponde a la métrica", async () => {
        await expect(
            setMetric({ ...ftp(320, "2026-09-01"), unit: "kg" }, { file }),
        ).rejects.toThrow(/se expresa en W/);
    });

    it("rechaza valores fuera del rango plausible", async () => {
        await expect(setMetric(ftp(2000, "2026-09-01"), { file })).rejects.toThrow(/rango/);
        await expect(
            setMetric(
                { metric: "weight_kg", value: 5, unit: "kg", effective_from: "2026-09-01" },
                { file },
            ),
        ).rejects.toThrow(/rango/);
    });

    it("rechaza una métrica desconocida", async () => {
        await expect(
            setMetric(
                { metric: "vo2max", value: 60, unit: "ml/kg/min", effective_from: "2026-09-01" },
                { file },
            ),
        ).rejects.toThrow();
    });

    it("rechaza effective_to anterior a effective_from", async () => {
        await expect(setMetric(ftp(320, "2026-09-01", "2026-08-01"), { file })).rejects.toThrow(
            /anterior/,
        );
    });

    it("rechaza fechas con formato inválido", async () => {
        await expect(setMetric(ftp(320, "01/09/2026"), { file })).rejects.toThrow(/YYYY-MM-DD/);
    });
});

describe("profileStore · ventanas solapadas", () => {
    it("detecta dos ventanas abiertas para la misma métrica", () => {
        expect(() =>
            assertNoOverlap([ftp(300, "2026-01-01"), ftp(320, "2026-06-01")]),
        ).toThrow(/solapad/i);
    });

    it("detecta solape parcial", () => {
        expect(() =>
            assertNoOverlap([ftp(300, "2026-01-01", "2026-07-01"), ftp(320, "2026-06-01")]),
        ).toThrow(/solapad/i);
    });

    it("acepta ventanas consecutivas sin solape", () => {
        expect(() =>
            assertNoOverlap([ftp(300, "2026-01-01", "2026-05-31"), ftp(320, "2026-06-01")]),
        ).not.toThrow();
    });

    it("no confunde ventanas de métricas distintas", () => {
        expect(() =>
            assertNoOverlap([
                ftp(300, "2026-01-01"),
                {
                    metric: "weight_kg",
                    value: 68.5,
                    unit: "kg",
                    effective_from: "2026-01-01",
                    effective_to: null,
                    source: "manual",
                },
            ]),
        ).not.toThrow();
    });

    it("no escribe en disco si el resultado solaparía", async () => {
        await setMetric(ftp(300, "2026-01-01"), { file });
        await expect(setMetric(ftp(320, "2026-06-01"), { file })).rejects.toThrow(/solapad/i);

        // El perfil en disco sigue teniendo solo la entrada original.
        const p = await loadProfile(file);
        expect(p.metrics).toHaveLength(1);
        expect(p.metrics[0]!.value).toBe(300);
    });
});

describe("profileStore · histórico protegido", () => {
    it("no sobrescribe una entrada existente sin overwrite", async () => {
        await setMetric(ftp(300, "2026-01-01"), { file });
        await expect(setMetric(ftp(310, "2026-01-01"), { file })).rejects.toThrow(/overwrite/);

        const p = await loadProfile(file);
        expect(p.metrics[0]!.value).toBe(300);
    });

    it("sobrescribe con overwrite:true", async () => {
        await setMetric(ftp(300, "2026-01-01"), { file });
        const p = await setMetric(ftp(310, "2026-01-01"), { file, overwrite: true });

        expect(p.metrics).toHaveLength(1);
        expect(p.metrics[0]!.value).toBe(310);
    });

    it("permite añadir histórico cerrando la ventana anterior", async () => {
        await setMetric(ftp(300, "2026-01-01", "2026-05-31"), { file });
        const p = await setMetric(ftp(320, "2026-06-01"), { file });

        expect(p.metrics).toHaveLength(2);
    });
});

describe("profileResolver", () => {
    const profile: PerformanceProfile = {
        metrics: [
            ftp(300, "2026-01-01", "2026-05-31"),
            ftp(320, "2026-06-01"),
            {
                metric: "weight_kg",
                value: 68.5,
                unit: "kg",
                effective_from: "2026-03-01",
                effective_to: null,
                source: "manual",
            },
        ],
    };

    it("devuelve el valor vigente en la fecha de la actividad", () => {
        const r = resolveMetric(profile, "ftp_w", "2026-03-15");
        expect(r.found).toBe(true);
        expect(r.found && r.value).toBe(300);
        expect(r.found && r.effective_from).toBe("2026-01-01");
    });

    it("elige la ventana correcta tras un cambio de FTP", () => {
        expect(resolveMetric(profile, "ftp_w", "2026-05-31")).toMatchObject({ value: 300 });
        expect(resolveMetric(profile, "ftp_w", "2026-06-01")).toMatchObject({ value: 320 });
        expect(resolveMetric(profile, "ftp_w", "2026-12-31")).toMatchObject({ value: 320 });
    });

    it("NUNCA cae al valor actual para una fecha anterior al histórico", () => {
        const r = resolveMetric(profile, "ftp_w", "2025-11-20");

        expect(r.found).toBe(false);
        expect(r.found === false && r.reason).toBe("missing_parameter");
        // Existe un FTP de 320 hoy, pero no debe usarse para esa fecha.
        expect(JSON.stringify(r)).not.toContain("320");
    });

    it("devuelve missing_parameter si la métrica no está en el perfil", () => {
        const r = resolveMetric(profile, "map_w", "2026-06-15");

        expect(r.found).toBe(false);
        expect(r.found === false && r.message).toContain("crc-set-performance-profile");
    });

    it("acepta una fecha ISO completa o un Date", () => {
        expect(resolveMetric(profile, "ftp_w", "2026-06-15T10:30:00Z")).toMatchObject({
            value: 320,
        });
        expect(resolveMetric(profile, "ftp_w", new Date("2026-06-15T10:30:00Z"))).toMatchObject({
            value: 320,
        });
    });

    it("resuelve varias métricas a la vez", () => {
        const r = resolveMetrics(profile, ["ftp_w", "weight_kg", "map_w"], "2026-06-15");

        expect(r["ftp_w"]!.found).toBe(true);
        expect(r["weight_kg"]!.found).toBe(true);
        expect(r["map_w"]!.found).toBe(false);
    });

    it("toIsoDay rechaza basura", () => {
        expect(() => toIsoDay("ayer")).toThrow(/Fecha inválida/);
    });
});

describe("profileStore · D25 fecha por defecto", () => {
    it("sin effective_from asume hoy", async () => {
        const hoy = new Date().toISOString().slice(0, 10);
        const p = await setMetric(
            { metric: "ftp_w", value: 250, unit: "W", source: "manual" },
            { file },
        );

        expect(p.metrics[0]!.effective_from).toBe(hoy);
    });

    it("una fecha explícita sigue mandando", async () => {
        const p = await setMetric(ftp(250, "2026-03-01"), { file });
        expect(p.metrics[0]!.effective_from).toBe("2026-03-01");
    });
});

describe("profileStore · D26 cierre de la vigencia anterior", () => {
    it("sin closePrevious, añadir un valor nuevo falla por solape", async () => {
        await setMetric(ftp(300, "2026-01-01"), { file });
        await expect(setMetric(ftp(320, "2026-06-01"), { file })).rejects.toThrow(/solapad/i);
    });

    it("con closePrevious cierra la anterior al día previo", async () => {
        await setMetric(ftp(300, "2026-01-01"), { file });
        const p = await setMetric(ftp(320, "2026-06-01"), { file, closePrevious: true });

        const previa = p.metrics.find((m) => m.effective_from === "2026-01-01")!;
        const nueva = p.metrics.find((m) => m.effective_from === "2026-06-01")!;

        expect(previa.effective_to).toBe("2026-05-31");
        expect(nueva.effective_to).toBeNull();
        expect(p.metrics).toHaveLength(2);
    });

    it("el histórico queda consultable en ambas fechas", async () => {
        await setMetric(ftp(300, "2026-01-01"), { file });
        const p = await setMetric(ftp(320, "2026-06-01"), { file, closePrevious: true });

        expect(resolveMetric(p, "ftp_w", "2026-03-15")).toMatchObject({ value: 300 });
        expect(resolveMetric(p, "ftp_w", "2026-07-15")).toMatchObject({ value: 320 });
    });

    it("cierra solo la ventana abierta más reciente, no todo el histórico", async () => {
        await setMetric(ftp(280, "2025-01-01", "2025-12-31"), { file });
        await setMetric(ftp(300, "2026-01-01"), { file });
        const p = await setMetric(ftp(320, "2026-06-01"), { file, closePrevious: true });

        expect(p.metrics.find((m) => m.effective_from === "2025-01-01")!.effective_to).toBe(
            "2025-12-31",
        );
        expect(p.metrics.find((m) => m.effective_from === "2026-01-01")!.effective_to).toBe(
            "2026-05-31",
        );
    });

    it("no toca métricas distintas", async () => {
        await setMetric(
            { metric: "weight_kg", value: 72, unit: "kg", effective_from: "2026-01-01" },
            { file },
        );
        await setMetric(ftp(300, "2026-01-01"), { file });
        const p = await setMetric(ftp(320, "2026-06-01"), { file, closePrevious: true });

        expect(p.metrics.find((m) => m.metric === "weight_kg")!.effective_to).toBeNull();
    });

    it("cruza el cambio de mes y de año correctamente", async () => {
        await setMetric(ftp(300, "2025-06-01"), { file });
        const p = await setMetric(ftp(320, "2026-01-01"), { file, closePrevious: true });

        expect(p.metrics.find((m) => m.effective_from === "2025-06-01")!.effective_to).toBe(
            "2025-12-31",
        );
    });
});
