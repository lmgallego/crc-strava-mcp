# Decisiones de implementación

## Sprint 1 — Robustez MCP (17/09/2026)

### D1. Actualización del SDK: hubo que subir Zod y deduplicar

`@modelcontextprotocol/sdk` 1.8.0 → 1.30.0. El SDK declara `zod: "^3.25 || ^4.0"`
y el proyecto tenía `zod@3.24.2`, así que npm instaló **zod 4.6.5 anidado** dentro
del SDK. Con dos copias de Zod en el árbol, `tsc` agotaba la memoria del heap
(`FATAL ERROR: Ineffective mark-compacts near heap limit`) por instanciación de
tipos infinita (TS2589), porque los `ZodType` del SDK y los del proyecto eran
tipos distintos.

**Decisión:** subir el proyecto a `zod@^3.25` (3.25.76) y ejecutar `npm dedupe`
para dejar **una sola copia** de Zod. Se descartó migrar a Zod 4 porque obligaría
a revisar los esquemas de las 26 herramientas originales, que este sprint no
puede tocar.

`src/server.ts` no necesitó ninguna adaptación: la API `server.tool(...)` sigue
soportada en 1.30.0.

### D2. Cambio de serialización en las tools sin parámetros

Las 26 tools siguen registrándose con el mismo nombre, descripción y propiedades.
Única diferencia, introducida por el SDK y no por nuestro código: para las 8 tools
sin parámetros, el `inputSchema` publicado ya **no incluye
`"additionalProperties": false`**.

```
antes:   {"type":"object","properties":{},"additionalProperties":false,...}
después: {"type":"object","properties":{},...}
```

Afecta a: `check-strava-connection`, `disconnect-strava`, `get-athlete-profile`,
`get-athlete-shoes`, `get-athlete-zones`, `get-server-version`,
`list-athlete-clubs`, `list-starred-segments`.

**Decisión:** aceptarlo. Es estrictamente más permisivo (admite propiedades extra
que estas tools ignoran) y no cambia el contrato observable. Forzarlo de vuelta
exigiría añadir `.strict()` a las 8, es decir, tocar sus esquemas.

### D3. Techo de precisión en 7 tools originales ✅ *resuelto en [D5](#d5-d3-aplicado-como-ampliación-de-tipo-no-como-sustitución)*

La regla del proyecto exige IDs como `string`, pero **7 herramientas originales
declaran el ID como `z.number().int().positive()`** en su esquema MCP:

`get-activity-details`, `get-athlete-stats`, `get-segment`, `get-segment-effort`,
`get-segment-leaderboard`, `list-segment-efforts`, `star-segment`.

Con esos esquemas, un ID de más de 16 dígitos llega ya corrompido desde el
`JSON.parse` del transporte: **no es recuperable dentro de la herramienta**.
Arreglarlo exige cambiar sus esquemas a `z.union([z.string(), z.number()])`, lo
que este sprint prohíbe expresamente.

