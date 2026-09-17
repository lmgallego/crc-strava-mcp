/**
 * Resolución histórica de parámetros del perfil.
 *
 * Regla central: para una actividad con fecha D se usa el valor cuya ventana de
 * vigencia incluye D. Si no hay ninguna, se devuelve `missing_parameter`.
 * NUNCA se cae hacia el valor actual: usar el FTP de hoy para una actividad de
 * hace ocho meses falsea IF, TSS y zonas sin que nadie lo note.
 */
import type { MetricEntry, MetricName, PerformanceProfile } from "./profileStore.js";
import { METRIC_SPECS } from "./profileStore.js";

export interface ResolvedMetric {
    found: true;
    metric: MetricName;
    value: number;
    unit: string;
    source: string;
    effective_from: string;
    effective_to: string | null;
}

export interface MissingMetric {
    found: false;
    metric: MetricName;
    reason: "missing_parameter";
    message: string;
}

export type ResolveResult = ResolvedMetric | MissingMetric;

/** Normaliza a `YYYY-MM-DD`. Acepta ISO completo o `Date`. */
export function toIsoDay(date: string | Date): string {
    if (date instanceof Date) {
        if (Number.isNaN(date.getTime())) throw new Error("Fecha inválida.");
        return date.toISOString().slice(0, 10);
    }
    const day = date.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        throw new Error(`Fecha inválida: ${date}. Se espera YYYY-MM-DD.`);
    }
    return day;
}

/** ¿La ventana de la entrada cubre ese día? `effective_to: null` = abierta. */
function covers(entry: MetricEntry, day: string): boolean {
    if (day < entry.effective_from) return false;
    const to = entry.effective_to;
    if (to === null || to === undefined) return true;
    return day <= to;
}

/**
 * Devuelve el valor vigente de `metric` en la fecha dada, o `missing_parameter`.
 *
 * Si varias ventanas cubriesen la fecha (el perfil no debería permitirlo, lo
 * valida `assertNoOverlap`), gana la de inicio más reciente.
 */
export function resolveMetric(
    profile: PerformanceProfile,
    metric: MetricName,
    date: string | Date,
): ResolveResult {
    const day = toIsoDay(date);

    const candidates = profile.metrics
        .filter((m) => m.metric === metric && covers(m, day))
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from));

    const hit = candidates[0];
    if (!hit) {
        const any = profile.metrics.some((m) => m.metric === metric);
        return {
            found: false,
            metric,
            reason: "missing_parameter",
            message: any
                ? `No hay ${metric} vigente para ${day}: el perfil tiene valores, pero ninguno cubre esa fecha.`
                : `El perfil no contiene ${metric}. Añádelo con crc-set-performance-profile.`,
        };
    }

    return {
        found: true,
        metric,
        value: hit.value,
        unit: hit.unit || METRIC_SPECS[metric].unit,
        source: hit.source,
        effective_from: hit.effective_from,
        effective_to: hit.effective_to ?? null,
    };
}

/** Resuelve varias métricas a la vez para la misma fecha. */
export function resolveMetrics(
    profile: PerformanceProfile,
    metrics: readonly MetricName[],
    date: string | Date,
): Record<string, ResolveResult> {
    const out: Record<string, ResolveResult> = {};
    for (const m of metrics) out[m] = resolveMetric(profile, m, date);
    return out;
}
