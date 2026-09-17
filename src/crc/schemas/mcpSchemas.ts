import { z } from "zod";

/**
 * Helpers Zod reutilizables por las herramientas CRC.
 *
 * Regla del proyecto: los IDs de Strava son `string` en toda la capa CRC.
 * Strava usa enteros de 64 bits y JavaScript solo representa enteros exactos
 * hasta 2^53-1 (16 dígitos). Un ID de 19 dígitos que pase por `Number` queda
 * corrompido de forma silenciosa e irreversible.
 */

/** Mayor entero que JavaScript representa de forma exacta: 9007199254740991. */
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/**
 * ID de Strava. Acepta `number` o `string`, exige que sean solo dígitos y
 * devuelve SIEMPRE `string`.
 *
 * Un `number` que ya venga fuera del rango seguro se rechaza en lugar de
 * aceptarse: en ese punto la precisión ya se ha perdido (la corrupción ocurre
 * al parsear el JSON, antes de llegar aquí) y devolver un ID silenciosamente
 * equivocado es peor que fallar. Los IDs largos deben enviarse como string.
 */
export const stravaId = z
    .union([z.string(), z.number()])
    .superRefine((value, ctx) => {
        if (typeof value === "number" && !Number.isSafeInteger(value)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    `ID numérico fuera del rango seguro de JavaScript (> ${MAX_SAFE}): ` +
                    `la precisión ya se ha perdido. Envía el ID como string.`,
            });
        }
    })
    .transform((value) => (typeof value === "number" ? String(value) : value.trim()))
    .refine((id) => /^\d+$/.test(id), {
        message: "El ID de Strava debe contener solo dígitos.",
    });

/** Tipo de salida de `stravaId`: siempre string. */
export type StravaId = z.infer<typeof stravaId>;

/**
 * Booleano tolerante: algunos clientes MCP envían los booleanos como texto.
 * Acepta `true`, `false`, `"true"` y `"false"`; devuelve siempre `boolean`.
 */
export const flexibleBoolean = z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => (typeof value === "boolean" ? value : value === "true"));

export type FlexibleBoolean = z.infer<typeof flexibleBoolean>;
