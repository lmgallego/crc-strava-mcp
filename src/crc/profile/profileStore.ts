/**
 * Perfil de rendimiento CRC (sección 5 de la especificación).
 *
 * No se llama "athlete profile" para no confundirlo con el perfil de Strava:
 * es una configuración fisiológica complementaria, con histórico por fechas.
 *
 * Escritura atómica: se escribe en un temporal y se renombra, de modo que un
 * fallo a mitad nunca deja el JSON del perfil a medias.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { z } from "zod";

export const PROFILE_DIR = path.join(os.homedir(), ".config", "strava-mcp");
export const PROFILE_FILE = path.join(PROFILE_DIR, "crc-performance-profile.json");

/**
 * Métricas admitidas y su rango plausible.
 *
 * AeT y MAP solo existen si alguien los introduce a mano con fuente explícita:
 * nunca se infieren de Strava.
 */
export const METRIC_SPECS = {
    ftp_w: { unit: "W", min: 50, max: 600 },
    weight_kg: { unit: "kg", min: 30, max: 200 },
    hr_max_bpm: { unit: "bpm", min: 120, max: 230 },
    aet_power_w: { unit: "W", min: 50, max: 500 },
    aet_hr_bpm: { unit: "bpm", min: 80, max: 200 },
    map_w: { unit: "W", min: 100, max: 700 },
} as const;

export type MetricName = keyof typeof METRIC_SPECS;

export const METRIC_NAMES = Object.keys(METRIC_SPECS) as MetricName[];

const isoDate = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "La fecha debe tener formato YYYY-MM-DD.")
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "Fecha inexistente.");

export const metricEntrySchema = z
    .object({
        metric: z.enum(METRIC_NAMES as [MetricName, ...MetricName[]]),
        value: z.number().finite(),
        unit: z.string(),
        effective_from: isoDate,
        effective_to: isoDate.nullable().optional().default(null),
        source: z.string().min(1).default("manual"),
    })
    .superRefine((entry, ctx) => {
        const spec = METRIC_SPECS[entry.metric];
        if (entry.unit !== spec.unit) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `${entry.metric} se expresa en ${spec.unit}, no en "${entry.unit}".`,
            });
        }
        if (entry.value < spec.min || entry.value > spec.max) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message:
                    `${entry.metric} = ${entry.value} ${spec.unit} está fuera del rango ` +
                    `plausible (${spec.min}-${spec.max} ${spec.unit}).`,
            });
        }
        if (entry.effective_to && entry.effective_to < entry.effective_from) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `effective_to (${entry.effective_to}) es anterior a effective_from (${entry.effective_from}).`,
            });
        }
    });

export type MetricEntry = z.infer<typeof metricEntrySchema>;

export const profileSchema = z.object({
    metrics: z.array(metricEntrySchema).default([]),
});

export type PerformanceProfile = z.infer<typeof profileSchema>;

const EMPTY_PROFILE: PerformanceProfile = { metrics: [] };

/** Error de validación del perfil: se traduce a `INVALID_PROFILE`. */
export class InvalidProfileError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InvalidProfileError";
    }
}

/**
 * Comprueba que, para una misma métrica, las ventanas de vigencia no se solapen.
 * Una ventana con `effective_to: null` está abierta hasta el infinito.
 */
export function assertNoOverlap(metrics: MetricEntry[]): void {
    const byMetric = new Map<string, MetricEntry[]>();
    for (const m of metrics) {
        const list = byMetric.get(m.metric) ?? [];
        list.push(m);
        byMetric.set(m.metric, list);
    }

    for (const [name, list] of byMetric) {
        const sorted = [...list].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
        for (let i = 0; i < sorted.length - 1; i++) {
            const current = sorted[i]!;
            const next = sorted[i + 1]!;
            // Sin cierre, la ventana actual cubre todo lo que venga después.
            const closesBefore =
                current.effective_to !== null && current.effective_to !== undefined
                    ? current.effective_to < next.effective_from
                    : false;
            if (!closesBefore) {
                throw new InvalidProfileError(
                    `Ventanas solapadas para ${name}: [${current.effective_from} .. ` +
                        `${current.effective_to ?? "abierta"}] se solapa con [${next.effective_from} .. ` +
                        `${next.effective_to ?? "abierta"}].`,
                );
            }
        }
    }
}

/** Lee el perfil. Si no existe, devuelve uno vacío (no es un error). */
export async function loadProfile(file: string = PROFILE_FILE): Promise<PerformanceProfile> {
    let text: string;
    try {
        text = await fs.readFile(file, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_PROFILE };
        throw err;
    }

    let json: unknown;
    try {
        json = JSON.parse(text);
    } catch {
        throw new InvalidProfileError(`El perfil ${file} no es JSON válido.`);
    }

    const parsed = profileSchema.safeParse(json);
    if (!parsed.success) {
        throw new InvalidProfileError(
            `Perfil inválido: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
    }
    assertNoOverlap(parsed.data.metrics);
    return parsed.data;
}

/** Escribe el perfil de forma atómica (tmp + rename). */
export async function saveProfile(
    profile: PerformanceProfile,
    file: string = PROFILE_FILE,
): Promise<void> {
    const parsed = profileSchema.safeParse(profile);
    if (!parsed.success) {
        throw new InvalidProfileError(
            `Perfil inválido: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
        );
    }
    assertNoOverlap(parsed.data.metrics);

    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
}

export interface SetMetricOptions {
    /** Permite reemplazar una entrada ya existente con el mismo effective_from. */
    overwrite?: boolean;
    file?: string;
}

/**
 * Añade o actualiza una entrada del perfil.
 *
 * Sin `overwrite: true` nunca pisa histórico: si ya hay una entrada para esa
 * métrica y esa misma fecha de inicio, se rechaza.
 */
export async function setMetric(
    entry: unknown,
    options: SetMetricOptions = {},
): Promise<PerformanceProfile> {
    const file = options.file ?? PROFILE_FILE;

    const parsed = metricEntrySchema.safeParse(entry);
    if (!parsed.success) {
        throw new InvalidProfileError(
            parsed.error.issues.map((i) => i.message).join("; "),
        );
    }
    const next = parsed.data;

    const profile = await loadProfile(file);
    const idx = profile.metrics.findIndex(
        (m) => m.metric === next.metric && m.effective_from === next.effective_from,
    );

    if (idx >= 0 && !options.overwrite) {
        throw new InvalidProfileError(
            `Ya existe ${next.metric} con effective_from ${next.effective_from} ` +
                `(valor ${profile.metrics[idx]!.value}). Usa overwrite:true para reemplazarlo.`,
        );
    }

    const metrics = [...profile.metrics];
    if (idx >= 0) metrics[idx] = next;
    else metrics.push(next);

    // Valida el solape ANTES de tocar el disco.
    assertNoOverlap(metrics);

    const updated: PerformanceProfile = { metrics };
    await saveProfile(updated, file);
    return updated;
}
