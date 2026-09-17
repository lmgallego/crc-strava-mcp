/**
 * Único punto que convierte respuestas de Strava en `AlignedStreams`.
 *
 * Las funciones de `analytics/` y `streams/` son puras y agnósticas de la
 * fuente: añadir mañana `intervals.ts` o `fit.ts` no toca ninguna fórmula.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { stravaApi } from "../../stravaClient.js";
import type { AlignedStreams, RawSignals } from "../streams/alignedStreams.js";
import { buildAlignedStreams, NUMERIC_SIGNALS } from "../streams/alignedStreams.js";

/** Tipos de stream que pedimos por defecto. */
export const DEFAULT_STREAM_TYPES = [
    "time",
    "watts",
    "heartrate",
    "cadence",
    "altitude",
    "distance",
    "grade_smooth",
    "moving",
] as const;

export type StreamType = string;

const CACHE_DIR = path.join(os.homedir(), ".config", "strava-mcp", "crc-cache", "streams");

/** Tope de la caché en disco. Al superarse se borran las entradas más antiguas. */
export const CACHE_MAX_ENTRIES = 200;
export const CACHE_MAX_BYTES = 128 * 1024 * 1024; // 128 MB

/** Formato de la caché. Al cambiar, invalida automáticamente lo anterior. */
const CACHE_VERSION = 2;

export interface FetchStreamsOptions {
    accessToken?: string;
    /** Huecos de hasta N s se rellenan al alinear (por defecto 3). */
    gapFillS?: number;
    /** `true` ignora la caché y vuelve a pedir los datos a Strava. */
    refresh?: boolean;
    /** `false` desactiva por completo la caché en disco. */
    useCache?: boolean;
}

export interface ActivityStreams {
    activity_id: string;
    /** Dueño de la actividad. Permite comprobar que es del atleta autenticado. */
    athlete_id: string | null;
    /** `true` = potencia de medidor real; `false` = estimada; `null` = desconocido. */
    device_watts: boolean | null;
    /** Fecha de inicio (ISO). Necesaria para resolver FTP y peso por fecha. */
    start_date: string | null;
    aligned: AlignedStreams;
    from_cache: boolean;
    /** Tipos que Strava devolvió realmente. */
    available_types: string[];
}

interface CachedPayload {
    cache_version: number;
    activity_id: string;
    athlete_id: string | null;
    device_watts: boolean | null;
    start_date: string | null;
    available_types: string[];
    raw: Record<string, unknown[]>;
    fetched_at: string;
}

/**
 * Descarga los streams nativos de una actividad y los devuelve alineados.
 *
 * Pide `key_by_type=true` y `series_type=time`, y **sin** `resolution`: con
 * `resolution` Strava devuelve una muestra reducida y las señales dejan de
 * corresponderse entre sí, que es justo lo que la capa CRC necesita evitar.
 */
export async function fetchActivityStreams(
    activityId: string,
    types: readonly StreamType[] = DEFAULT_STREAM_TYPES,
    options: FetchStreamsOptions = {},
): Promise<ActivityStreams> {
    if (!/^\d+$/.test(activityId)) {
        throw new Error(`activityId debe ser una cadena de dígitos (recibido: ${activityId}).`);
    }

    const token = options.accessToken ?? process.env.STRAVA_ACCESS_TOKEN;
    if (!token) {
        throw new Error("Falta STRAVA_ACCESS_TOKEN para acceder a Strava.");
    }

    const useCache = options.useCache !== false;
    const key = cacheKey(activityId, types);

    let payload: CachedPayload | null = null;
    let fromCache = false;

    if (useCache && !options.refresh) {
        payload = await readCache(key);
        fromCache = payload !== null;
    }

    if (!payload) {
        payload = await downloadStreams(activityId, types, token);
        if (useCache) await writeCache(key, payload);
    }

    const raw = toRawSignals(payload.raw);
    const time = (payload.raw["time"] ?? []) as (number | null | undefined)[];
    if (time.length === 0) {
        throw new Error(`La actividad ${activityId} no tiene stream de tiempo: no se puede alinear.`);
    }

    return {
        activity_id: payload.activity_id,
        athlete_id: payload.athlete_id,
        device_watts: payload.device_watts,
        start_date: payload.start_date,
        aligned: buildAlignedStreams(time, raw, { gapFillS: options.gapFillS }),
        from_cache: fromCache,
        available_types: payload.available_types,
    };
}

