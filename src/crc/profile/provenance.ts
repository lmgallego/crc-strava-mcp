/**
 * Procedencia de los parámetros del perfil.
 *
 * Un FTP estimado no vale lo mismo que uno medido: IF, TSS y las zonas
 * relativas heredan su incertidumbre, así que cualquier análisis que lo use
 * debe decirlo en su bloque `quality` (D12).
 */

/** Valores de `source` que indican que el dato NO fue declarado ni medido. */
export const ESTIMATED_SOURCES: readonly string[] = ["estimated_20min"];

export function isEstimatedSource(source: unknown): boolean {
    return typeof source === "string" && ESTIMATED_SOURCES.includes(source);
}

export interface ProvenanceNote {
    /** `true` si el parámetro proviene de una estimación. */
    estimated: boolean;
    source: string | null;
    warnings: string[];
}

/**
 * Analiza la procedencia de un parámetro ya resuelto.
 *
 * `entry` es lo que guarda `parameter_sources`: `{ source, effective_from, value }`.
 */
export function describeProvenance(metric: string, entry: unknown): ProvenanceNote {
    const source =
        entry && typeof entry === "object" && "source" in entry
            ? ((entry as { source?: unknown }).source ?? null)
            : null;

    const src = typeof source === "string" ? source : null;
    if (!isEstimatedSource(src)) return { estimated: false, source: src, warnings: [] };

    return {
        estimated: true,
        source: src,
        warnings: [
            `El ${metric} usado es una ESTIMACIÓN (source: "${src}"), no un valor medido ni ` +
                "declarado por el usuario. Las métricas derivadas heredan esa incertidumbre.",
        ],
    };
}
