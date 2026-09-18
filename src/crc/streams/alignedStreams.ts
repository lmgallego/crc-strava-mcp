/**
 * Alineación de streams sobre una rejilla de 1 s.
 *
 * Función pura: no depende de Strava ni de MCP.
 *
 * Por qué existe: el `downsampleStream` del código original inserta picos y
 * valles de forma independiente en cada señal, de modo que `watts[i]` y
 * `heartrate[i]` pueden acabar representando muestras distintas. Aquí se
 * construye un ÚNICO índice temporal y todas las señales se proyectan sobre él,
 * por lo que `time[i]`, `watts[i]` y `heartrate[i]` siempre son el mismo
 * instante.
 */

/** Hueco máximo (s) que se rellena. Por encima, el tramo se marca no válido. */
export const DEFAULT_GAP_FILL_S = 3;

/**
 * Tope de la rejilla: 24 h a 1 Hz. Protege contra una actividad con una pausa
 * absurda que haría explotar la memoria.
 * ponytail: tope fijo; si algún día hace falta, se parametriza.
 */
const MAX_GRID_SECONDS = 24 * 3600;

export type NumericSignal =
    | "watts"
    | "heartrate"
    | "cadence"
    | "altitude"
    | "distance"
    | "grade";

export const NUMERIC_SIGNALS: readonly NumericSignal[] = [
    "watts",
    "heartrate",
    "cadence",
    "altitude",
    "distance",
    "grade",
];

/** Streams crudos tal y como llegan de la fuente (pueden traer huecos y nulls). */
export type RawSignals = Partial<Record<NumericSignal, ReadonlyArray<number | null | undefined>>> & {
    moving?: ReadonlyArray<boolean | null | undefined>;
};

export interface SignalMeta {
    /** La señal venía en el origen. */
    present: boolean;
    /** Muestras que llegaron como null/undefined o no numéricas. */
    missing_samples: number;
    /** Segundos de la rejilla cuyo valor se ha rellenado (interpolado o arrastrado). */
    filled_seconds: number;
}

export interface Gap {
    /** Primer segundo del hueco (relativo al inicio, incluido). */
    from_s: number;
    /** Último segundo del hueco (incluido). */
    to_s: number;
    duration_s: number;
    filled: boolean;
}

export interface AlignMeta {
    gap_fill_s: number;
    /** Offset aplicado: `time[0]` original. La rejilla siempre empieza en 0. */
    start_offset_s: number;
    grid_seconds: number;
    valid_seconds: number;
    gaps: Gap[];
    signals: Record<string, SignalMeta>;
    warnings: string[];
    /** Descripción del método, para volcarla en el bloque `method` de la respuesta. */
    method: string;
}

export interface AlignedStreams {
    /** Rejilla de 1 s empezando en 0. Todas las señales comparten longitud e índice. */
    time: number[];
    /** `false` en los segundos que caen dentro de un hueco largo. */
    valid: boolean[];
    watts?: number[];
    heartrate?: number[];
    cadence?: number[];
    altitude?: number[];
    distance?: number[];
    grade?: number[];
    moving?: boolean[];
    meta: AlignMeta;
}

