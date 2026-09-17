# CRC Strava MCP — instrucciones para Claude Code

Fork de r-huijts/strava-mcp con una capa analítica determinista (CRC).
La especificación completa está en `docs/CRC_Strava_MCP_Especificacion_Tecnica_v0_1.docx`
y el estudio de viabilidad en `docs/Estudio_CRC_Strava_MCP.md`. Léelos antes de cada sprint.

## Reglas no negociables
- Las 26 herramientas originales NO se renombran, eliminan ni cambian de contrato.
  (Son 26, no 25: verificado en runtime con `tools/list` contra `dist/server.js`.)
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

## Arquitectura
- `src/crc/analytics/` y `src/crc/streams/`: funciones puras, SIN dependencias de Strava ni de MCP. Reciben `AlignedStreams`.
- `src/crc/sources/strava.ts`: único punto que convierte respuestas de Strava en `AlignedStreams` (streams nativos: `key_by_type=true`, `series_type=time`, sin `resolution`).
- `src/crc/tools/`: wrappers MCP finos (validación Zod → source → analytics → `crcToolResponse`).
- `src/crc/registerCrcTools.ts`: único punto de registro, llamado al final de `server.ts`.
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

## Comandos
- `npm run build` · `npm test` · `npm run dev` · `npx vitest run tests/crc`
