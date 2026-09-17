import { z } from "zod";

/**
 * Envoltorio común de todas las respuestas CRC (sección 8 de la especificación)
 * y saneado final que garantiza que ninguna respuesta pública contiene
 * `NaN` ni `Infinity`.
 */

/** Códigos de error de la sección 12 de la especificación. */
export const CrcErrorCode = {
    MISSING_POWER: "MISSING_POWER",
    MISSING_HR: "MISSING_HR",
    MISSING_FTP: "MISSING_FTP",
    MISSING_WEIGHT: "MISSING_WEIGHT",
    INSUFFICIENT_DURATION: "INSUFFICIENT_DURATION",
    LOW_COVERAGE: "LOW_COVERAGE",
    INVALID_PROFILE: "INVALID_PROFILE",
} as const;

export type CrcErrorCode = (typeof CrcErrorCode)[keyof typeof CrcErrorCode];

export const crcErrorCodeSchema = z.nativeEnum(CrcErrorCode);

export const crcErrorSchema = z.object({
    code: crcErrorCodeSchema,
    message: z.string(),
});

export type CrcError = z.infer<typeof crcErrorSchema>;

export const crcQualitySchema = z
    .object({
        warnings: z.array(z.string()),
    })
    .passthrough();

/**
 * Envoltorio `{ tool, version, activity_id, inputs, method, metrics, quality, errors }`.
 *
 * `available` marca si el módulo pudo calcularse. Convención de la
 * especificación (decisión 6): un módulo no disponible devuelve
 * `available: false` DENTRO del JSON y nunca `isError`. `isError` queda
 * reservado a fallos de entrada o de red.
 */
export const crcToolResponseSchema = z.object({
    tool: z.string(),
    version: z.string(),
    activity_id: z.string().nullable(),
    available: z.boolean(),
    inputs: z.record(z.unknown()),
    method: z.record(z.unknown()),
    metrics: z.record(z.unknown()),
    quality: crcQualitySchema,
    errors: z.array(crcErrorSchema),
});

export type CrcToolResponse = z.infer<typeof crcToolResponseSchema>;

/** Valor no finito encontrado durante el saneado. */
function describeNonFinite(value: number): string {
    if (Number.isNaN(value)) return "NaN";
    return value > 0 ? "Infinity" : "-Infinity";
}

/**
 * Sustituye recursivamente `NaN`, `Infinity` y `-Infinity` por `null` y añade
 * un warning por cada sustitución indicando la ruta del campo afectado.
 *
 * Devuelve una copia: no muta la entrada.
 */
export function sanitize<T>(value: T): { value: T; warnings: string[] } {
    const warnings: string[] = [];

    const walk = (node: unknown, path: string): unknown => {
        if (typeof node === "number") {
            if (!Number.isFinite(node)) {
                warnings.push(`${path}: ${describeNonFinite(node)} sustituido por null.`);
                return null;
            }
            return node;
        }
        if (Array.isArray(node)) {
            return node.map((item, i) => walk(item, `${path}[${i}]`));
        }
        // Solo se recorren objetos planos; Date, Map y similares se dejan intactos.
        if (node !== null && typeof node === "object" && isPlainObject(node)) {
            const out: Record<string, unknown> = {};
            for (const [key, child] of Object.entries(node)) {
                out[key] = walk(child, path ? `${path}.${key}` : key);
            }
            return out;
        }
        return node;
    };

    return { value: walk(value, "") as T, warnings };
}

function isPlainObject(value: object): value is Record<string, unknown> {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

/**
 * Construye una respuesta CRC saneada. Los warnings generados por el saneado
 * se acumulan en `quality.warnings`, nunca se descartan.
 */
export function crcToolResponse(input: {
    tool: string;
    version: string;
    activity_id?: string | null;
    available?: boolean;
    inputs?: Record<string, unknown>;
    method?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    quality?: Record<string, unknown> & { warnings?: string[] };
    errors?: CrcError[];
}): CrcToolResponse {
    const { warnings: sanitizeWarnings, value: sanitized } = sanitize({
        inputs: input.inputs ?? {},
        method: input.method ?? {},
        metrics: input.metrics ?? {},
        quality: input.quality ?? {},
    });

    const { warnings: existingWarnings, ...restQuality } = sanitized.quality as Record<
        string,
        unknown
    > & { warnings?: string[] };

    return {
        tool: input.tool,
        version: input.version,
        activity_id: input.activity_id ?? null,
        available: input.available ?? true,
        inputs: sanitized.inputs,
        method: sanitized.method,
        metrics: sanitized.metrics,
        quality: {
            ...restQuality,
            warnings: [...(existingWarnings ?? []), ...sanitizeWarnings],
        },
        errors: input.errors ?? [],
    };
}

/**
 * Respuesta de módulo no disponible: `available: false` + código de error,
 * sin `isError` (decisión 6 de la especificación).
 */
export function crcUnavailable(
    input: Parameters<typeof crcToolResponse>[0] & { code: CrcErrorCode; message: string },
): CrcToolResponse {
    return crcToolResponse({
        ...input,
        available: false,
        errors: [...(input.errors ?? []), { code: input.code, message: input.message }],
    });
}