/** Descarga streams + metadatos de la actividad (device_watts y athlete.id). */
async function downloadStreams(
    activityId: string,
    types: readonly StreamType[],
    token: string,
): Promise<CachedPayload> {
    const headers = { Authorization: `Bearer ${token}` };

    // El ID viaja como string dentro de la URL: nunca pasa por Number.
    const [streamsRes, activityRes] = await Promise.all([
        stravaApi.get<Record<string, { data?: unknown[] }>>(`activities/${activityId}/streams`, {
            headers,
            params: {
                keys: types.join(","),
                key_by_type: true,
                series_type: "time",
                // Sin `resolution`: se quieren los datos nativos.
            },
        }),
        stravaApi.get<{
            device_watts?: boolean;
            athlete?: { id?: number | string };
            start_date?: string;
        }>(
            `activities/${activityId}`,
            { headers },
        ),
    ]);

    const byType = streamsRes.data ?? {};
    const raw: Record<string, unknown[]> = {};
    for (const [name, entry] of Object.entries(byType)) {
        if (entry && Array.isArray(entry.data)) raw[name] = entry.data;
    }

    const athleteRaw = activityRes.data?.athlete?.id;

    return {
        cache_version: CACHE_VERSION,
        activity_id: activityId,
        athlete_id: athleteRaw == null ? null : String(athleteRaw),
        device_watts: activityRes.data?.device_watts ?? null,
        start_date: activityRes.data?.start_date ?? null,
        available_types: Object.keys(raw),
        raw,
        fetched_at: new Date().toISOString(),
    };
}

/** Traduce los nombres de Strava a los de `AlignedStreams`. */
function toRawSignals(raw: Record<string, unknown[]>): RawSignals {
    const out: Record<string, unknown[]> = {};
    for (const name of NUMERIC_SIGNALS) {
        // Strava llama `grade_smooth` a lo que aquí es `grade`.
        const source = name === "grade" ? (raw["grade_smooth"] ?? raw["grade"]) : raw[name];
        if (source) out[name] = source;
    }
    if (raw["moving"]) out["moving"] = raw["moving"];
    return out as RawSignals;
}

// --- Caché en disco -------------------------------------------------------

function cacheKey(activityId: string, types: readonly StreamType[]): string {
    // Los tipos entran en la clave: pedir menos señales no debe servir una
    // entrada incompleta como si fuera completa.
    const h = createHash("sha1").update([...types].sort().join(",")).digest("hex").slice(0, 8);
    return `${activityId}-${h}`;
}

function cacheFile(key: string): string {
    return path.join(CACHE_DIR, `${key}.json`);
}

async function readCache(key: string): Promise<CachedPayload | null> {
    try {
        const text = await fs.readFile(cacheFile(key), "utf8");
        const parsed = JSON.parse(text) as CachedPayload;
        if (parsed.cache_version !== CACHE_VERSION) return null;
        return parsed;
    } catch {
        // Ausente o corrupta: se trata como fallo de caché, nunca como error.
        return null;
    }
}

async function writeCache(key: string, payload: CachedPayload): Promise<void> {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
        const file = cacheFile(key);
        const tmp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(payload), "utf8");
        await fs.rename(tmp, file);
        await enforceCacheLimits();
    } catch {
        // Un fallo de caché no debe tumbar la petición.
    }
}

