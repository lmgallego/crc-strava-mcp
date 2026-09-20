/**
 * Detección de subidas contra las fixtures 10-13, cuyos perfiles de altitud
 * están construidos a propósito y cuyos valores salen de esa construcción.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
    classify,
    detectClimbs,
    elevationGainWithDeadband,
    smoothAltitude,
    DEFAULT_MAX_FLAT_RUN_M,
    DEFAULT_MIN_AVG_GRADE_PCT,
    DEFAULT_MIN_ELEVATION_GAIN_M,
    DEFAULT_MIN_LENGTH_M,
} from "../../src/crc/analytics/climbDetection.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";

const FIXTURES = path.join(__dirname, "fixtures");

/** Tolerancias: el suavizado desplaza ligeramente los bordes del tramo. */
const TOL = { dist_m: 60, gain_m: 5, grade_pct: 0.3, vam: 40, time_s: 15 };

function load(name: string) {
    const s = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.streams.json`), "utf8"));
    const e = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.expected.json`), "utf8"));
    const st = s.streams;
    return {
        expected: e,
        aligned: buildAlignedStreams(st.time.data, {
            altitude: st.altitude.data,
            distance: st.distance.data,
            watts: st.watts?.data,
        }),
    };
}

describe("detectClimbs · 10-subida-limpia", () => {
    const { expected, aligned } = load("10-subida-limpia");
    const r = detectClimbs(aligned, { weightKg: expected.inputs.weight_kg });
    const want = expected.expected.climbs[0];

    it("detecta exactamente una subida", () => {
        expect(r.available).toBe(true);
        expect(r.climb_count).toBe(1);
    });

    it("mide la distancia y el desnivel construidos", () => {
        expect(Math.abs(r.climbs[0]!.distance_m - want.distance_m)).toBeLessThanOrEqual(TOL.dist_m);
        expect(
            Math.abs(r.climbs[0]!.elevation_gain_m - want.elevation_gain_m),
        ).toBeLessThanOrEqual(TOL.gain_m);
    });

    it("la pendiente media es del 6 %", () => {
        expect(Math.abs(r.climbs[0]!.avg_grade_pct - 6)).toBeLessThanOrEqual(TOL.grade_pct);
    });

    it("la VAM es 1080 m/h", () => {
        expect(Math.abs(r.climbs[0]!.vam_m_per_h - want.vam_m_per_h)).toBeLessThanOrEqual(TOL.vam);
    });

    it("sitúa la subida donde se construyó", () => {
        expect(Math.abs(r.climbs[0]!.start_time_s - want.start_time_s)).toBeLessThanOrEqual(
            TOL.time_s,
        );
        expect(Math.abs(r.climbs[0]!.end_time_s - want.end_time_s)).toBeLessThanOrEqual(TOL.time_s);
    });

    it("la pendiente máxima sostenida es coherente, no un pico de ruido", () => {
        const g = r.climbs[0]!.max_sustained_grade_pct!;
        expect(g).toBeGreaterThan(5.5);
        // En una rampa constante al 6 %, ningún tramo sostenido puede dar mucho más.
        expect(g).toBeLessThan(7);
    });

    it("incluye las métricas de potencia de la subida", () => {
        const c = r.climbs[0]!;
        // En la rampa se pedalea a 150 + 2500 × 0.06 = 300 W exactos.
        // La media sale ~299,1 y no 300 porque el suavizado de 15 s difumina el
        // codo del perfil: el tramo detectado arrastra unos 5 s del llano
        // posterior, a 150 W. Es el coste declarado del suavizado (D40), no un
        // error de cálculo, y equivale a un 0,3 % sobre la media.
        expect(Math.abs(c.average_power_w! - 300)).toBeLessThanOrEqual(2);
        expect(Math.abs(c.normalized_power_w! - 300)).toBeLessThanOrEqual(2);
        expect(c.average_wkg).toBeCloseTo(300 / 72, 1);
    });

    it("el error de borde del suavizado se mantiene por debajo del 1 %", () => {
        const c = r.climbs[0]!;
        // Cuantifica el sesgo en vez de ignorarlo: si un cambio futuro lo
        // empeora, este test lo caza.
        expect(Math.abs(c.distance_m - 5000) / 5000).toBeLessThan(0.01);
        expect(Math.abs(c.duration_s - 1000)).toBeLessThanOrEqual(10);
    });
});