**Decisión (actualizada en el Sprint 2):** aprobado y aplicado. Las 7 tools usan
`stravaId` (`number | string` → siempre string); el detalle de la ampliación y su
efecto en el JSON Schema está en [D5](#d5-d3-aplicado-como-ampliación-de-tipo-no-como-sustitución).
La capa CRC no está
afectada: usa `stravaId` de `src/crc/schemas/mcpSchemas.ts`, que transporta el ID
como string y rechaza un `number` fuera del rango seguro en vez de devolverlo
corrupto en silencio.

Sí se corrigió lo que no requería tocar esquemas:

- `getActivityPhotos` hacía `parseInt(id, 10)` sobre un esquema que **ya aceptaba
  string**: corrompía IDs largos válidos. Ahora conserva el string y valida con
  `/^\d+$/`.
- Las 8 firmas de `src/stravaClient.ts` que tipaban el ID como `number` pasan a
  `number | string`, para que ningún llamador se vea forzado a convertir. La URL
  se construye por interpolación, así que el string llega intacto a Strava.

### D4. Módulo no disponible: `available: false`, nunca `isError`

Confirmada la decisión 6 del estudio e implementada en `crcUnavailable()`.
`isError` queda reservado a fallos de entrada o de red.

## Sprint 2 — Streams y perfil (17/09/2026)

### D5. D3 aplicado como ampliación de tipo, no como sustitución

Las 7 tools con `z.number().int().positive()` pasan a `stravaId`
(`number | string` → siempre string). Verificado con
`node scripts/snapshot-tools.mjs --diff`: cambian exactamente esos 7
`inputSchema` y solo en el campo del ID.

```
antes:   "activityId": {"type":"integer","exclusiveMinimum":0,...}
después: "activityId": {"type":["string","number"],...}
```

Matiz honesto: al ampliarse el tipo se pierden las facetas `integer` y
`exclusiveMinimum: 0` del JSON Schema. En runtime la validación **no** se
relaja (el helper exige `/^\d+$/`), salvo en un detalle: `"0"` supera el
esquema y antes lo rechazaba `exclusiveMinimum`. Llega a la API como 404. Se
acepta: ningún cliente que funcionara antes deja de funcionar.

### D6. `stravaId` movido a `src/schemas/stravaId.ts`

Usarlo en las tools originales habría violado la regla no negociable *"las
herramientas originales NUNCA importan nada de `src/crc/`"*. El helper es
neutral (no depende de la capa analítica), así que vive en `src/schemas/` y
`src/crc/schemas/mcpSchemas.ts` lo reexporta: una sola definición, regla intacta.

### D7. Relleno de huecos: interpolación lineal

La especificación exige rellenar huecos ≤ `gap_fill_s` pero no dice cómo. Se
elige **interpolación lineal**, correcta para señales acumulativas (distance,
altitude) y aceptable en tramos de ≤ 3 s para watts y FC. En los huecos largos
se arrastra el último valor únicamente para conservar la longitud del array;
`valid[i] === false` los excluye y las ventanas móviles no deben cruzarlos.
Queda declarado en `meta.method`.

Un `0` es siempre un dato legítimo (rueda libre, parado) y nunca cuenta como
ausencia: solo `null`, `undefined` y no finitos son "falta".

### D8. `power_source` desconocido = `estimated`

Si no se conoce `device_watts`, la potencia se marca `estimated` y se avisa.
Asumir `measured` sin evidencia inflaría la confianza en power curve y VO2max,
que son justo los cálculos que la especificación prohíbe con potencia estimada.

### D9. Caché de streams

`~/.config/strava-mcp/crc-cache/streams/<activityId>-<hash de tipos>.json`.
Se cachea la respuesta **cruda**, no la alineada, para poder realinear con otro
`gap_fill_s` sin volver a llamar a Strava. Topes: 200 entradas y 128 MB, podando
por fecha de modificación. Invalidación: `refresh: true` por llamada,
`clearStreamCache(activityId?)`, y `CACHE_VERSION` que invalida todo al cambiar
el formato. Un fallo de caché nunca tumba la petición.

### D10. `scripts/snapshot-tools.mjs`

La verificación de `tools/list` se repetía en cada sprint; queda como script
reutilizable con modo `--diff`.

### D11. `src/schemas/` es zona neutral

`src/schemas/` es una **zona neutral compartida por las dos capas**: el código
original y la capa CRC pueden importar de ahí. Existe porque la regla de
dependencia unidireccional (las tools originales nunca importan de `src/crc/`)
dejaba sin sitio a los helpers que ambas capas necesitan, y la alternativa era
duplicarlos.

Reglas de la zona neutral:

- **No depende de nada.** Nada en `src/schemas/` puede importar de `src/crc/`
  ni de `src/tools/`; solo librerías externas (Zod) y tipos propios. Si un
  helper necesita algo de la capa CRC, no es neutral y no va aquí.
- **Solo contratos genéricos**, no analítica: validación y normalización de
  datos que existen igual en ambos lados (identificadores, booleanos tolerantes
  y similares). Cualquier cosa que sepa de NP, TSS, streams o perfil pertenece a
  `src/crc/`.
- **La capa CRC la consume a través de sus propios módulos**, no directamente:
  `src/crc/schemas/mcpSchemas.ts` reexporta lo que necesita, de modo que las
  tools CRC siguen importando de `src/crc/schemas/` y la procedencia real puede
  cambiar sin tocarlas.
- **Añadir algo aquí es una decisión, no un atajo.** El criterio es que lo
  necesiten de verdad las dos capas. Si solo lo usa una, vive en esa capa.

Dirección de dependencias resultante:

```
src/tools/  (original) ─┐
                        ├─> src/schemas/  (neutral, no importa de nadie)
src/crc/    (CRC) ──────┘
                        └─> src/crc/  nunca es importado por el código original
```

Contenido actual: `stravaId.ts` (`stravaId`, `flexibleBoolean`), ver [D6](#d6-stravaid-movido-a-srcschemasstravaidts).

### D12 · Estimación de FTP desde el historial ✅ *implementada en el Sprint 5*

**Estado: IMPLEMENTADA en el Sprint 5** (`crc-estimate-ftp`, `analytics/bestEffort.ts`).
El texto que sigue es la decisión tal y como se acordó; lo que cambió al
implementarla está en D25-D29.

**Contexto.** El producto va dirigido a cicloturistas, que muchas veces no conocen
su FTP. El perfil CRC no puede depender de ninguna plataforma externa, así que el
valor tiene que salir del propio usuario o de sus datos de Strava.

**Flujo acordado:**

1. **Preguntar siempre primero al usuario.** Si lo declara, `source: "manual"`.
   *Orientación del orquestador, no invariante:* preguntar es comportamiento
   deseable pero no puede garantizarse por código. La invariante real es la de
   los puntos 3 y 4: se pregunte o no, nada se persiste sin una segunda llamada
   explícita.
2. Si no lo sabe, **estimar desde su historial**: mejor 20 min × 0,95.
3. **La estimación NO persiste.** `crc-estimate-ftp` devuelve la propuesta
   (`available: true`) con el valor, la actividad y la fecha de origen, pero no
   escribe en el perfil.
4. **Guardar exige una llamada explícita y separada** a
   `crc-set-performance-profile` con `source: "estimated_20min"`. La separación
   entre calcular y persistir es lo que garantiza que nada se guarde en silencio:
   es una propiedad del diseño, no una instrucción de comportamiento para el
   orquestador.

> **Por qué se separa en dos llamadas.** Las tools MCP son sin estado y no pueden
> bloquearse esperando una respuesta del usuario: no existe "pregunta y espera"
> dentro de una tool. Por eso cualquier regla del tipo *"pedir confirmación antes
> de X"* debe implementarse **separando la operación en dos llamadas** —una que
> calcula y propone, otra que persiste—, nunca confiando en que el modelo que
> orquesta se comporte como se le ha pedido. Una instrucción que el orquestador
> puede ignorar no es una garantía; una tool que no sabe escribir, sí.
>
> Esto vale como **principio general del proyecto**, no solo para el FTP:
> aplica a cualquier operación futura que deba confirmarse antes de tener efecto.

**Implicaciones que hay que respetar cuando se implemente:**

- Cualquier análisis que use un FTP estimado debe reflejarlo en su bloque
  `quality`: IF y TSS heredan esa incertidumbre.
- **El mejor 20 min observado NO es un test de 20 minutos.** Si no hay evidencia
  de esfuerzo máximo, `quality` debe advertirlo. Mismo tratamiento que la
  especificación ya da al mejor 5 min en VO2max (sección 7.11).
- Barrer el historial cuesta llamadas a la API: ventana acotada (90 días por
  defecto), tope de actividades configurable y uso obligatorio de la caché de
  streams del Sprint 2 (ver [D9](#d9-caché-de-streams)).
- **Solo cuenta potencia medida.** Con `device_watts=false` no se estima FTP,
  igual que con power curve y VO2max (ver [D8](#d8-power_source-desconocido--estimated)).

**Nota de implementación para el Sprint 5.** Esto comparte maquinaria con
`crc-estimate-vo2max`: mejor esfuerzo de una duración dada dentro de una ventana
temporal. Escribir **una sola** función reutilizable, del tipo
`bestEffortInPeriod(duration_s, days)`, y que ambas la consuman. No duplicar la
lógica de barrido.

**Pendientes de D12, ya resueltos en el Sprint 5:**

- ✅ Cierre automático de la vigencia anterior → **sí, pero solo con
  `close_previous: true`**. Ver [D26](#d26-el-cierre-de-la-vigencia-anterior-exige-confirmación-explícita-pendiente-de-d12-resuelto).
- ✅ FTP declarado sin fecha asume "desde hoy" → **sí**. Ver
  [D25](#d25-un-valor-sin-fecha-asume-desde-hoy-pendiente-de-d12-resuelto).

## Sprint 3 — Potencia (17/09/2026)

### D13. Golden tests: coincidencia exacta, no dentro de tolerancia

Las cinco fixtures de `tests/crc/fixtures/` pasaron a la primera con diferencia
**0.000 W / 0.0000 %** en todas las métricas (media, NP, VI, IF, TSS, kJ y los
tres puntos de la curva). Las tolerancias acordadas (NP ±1 W, TSS ±1 %, kJ ±0,5 %,
curva ±1 W) no llegaron a usarse: ningún valor depende del margen.

No se modificó ningún `.expected.json` ni ninguna tolerancia.

Las fixtures se movieron de `tests/fixtures/` a `tests/crc/fixtures/`, que es la
ruta que fija CLAUDE.md; `tests/fixtures/` conserva intactas las del repo original.

### D14. Equivalencia entre el método del generador y `AlignedStreams`

El generador de fixtures descarta las ventanas cuyo `time` no abarca exactamente
`N-1` segundos (es decir, las que cruzan un hueco de muestreo). La implementación
trabaja sobre la rejilla de 1 s y descarta las ventanas que contienen algún
segundo con `valid[i] === false`. Son equivalentes porque `buildAlignedStreams`
marca no válido todo hueco mayor que `gap_fill_s`.

La fixture `04-paradas` es la que lo demuestra: con huecos de 45 s y 10 min,
`valid_seconds` da 4755 y NP se mantiene en 190 W. Si el código cruzara los huecos
o los rellenara con ceros, NP bajaría y el test lo cazaría.

### D15. `start_date` en la fuente de streams

Resolver FTP y peso por la fecha de la actividad exige conocerla, así que
`fetchActivityStreams` devuelve ahora `start_date` junto a `device_watts` y
`athlete_id`. `CACHE_VERSION` sube a 2: las entradas cacheadas con el formato
anterior se invalidan solas.

### D16. Disponibilidad parcial por parámetro

- **Sin FTP** → `MISSING_FTP`, `intensity_factor` y `tss` a `null`, pero NP, VI,
  media y kJ se devuelven igualmente. `available` sigue siendo `true`.
- **Sin peso** → `MISSING_WEIGHT` y `average_wkg` a `null`; el resto se calcula.
- **Sin stream de potencia** → `MISSING_POWER` con `available: false`.
- `crc-power-curve` no reporta `MISSING_FTP`: el FTP no interviene en la curva.

En ningún caso se usa `isError`, reservado a fallos de entrada o de red.

### D17. La curva de potencia exige potencia medida

`crc-power-curve` devuelve `available: false` cuando `power_source` no es
`measured`, lo que incluye `device_watts` desconocido (por D8). `crc-calculate-power-metrics`
**sí** calcula con potencia estimada: la restricción de CLAUDE.md es para power
curve y VO2max, no para NP y TSS, y el bloque `quality` refleja el origen.

## Sprint 4 — Fisiología de campo (17/09/2026)

### D18. Fixtures propias para el desacople (06-08)

Las fixtures 01-05 llevan FC derivada de la potencia por fórmula
(`hr = 95 + 0.19*W`): sin deriva cardíaca, el desacople de cualquier serie a
potencia constante saldría 0 y el test no probaría nada. Se añaden tres fixtures
con la deriva construida a propósito, generadas por
`generador-fixtures-desacople.py` y derivadas analíticamente en Python, sin usar
la implementación TypeScript.

`07-desacople-hueco` es la importante: con un hueco asimétrico de 10 min, partir
por tiempo válido da **6.6667 %** y partir por índice de rejilla daría
**5.7692 %**. El `.expected.json` guarda los dos y el test comprueba que sale el
primero y que dista del segundo. Sin esa asimetría, ambos métodos coinciden y el
error pasaría desapercibido.

### D19. EF = media(P) / media(FC), no media de (P/FC)

La especificación dice "EF = power/hr" sin precisar. Se elige el cociente de
medias por mitad, que es el método estándar (Friel) y el que declara el
generador. La media de cocientes por muestra da otro número y penaliza en exceso
los segundos de FC baja. Declarado en `method.ef`.

### D20. El desacople no se interpreta

`computeDecoupling` devuelve el valor y los filtros, sin ningún campo de
veredicto. Hay un test que comprueba que la salida no contiene "fatiga",
"adaptación" ni campos tipo `verdict`/`rating`, inspeccionando los datos y
excluyendo `method` (donde la palabra aparece a propósito, en la frase que
declara que no se interpreta).

### D21. Fronteras semiabiertas en zonas y rangos

Toda zona o rango es `[lower, upper)`: la primera empieza en 0, la última no
tiene tope y un valor en la frontera cae en el intervalo superior. `zones.ts`
valida que las zonas sean contiguas y cubran `[0, ∞)`, y lanza si hay huecos,
solapes o si la última tiene tope.

Consecuencia comprobada por test: la suma de segundos de todas las zonas es
igual a `classified_seconds`, y `classified_seconds + unclassified_seconds` es
igual a `valid_seconds`. Los segundos válidos sin valor de la señal van a
`unclassified_seconds` en vez de desaparecer.

### D22. `work_kj` en work-above-ftp: total y excedente

`work_kj` por rango es ambiguo. Se devuelven ambos:
- `work_kj`: trabajo total en esos segundos, `Σ P / 1000`, coherente con el resto
  del proyecto.
- `work_above_ftp_kj`: solo el excedente, `Σ (P − FTP) / 1000`, que es lo que el
  nombre de la herramienta sugiere.

### D23. Esfuerzos: microcortes y tramos no válidos

`gap_tolerance_s` (2 s por defecto) evita que un segundo flojo parta un intervalo
de 5 min en dos esfuerzos. La duración del esfuerzo cuenta solo sus segundos
dentro del rango, no los del microcorte.

Un tramo NO VÁLIDO siempre rompe el esfuerzo, por larga que sea la tolerancia: en
un hueco sin muestras no sabemos qué pasó, y unir los dos lados inventaría un
esfuerzo continuo que quizá no existió.

### D24. Disponibilidad parcial por señal y parámetro

- Sin FC → desacople y zonas de FC no disponibles (`MISSING_HR`); potencia,
  torque y work-above-ftp siguen.
- Sin FTP → zonas relativas y work-above-ftp no disponibles (`MISSING_FTP`);
  zonas ABSOLUTAS y torque/cadencia funcionan igual, sin reportar el error.
- `crc-torque-cadence` no necesita FTP ni peso.
- `crc-aerobic-decoupling` solo pide FTP si se usan filtros relativos a él.

## Sprint 5 — VO2max y estimación de FTP (17/09/2026)

D12 deja de ser documentación: queda implementada.

### D25. Un valor sin fecha asume "desde hoy" *(pendiente de D12, resuelto)*

`effective_from` pasa a opcional y por defecto toma el día actual. Es lo que
quiere decir alguien que declara su FTP sin más, y rechazarlo solo añadía
fricción a la ruta principal del producto (un cicloturista que por fin sabe su
FTP y lo dice).

Cambia el contrato de `crc-set-performance-profile`, que es una tool CRC propia,
no una de las 26 originales: `effective_from` sale de `required`. Es una
ampliación retrocompatible, ninguna llamada que funcionara antes deja de hacerlo.

### D26. El cierre de la vigencia anterior exige confirmación explícita *(pendiente de D12, resuelto)*

`close_previous: true` pone `effective_to` de la ventana abierta anterior al día
previo al nuevo `effective_from`. **No es el comportamiento por defecto**: MODIFICA
una entrada del histórico que el usuario ya había guardado, y eso no se hace sin
que lo pida.

Sin la opción, añadir un FTP nuevo sobre una ventana abierta falla por solape,
que es exactamente el aviso correcto: obliga a decidir qué pasa con el valor
anterior en vez de resolverlo en silencio.

Detalle: solo se cierra la ventana ABIERTA más reciente anterior a la nueva. Las
ventanas ya cerradas del histórico no se tocan.

### D27. `bestEffortInPeriod` vive en `analytics/` con proveedores inyectados

El barrido necesita datos de Strava, pero CLAUDE.md exige que `analytics/` no
dependa de la fuente. Se resuelve inyectando `BestEffortProviders`
(`listActivities` y `loadStreams`): el módulo no importa nada de `sources/` y
`sources/strava.ts` aporta el adaptador `stravaBestEffortProviders()`.

Un único barrido compartido por `crc-estimate-vo2max` (5 min) y
`crc-estimate-ftp` (20 min), como exigía la nota de D12. Además:

- Las actividades no elegibles (`device_watts !== true`) se descartan ANTES de
  descargar sus streams: filtrar por metadatos no cuesta llamadas a la API.
- Una actividad que falle al descargarse se anota en `skipped` y el barrido
  sigue; un 503 puntual no tumba la estimación entera.

### D28. `model_reference` verificada

**Verificada el 17/09/2026.** `reference_verified: true`.

> Sitko S, Cirer-Sastre R, Corbi F, López-Laval I. *"Five-Minute Power-Based Test
> to Predict Maximal Oxygen Consumption in Road Cycling"*. International Journal
> of Sports Physiology and Performance, 2022;17(1):9-15.
> DOI 10.1123/ijspp.2020-0923 · PMID 34225254

Ecuación confirmada contra la publicación:

```
VO2max (mL·kg⁻¹·min⁻¹) = 8.87 × RPO5min + 16.6
```

Coincide con la implementación. `VO2MAX_MODEL` guarda además `doi` y `pmid` por
separado, y hay un test que falla si alguien los cambia.

**Límites de validez (en `quality.model_limitations`).** Salen del propio estudio
y acotan a quién es aplicable la estimación. No son errores de cálculo: son el
alcance del modelo, y por eso viajan con cada respuesta en lugar de quedarse en
la documentación.

1. **Muestra**: 46 ciclistas **varones** (38 ± 9 años, 71,4 ± 8,6 kg, VO2max
   61,13 ± 9,05 mL·kg⁻¹·min⁻¹). Extrapolar a mujeres o a perfiles muy distintos
   de esa muestra es una limitación conocida del modelo.
2. **Ajuste**: el R² con datos del propio 5MT fue 0,61-0,77 (intervalo de
   credibilidad del 95 %), frente a 0,81-0,88 usando un test incremental. Nuestro
   caso —mejor 5 min observado— se parece al primero, así que el margen de error
   es el mayor de los dos.

La segunda limitación se suma a la advertencia que ya daba la especificación: un
mejor 5 min observado tampoco garantiza que el esfuerzo fuera máximo. Son dos
fuentes de incertidumbre distintas y ambas se declaran.

### D28b. `effective_from` del FTP estimado: la fecha del esfuerzo

Confirmado: `crc-estimate-ftp` propone `effective_from` igual a la fecha de la
actividad donde se observó el mejor 20 min, no la de hoy. El FTP se demostró ese
día, y fecharlo hoy falsearía el histórico de cualquier actividad intermedia.

### D29. La procedencia estimada viaja en `quality`

`describeProvenance` marca `ftp_estimated` / `reference_estimated` y añade un
warning explícito en el bloque `quality` de toda tool que use un parámetro con
`source: "estimated_20min"`. Afecta a `crc-calculate-power-metrics` (IF y TSS),
`crc-time-in-zones` (zonas relativas), `crc-work-above-ftp` y
`crc-aerobic-decoupling` (filtros relativos).

Las métricas se siguen calculando: la incertidumbre se declara, no se oculta
devolviendo `null`.

### D30. Fixture 09-periodo con dos trampas deliberadas

El mejor 5 min (320 W, actividad 1001) y el mejor 20 min (265 W, actividad 1002)
están en actividades DISTINTAS, para que un barrido que devolviera siempre la
misma no pasara los tests. Además:

- `1003` tiene el pico más alto de 5 min (400 W) pero `device_watts: false`.
- `1004` tiene 450 W en 20 min pero cae fuera de la ventana de 90 días.

Si el resultado es una de esas dos, el filtro que falla es el de potencia medida
o el temporal, respectivamente.

## Sprint 6 — Orquestación (17/09/2026)

Las 11 herramientas CRC de la especificación quedan completas. En total son 12
tools CRC: las 11 de la especificación más `crc-estimate-ftp`, que nació de D12
y no figura en el documento original.

### D31. `streamSummary.ts`, la única pieza de cálculo nueva del sprint

El sprint no añade fórmulas, pero la sección 7.10 pide "HR/cadence summaries" y
no existía nada equivalente en `analytics/`: `zones.ts` da distribuciones,
`torqueCadence.ts` da bins, ninguno da media y máximo por señal. Se añade un
módulo mínimo de estadística descriptiva (media, máximo, mínimo sobre segundos
válidos).

No reimplementa nada: NP, TSS, zonas, torque y desacople se consumen de sus
módulos. Hay una comprobación en el checklist que falla si aparece un cálculo
propio en `orchestrationTools.ts`.

**La cadencia se resume excluyendo los ceros.** La rueda libre no describe cómo
pedalea nadie: con los ceros dentro, una bajada larga hunde la cadencia media y
el número deja de significar nada. La FC, en cambio, incluye todos sus valores.
Cada caso lo declara su propio `method`, para que la diferencia no sorprenda.

### D32. Los detalles de la actividad no cuestan una llamada extra

`crc-analyze-cycling-activity` necesita nombre, distancia, desnivel y tipo de
actividad. Esos datos ya venían en la llamada a `activities/{id}` que
`fetchActivityStreams` hacía para obtener `device_watts`: solo se guardaban menos
campos. Ahora se conserva un bloque `details` en el payload cacheado.
`CACHE_VERSION` sube a 3.

Alternativa descartada: llamar a `getActivityById` por separado. Habría duplicado
una petición que ya se estaba haciendo.

### D33. Disponibilidad parcial: la salida dice qué falta y por qué

Cada módulo de `crc-analyze-cycling-activity` lleva su `available` y, si es
`false`, un `reason`. El bloque `quality` del conjunto agrega esas razones
prefijadas con el nombre del módulo, más `modules_available` / `modules_total`.

Caso intermedio, que no es "disponible" ni "no disponible": con potencia pero sin
FTP, `power_metrics` sigue `available: true` y devuelve NP, VI, media y kJ, con
`intensity_factor` y `tss` a `null` y la lista explícita en
`unavailable_metrics`. Marcar el módulo entero como no disponible habría escondido
métricas perfectamente válidas.

### D34. `missing_data` frente a cero legítimo

En `crc-compare-activities` cada celda es
`{ value, status: "ok" | "missing_data", reason? }`:

- Una actividad rodada a 0 W da `{ value: 0, status: "ok" }`.
- Una actividad sin pulsómetro da `{ value: null, status: "missing_data", reason: "Sin FC." }`.

Un `null` a secas habría confundido las dos cosas, que es justo lo que prohíbe la
sección 7.9. Todas las filas comparten el mismo conjunto de claves
(`metric_keys`), para que la tabla sea comparable columna a columna aunque una
actividad no tenga un dato.

### D35. Propiedad de las actividades comprobada contra el atleta autenticado

`crc-compare-activities` consulta `getAuthenticatedAthlete` (del cliente original,
sin reimplementar nada) y rechaza toda actividad cuyo `athlete_id` no coincida,
anotándola en `quality.rejected` con su motivo. Es la regla de que los datos solo
se muestran a su propietario, aplicada en el punto donde podrían colarse
actividades ajenas.

Los IDs repetidos se descartan antes de pedirlos: no aportan nada a una
comparación y ahorran una llamada. El resto se apoya en la caché del Sprint 2.

## Sprint 7 — QA y documentación (18/09/2026)

### D36. Tres decisiones contradecían su propio estado

Al repasar `decisiones.md` aparecieron tres entradas que sprints posteriores ya
habían resuelto pero seguían marcadas como abiertas:

- **D3** decía "(abierto)" y "pendiente de aprobación"; la aprobaste y se aplicó
  en D5 (Sprint 2).
- **D12** decía "No implementado"; el Sprint 5 la implementó entera.
- Los dos pendientes de D12 seguían listados como "pendiente de decidir"; son
  D25 y D26.

Las tres se han actualizado con su estado real y un enlace a donde se
resolvieron. Un registro de decisiones que miente sobre lo que está hecho es peor
que no tenerlo: el siguiente que lo lea desconfiará de todo lo demás.

### D37. El informe de aceptación declara dos incumplimientos parciales

`docs/aceptacion-v0.1.md` recorre los diez criterios de la sección 14. Ocho se
cumplen limpiamente; dos lo hacen con matices, y se dicen:

- **Criterio 1** (las originales siguen funcionando): cumple, pero el SDK nuevo
  cambió la serialización de `additionalProperties` en 8 tools sin parámetros, y
  hay tres cambios deliberados en código original, todos retrocompatibles.
- **Criterio 9** (JSON estable y versionado): el envoltorio está versionado y no
  produce `NaN`/`Infinity`, pero **no se usa `structuredContent` con
  `outputSchema`** (lo proponía la decisión 5 del estudio) y **no hay snapshot
  del contrato de SALIDA**, solo del de entrada.

Además se deja constancia de que los **golden tests cruzados contra
Intervals.icu o WKO5 no se han hecho**: las fixtures son sintéticas y derivadas
analíticamente, lo que demuestra que el código implementa el método declarado,
pero no que ese método coincida con el de otras plataformas.

### D38. `noNaN.test.ts` inspecciona el texto, no el objeto

El criterio de que ninguna respuesta pública contenga `NaN` ni `Infinity` no se
puede verificar sobre el objeto parseado: `JSON.parse` nunca devuelve `NaN`, así
que ese test pasaría siempre sin probar nada. La única vía real de escape es un
valor interpolado dentro de una cadena (`` `${valor}` ``), y eso solo se ve en el
texto crudo.

El test recorre las 12 tools CRC en cinco escenarios adversos —actividad entera a
0 W (que produce 0/0 en el VI), actividad de 1 segundo, FC a 0, perfil vacío y
una actividad sin más stream que el tiempo— y comprueba el texto devuelto. 62
comprobaciones, todas en verde.

## Sprint 8 — Detección de subidas (18/09/2026) · primera de la v0.2

Abre la v0.2 sobre la capa ya validada. Todo lo de CLAUDE.md sigue en pie:
función pura en `analytics/`, cálculo determinista y sin interpretación.

### D39. Los umbrales de qué es una subida son convención nuestra

No existe una definición universal de "subida": cada plataforma usa la suya y
ninguna la publica del todo. Estos son los valores por defecto y el razonamiento
de cada uno. Todos son configurables por llamada, y viajan en
`inputs.thresholds` de cada respuesta para que el resultado sea reproducible.

| Umbral | Valor | Por qué |
|---|---|---|
| Desnivel mínimo | **30 m** | Por debajo, un repecho urbano o un paso elevado ya contaría como subida. 30 m es el orden de magnitud de un puente grande: lo mínimo que un ciclista recordaría como "una cuesta". |
| Pendiente media mínima | **3 %** | Por debajo del 3 % la mayoría rueda en llano, sin cambiar de posición ni de desarrollo. Es también el suelo habitual de las escalas de puertos. |
| Longitud mínima | **500 m** | Filtra rampas cortas que, con 30 m de desnivel, darían pendientes altas pero no son subidas: 30 m en 200 m es un muro de 15 %, no un puerto. |
| Llano tolerado | **200 m seguidos** | Un puerto real tiene descansillos. 200 m a 20 km/h son unos 36 s: suficiente para un falso llano, corto para unir dos puertos distintos. |
| Ventana de suavizado | **15 s** | Ver [D40](#d40-el-suavizado-tiene-un-coste-de-borde-medido). |
| Banda muerta | **1 m** | Orden de magnitud del ruido del barómetro de Strava. |
| Pendiente sostenida | **200 m** | La "pendiente máxima" instantánea de un barómetro es ruido; lo que describe una subida es el tramo más duro que se mantiene. |

Además, el criterio de aceptación es conjunto: un tramo debe cumplir **los tres**
mínimos (desnivel, longitud y pendiente media). Con eso, el falso llano de una
subida real no la parte pero tampoco permite que un llano larguísimo con un
repecho al final pase por puerto.

Un tramo NO VÁLIDO rompe la subida, igual que rompe un esfuerzo en
[D23](#d23-esfuerzos-microcortes-y-tramos-no-válidos): en un hueco sin muestras
no se sabe qué pasó, y unir los dos lados inventaría una subida continua.

### D40. El suavizado tiene un coste de borde, medido

El barómetro tiene ruido, así que la altitud se suaviza antes de derivar
pendientes. Dos detalles:

- **Media móvil centrada con ventana simétrica truncada.** La simetría no es un
  capricho: sobre una rampa constante devuelve la rampa exacta, bordes incluidos,
  así que suavizar no altera la pendiente de una subida real. Solo aplana el
  ruido.
- **Banda muerta de 1 m en el desnivel acumulado.** Sumar toda diferencia
  positiva sobre una señal ruidosa inventa desnivel: la fixture `13-llano-ruido`
  lo demuestra, un perfil completamente plano con ±1,5 m de ruido acumula más de
  100 m falsos sin filtrar, y menos de una décima parte con suavizado y banda
  muerta.

**Coste medido.** El suavizado difumina el codo del perfil, así que el tramo
detectado no coincide exactamente con la rampa construida. Sobre
`10-subida-limpia` (5 km al 6 %, de t=200 a t=1200):

| Suavizado | Tramo detectado | Distancia | Potencia media |
|---|---|---|---|
| 15 s (por defecto) | 204 → 1205 | 5005 m (+0,1 %) | 299,1 W (real 300) |
| 5 s | 204 → 1202 | 4990 m | 299,6 W |
| 1 s | 204 → 1200 | 4980 m | 299,9 W |

Se conservan los 15 s: en datos reales el ruido pesa mucho más que ese 0,1 %. El
sesgo queda **cuantificado en un test** (`el error de borde del suavizado se
mantiene por debajo del 1 %`) en vez de ignorado, de modo que si un cambio futuro
lo empeora, salta.

Se añadió un recorte de bordes que descarta los extremos donde la altitud
suavizada no sube. Reduce el arrastre pero no lo elimina, porque el difuminado
del codo es inherente a la media móvil.

### D41. La escala de dificultad es propia y se dice en cada respuesta

`difficulty_score = distancia_km × pendiente_media_%`, con cortes en 6, 16, 40 y
80 para `corta`, `suave`, `media`, `dura` y `muy dura`.

El producto distancia × pendiente es la idea que sustenta la mayoría de escalas
de puertos, pero **los cortes son nuestros**. Cada subida incluye
`difficulty_scale` con un texto que dice literalmente que NO es la categorización
oficial de la UCI ni de ninguna otra organización, y las etiquetas son palabras
comunes, no "HC" ni "categoría 1", para que nadie las confunda. Hay un test que
falla si la etiqueta empieza a parecerse a una categoría oficial.

### D42. `MISSING_ELEVATION`: primer código de error fuera de la sección 12

La sección 12 de la v0.1 define siete códigos y ninguno cubre "falta altitud".
Se añade `MISSING_ELEVATION` al enum, marcado en el código como ampliación de la
v0.2.

Para que la lista original siga siendo verificable, se exporta
`SPEC_V01_ERROR_CODES` con los siete de la especificación, y hay dos tests: uno
comprueba que los siete siguen presentes, y otro que las ampliaciones son
exactamente las esperadas. Así el enum puede crecer sin que se pierda de vista
qué venía del documento y qué añadimos después.

### D43. `sliceAlignedStreams`, para no reimplementar NP por subida

Cada subida necesita su potencia media y su NP. En vez de recalcularlos, se
recorta el tramo con `sliceAlignedStreams` y se pasa a `computePowerMetrics`. El
helper conserva la correspondencia entre señales y ajusta `start_offset_s`, de
modo que los tiempos siguen refiriéndose a la actividad original.
## Sprint 10 — Zonas de frecuencia cardíaca (20/09/2026) · v0.2

### D56. `hr_threshold_bpm`: por qué se documenta tan insistentemente

Es la FC del **segundo** umbral (LTHR). Ya existía `aet_hr_bpm`, que es la del
**primero**. Ambas son "una FC de umbral" y se confunden con facilidad, pero
marcan transiciones fisiológicas distintas y anclan zonas distintas: las de
Coggan se calculan sobre el segundo, no sobre el primero.

Por eso la distinción está escrita **en el propio esquema**, no solo aquí: quien
vaya a rellenar el perfil lee la descripción del campo, no el registro de
decisiones.

Orden esperado: `aet_hr_bpm < hr_threshold_bpm < hr_max_bpm`. Rango plausible
100-210 bpm.

### D57. La coherencia entre frecuencias se valida al guardar

`assertCoherentHeartRates` comprueba el orden fisiológico entre las tres FCs
cuyas ventanas de vigencia se solapan. Un LTHR por encima de la FC máxima no es
un dato raro: es imposible, y es exactamente el error de quien ha confundido
`aet_hr_bpm` con `hr_threshold_bpm`. El mensaje de error lo dice con esas
palabras.

Se valida **al escribir**, no al calcular zonas, para que el perfil nunca llegue
a contener algo incoherente. Y se comprueba en ambos sentidos: da igual cuál de
los dos valores se guarde primero.

Las ventanas que no se solapan no se comparan: un umbral alto en 2025 y una FC
máxima más baja medida en 2026 son perfectamente compatibles.

### D58. Cortes enteros, no porcentajes

Las zonas de Coggan se definen en porcentajes (69 %, 84 %, 95 %, 105 %), pero se
guardan como **cortes en bpm enteros**. Dos motivos:

- Un pulsómetro no da decimales. "Zona 4 a partir de 156,75 ppm" no significa
  nada sobre el terreno.
- Tomados literalmente, los porcentajes dejan huecos: entre "Z1 hasta 68 %" y
  "Z2 desde 69 %" falta el 68,5 %. Guardando **un único corte** que es a la vez
  tope de una zona y suelo de la siguiente, el hueco no puede existir por
  construcción.

Con LTHR 165: Z1 `[0,114)`, Z2 `[114,139)`, Z3 `[139,157)`, Z4 `[157,174)`,
Z5 `[174,191)`. El latido del corte pertenece siempre a la zona superior, igual
que en las zonas de potencia ([D21](#d21-fronteras-semiabiertas-en-zonas-y-rangos)).

### D59. La Z5 se cierra en la FC máxima, y lo que la supera no se reparte

Cuando hay `hr_max_bpm`, la Z5 termina ahí. Los segundos por encima quedan en
`unclassified_seconds` en lugar de sumarse a la zona más dura.

Es deliberado: una FC por encima de la máxima registrada es un artefacto del
sensor o una FC máxima desactualizada. En ninguno de los dos casos conviene
contarla como esfuerzo real en Z5, que es la interpretación que invitaría a
hacer. Se reporta aparte y el bloque `method` lo dice.

Esto obligó a relajar una regla: `zones.ts` exigía que la última zona quedase
abierta. Ahora admite un techo explícito mediante `allowClosedTopZone`, que por
defecto sigue en `false` para que ningún valor se quede fuera por olvido.

**Consecuencia para los tests:** con techo, la suma por zona iguala
`classified_seconds`, no `valid_seconds`. La fixture `16-zonas-sobre-maxima`
comprueba justo ese caso.

### D60. `bestEffortInPeriod` admite la señal de FC

En vez de escribir un segundo barrido, se añadió el parámetro `signal`
(`watts` | `heartrate`). La matemática de la ventana móvil es idéntica, así que
la señal elegida se pasa en el hueco de `watts` a `computePowerCurve` y se
reutiliza el algoritmo entero.

Diferencia importante: con `heartrate` **no** se exige `device_watts === true`.
Exigirlo dejaría fuera a quien rueda con pulsómetro y sin potenciómetro, que es
precisamente a quien más le sirve estimar su umbral de FC.

Ventana por defecto de **un año** frente a los 90 días del FTP, porque la FC de
umbral se mueve mucho menos a lo largo de una temporada. A cambio son muchas más
actividades: el tope por defecto baja a 40 y la caché no es opcional.

### D61. La advertencia sobre la FC es un límite del método, no un fallo

`crc-estimate-hr-threshold` devuelve siempre `quality.method_limitations` con
tres avisos: que la FC se desplaza con el calor, la deshidratación, la altitud o
la fatiga sin que cambie la forma física; que el mejor 20 min de FC puede no
corresponder a un esfuerzo de umbral; y que un test de campo declarado da un
valor más fiable.

Redactados como alcance del método, no como error de cálculo. Hay un test que
falla si el texto empieza a hablar de "error" o "fallo".


Métricas que venían de un script de análisis de puertos ya en uso. Adaptadas a
las reglas del proyecto, no copiadas: funciones puras en `analytics/`, sin
interpretación en la salida y consumiendo `powerMetrics` para el NP.

### D62. Un bug de prioridad de errores que el sprint destapó

Al anclar las zonas de FC al umbral, una actividad **sin pulsómetro** empezó a
devolver `MISSING_HR_THRESHOLD`: el perfil se resolvía antes de mirar si había
señal. El usuario habría configurado su umbral para descubrir que seguía sin
funcionar.

Corregido: si no hay stream de FC no se resuelve el umbral, y el error vuelve a
ser `MISSING_HR`. La regla general que deja el caso: **cuando faltan un dato de
la actividad y uno del perfil, se reporta primero el de la actividad**, porque
es el que el usuario no puede arreglar configurando nada.
## Sprint 11 — Métricas de subidas (20/09/2026) · v0.2

### D63. El índice de dificultad pasa a ser cuadrático en la pendiente

**Antes:** `distancia_km × pendiente_media_%`.
**Ahora:** `pendiente_media_%² × distancia_km`.

El producto lineal trataba pendiente y distancia como intercambiables: 10 km al
6 % y 5 km al 12 % daban exactamente lo mismo (60). Sobre la bici no se parecen
en nada. Doblar la pendiente no duplica el esfuerzo, lo dispara: sube la
potencia necesaria para avanzar, obliga a cambiar de desarrollo y a menudo a
levantarse. Elevarla al cuadrado recoge eso; la distancia sigue entrando en
lineal, que es como se comporta.

Con la fórmula nueva esos dos ejemplos dan 360 y 720: el doble, que es el orden
de diferencia que percibe quien los sube.

**Cortes recalibrados**, porque la escala de los números cambia por completo:

| Etiqueta | Corte | Referencia que lo sitúa |
|---|---|---|
| corta | < 20 | 500 m al 3 % (el mínimo detectable) da 4,5 |
| suave | 20 | 2 km al 6 % da 72 |
| media | 100 | 5 km al 6 % da 180 |
| dura | 300 | 10 km al 6 % da 360 |
| muy dura | 700 | Alpe d'Huez unos 905; Angliru unos 1200 |

Se mantiene todo lo demás de [D41](#d41-la-escala-de-dificultad-es-propia-y-se-dice-en-cada-respuesta):
etiquetas en palabras comunes, `difficulty_scale` en cada subida diciendo que no
es la categorización oficial de nadie, y el test que falla si una etiqueta
empieza a parecerse a una categoría de federación.

**Aviso para quien compare informes antiguos:** los valores de
`difficulty_score` anteriores a este sprint NO son comparables con los nuevos.
La etiqueta de una misma subida puede cambiar.

### D64. El índice de eficiencia compara subidas, no ciclistas

`EI = VAM / (W/kg)`. Cuántos metros por hora se suben por cada vatio por kilo.

Solo se calcula con **potencia medida** y peso vigente. Con potencia estimada el
cociente heredaría el error del modelo de Strava y daría una precisión que no
tiene.

Su limitación viaja en `method`: **sirve para comparar subidas del mismo
ciclista entre sí, no para comparar ciclistas**. Depende de la posición sobre la
bici, del material, del viento y de la propia pendiente, así que dos personas
con el mismo EI no rinden igual. Es la clase de número que invita al ranking
justo cuando peor lo soporta.

### D65. La comparación con el histórico excluye la actividad analizada

`%MMP` compara la potencia media de cada subida con el mejor esfuerzo del atleta
en **esa misma duración**, en una ventana de 42 días por defecto (seis semanas:
bastante para tener con qué comparar, poco para que siga reflejando la forma
actual).

**La actividad analizada se excluye del histórico.** Si contara, una subida que
bate el récord se compararía consigo misma y daría exactamente 100 % en vez de
superarlo, que es justo el caso que interesa detectar. Para eso se añadió
`excludeActivityIds` a `bestEffortInPeriod`.

**Un solo barrido para todas las subidas.** Cada subida necesita su propia
duración, y llamar una vez por subida repetiría el recorrido entero del
historial. Se añadió `bestEffortsInPeriod` (plural), que recorre las actividades
UNA vez y saca todas las duraciones de cada una, que es lo que `computePowerCurve`
ya hacía en una pasada. `bestEffortInPeriod` queda como envoltorio de un solo
elemento, así que nada de lo que la usaba cambia.

Requiere potencia medida y está detrás de `compare_to_best`, apagado por
defecto: cuesta llamadas a la API y no todo el mundo la necesita en cada
análisis.

### D66. Las tendencias se devuelven como coeficientes, sin etiqueta

Regresión lineal de la potencia media y de la FC media sobre el índice de subida
(0, 1, 2…). Se devuelven `slope`, `intercept`, `r_squared` y `n`. Nada más.

**Ni "fatiga", ni "deriva cardiovascular", ni flechas.** Una pendiente negativa
de potencia a lo largo de una salida puede ser fatiga, pero también terreno
distinto, dosificación deliberada, viento o una subida final más tendida. Cuál
de las cuatro es depende del contexto del entrenamiento, y esa lectura le
corresponde a quien tiene ese contexto, no a este módulo. Hay un test que falla
si aparecen esas palabras en la salida.

Mínimo **3 subidas**: con dos, una recta pasa exactamente por los dos puntos y
`r_squared` da 1 siempre, lo que sugeriría una certeza que no existe.