/** Borra las entradas más antiguas hasta respetar los topes de número y tamaño. */
export async function enforceCacheLimits(): Promise<void> {
    let names: string[];
    try {
        names = await fs.readdir(CACHE_DIR);
    } catch {
        return;
    }

    const entries: { file: string; size: number; mtime: number }[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const file = path.join(CACHE_DIR, name);
        try {
            const st = await fs.stat(file);
            entries.push({ file, size: st.size, mtime: st.mtimeMs });
        } catch {
            /* ignorada */
        }
    }

    // Más reciente primero: se conservan los primeros y se podan los últimos.
    entries.sort((a, b) => b.mtime - a.mtime);

    let bytes = 0;
    for (let i = 0; i < entries.length; i++) {
        bytes += entries[i]!.size;
        if (i >= CACHE_MAX_ENTRIES || bytes > CACHE_MAX_BYTES) {
            try {
                await fs.unlink(entries[i]!.file);
            } catch {
                /* ignorada */
            }
        }
    }
}

/**
 * Invalida la caché: una actividad concreta o, sin argumento, toda.
 * Devuelve cuántos archivos se han borrado.
 */
export async function clearStreamCache(activityId?: string): Promise<number> {
    let names: string[];
    try {
        names = await fs.readdir(CACHE_DIR);
    } catch {
        return 0;
    }

    let removed = 0;
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        if (activityId && !name.startsWith(`${activityId}-`)) continue;
        try {
            await fs.unlink(path.join(CACHE_DIR, name));
            removed++;
        } catch {
            /* ignorada */
        }
    }
    return removed;
}

/** Ruta de la caché, expuesta para diagnóstico y tests. */
export function streamCacheDir(): string {
    return CACHE_DIR;
}

// --- Barrido temporal -----------------------------------------------------

/**
 * Actividades del atleta autenticado en una ventana de fechas.
 *
 * Adaptador para `bestEffortInPeriod`: éste no conoce Strava, solo consume los
 * proveedores que se le inyectan.
 */
export async function listActivitiesInPeriod(
    fromIso: string,
    toIso: string,
    max: number,
    options: { accessToken?: string } = {},
): Promise<{ activity_id: string; start_date: string; device_watts: boolean | null }[]> {
    const token = options.accessToken ?? process.env.STRAVA_ACCESS_TOKEN;
    if (!token) throw new Error("Falta STRAVA_ACCESS_TOKEN para acceder a Strava.");

    const after = Math.floor(new Date(`${fromIso}T00:00:00Z`).getTime() / 1000);
    const before = Math.floor(new Date(`${toIso}T23:59:59Z`).getTime() / 1000);

    const res = await stravaApi.get<
        { id?: number | string; start_date?: string; device_watts?: boolean }[]
    >("athlete/activities", {
        headers: { Authorization: `Bearer ${token}` },
        // per_page acotado por `max`: barrer cuesta llamadas a la API.
        params: { after, before, per_page: Math.min(max, 200), page: 1 },
    });

    const list = Array.isArray(res.data) ? res.data : [];
    return list
        .filter((a) => a.id != null)
        .slice(0, max)
        .map((a) => ({
            // El ID viaja como string: nunca pasa por Number.
            activity_id: String(a.id),
            start_date: a.start_date ?? "",
            device_watts: a.device_watts ?? null,
        }));
}

/**
 * Proveedores listos para `bestEffortInPeriod`.
 * `loadStreams` usa la caché de disco, como exige D12.
 */
export function stravaBestEffortProviders(options: { accessToken?: string } = {}) {
    return {
        listActivities: (fromIso: string, toIso: string, max: number) =>
            listActivitiesInPeriod(fromIso, toIso, max, options),
        loadStreams: async (activityId: string) => {
            const r = await fetchActivityStreams(activityId, DEFAULT_STREAM_TYPES, {
                ...options,
                useCache: true,
            });
            return {
                activity_id: r.activity_id,
                start_date: r.start_date,
                device_watts: r.device_watts,
                aligned: r.aligned,
            };
        },
    };
}
