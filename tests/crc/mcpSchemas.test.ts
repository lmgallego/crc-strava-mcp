import { describe, expect, it } from "vitest";

import { flexibleBoolean, stravaId } from "../../src/crc/schemas/mcpSchemas.ts";

describe("stravaId", () => {
    it("devuelve string a partir de un number seguro", () => {
        expect(stravaId.parse(1234567890)).toBe("1234567890");
    });

    it("devuelve el string tal cual", () => {
        expect(stravaId.parse("1234567890")).toBe("1234567890");
    });

    it("conserva un ID de 19 dígitos que Number corrompería", () => {
        const id = "1234567890123456789";

        // Demostración del daño: pasar por Number pierde los últimos dígitos.
        expect(String(Number(id))).not.toBe(id);
        expect(Number(id)).toBeGreaterThan(Number.MAX_SAFE_INTEGER);

        // El helper lo transporta intacto porque nunca pasa por Number.
        expect(stravaId.parse(id)).toBe(id);
    });

    it("rechaza un number fuera del rango seguro en lugar de devolverlo corrupto", () => {
        // 1234567890123456789 como number ya llega redondeado: no es recuperable.
        const result = stravaId.safeParse(1234567890123456789);
        expect(result.success).toBe(false);
    });

    it("rechaza valores que no son solo dígitos", () => {
        for (const bad of ["", "12a34", "12.5", "-123", " ", "1e5"]) {
            expect(stravaId.safeParse(bad).success, `debería rechazar ${JSON.stringify(bad)}`).toBe(
                false,
            );
        }
        expect(stravaId.safeParse(-123).success).toBe(false);
        expect(stravaId.safeParse(12.5).success).toBe(false);
    });

    it("recorta espacios alrededor del ID", () => {
        expect(stravaId.parse("  1234  ")).toBe("1234");
    });
});

describe("flexibleBoolean", () => {
    it("acepta booleanos nativos", () => {
        expect(flexibleBoolean.parse(true)).toBe(true);
        expect(flexibleBoolean.parse(false)).toBe(false);
    });

    it('acepta "true" y "false" como texto', () => {
        expect(flexibleBoolean.parse("true")).toBe(true);
        expect(flexibleBoolean.parse("false")).toBe(false);
    });

    it("rechaza otros valores", () => {
        for (const bad of ["yes", "1", 1, 0, "True", null, undefined]) {
            expect(flexibleBoolean.safeParse(bad).success, `debería rechazar ${String(bad)}`).toBe(
                false,
            );
        }
    });
});