export interface AlignOptions {
    /** Huecos de hasta este tamaño se rellenan (por defecto 3 s). */
    gapFillS?: number;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Construye `AlignedStreams` a partir del stream `time` y las señales crudas.
 *
 * - La rejilla va de 0 a `time[last] - time[0]`, con paso de 1 s.
 * - Los huecos de hasta `gapFillS` se rellenan por interpolación lineal y
 *   cuentan como válidos.
 * - Los huecos mayores se rellenan arrastrando el último valor conocido (para
 *   conservar la longitud) pero quedan marcados `valid[i] === false`. Las
 *   ventanas móviles deben excluirlos.
 * - Un `0` es un valor legítimo (rueda libre, parado) y nunca se trata como
 *   ausencia: solo `null`, `undefined` y no finitos cuentan como falta.
 */
export function buildAlignedStreams(
    time: ReadonlyArray<number | null | undefined>,
    signals: RawSignals = {},
    options: AlignOptions = {},
): AlignedStreams {
    const gapFillS = options.gapFillS ?? DEFAULT_GAP_FILL_S;
    if (!Number.isInteger(gapFillS) || gapFillS < 0) {
        throw new Error(`gapFillS debe ser un entero >= 0 (recibido: ${gapFillS}).`);
    }
    if (!Array.isArray(time) || time.length === 0) {
        throw new Error("El stream `time` es obligatorio y no puede estar vacío.");
    }

    const warnings: string[] = [];

    // 1) Muestras utilizables de `time`: finitas y estrictamente crecientes.
    const sampleIdx: number[] = [];
    const sampleT: number[] = [];
    let last = -Infinity;
    let dropped = 0;
    for (let i = 0; i < time.length; i++) {
        const t = time[i];
        if (!isNum(t)) {
            dropped++;
            continue;
        }
        const ti = Math.round(t);
        if (ti <= last) {
            // Tiempo que no avanza: muestra duplicada o corrupta.
            dropped++;
            continue;
        }
        last = ti;
        sampleIdx.push(i);
        sampleT.push(ti);
    }
    if (sampleT.length === 0) {
        throw new Error("El stream `time` no contiene ninguna muestra utilizable.");
    }
    if (dropped > 0) {
        warnings.push(`Se descartaron ${dropped} muestras de time no finitas o no crecientes.`);
    }

    const startOffset = sampleT[0]!;
    const span = sampleT[sampleT.length - 1]! - startOffset;
    if (span + 1 > MAX_GRID_SECONDS) {
        throw new Error(
            `La actividad abarca ${span} s, por encima del tope de ${MAX_GRID_SECONDS} s.`,
        );
    }
    const n = span + 1;

    // 2) Rejilla y validez. Se parte de "no válido" y se marcan las muestras reales.
    const grid: number[] = new Array(n);
    for (let i = 0; i < n; i++) grid[i] = i;
    const valid: boolean[] = new Array(n).fill(false);
    for (const t of sampleT) valid[t - startOffset] = true;

    // 3) Huecos entre muestras consecutivas.
    const gaps: Gap[] = [];
    for (let k = 0; k < sampleT.length - 1; k++) {
        const a = sampleT[k]! - startOffset;
        const b = sampleT[k + 1]! - startOffset;
        const gap = b - a - 1; // segundos sin muestra entre ambas
        if (gap <= 0) continue;
        const fill = gap <= gapFillS;
        gaps.push({ from_s: a + 1, to_s: b - 1, duration_s: gap, filled: fill });
        if (fill) for (let i = a + 1; i < b; i++) valid[i] = true;
    }

    const longGaps = gaps.filter((g) => !g.filled);
    if (longGaps.length > 0) {
        const lost = longGaps.reduce((s, g) => s + g.duration_s, 0);
        warnings.push(
            `${longGaps.length} hueco(s) mayores de ${gapFillS} s (${lost} s en total) marcados como no válidos.`,
        );
    }

    // 4) Proyección de cada señal sobre la rejilla.
    const out: AlignedStreams = {
        time: grid,
        valid,
        meta: {
            gap_fill_s: gapFillS,
            start_offset_s: startOffset,
            grid_seconds: n,
            valid_seconds: valid.reduce((s, v) => s + (v ? 1 : 0), 0),
            gaps,
            signals: {},
            warnings,
            method:
                `Rejilla de 1 s sobre el stream time. Huecos <= ${gapFillS} s rellenados por ` +
                `interpolación lineal y contados como válidos; huecos mayores marcados no válidos ` +
                `(valor arrastrado solo para conservar la longitud). Índice único compartido por ` +
                `todas las señales; sin downsampling por señal.`,
        },
    };

    for (const name of NUMERIC_SIGNALS) {
        const raw = signals[name];
        if (raw === undefined) {
            out.meta.signals[name] = { present: false, missing_samples: 0, filled_seconds: 0 };
            continue;
        }
        const { values, meta } = projectNumeric(raw, sampleIdx, sampleT, startOffset, n, gapFillS);
        out[name] = values;
        out.meta.signals[name] = meta;
        if (meta.present && meta.missing_samples > 0) {
            warnings.push(
                `La señal ${name} traía ${meta.missing_samples} muestra(s) sin valor numérico.`,
            );
        }
    }

    if (signals.moving !== undefined) {
        const { values, meta } = projectBoolean(signals.moving, sampleIdx, sampleT, startOffset, n);
        out.moving = values;
        out.meta.signals["moving"] = meta;
    } else {
        out.meta.signals["moving"] = { present: false, missing_samples: 0, filled_seconds: 0 };
    }

    return out;
}

/** Proyecta una señal numérica sobre la rejilla, interpolando los huecos cortos. */
function projectNumeric(
    raw: ReadonlyArray<number | null | undefined>,
    sampleIdx: number[],
    sampleT: number[],
    startOffset: number,
    n: number,
    gapFillS: number,
): { values: number[]; meta: SignalMeta } {
    // Anclas: posición en la rejilla -> valor real conocido.
    const anchorPos: number[] = [];
    const anchorVal: number[] = [];
    let missing = 0;

    for (let k = 0; k < sampleIdx.length; k++) {
        const v = raw[sampleIdx[k]!];
        if (!isNum(v)) {
            missing++;
            continue;
        }
        anchorPos.push(sampleT[k]! - startOffset);
        anchorVal.push(v);
    }

    const values: number[] = new Array(n).fill(0);
    if (anchorPos.length === 0) {
        // La señal venía pero sin un solo valor numérico: se considera ausente.
        return {
            values,
            meta: { present: false, missing_samples: missing, filled_seconds: 0 },
        };
    }

    let filled = 0;

    // Antes de la primera ancla y después de la última: se arrastra el extremo.
    for (let i = 0; i < anchorPos[0]!; i++) {
        values[i] = anchorVal[0]!;
        filled++;
    }
    const lastPos = anchorPos[anchorPos.length - 1]!;
    for (let i = lastPos + 1; i < n; i++) {
        values[i] = anchorVal[anchorVal.length - 1]!;
        filled++;
    }

    for (let k = 0; k < anchorPos.length; k++) {
        const p = anchorPos[k]!;
        values[p] = anchorVal[k]!;

        if (k === anchorPos.length - 1) break;
        const q = anchorPos[k + 1]!;
        const span = q - p;
        if (span <= 1) continue;

        const v0 = anchorVal[k]!;
        const v1 = anchorVal[k + 1]!;
        const interpolate = span - 1 <= gapFillS;
        for (let i = p + 1; i < q; i++) {
            // Hueco corto: interpolación lineal. Hueco largo: se arrastra el
            // último valor solo para conservar longitud (valid[] ya lo excluye).
            values[i] = interpolate ? v0 + ((v1 - v0) * (i - p)) / span : v0;
            filled++;
        }
    }

    return {
        values,
        meta: { present: true, missing_samples: missing, filled_seconds: filled },
    };
}

/** Proyecta `moving` arrastrando el último valor conocido (no se interpola un booleano). */
function projectBoolean(
    raw: ReadonlyArray<boolean | null | undefined>,
    sampleIdx: number[],
    sampleT: number[],
    startOffset: number,
    n: number,
): { values: boolean[]; meta: SignalMeta } {
    const anchorPos: number[] = [];
    const anchorVal: boolean[] = [];
    let missing = 0;

    for (let k = 0; k < sampleIdx.length; k++) {
        const v = raw[sampleIdx[k]!];
        if (typeof v !== "boolean") {
            missing++;
            continue;
        }
        anchorPos.push(sampleT[k]! - startOffset);
        anchorVal.push(v);
    }

    const values: boolean[] = new Array(n).fill(false);
    if (anchorPos.length === 0) {
        return { values, meta: { present: false, missing_samples: missing, filled_seconds: 0 } };
    }

    let filled = 0;
    let cursor = anchorVal[0]!;
    let k = 0;
    for (let i = 0; i < n; i++) {
        if (k < anchorPos.length && anchorPos[k] === i) {
            cursor = anchorVal[k]!;
            values[i] = cursor;
            k++;
        } else {
            values[i] = cursor;
            filled++;
        }
    }

    return { values, meta: { present: true, missing_samples: missing, filled_seconds: filled } };
}

/**
 * Recorta `AlignedStreams` al intervalo [from, to] (índices de rejilla, ambos
 * incluidos), conservando la correspondencia entre señales.
 *
 * Permite reutilizar las funciones de `analytics/` sobre un tramo concreto
 * —una subida, un intervalo— sin reimplementar sus fórmulas.
 */
export function sliceAlignedStreams(
    aligned: AlignedStreams,
    from: number,
    to: number,
): AlignedStreams {
    const n = aligned.time.length;
    const a = Math.max(0, Math.min(from, n - 1));
    const b = Math.max(a, Math.min(to, n - 1));
    const len = b - a + 1;

    const valid = aligned.valid.slice(a, b + 1);
    const out: AlignedStreams = {
        // El tramo recortado vuelve a empezar en 0; el desplazamiento se guarda
        // en meta.start_offset_s para poder volver al tiempo original.
        time: Array.from({ length: len }, (_, i) => i),
        valid,
        meta: {
            ...aligned.meta,
            start_offset_s: aligned.meta.start_offset_s + a,
            grid_seconds: len,
            valid_seconds: valid.reduce((s, v) => s + (v ? 1 : 0), 0),
            gaps: aligned.meta.gaps
                .filter((g) => g.to_s >= a && g.from_s <= b)
                .map((g) => ({
                    ...g,
                    from_s: Math.max(g.from_s - a, 0),
                    to_s: Math.min(g.to_s - a, len - 1),
                    duration_s: Math.min(g.to_s, b) - Math.max(g.from_s, a) + 1,
                })),
        },
    };

    for (const name of NUMERIC_SIGNALS) {
        const src = aligned[name];
        if (src) out[name] = src.slice(a, b + 1);
    }
    if (aligned.moving) out.moving = aligned.moving.slice(a, b + 1);

    return out;
}
