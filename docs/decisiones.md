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