describe("detectClimbs · 11-falso-llano", () => {
    const { expected, aligned } = load("11-falso-llano");
    const r = detectClimbs(aligned, { weightKg: 72 });
    const want = expected.expected.climbs[0];

    it("NO parte la subida: el llano de 150 m está por debajo de la tolerancia", () => {
        expect(r.climb_count).toBe(1);
    });

    it("la subida abarca los dos tramos y el llano intermedio", () => {
        expect(Math.abs(r.climbs[0]!.distance_m - want.distance_m)).toBeLessThanOrEqual(TOL.dist_m);
        expect(
            Math.abs(r.climbs[0]!.elevation_gain_m - want.elevation_gain_m),
        ).toBeLessThanOrEqual(TOL.gain_m);
    });

    it("la pendiente media baja por el llano pero sigue sobre el mínimo", () => {
        expect(Math.abs(r.climbs[0]!.avg_grade_pct - want.avg_grade_pct)).toBeLessThanOrEqual(
            TOL.grade_pct,
        );
        expect(r.climbs[0]!.avg_grade_pct).toBeGreaterThan(DEFAULT_MIN_AVG_GRADE_PCT);
        expect(r.climbs[0]!.avg_grade_pct).toBeLessThan(6);
    });

    it("con una tolerancia menor que el llano, sí se parte en dos", () => {
        const estricto = detectClimbs(aligned, { maxFlatRunM: 50 });
        expect(estricto.climb_count).toBe(2);
    });
});

describe("detectClimbs · 12-dos-subidas", () => {
    const { expected, aligned } = load("12-dos-subidas");
    const r = detectClimbs(aligned, { weightKg: 72 });

    it("detecta DOS subidas separadas por el descenso", () => {
        expect(r.climb_count).toBe(2);
    });

    it("cada una tiene el desnivel construido", () => {
        for (const c of r.climbs) {
            expect(Math.abs(c.elevation_gain_m - 120)).toBeLessThanOrEqual(TOL.gain_m);
            expect(Math.abs(c.avg_grade_pct - 6)).toBeLessThanOrEqual(TOL.grade_pct);
        }
    });

    it("la segunda empieza después de que acabe la primera", () => {
        expect(r.climbs[1]!.start_time_s).toBeGreaterThan(r.climbs[0]!.end_time_s);
    });

    it("el desnivel total suma el de las dos", () => {
        expect(
            Math.abs(r.total_elevation_gain_m - expected.expected.total_elevation_gain_m),
        ).toBeLessThanOrEqual(2 * TOL.gain_m);
    });

    it("el descenso no cuenta como subida", () => {
        for (const c of r.climbs) expect(c.avg_grade_pct).toBeGreaterThan(0);
    });
});

describe("detectClimbs · 13-llano-ruido", () => {
    const { aligned } = load("13-llano-ruido");

    it("no inventa ninguna subida sobre un perfil plano con ruido", () => {
        const r = detectClimbs(aligned);

        expect(r.available).toBe(true);
        expect(r.climb_count).toBe(0);
        expect(r.total_elevation_gain_m).toBe(0);
    });

    it("sin banda muerta ni suavizado, el ruido sí produciría desnivel falso", () => {
        // Demuestra que el filtrado es lo que evita el falso positivo, no la suerte.
        const alt = aligned.altitude!;
        const crudo = elevationGainWithDeadband(alt, 0, alt.length - 1, 0);
        const filtrado = elevationGainWithDeadband(
            smoothAltitude(alt, aligned.valid, 15),
            0,
            alt.length - 1,
            1,
        );

        expect(crudo).toBeGreaterThan(100);
        expect(filtrado).toBeLessThan(crudo / 10);
    });
});

