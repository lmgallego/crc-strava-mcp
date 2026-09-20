import { describe, expect, it } from "vitest";

import {
    CrcErrorCode,
    crcToolResponse,
    crcToolResponseSchema,
    crcUnavailable,
    sanitize,
    SPEC_V01_ERROR_CODES,
} from "../../src/crc/schemas/crcToolResponse.ts";

describe("sanitize", () => {
    it("convierte NaN e Infinity en null y avisa de cada uno", () => {
        const { value, warnings } = sanitize({ a: NaN, b: Infinity, c: -Infinity, d: 1.5 });

        expect(value).toEqual({ a: null, b: null, c: null, d: 1.5 });
        expect(warnings).toHaveLength(3);
        expect(warnings.join(" ")).toContain("NaN");
        expect(warnings.join(" ")).toContain("Infinity");
    });

    it("recorre objetos anidados y arrays indicando la ruta", () => {
        const { value, warnings } = sanitize({ m: { list: [1, NaN, 3] } });

        expect(value).toEqual({ m: { list: [1, null, 3] } });
        expect(warnings[0]).toContain("m.list[1]");
    });

    it("no muta la entrada", () => {
        const input = { a: NaN };
        sanitize(input);
        expect(Number.isNaN(input.a)).toBe(true);
    });

    it("deja intactos los valores finitos y no numéricos", () => {
        const input = { n: 0, s: "NaN", b: false, nul: null };
        const { value, warnings } = sanitize(input);
        expect(value).toEqual(input);
        expect(warnings).toEqual([]);
    });
});

describe("crcToolResponse", () => {
    it("cumple el esquema del envoltorio", () => {
        const res = crcToolResponse({
            tool: "crc-calculate-power-metrics",
            version: "0.1.0",
            activity_id: "1234567890123456789",
            metrics: { normalized_power_w: 268.4 },
            quality: { valid_seconds: 7604, warnings: [] },
        });

        expect(crcToolResponseSchema.safeParse(res).success).toBe(true);
        expect(res.activity_id).toBe("1234567890123456789");
        expect(res.available).toBe(true);
        expect(res.errors).toEqual([]);
    });

    it("sanea las métricas y acumula los warnings en quality", () => {
        const res = crcToolResponse({
            tool: "t",
            version: "0.1.0",
            metrics: { if: NaN, vi: Infinity },
            quality: { warnings: ["aviso previo"] },
        });

        expect(res.metrics).toEqual({ if: null, vi: null });
        expect(res.quality.warnings[0]).toBe("aviso previo");
        expect(res.quality.warnings).toHaveLength(3);
        expect(JSON.stringify(res)).not.toContain("null,\"__proto__\"");
    });

    it("ninguna respuesta pública serializa NaN ni Infinity", () => {
        const res = crcToolResponse({
            tool: "t",
            version: "0.1.0",
            metrics: { a: NaN, nested: { b: [Infinity] } },
        });

        // Se comprueban los VALORES, no el texto: los warnings mencionan
        // "NaN"/"Infinity" a propósito y eso es correcto.
        const nonFinite: string[] = [];
        const walk = (node: unknown, path: string): void => {
            if (typeof node === "number" && !Number.isFinite(node)) nonFinite.push(path);
            else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
            else if (node && typeof node === "object")
                for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
        };
        walk({ inputs: res.inputs, method: res.method, metrics: res.metrics }, "");
        expect(nonFinite).toEqual([]);

        // JSON.stringify convertiría NaN en null de todos modos, pero sin avisar:
        // el saneado explícito garantiza el warning.
        expect(res.quality.warnings).toHaveLength(2);
    });

    it("activity_id es null cuando no se indica", () => {
        const res = crcToolResponse({ tool: "t", version: "0.1.0" });
        expect(res.activity_id).toBeNull();
    });
});

describe("crcUnavailable", () => {
    it("marca available:false con el código de error, sin isError", () => {
        const res = crcUnavailable({
            tool: "crc-calculate-power-metrics",
            version: "0.1.0",
            activity_id: "123",
            code: CrcErrorCode.MISSING_POWER,
            message: "La actividad no tiene stream de potencia.",
        });

        expect(res.available).toBe(false);
        expect(res.errors).toEqual([
            { code: "MISSING_POWER", message: "La actividad no tiene stream de potencia." },
        ]);
        expect(crcToolResponseSchema.safeParse(res).success).toBe(true);
        expect(res).not.toHaveProperty("isError");
    });

    it("expone los 7 códigos de la sección 12", () => {
        // Siguen estando todos, aunque el enum haya crecido con ampliaciones.
        for (const code of SPEC_V01_ERROR_CODES) {
            expect(Object.keys(CrcErrorCode)).toContain(code);
        }
        expect(SPEC_V01_ERROR_CODES).toHaveLength(7);
    });

    it("las ampliaciones posteriores están identificadas", () => {
        const ampliaciones = Object.keys(CrcErrorCode).filter(
            (c) => !SPEC_V01_ERROR_CODES.includes(c as (typeof SPEC_V01_ERROR_CODES)[number]),
        );
        // v0.2: subidas (Sprint 8) y umbral de FC (Sprint 10).
        expect(ampliaciones).toEqual(["MISSING_ELEVATION", "MISSING_HR_THRESHOLD"]);
    });
});
