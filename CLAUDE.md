# CRC Strava MCP — instrucciones para Claude Code

Fork de r-huijts/strava-mcp con una capa analítica determinista (CRC).
La especificación completa está en `docs/CRC_Strava_MCP_Especificacion_Tecnica_v0_1.docx`
y el estudio de viabilidad en `docs/Estudio_CRC_Strava_MCP.md`. Léelos antes de cada sprint.

## Reglas no negociables
- Las 26 herramientas originales NO se renombran, eliminan ni cambian de contrato.
  (Son 26, no 25: verificado en runtime con `tools/list` contra `dist/server.js`.)
  Total actual: **28** = 26 originales + 2 CRC (`crc-get-performance-profile` y
  `crc-set-performance-profile`, Sprint 2).
- Las herramientas originales NUNCA importan nada de `src/crc/`.
- Todo cálculo (NP, IF, TSS, kJ, curvas, desacople, torque, VO2max) es TypeScript determinista y testeado. Nada se delega al LLM.
- Los datos solo se muestran al propio usuario autenticado. Una instancia = un atleta. Sin multitenencia, sin compartir, sin exportar a terceros.
- Al LLM solo se devuelven métricas agregadas en JSON. Las tools CRC nunca devuelven streams crudos.
- Los IDs de Strava son `string` en toda la capa CRC (IDs de 64 bits).
- AeT, MAP y similares nunca se infieren de Strava: solo existen si están en el perfil CRC con fuente explícita.
- FTP y peso se resuelven por la fecha de la actividad. Si no hay valor vigente → `missing_parameter`. Nunca usar el valor actual por defecto.
- VO2max siempre se etiqueta `estimated_vo2max`.
- Ninguna respuesta pública puede contener `NaN` o `Infinity` (convertir a `null` + warning).
- No reutilizar `downsampleStream` del código original: desalinea señales. Usar `src/crc/streams/alignedStreams.ts`.
- Calcular y persistir van en tools separadas. Las tools MCP son sin estado y no pueden esperar una confirmación del usuario, así que toda regla del tipo "confirmar antes de X" se implementa partiendo la operación en dos llamadas, nunca confiando en el comportamiento del orquestador. Ver D12 en `docs/decisiones.md`. Es el mismo principio que "nada se delega al LLM" aplicado a la escritura: no confiar al modelo lo que debe garantizar el código.

## Arquitectura
- `src/crc/analytics/` y `src/crc/streams/`: funciones puras, SIN dependencias de Strava ni de MCP. Reciben `AlignedStreams`.
- `src/crc/sources/strava.ts`: único punto que convierte respuestas de Strava en `AlignedStreams` (streams nativos: `key_by_type=true`, `series_type=time`, sin `resolution`).
- `src/crc/tools/`: wrappers MCP finos (validación Zod → source → analytics → `crcToolResponse`).
- `src/crc/registerCrcTools.ts`: único punto de registro, llamado al final de `server.ts`.
- `src/schemas/`: zona neutral compartida. Solo contratos genéricos (validación de IDs, booleanos flexibles), nunca analítica. No importa nada salvo Zod. La capa CRC la consume vía `mcpSchemas.ts`, no directamente. Para añadir algo aquí, las dos capas deben necesitarlo. Ver D11 en `docs/decisiones.md`.
- Perfil: `~/.config/strava-mcp/crc-performance-profile.json`, escritura atómica (tmp + rename).

## Convenciones de cálculo (declarar siempre en `method`)
- Rejilla de 1 s sobre `time`. Huecos ≤ `gap_fill_s` (3 s por defecto) se rellenan; huecos mayores se marcan no válidos.
- Las ventanas móviles (NP, power curve, mejor 5 min) no cruzan huecos no válidos.
- Duración para TSS = segundos válidos.
- Con potencia estimada (`device_watts=false`) no se calcula power curve ni VO2max.
- Desacople: mitades por tiempo válido, no por índice.

## Flujo de trabajo
- Una rama por sprint: `sprint-N/<tema>`. Commits pequeños y descriptivos.
- Tests primero para cada fórmula (Vitest, `tests/crc/`). Fixtures en `tests/crc/fixtures/`.
- Antes de dar una tarea por terminada: `npm run build && npm test` en verde.
- Si algo de la especificación es ambiguo, pregunta antes de decidir; si decides, documéntalo en `docs/decisiones.md`.

### Checklist de cierre de sprint
Además de build y tests en verde, comprobar las invariantes de arquitectura:
- `src/schemas/` no importa nada salvo Zod:
  `grep -rn "from \"" src/schemas/ | grep -v '"zod"'` → sin resultados.
- Ninguna tool original importa de `src/crc/`:
  `grep -rn "crc/" src/tools/` → sin resultados.
- El snapshot de `tools/list` contra `dist/server.js` no ha cambiado en las
  herramientas originales: `node scripts/snapshot-tools.mjs > despues.json` y
  `node scripts/snapshot-tools.mjs --diff antes.json despues.json`
  (capturar `antes.json` ANTES de empezar el sprint). Solo deben aparecer tools
  CRC añadidas; ninguna original eliminada ni modificada salvo decisión
  aprobada y documentada.

## Comandos
- `npm run build` · `npm test` · `npm run dev` · `npx vitest run tests/crc`