describe("detectClimbs · señales ausentes", () => {
    it("sin altitud devuelve MISSING_ELEVATION", () => {
        const a = buildAlignedStreams([0, 1, 2], { distance: [0, 5, 10] });
        const r = detectClimbs(a);

        expect(r.available).toBe(false);
        expect(r.code).toBe("MISSING_ELEVATION");
        expect(r.reason).toContain("altitud");
    });

    it("sin distancia también devuelve MISSING_ELEVATION", () => {
        const a = buildAlignedStreams([0, 1, 2], { altitude: [100, 101, 102] });
        const r = detectClimbs(a);

        expect(r.available).toBe(false);
        expect(r.code).toBe("MISSING_ELEVATION");
        expect(r.reason).toContain("distancia");
    });

    it("sin potencia, la subida se detecta igual y las métricas quedan a null", () => {
        const { aligned } = load("10-subida-limpia");
        const sinWatts = buildAlignedStreams(
            aligned.time.map((t) => t + aligned.meta.start_offset_s),
            { altitude: aligned.altitude, distance: aligned.distance },
        );
        const r = detectClimbs(sinWatts);

        expect(r.climb_count).toBe(1);
        expect(r.climbs[0]!.average_power_w).toBeNull();
        expect(r.climbs[0]!.normalized_power_w).toBeNull();
    });
});

describe("detectClimbs · umbrales y escala", () => {
    it("los umbrales por defecto son los acordados", () => {
        expect(DEFAULT_MIN_ELEVATION_GAIN_M).toBe(30);
        expect(DEFAULT_MIN_AVG_GRADE_PCT).toBe(3);
        expect(DEFAULT_MIN_LENGTH_M).toBe(500);
        expect(DEFAULT_MAX_FLAT_RUN_M).toBe(200);
    });

    it("los umbrales viajan en la respuesta", () => {
        const { aligned } = load("10-subida-limpia");
        const r = detectClimbs(aligned);

        expect(r.thresholds["min_avg_grade_pct"]).toBe(3);
        expect(r.thresholds["max_flat_run_m"]).toBe(200);
    });

    it("subir el mínimo de desnivel descarta subidas pequeñas", () => {
        const { aligned } = load("12-dos-subidas");
        expect(detectClimbs(aligned, { minElevationGainM: 200 }).climb_count).toBe(0);
    });

    it("la escala de dificultad se declara como propia y no oficial", () => {
        const { aligned } = load("10-subida-limpia");
        const r = detectClimbs(aligned);
        const nota = r.climbs[0]!.difficulty_scale;

        expect(nota).toContain("propia");
        expect(nota).toContain("NO es la categorización oficial");
        expect(nota).toContain("UCI");
        // Y la etiqueta no imita una categoría oficial.
        expect(r.climbs[0]!.difficulty_tier).not.toMatch(/HC|cat|categor[íi]a \d/i);
    });

    it("la escala ordena por pendiente² × distancia (D63)", () => {
        // Cortes recalibrados al pasar de producto lineal a cuadrático.
        expect(classify(5)).toBe("corta");
        expect(classify(50)).toBe("suave");
        expect(classify(180)).toBe("media");
        expect(classify(400)).toBe("dura");
        expect(classify(900)).toBe("muy dura");
    });

    it("no interpreta el resultado", () => {
        const { aligned } = load("10-subida-limpia");
        const r = detectClimbs(aligned);
        const texto = JSON.stringify(r.climbs).toLowerCase();

        for (const palabra of ["fatiga", "deber", "recomend", "deberías", "mejora"]) {
            expect(texto).not.toContain(palabra);
        }
    });
});

describe("smoothAltitude", () => {
    it("no deforma una rampa constante", () => {
        const alt = Array.from({ length: 100 }, (_, i) => 100 + i * 0.3);
        const valid = new Array(100).fill(true);
        const s = smoothAltitude(alt, valid, 15);

        // La ventana simétrica preserva exactamente una recta, bordes incluidos.
        for (let i = 0; i < 100; i++) expect(s[i]!).toBeCloseTo(alt[i]!, 6);
    });

    it("reduce el ruido de un perfil plano", () => {
        const alt = Array.from({ length: 600 }, (_, i) => 100 + Math.sin(i * 3.7) * 1.5);
        const valid = new Array(600).fill(true);
        const s = smoothAltitude(alt, valid, 15);

        const rango = (a: number[]) => Math.max(...a) - Math.min(...a);
        expect(rango(s)).toBeLessThan(rango(alt));
    });
});
