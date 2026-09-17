/**
 * Helpers Zod reutilizables por las herramientas CRC.
 *
 * `stravaId` y `flexibleBoolean` viven en `src/schemas/stravaId.ts` porque las
 * herramientas originales también los necesitan y no pueden importar de
 * `src/crc/` (regla de dependencia unidireccional). Aquí se reexportan para que
 * la capa CRC los consuma desde su propio módulo de schemas.
 */
export { flexibleBoolean, stravaId } from "../../schemas/stravaId.js";
export type { FlexibleBoolean, StravaId } from "../../schemas/stravaId.js";
