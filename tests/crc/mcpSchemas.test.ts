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

    it("acepta la forma capitalizada de Python", () => {
        // Un cliente entrenado sobre Python escribe True/False, no true/false.
        expect(flexibleBoolean.parse("True")).toBe(true);
        expect(flexibleBoolean.parse("False")).toBe(false);
    });

    it("acepta la forma en mayúsculas", () => {
        expect(flexibleBoolean.parse("TRUE")).toBe(true);
        expect(flexibleBoolean.parse("FALSE")).toBe(false);
    });

    it("acepta 1 y 0", () => {
        expect(flexibleBoolean.parse(1)).toBe(true);
        expect(flexibleBoolean.parse(0)).toBe(false);
    });

    it("rechaza lo que ya sería adivinar la intención", () => {
        // El límite: normalizar una serialización, sí; interpretar, no.
        for (const bad of ["yes", "no", "si", "1", "0", 2, -1, "", " true ", null, undefined, {}]) {
            expect(
                flexibleBoolean.safeParse(bad).success,
                `debería rechazar ${JSON.stringify(bad)}`,
            ).toBe(false);
        }
    });

    it("todas las formas aceptadas dan un boolean nativo", () => {
        for (const v of [true, "true", "True", "TRUE", 1] as unknown[]) {
            const r = flexibleBoolean.parse(v);
            expect(typeof r, `${JSON.stringify(v)} debería dar boolean`).toBe("boolean");
            expect(r).toBe(true);
        }
        for (const v of [false, "false", "False", "FALSE", 0] as unknown[]) {
            expect(flexibleBoolean.parse(v)).toBe(false);
        }
    });
});
