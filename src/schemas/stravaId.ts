import { z } from "zod";

/**
 * Helpers Zod neutrales, compartidos por las herramientas originales y por la
 * capa CRC. Este módulo NO depende de `src/crc/`: así las tools originales
 * pueden usarlo sin romper la regla de dependencia unidireccional.
 *
 * Los IDs de Strava son enteros de 64 bits y JavaScript solo representa
 * enteros exactos hasta 2^53-1 (16 dígitos). Un ID de 19 dígitos que pase por
 * `Number` queda corrompido de forma silenciosa e irreversible.
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
 * Booleano tolerante: no todos los clientes MCP serializan igual un booleano.
 *
 * Acepta, además del `boolean` nativo:
 * - `"true"` / `"false"` en minúscula, que es lo que envía JSON.
 * - `"True"` / `"TRUE"` y sus negativos, que es la forma natural de un cliente
 *   entrenado sobre Python, donde el literal se escribe capitalizado.
 * - `1` y `0`, la convención de C y de buena parte de las APIs.
 *
 * Devuelve siempre `boolean`. Deliberadamente NO acepta `"1"`, `"0"`, `"yes"`,
 * `"si"` ni cadena vacía: ahí ya no se está normalizando una serialización,
 * se está adivinando la intención.
 */
const TRUE_STRINGS = ["true", "True", "TRUE"] as const;
const FALSE_STRINGS = ["false", "False", "FALSE"] as const;

export const flexibleBoolean = z
    .union([
        z.boolean(),
        z.enum([...TRUE_STRINGS, ...FALSE_STRINGS]),
        z.literal(0),
        z.literal(1),
    ])
    .transform((value) => {
        if (typeof value === "boolean") return value;
        if (typeof value === "number") return value === 1;
        return value.toLowerCase() === "true";
    });

export type FlexibleBoolean = z.infer<typeof flexibleBoolean>;
