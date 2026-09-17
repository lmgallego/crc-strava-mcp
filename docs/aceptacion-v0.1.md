# Criterios de aceptación v0.1 — verificación

Revisión de los diez criterios de la **sección 14** de la especificación contra
el estado real del repositorio al cierre del Sprint 7.

| Fecha | Rama | Build | Tests |
|---|---|---|---|
| 18/09/2026 | `sprint-7/qa` | `npm run build` OK | 459/459 |

**Resumen: 8 criterios cumplidos, 2 cumplidos con matices.** Los matices están en
los criterios 1 y 9, y se detallan abajo. Ninguno bloquea la v0.1, pero conviene
conocerlos antes de dar el trabajo por cerrado.

---

## 1. Las herramientas originales continúan funcionando ⚠️ *cumple con matices*

**Cómo se verifica**

```bash
npm run build
node scripts/snapshot-tools.mjs > antes.json   # antes de cualquier cambio
node scripts/snapshot-tools.mjs --diff antes.json despues.json
npx vitest run tests/            # los 69 tests originales siguen en la suite
```

**Estado.** Las 26 herramientas originales se registran y responden igual. Ningún
test original se ha eliminado ni relajado.

**Matiz 1 — serialización del `inputSchema` en 8 tools sin parámetros.** Al
actualizar el SDK de 1.8.0 a 1.30.0, éste dejó de emitir
`"additionalProperties": false` en las tools sin parámetros
(`get-athlete-profile`, `get-server-version`, etc.). Es un cambio del SDK, no del
código, y es más permisivo, no más restrictivo. Detalle en
[D2](decisiones.md#d2-cambio-de-serialización-en-las-tools-sin-parámetros).

**Matiz 2 — tres cambios deliberados en código original.** Todos
retrocompatibles, ninguno altera nombres ni rompe llamadas existentes:

- 7 tools pasan el ID de `z.number().int().positive()` a `stravaId`
  (`number | string`). Amplía el tipo aceptado; pierde las facetas `integer` y
  `exclusiveMinimum` del JSON Schema, aunque el runtime sigue exigiendo dígitos
  ([D5](decisiones.md#d5-d3-aplicado-como-ampliación-de-tipo-no-como-sustitución)).
- `getActivityPhotos` ya no hace `parseInt` sobre el ID: corrompía IDs largos que
  su propio esquema aceptaba.
- 8 firmas de `src/stravaClient.ts` pasan de `number` a `number | string`.

**Lo que NO se ha verificado.** No hay pruebas de integración contra la API real
de Strava en CI: la suite usa mocks. Un cambio de comportamiento de la API no lo
detectaría esta batería.

---

## 2. Las 11 herramientas CRC aparecen correctamente en `tools/list` ✅

**Cómo se verifica**

```bash
npm run build && node scripts/snapshot-tools.mjs | \
  node -e "const j=JSON.parse(require('fs').readFileSync(0));
    console.log(j.tools.filter(t=>t.name.startsWith('crc-')).map(t=>t.name).join('\n'))"
```

**Estado.** Las 11 de la especificación están presentes y registradas contra
`dist/server.js` en runtime, no solo en el código fuente. Recuento completo en
[§ Recuento de herramientas](#recuento-de-herramientas).

---

## 3. Los cálculos no dependen del razonamiento del LLM ✅

**Cómo se verifica**

```bash
npx vitest run tests/crc          # 390 tests de la capa CRC
grep -rn "sources/\|modelcontextprotocol" src/crc/analytics/   # sin resultados
```

**Estado.** Todas las fórmulas viven en `src/crc/analytics/` como funciones puras
de TypeScript, sin dependencias de Strava ni de MCP, y cada una tiene tests. Al
modelo solo se le devuelven métricas agregadas en JSON; las tools CRC nunca
devuelven streams crudos.

Los golden tests contra fixtures derivadas analíticamente
(`tests/crc/fixtures/`) comprueban NP, TSS, kJ, power curve y desacople con
**coincidencia exacta**, no dentro de tolerancia
([D13](decisiones.md#d13-golden-tests-coincidencia-exacta-no-dentro-de-tolerancia)).

**Lo que NO se ha verificado.** El estudio de viabilidad recomendaba *golden
tests cruzados* contra Intervals.icu o WKO5 con actividades reales exportadas en
FIT (±1 W en NP, ±1 % en TSS). **No se han hecho.** Las fixtures son sintéticas y
sus valores están derivados a mano: eso demuestra que el código implementa el
método declarado, pero no que el método coincida con el de otras plataformas.
Es la validación externa que falta para la v0.2.

---

## 4. No se atribuye a Strava ningún dato que Strava no proporcione ✅

**Cómo se verifica**

```bash
npx vitest run tests/crc/bestEffort.test.ts    # etiquetado de VO2max
npx vitest run tests/crc/streamQuality.test.ts # power_source
```

**Estado.** Todo lo calculado o estimado se declara como tal:

- El VO2max sale siempre con `label: "estimated_vo2max"` y su `model_reference`.
- El FTP estimado se guarda con `source: "estimated_20min"`, nunca `"manual"`, y
  toda métrica derivada lo marca en `quality.ftp_estimated`
  ([D29](decisiones.md#d29-la-procedencia-estimada-viaja-en-quality)).
- `quality.power_source` distingue `measured` de `estimated`; sin conocer
  `device_watts` se asume `estimated` por prudencia
  ([D8](decisiones.md#d8-power_source-desconocido--estimated)).
- Cada respuesta lleva su bloque `method` con el procedimiento declarado.

---

## 5. AeT y MAP solo existen si han sido configurados por una fuente explícita ✅

**Cómo se verifica**

```bash
grep -rn "aet_power_w\|aet_hr_bpm\|map_w" src/crc/sources/ src/crc/analytics/
# sin resultados: no se infieren en ninguna parte
npx vitest run tests/crc/profile.test.ts
```

**Estado.** `aet_power_w`, `aet_hr_bpm` y `map_w` solo aparecen en
`profileStore.ts` como métricas del perfil, cada una con `source` obligatorio.
Ningún módulo de fuente ni de analítica las calcula ni las deduce.

---

## 6. FTP y peso históricos se resuelven por fecha ✅

**Cómo se verifica**

```bash
npx vitest run tests/crc/profile.test.ts            # resolver y ventanas
npx vitest run tests/crc/orchestrationTools.test.ts # comparación por fechas
```

**Estado.** `profileResolver` devuelve el valor cuya ventana incluye la fecha, o
`missing_parameter`. Hay un test que fija la regla: con FTP 320 vigente hoy, una
actividad de 2025 devuelve `missing_parameter` y el 320 no aparece en la
respuesta.

`crc-compare-activities` lo verifica de punta a punta: dos actividades con la
misma potencia (200 W) y FTP distinto en su fecha (200 y 250) dan IF 1.0 y 0.8.
El test comprueba además que el primero **no** es 0.8, que es lo que saldría si se
recalculara con el FTP actual.

El VO2max usa el peso vigente **en la fecha del esfuerzo**, con un test que lo
distingue del peso de hoy.

---

## 7. VO2max se etiqueta siempre como estimado y registra el modelo ✅

**Cómo se verifica**

```bash
npx vitest run tests/crc/bestEffort.test.ts tests/crc/estimateTools.test.ts
```

**Estado.** `label: "estimated_vo2max"` siempre; hay un test que falla si aparece
`lab_vo2max` en los datos. `model_reference` lleva la cita verificada
(Sitko et al., 2022, PMID 34225254), con `doi` y `pmid` en campos propios y
`reference_verified: true`.

`quality.model_limitations` añade los dos límites de validez del estudio (muestra
de 46 varones; R² 0,61-0,77 con datos del propio 5MT), y `quality` advierte de
que un mejor 5 min observado no equivale a un test máximo.

---

## 8. Todas las métricas multistream usan muestras temporalmente alineadas ✅

**Cómo se verifica**

```bash
npx vitest run tests/crc/alignedStreams.test.ts
grep -rn "downsampleStream" src/crc/    # solo en un comentario que explica por qué NO se usa
```

**Estado.** `buildAlignedStreams` construye un índice único de 1 s y proyecta
todas las señales sobre él, de modo que `time[i]`, `watts[i]` y `heartrate[i]`
son siempre el mismo instante. La capa CRC **no** usa `downsampleStream` del
código original, que desalinea las señales al insertar picos de forma
independiente en cada una.

Ocho de los nueve módulos de `analytics/` reciben `AlignedStreams`; el noveno
(`vo2maxEstimate.ts`) recibe números ya calculados, así que no aplica.

Las ventanas móviles (NP, power curve, esfuerzos) no cruzan tramos no válidos: lo
demuestra la fixture `04-paradas`, donde NP se mantiene en 190 W con huecos de
45 s y 10 min.

---

## 9. La respuesta pública es JSON estable y versionado ⚠️ *cumple con matices*

**Cómo se verifica**

```bash
npx vitest run tests/crc/crcToolResponse.test.ts
npx vitest run tests/crc/noNaN.test.ts   # 62 comprobaciones de NaN/Infinity
```

**Estado.** Todas las tools CRC devuelven el envoltorio común
`{ tool, version, activity_id, available, inputs, method, metrics, quality, errors }`
con `version: "0.1.0"`, y `sanitize` convierte `NaN`/`Infinity` en `null`
añadiendo un warning. El test `noNaN.test.ts` recorre las 12 tools CRC con cinco
escenarios adversos (actividad entera a 0 W, actividad de 1 segundo, FC a 0,
perfil vacío, sin más stream que el tiempo) y comprueba que ningún texto contiene
`NaN` ni `Infinity`, ni siquiera interpolado dentro de una cadena.

**Matiz 1 — no se usa `structuredContent`.** La decisión 5 del estudio de
viabilidad proponía devolver `structuredContent` con `outputSchema` y el texto
JSON como respaldo. **No está implementado**: las tools devuelven el JSON como
texto en `content[0].text`. El contenido es JSON estructurado y estable, pero el
cliente MCP no recibe un esquema de salida declarado y tiene que parsear el texto.
Candidato claro para la v0.2.

**Matiz 2 — no hay test de regresión del esquema de salida.**
`scripts/snapshot-tools.mjs` protege el contrato de ENTRADA (`inputSchema`), pero
nada impide que un cambio futuro renombre un campo de `metrics` sin que ningún
test lo note. La estabilidad hoy se apoya en los tests por tool, no en un
snapshot del contrato de salida.

---

## 10. `npm run build` y `npm test` finalizan sin errores ✅

**Cómo se verifica**

```bash
npm run build && npm test
```

**Estado.** Build limpio con `tsc` en modo estricto
(`noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`) y **459/459
tests** en 22 archivos. CI en `.github/workflows/ci.yml` ejecuta `npm ci`,
`npm run build` y `npm test` con Node 20.

**Nota.** `npm audit` reporta vulnerabilidades heredadas del repositorio base que
**no se han tocado** por indicación expresa durante todos los sprints. Queda
pendiente revisarlas.

---

## Recuento de herramientas

**38 tools = 26 originales + 12 CRC.**

Conviene fijarlo porque el documento original habla de "25 herramientas
originales" y de "11 herramientas CRC", y ninguno de los dos números coincide con
lo que devuelve `tools/list`:

### Las originales son 26, no 25

Verificado en runtime contra `dist/server.js`, no contando archivos. El documento
y el README del repositorio base decían 25; el recuento real incluye
`connect-strava`, `disconnect-strava`, `check-strava-connection` y
`get-server-version`. CLAUDE.md se corrigió en el Sprint 1.

### Las CRC son 12: las 11 de la especificación más una

| # | Tool | Origen |
|---|---|---|
| 1 | `crc-get-performance-profile` | Especificación § 7.1 |
| 2 | `crc-set-performance-profile` | Especificación § 7.2 |
| 3 | `crc-analyze-cycling-activity` | Especificación § 7.10 |
| 4 | `crc-calculate-power-metrics` | Especificación § 7.3 |
| 5 | `crc-power-curve` | Especificación § 7.4 |
| 6 | `crc-aerobic-decoupling` | Especificación § 7.5 |
| 7 | `crc-time-in-zones` | Especificación § 7.6 |
| 8 | `crc-torque-cadence` | Especificación § 7.7 |
| 9 | `crc-work-above-ftp` | Especificación § 7.8 |
| 10 | `crc-compare-activities` | Especificación § 7.9 |
| 11 | `crc-estimate-vo2max` | Especificación § 7.11 |
| 12 | **`crc-estimate-ftp`** | **Adicional — [D12](decisiones.md#d12--estimación-de-ftp-desde-el-historial--implementada-en-el-sprint-5)** |

`crc-estimate-ftp` **no figura en la especificación v0.1**. Surgió de D12, al
constatar que el producto va dirigido a cicloturistas que a menudo no conocen su
FTP, y que el perfil CRC no puede depender de ninguna plataforma externa. Propone
un FTP desde el mejor 20 min del historial (× 0,95) y **no persiste nada**:
guardarlo exige una llamada separada a `crc-set-performance-profile`.

Si dentro de un año alguien compara este repositorio con el documento original y
cuenta 12 donde esperaba 11, esta es la razón.

---

## Fuera de alcance de v0.1

Según la sección 15 de la especificación, y confirmado en el código: **no** hay
detección automática de intervalos, detección de subidas, durability, análisis
longitudinal, CTL/ATL/TSB, modelos CP/W′ ni generación de informes. Se añadirán
solo después de validar la exactitud de esta capa.

## Trabajo pendiente identificado

1. **Golden tests cruzados** contra Intervals.icu o WKO5 con actividades reales
   (criterio 3). Es la validación externa que hoy falta.
2. **`structuredContent` + `outputSchema`** en las tools CRC (criterio 9).
3. **Snapshot del contrato de salida**, equivalente al que ya existe para el de
   entrada (criterio 9).
4. **`npm audit`**: revisar las vulnerabilidades heredadas del repositorio base.
5. **Pruebas contra la API real** de Strava, hoy inexistentes (criterio 1).
