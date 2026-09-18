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

## Sprint 9 — Distribución por npm (18/09/2026) · rama de pruebas

**Rama de pruebas, no mergeada.** Parte de `f73ee96` (v0.1 validada, 38 tools),
no de `main`, por lo explicado en D44.

### D44. La rama parte de la v0.1, no de main

Al empezar el sprint, `main` ya apuntaba al Sprint 8 (39 tools, detección de
subidas). El reflog lo registra como `merge sprint-8/subidas: Fast-forward`.

**Aclarado:** ese fast-forward fue deliberado, pedido para probar la detección de
subidas en Claude Desktop. No hay nada que investigar y `main` se queda como
está: la 0.2.0 saldrá de ahí cuando las subidas se validen con datos reales.

Se decide publicar **la v0.1**, que es lo que cubre `docs/aceptacion-v0.1.md`. La
detección de subidas es v0.2 experimental, con una escala de dificultad que es
convención propia recién estrenada y sin validación externa: no es lo que quieres
en el primer paquete que instale alguien.

### D45. Nombre del paquete: `crc-strava-mcp`

El scope `@crc` **no existe en npm** (404 en el registro), así que
`@crc/strava-mcp-server` no era publicable sin crear antes la organización.
Verificado que `crc-strava-mcp` está libre.

Sin scope, porque el comando que teclea el usuario final es más corto:
`npx crc-strava-mcp`. Se mantiene `strava-mcp-server` como segundo alias en
`bin` para no romper a quien viniera del paquete original.

`files` pasa a `["dist", "README.md", "LICENSE", "CHANGELOG.md"]`: antes incluía
`scripts/`, con `setup-auth.ts` sin compilar y utilidades de desarrollo que no
sirven de nada dentro del paquete.

### D46. `npm audit`: 3 de 21 eran reales

Primera revisión del audit en todo el proyecto. El desglose importa más que el
número:

| | Cuántas | Qué son |
|---|---|---|
| Producción (`--omit=dev`) | **3** | `form-data` (crítica), `axios` (alta), `follow-redirects` (moderada). Toda la cadena de axios. |
| Desarrollo | 18 | `vitest`, `vite`, `rollup`, `postcss`, `esbuild`, `@typescript-eslint`. |

Las 18 de desarrollo **no las instala nunca un usuario**: `npm i` de un paquete
publicado solo resuelve `dependencies`. Son ruido para quien consume el paquete,
aunque convenga mantenerlas al día para quien desarrolla.

Las 3 de producción se arreglaron actualizando **axios 1.8.4 → 1.20.0**, que
entra en el `^1.6.0` ya declarado: sin salto mayor y sin `--force`. Resultado:
`npm audit --omit=dev` → **0 vulnerabilidades**, con los 459 tests intactos.

No se ejecutó `npm audit fix --force`: arrastraría cambios mayores en vitest y
en el toolchain, justo lo que sostiene el baseline.

### D47. El muro del alta no estaba donde parecía

El diagnóstico inicial era que el OAuth acaba en una página de localhost con
error de conexión. Cierto, pero solo en `scripts/setup-auth.ts`, que usa
`redirect_uri=http://localhost` **sin servidor escuchando**: el navegador falla y
hay que copiar el código a mano de la barra de direcciones.

`connect-strava` ya hacía lo correcto: servidor en `localhost:8111`, formulario
web para las credenciales, callback real y página de éxito. El problema era que
los dos flujos convivían.

Se mejora el que funciona en lugar de inventar otro:

- **Guía de tres pasos** en la propia página, con enlace a Strava.
- **El Authorization Callback Domain, copiable con un botón**, y con un aviso de
  que es `localhost` a secas. Es el campo donde más gente se equivoca escribiendo
  `http://localhost` o `localhost:8111`, y el fallo se manifiesta después, al
  autorizar, donde ya no es evidente de dónde viene.
- La página dice dónde se guardan las credenciales y que no salen del equipo.

Descartado: una app de Strava compartida. Exigiría distribuir el `client_secret`
en un paquete público, permitiría suplantar la aplicación y repartiría el límite
de 1000 peticiones/día entre todos los usuarios. Contradice además la decisión
del estudio de que cada usuario use su propia app.

### D48. Los errores dicen qué hacer, no qué ha fallado

`src/authMessages.ts` centraliza los mensajes de autenticación. Antes cada
herramienta repetía su propio literal, con dos redacciones distintas y ambas
inútiles para el usuario: *"Configuration Error: STRAVA_ACCESS_TOKEN is missing
or not set in the .env file"* le habla de una variable de entorno y de un fichero
que, instalando por npx, no existe.

Ahora: *"Todavía no hay ninguna cuenta de Strava conectada. Qué hacer: escribe
«conecta mi cuenta de Strava»…"*. Están en un único módulo para que el día que
cambie el procedimiento haya un solo sitio que tocar.

Efecto lateral asumido: dos tests originales comprobaban el texto literal. Se
actualizaron para verificar lo que de verdad importa —que hay error y que el
mensaje orienta—, no la redacción exacta.

### D49. Precedencia de credenciales, declarada

1. Variables de entorno del proceso.
2. `~/.config/strava-mcp/config.json` ← fuente de verdad.
3. `.env` junto al paquete ← solo desarrollo.

Ya funcionaba así en `config.ts`, pero no estaba escrito en ninguna parte. El
`.env` se carga primero en el arranque porque dotenv nunca pisa una variable ya
definida, de modo que el orden efectivo es el de arriba. Con npx no hay ningún
`.env` y eso es lo normal.

### D50. Verificado instalando el tarball, no solo empaquetando

`npm pack` genera el .tgz, pero no prueba que el paquete funcione. Se instaló en
un directorio limpio fuera del repositorio y se arrancó con un cliente MCP real
contra `node_modules/crc-strava-mcp/dist/server.js`: **38 tools, 12 de ellas
CRC**. Es la única forma de comprobar que `files`, `bin` y el shebang están bien.


### D51. La página de alta está en español, a propósito

El resto de la interfaz heredada del proyecto original está en inglés, pero la
página de conexión (`src/auth/pages.ts`, `setupPage`) se escribe en español.

Es una elección deliberada, no un descuido: el fork va dirigido a cicloturistas
hispanohablantes y esa página es **la primera pantalla que ve un usuario nuevo**,
justo en el paso donde más gente abandona. Un muro de onboarding en otro idioma
es un muro más alto.

Coherente con el resto de la documentación del fork (README, `decisiones.md`,
`aceptacion-v0.1.md`, CHANGELOG), toda en español. Si alguna vez se publica el
fork para público internacional, esta es la pieza a traducir primero, junto con
los mensajes de `src/authMessages.ts`.

### D52. Numeración: 0.1.0 limpia, no prerelease

La versión pasa de `0.1.0-crc.0` a **`0.1.0`**. Un prerelease no se instala con
`npm install crc-strava-mcp` ni con `npx crc-strava-mcp` salvo que se pida por
nombre exacto, que es justo lo contrario de lo que busca este sprint.

La numeración arranca en 0.1.0 y no continúa la 1.2.1 del proyecto original
porque el alcance y el contrato son distintos: son 38 herramientas frente a 26,
con una capa de cálculo propia.

Metadatos actualizados al fork, que apuntaban todos al repositorio original:
`repository.url`, `homepage`, `bugs`, `author` y `mcpName` en `package.json`, y
`name`, `repository`, `description` e `identifier` del paquete npm en
`server.json` (este último aún declaraba `@r-huijts/strava-mcp-server`).
