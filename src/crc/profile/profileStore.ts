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
    /**
     * FC del SEGUNDO umbral (umbral funcional / LTHR): la máxima que se
     * sostiene en estado estable, en torno a una hora de esfuerzo.
     *
     * NO confundir con `aet_hr_bpm`, que es la del PRIMER umbral (aeróbico),
     * bastante más baja. Se prestan a confusión porque ambas son "una FC de
     * umbral", pero marcan transiciones fisiológicas distintas y anclan zonas
     * distintas: las zonas de Coggan de FC se calculan sobre ESTA, no sobre
     * la de AeT.
     *
     * Orden esperado: aet_hr_bpm < hr_threshold_bpm < hr_max_bpm.
     */
    hr_threshold_bpm: { unit: "bpm", min: 100, max: 210 },
    aet_power_w: { unit: "W", min: 50, max: 500 },
    /** FC del PRIMER umbral (aeróbico). Ver la nota de `hr_threshold_bpm`. */
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
        // Sin fecha se asume "desde hoy" (D25): es lo que quiere decir alguien
        // que declara su FTP sin más, y rechazarlo solo añade fricción.
        effective_from: isoDate.optional().default(() => todayIso()),
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

/**
 * Orden fisiológico que deben respetar las tres frecuencias, de menor a mayor.
 * Solo se comprueban las que existan y cuyas ventanas se solapen.
 */
const HR_ORDER: { metric: MetricName; label: string }[] = [
    { metric: "aet_hr_bpm", label: "FC del primer umbral (AeT)" },
    { metric: "hr_threshold_bpm", label: "FC de umbral (LTHR)" },
    { metric: "hr_max_bpm", label: "FC máxima" },
];

/** ¿Se solapan las ventanas de vigencia de dos entradas? */
function windowsOverlap(a: MetricEntry, b: MetricEntry): boolean {
    const aEnd = a.effective_to ?? "9999-12-31";
    const bEnd = b.effective_to ?? "9999-12-31";
    return a.effective_from <= bEnd && b.effective_from <= aEnd;
}

/**
 * Comprueba que las frecuencias cardíacas guardan el orden fisiológico.
 *
 * Un LTHR por encima de la FC máxima no es un dato raro: es un dato
 * imposible, y además es el error típico de quien confunde `aet_hr_bpm` con
 * `hr_threshold_bpm`. Se caza al guardar, no al calcular zonas, para que el
 * perfil no llegue a contener algo incoherente.
 */
export function assertCoherentHeartRates(metrics: MetricEntry[]): void {
    for (let i = 0; i < HR_ORDER.length - 1; i++) {
        for (let j = i + 1; j < HR_ORDER.length; j++) {
            const lower = HR_ORDER[i]!;
            const upper = HR_ORDER[j]!;
            for (const a of metrics.filter((m) => m.metric === lower.metric)) {
                for (const b of metrics.filter((m) => m.metric === upper.metric)) {
                    if (!windowsOverlap(a, b)) continue;
                    if (a.value < b.value) continue;
                    throw new InvalidProfileError(
                        `${lower.label} (${a.value} bpm desde ${a.effective_from}) debe ser menor ` +
                            `que la ${upper.label} (${b.value} bpm desde ${b.effective_from}), y sus ` +
                            "ventanas se solapan. Revisa si has confundido aet_hr_bpm con hr_threshold_bpm.",
                    );
                }
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
    assertCoherentHeartRates(parsed.data.metrics);
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
    assertCoherentHeartRates(parsed.data.metrics);

    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, "utf8");
    await fs.rename(tmp, file);
}

/** Día de hoy en formato YYYY-MM-DD (UTC). */
export function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

/** Día anterior a `day`, en YYYY-MM-DD. */
export function previousDay(day: string): string {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

export interface SetMetricOptions {
    /** Permite reemplazar una entrada ya existente con el mismo effective_from. */
    overwrite?: boolean;
    /**
     * Cierra la vigencia de la entrada abierta anterior de esa misma métrica,
     * poniéndole `effective_to` al día previo al nuevo `effective_from`.
     *
     * Exige confirmación explícita (D26) porque MODIFICA el histórico: sin esto,
     * añadir un FTP nuevo fallaría por solape, que es el aviso correcto.
     */
    closePrevious?: boolean;
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

    // Cierre de la vigencia anterior (D26). Solo con confirmación explícita:
    // modifica una entrada del histórico que el usuario ya había guardado.
    if (options.closePrevious) {
        let closedAt = -1;
        for (let i = 0; i < metrics.length; i++) {
            const m = metrics[i]!;
            if (m === next) continue;
            if (m.metric !== next.metric) continue;
            // Solo la ventana abierta que empieza antes que la nueva.
            if (m.effective_to != null) continue;
            if (m.effective_from >= next.effective_from) continue;
            if (closedAt >= 0 && metrics[closedAt]!.effective_from > m.effective_from) continue;
            closedAt = i;
        }
        if (closedAt >= 0) {
            const prev = metrics[closedAt]!;
            metrics[closedAt] = { ...prev, effective_to: previousDay(next.effective_from) };
        }
    }

    // Valida el solape ANTES de tocar el disco.
    assertNoOverlap(metrics);
    assertCoherentHeartRates(metrics);

    const updated: PerformanceProfile = { metrics };
    await saveProfile(updated, file);
    return updated;
}
