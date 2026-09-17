/**
 * Golden tests del desacople contra las fixtures 06-08, cuya deriva cardíaca
 * está construida a propósito y cuyos valores se derivaron analíticamente.
 *
 * Las fixtures 01-05 llevan FC generada por fórmula a partir de la potencia,
 * así que sirven para comprobar que el código corre, no para validar esto.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { computeDecoupling } from "../../src/crc/analytics/decoupling.ts";
import { buildAlignedStreams } from "../../src/crc/streams/alignedStreams.ts";

const FIXTURES = path.join(__dirname, "fixtures");

/** Tolerancias: el desacople es un cociente de medias, debe salir casi exacto. */
const TOL = { ef: 0.0001, pct: 0.01 };

function load(name: string) {
    const s = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.streams.json`), "utf8"));
    const e = JSON.parse(readFileSync(path.join(FIXTURES, `${name}.expected.json`), "utf8"));
    const st = s.streams;
    const aligned = buildAlignedStreams(st.time.data, {
        watts: st.watts?.data,
        heartrate: st.heartrate?.data,
        moving: st.moving?.data,
    });
    return { expected: e, aligned };
}

/** Traduce los filtros declarados en la fixture a opciones del módulo. */
function optionsFrom(expected: {
    inputs: { ftp_w: number; filters: Record<string, unknown> };
}) {
    const f = expected.inputs.filters;
    return {
        ftpW: expected.inputs.ftp_w,
        warmupExclusionMin: (f["warmup_exclusion_min"] as number) ?? 0,
        movingOnly: (f["moving_only"] as boolean) ?? false,
        powerMinPctFtp: f["power_min_pct_ftp"] as number | undefined,
        powerMaxPctFtp: f["power_max_pct_ftp"] as number | undefined,
    };
}

describe.each(["06-desacople-deriva", "07-desacople-hueco", "08-desacople-filtros"])(
    "golden desacople · %s",
    (name) => {
        const { expected, aligned } = load(name);
        const exp = expected.expected;
        const r = computeDecoupling(aligned, optionsFrom(expected));

        it("está disponible", () => {
            expect(r.available, r.reason ?? "").toBe(true);
        });

        it("segundos válidos tras filtrar", () => {
            expect(r.valid_seconds).toBe(exp.valid_seconds);
        });

        it("mitades por tiempo válido", () => {
            expect(r.first_half_seconds).toBe(exp.first_half_seconds);
            expect(r.second_half_seconds).toBe(exp.second_half_seconds);
        });

        it("EF de la primera mitad", () => {
            expect(Math.abs(r.first_half_ef! - exp.first_half_ef)).toBeLessThanOrEqual(TOL.ef);
        });

        it("EF de la segunda mitad", () => {
            expect(Math.abs(r.second_half_ef! - exp.second_half_ef)).toBeLessThanOrEqual(TOL.ef);
        });

        it("desacople", () => {
            expect(Math.abs(r.decoupling_pct! - exp.decoupling_pct)).toBeLessThanOrEqual(TOL.pct);
        });

        it("medias de potencia y FC por mitad", () => {
            expect(Math.abs(r.first_half_mean_hr_bpm! - exp.first_half_mean_hr_bpm)).toBeLessThanOrEqual(0.01);
            expect(Math.abs(r.second_half_mean_hr_bpm! - exp.second_half_mean_hr_bpm)).toBeLessThanOrEqual(0.01);
        });
    },
);

describe("golden desacople · invariantes", () => {
    it("07: las mitades se parten por tiempo válido, NO por índice de rejilla", () => {
        const { expected, aligned } = load("07-desacople-hueco");
        const r = computeDecoupling(aligned, optionsFrom(expected));

        const correcto = expected.expected.decoupling_pct; // 6.6667
        const incorrecto = expected.expected.wrong_if_split_by_grid_index; // 5.7692

        expect(Math.abs(r.decoupling_pct! - correcto)).toBeLessThanOrEqual(TOL.pct);
        // Si alguien "simplifica" partiendo por el índice medio de la rejilla,
        // saldría este otro número: el test lo caza.
        expect(Math.abs(r.decoupling_pct! - incorrecto)).toBeGreaterThan(0.5);
    });

    it("08: los filtros se aplican antes de partir en mitades", () => {
        const { expected, aligned } = load("08-desacople-filtros");
        const r = computeDecoupling(aligned, optionsFrom(expected));

        expect(r.valid_seconds).toBe(3600);
        expect(r.excluded_seconds).toBe(expected.expected.excluded_seconds);
        // Sin filtrar, la FC media de la primera mitad no sería 140 exactos.
        expect(r.first_half_mean_hr_bpm).toBeCloseTo(140, 4);
        expect(r.second_half_mean_hr_bpm).toBeCloseTo(150, 4);
    });

    it("no interpreta el resultado: nada de fatiga ni adaptación", () => {
        const { expected, aligned } = load("06-desacople-deriva");
        const r = computeDecoupling(aligned, optionsFrom(expected));

        // Se inspeccionan los DATOS, no el bloque `method`: ahí la palabra
        // aparece a propósito, en la frase que declara que no se interpreta.
        const { method, ...datos } = r;
        const texto = JSON.stringify(datos).toLowerCase();

        for (const palabra of ["fatiga", "adaptaci", "fatigue", "bueno", "malo", "deficiente"]) {
            expect(texto, `la salida no debe interpretar (${palabra})`).not.toContain(palabra);
        }
        // Tampoco debe haber ningún campo de veredicto.
        for (const campo of ["interpretation", "verdict", "rating", "status", "assessment"]) {
            expect(Object.keys(datos)).not.toContain(campo);
        }
    });

    it("hr_lag_s viaja en el contrato pero no se aplica en v0.1", () => {
        const { expected, aligned } = load("06-desacople-deriva");
        const sin = computeDecoupling(aligned, optionsFrom(expected));
        const con = computeDecoupling(aligned, { ...optionsFrom(expected), hrLagS: 20 });

        expect(con.filters_applied["hr_lag_s"]).toBe(20);
        expect(con.filters_applied["hr_lag_applied"]).toBe(false);
        // Al no aplicarse, el resultado es idéntico.
        expect(con.decoupling_pct).toBe(sin.decoupling_pct);
    });
});
