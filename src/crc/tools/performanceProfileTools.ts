/**
 * Wrappers MCP del perfil de rendimiento CRC.
 *
 * Finos por diseño: validación Zod -> store/resolver -> `crcToolResponse`.
 * Toda la lógica vive en `../profile/`.
 */
import { z } from "zod";

import {
    resolveMetrics,
    type ResolveResult,
} from "../profile/profileResolver.js";
import {
    InvalidProfileError,
    loadProfile,
    METRIC_NAMES,
    METRIC_SPECS,
    setMetric,
    type MetricName,
} from "../profile/profileStore.js";
import { CrcErrorCode, crcToolResponse, crcUnavailable } from "../schemas/crcToolResponse.js";
import { flexibleBoolean } from "../schemas/mcpSchemas.js";

export const CRC_VERSION = "0.1.0";

const metricEnum = z.enum(METRIC_NAMES as [MetricName, ...MetricName[]]);

// --- crc-get-performance-profile -----------------------------------------

export const getPerformanceProfileInput = {
    date: z
        .string()
        .optional()
        .describe(
            "Fecha (YYYY-MM-DD) para la que resolver los valores vigentes. " +
                "Si se omite, devuelve el perfil completo sin resolver.",
        ),
    metrics: z
        .array(metricEnum)
        .optional()
        .describe(`Métricas a resolver. Por defecto todas: ${METRIC_NAMES.join(", ")}.`),
};

export const getPerformanceProfileTool = {
    name: "crc-get-performance-profile",
    description:
        "Devuelve el perfil de rendimiento CRC (FTP, peso, FC máx, AeT, MAP) del atleta " +
        "autenticado. Con `date`, resuelve el valor vigente en esa fecha; si no hay ninguno " +
        "vigente devuelve missing_parameter en lugar del valor actual.",
    inputSchema: z.object(getPerformanceProfileInput),
    execute: async (args: { date?: string; metrics?: MetricName[] }) => {
        try {
            const profile = await loadProfile();
            const wanted = args.metrics ?? METRIC_NAMES;

            if (!args.date) {
                return json(
                    crcToolResponse({
                        tool: "crc-get-performance-profile",
                        version: CRC_VERSION,
                        inputs: { date: null, metrics: wanted },
                        method: { resolution: "perfil completo sin resolución por fecha" },
                        metrics: { entries: profile.metrics, entry_count: profile.metrics.length },
                        quality: { warnings: profile.metrics.length ? [] : ["El perfil está vacío."] },
                    }),
                );
            }

            const resolved = resolveMetrics(profile, wanted, args.date);
            const missing = Object.values(resolved).filter((r) => !r.found) as Extract<
                ResolveResult,
                { found: false }
            >[];

            return json(
                crcToolResponse({
                    tool: "crc-get-performance-profile",
                    version: CRC_VERSION,
                    inputs: { date: args.date, metrics: wanted },
                    method: {
                        resolution:
                            "Valor cuya ventana effective_from/effective_to incluye la fecha. " +
                            "Sin ventana vigente se devuelve missing_parameter; nunca el valor actual.",
                    },
                    metrics: resolved,
                    quality: {
                        resolved_count: wanted.length - missing.length,
                        missing_count: missing.length,
                        warnings: missing.map((m) => m.message),
                    },
                }),
            );
        } catch (err) {
            return failure(err, "crc-get-performance-profile");
        }
    },
};

// --- crc-set-performance-profile -----------------------------------------

export const setPerformanceProfileInput = {
    metric: metricEnum.describe(
        `Métrica a fijar. AeT y MAP solo se registran a mano: nunca se infieren de Strava.`,
    ),
    value: z.number().finite().describe("Valor numérico de la métrica."),
    unit: z
        .string()
        .optional()
        .describe(
            "Unidad. Si se omite se usa la canónica: " +
                Object.entries(METRIC_SPECS)
                    .map(([m, s]) => `${m}=${s.unit}`)
                    .join(", "),
        ),
    effective_from: z
        .string()
        .describe("Inicio de la vigencia (YYYY-MM-DD). Obligatorio: el perfil es histórico."),
    effective_to: z
        .string()
        .nullable()
        .optional()
        .describe("Fin de la vigencia (YYYY-MM-DD) o null si sigue vigente."),
    source: z
        .string()
        .optional()
        .describe("Origen del dato (p. ej. 'manual', 'test de rampa 2026-09'). Por defecto 'manual'."),
    overwrite: flexibleBoolean
        .optional()
        .describe(
            "true para reemplazar una entrada existente con el mismo effective_from. " +
                "Sin esto, el histórico no se pisa.",
        ),
};

export const setPerformanceProfileTool = {
    name: "crc-set-performance-profile",
    description:
        "Registra un valor del perfil de rendimiento CRC con su ventana de vigencia. " +
        "Valida unidades, rangos plausibles y que las ventanas no se solapen. " +
        "No sobrescribe histórico salvo overwrite:true.",
    inputSchema: z.object(setPerformanceProfileInput),
    execute: async (args: {
        metric: MetricName;
        value: number;
        unit?: string;
        effective_from: string;
        effective_to?: string | null;
        source?: string;
        overwrite?: boolean;
    }) => {
        try {
            const updated = await setMetric(
                {
                    metric: args.metric,
                    value: args.value,
                    unit: args.unit ?? METRIC_SPECS[args.metric].unit,
                    effective_from: args.effective_from,
                    effective_to: args.effective_to ?? null,
                    source: args.source ?? "manual",
                },
                { overwrite: args.overwrite },
            );

            return json(
                crcToolResponse({
                    tool: "crc-set-performance-profile",
                    version: CRC_VERSION,
                    inputs: {
                        metric: args.metric,
                        value: args.value,
                        effective_from: args.effective_from,
                        effective_to: args.effective_to ?? null,
                        overwrite: args.overwrite ?? false,
                    },
                    method: { write: "escritura atómica (archivo temporal + rename)" },
                    metrics: {
                        saved: true,
                        entry_count: updated.metrics.length,
                        entries: updated.metrics.filter((m) => m.metric === args.metric),
                    },
                    quality: { warnings: [] },
                }),
            );
        } catch (err) {
            // Un perfil incoherente es INVALID_PROFILE dentro del JSON, no isError:
            // el orquestador puede seguir con el resto del análisis.
            if (err instanceof InvalidProfileError) {
                return json(
                    crcUnavailable({
                        tool: "crc-set-performance-profile",
                        version: CRC_VERSION,
                        inputs: { metric: args.metric, effective_from: args.effective_from },
                        code: CrcErrorCode.INVALID_PROFILE,
                        message: err.message,
                        quality: { warnings: [err.message] },
                    }),
                );
            }
            return failure(err, "crc-set-performance-profile");
        }
    },
};

// --- helpers --------------------------------------------------------------

function json(payload: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/** isError solo para fallos de entrada o de red (decisión 6). */
function failure(err: unknown, tool: string) {
    const message = err instanceof Error ? err.message : String(err);
    return {
        content: [{ type: "text" as const, text: `❌ ${tool}: ${message}` }],
        isError: true as const,
    };
}
