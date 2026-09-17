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

### D3. Techo de precisión en 7 tools originales (abierto)

La regla del proyecto exige IDs como `string`, pero **7 herramientas originales
declaran el ID como `z.number().int().positive()`** en su esquema MCP:

`get-activity-details`, `get-athlete-stats`, `get-segment`, `get-segment-effort`,
`get-segment-leaderboard`, `list-segment-efforts`, `star-segment`.

Con esos esquemas, un ID de más de 16 dígitos llega ya corrompido desde el
`JSON.parse` del transporte: **no es recuperable dentro de la herramienta**.
Arreglarlo exige cambiar sus esquemas a `z.union([z.string(), z.number()])`, lo
que este sprint prohíbe expresamente.

**Decisión:** dejarlo documentado y pendiente de aprobación. La capa CRC no está
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

### D12 · Estimación de FTP desde el historial

**Alcance: Sprint 5. No implementado. Esta entrada solo deja registrada la decisión.**

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

**Pendiente de decidir en el Sprint 5:**

- Si al fijar un valor nuevo se cierra automáticamente la vigencia del anterior
  (`effective_to` al día previo).
- Si un FTP declarado sin fecha asume "desde hoy" en vez de rechazarse.

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
