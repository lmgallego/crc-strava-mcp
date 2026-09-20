# Codex como cliente MCP · investigación

**Fecha: 19 de septiembre de 2026.** Rama `sprint-9/npm-distribucion`, sobre la
v0.1 (38 herramientas).

Objetivo: poder dar instrucciones fiables de instalación tanto para Claude
Desktop como para Codex, sin que fallen delante de una clase.

> **Este documento distingue tres cosas y conviene no mezclarlas:**
>
> - ✅ **VERIFICADO AQUÍ** — medido en esta máquina, reproducible.
> - 📄 **DOCUMENTADO** — de fuente oficial o de un issue del repositorio de
>   Codex. Fiable, pero no comprobado por nosotros.
> - ❓ **CONJETURA** — razonamiento pendiente de prueba real. **No actuar sobre
>   esto sin comprobarlo antes.**

## Límite de esta investigación

**Codex no estaba instalado en la máquina donde se hizo** (`codex: command not
found`, sin `~/.codex/`). No se ejecutó Codex ni una sola vez. Todo lo relativo
a su comportamiento en ejecución es documentación o conjetura.

Lo que sí se midió aquí: el tamaño de nuestras respuestas, la cobertura de
nuestros validadores y la forma de `npx` en Windows.

---

## 1. Configuración

📄 **Ruta: `~/.codex/config.toml`** en Windows, macOS y Linux por igual. En
Windows es `C:\Users\<usuario>\.codex\config.toml`: **no** usa `%APPDATA%`, a
diferencia de Claude Desktop. Admite además `.codex/config.toml` por proyecto.

```toml
[mcp_servers.crc-strava]
command = "npx"
args = ["-y", "crc-strava-mcp"]

[mcp_servers.crc-strava.env]
MI_VAR = "valor"
```

Equivalente por CLI: `codex mcp add crc-strava -- npx -y crc-strava-mcp`.

### Diferencias con Claude Desktop

| | Claude Desktop | Codex |
|---|---|---|
| Formato | JSON | **TOML** |
| Clave | `mcpServers` | `mcp_servers` (guion bajo) |
| Ruta en Windows | `%APPDATA%\Claude\` | `~/.codex/` |
| Timeout de arranque | sin límite documentado | **10 s** (`startup_timeout_sec`) |
| Timeout por herramienta | sin límite documentado | **60 s** (`tool_timeout_sec`) |
| Filtrar herramientas | no | `enabled_tools` / `disabled_tools` |
| Límite de salida | — | `output_token_limit` por herramienta |

Claves documentadas para stdio: `command` (obligatoria), `args`, `env`, `cwd`,
`enabled`, `startup_timeout_sec`, `tool_timeout_sec`, `env_vars`.

### Qué ha cambiado, y por qué las guías se contradicen

📄 La documentación **se ha movido dos veces**. `docs/config.md` del repositorio
es hoy solo un índice que apunta a `developers.openai.com/codex/*`, que a su vez
redirige (HTTP 308) a `learn.chatgpt.com/docs/*`. Cualquier guía que enlace a
las rutas antiguas está desactualizada.

📄 `startup_timeout_ms` → **`startup_timeout_sec`**. La clave vigente es en
segundos; la de milisegundos sigue circulando en blogs.
❓ **No se pudo fechar el cambio**: no se encontró entrada de changelog que lo
documente.

📄 Desde marzo de 2026 existe la familia de comandos `codex mcp`. Desde la
v0.152.0 (septiembre de 2026) hay límites de tokens por herramienta.

⚠️ 📄 El issue [#29396](https://github.com/openai/codex/issues/29396) (**abierto**,
18 👍) reporta que fijar `startup_timeout_sec` provoca
`invalid transport in mcp_servers.*` en la v0.141.0. Está reportado sobre el
servidor `codex_apps`; ❓ **no está confirmado que afecte a servidores stdio de
terceros como el nuestro**. Si se recomienda esa clave en el README, hay que
probarla antes.

## 2. `npx` en Windows: es un problema real

✅ **VERIFICADO AQUÍ:** en este Windows `npx` existe como `npx` (script),
`npx.cmd` y `npx.ps1`. **No hay ningún `.exe`.**

📄 Codex lanza el proceso sin shell, así que no resuelve `PATHEXT` y no
encuentra el comando:

- [Issue #16229](https://github.com/openai/codex/issues/16229) — **abierto**,
  etiquetas `bug`/`windows-os`/`mcp`. Creado el 30/03/2026, actualizado el
  02/07/2026. Error:
  `MCP startup failed: handshaking with MCP server failed: connection closed`.
  **Sin corrección publicada.**
- [Issue #3111](https://github.com/openai/codex/issues/3111) — cerrado, mismo
  síntoma con `uvx`/`npx`: `Tools: (none)`.

Lo llamativo es que **el ejemplo oficial de OpenAI usa `command = "npx"`**, que
es justo lo que falla en Windows.

Workarounds, ordenados por fiabilidad de la evidencia:

1. 📄 **Ruta absoluta a `node.exe`** más la ruta del script. Es lo que confirma
   el issue. Robusto, pero obliga a cada alumno a localizar su ruta.
2. ❓ **`command = "cmd"`, `args = ["/c", "npx", "-y", "crc-strava-mcp"]`**. Lo
   recomiendan varias guías de terceros; **no verificado**, no aparece en la
   documentación oficial.
3. ❓ Instalación global y `command = "crc-strava-mcp"`: mismo problema de shim
   `.cmd`, previsiblemente falla igual.

❓ Añadido: `npx -y` en frío descarga 119 paquetes y el timeout de arranque son
10 s. Es probable que haya que subirlo.

## 3. Serialización de parámetros

❓ **No se sabe qué tipos envía Codex.** Es la pregunta central y la que exige
probarlo.

✅ **VERIFICADO AQUÍ** — qué acepta nuestro código (medido ejecutando los
validadores):

```
stravaId        | 1234567890 → OK    | "1234567890" → OK   | " 123 " → OK
                | "1234567890123456789" → OK (19 dígitos)
                | 123.5 → RECHAZA    | -1 → RECHAZA        | null → RECHAZA
flexibleBoolean | true → OK          | "true" → OK
  (antes)       | "True" → RECHAZA   | "TRUE" → RECHAZA    | 1 → RECHAZA
z.number()      | 250 → OK           | "250" → RECHAZA
z.array(number) | [60,300] → OK      | ["60","300"] → RECHAZA
```

Dos huecos, uno ya cerrado:

- **`flexibleBoolean` no cubría `"True"` ni `1`/`0`.** `"True"` capitalizado es
  la forma natural de un cliente entrenado sobre Python. **Corregido el
  19/09/2026**: ahora acepta `true`/`false`, `"true"`/`"True"`/`"TRUE"` y sus
  negativos, y `1`/`0`. Sigue rechazando `"yes"`, `"si"`, `"1"` y `""`, que ya
  sería adivinar la intención en vez de normalizar una serialización.
- **Los parámetros numéricos siguen sin protección.** En el Sprint 1 se
  blindaron IDs y booleanos, pero no los números: si un cliente serializa
  `ftp_w` como `"250"`, falla. Afecta a una veintena de parámetros (`ftp_w`,
  `weight_kg`, `days`, `max_activities`, `durations_s`, `bin_width_rpm`,
  `gap_tolerance_s`, `min_valid_duration`…).

❓ Que ese segundo hueco importe depende de si Codex coacciona los tipos contra
el `inputSchema` antes de enviar. **Decisión tomada: no blindar veinte
parámetros por si acaso.** Se hará solo si la prueba real lo confirma.

## 4. Límites

### Número de herramientas

📄 No hay límite duro documentado. El problema es de contexto: 38 herramientas
ocupan espacio en cada petición. Codex permite filtrar con
`enabled_tools`/`disabled_tools`, cosa que Claude Desktop no ofrece.

### Tamaño de las respuestas

✅ **VERIFICADO AQUÍ** — medido con una actividad sintética de 3 h a 1 Hz:

| Herramienta | Bytes | ~tokens | |
|---|---|---|---|
| `crc-calculate-power-metrics` | 2 645 | 661 | ok |
| `crc-time-in-zones` | 3 761 | 940 | ok |
| `crc-compare-activities` (2 actividades) | 4 250 | 1 063 | ok |
| `crc-torque-cadence` | 5 689 | 1 422 | ok |
| `crc-power-curve` (17 duraciones) | 5 748 | 1 437 | ok |
| `crc-analyze-cycling-activity` | 7 389 | 1 847 | ok |
| **`crc-compare-activities` (10 actividades)** | **16 999** | **4 250** | **se sale** |

📄 El truncado duro de 10 KB del
[issue #7906](https://github.com/openai/codex/issues/7906) **se cerró en marzo de
2026** y se sustituyó por límites por tokens, ajustables con `output_token_limit`
por herramienta. Aun así, comparar 10 actividades genera 4 250 tokens de una vez
y es la única respuesta fuera del rango del resto.

### Timeout por herramienta

📄 60 s por defecto. ❓ `crc-compare-activities` con 10 actividades puede hacer
hasta 20 llamadas a Strava sin caché; con red lenta, 60 s es ajustado. La caché
del Sprint 2 ayuda a partir de la segunda pasada, no en la primera.

## 5. Flujo de conexión

📄 **Los servidores MCP corren _fuera_ del sandbox de Codex.** Los stdio son
procesos locales con acceso directo a red y **pueden abrir navegadores**.

❓ Por tanto `connect-strava` —navegador más servidor en `localhost:8111`—
debería funcionar igual que en Claude Desktop. Dos incógnitas: que abrir el
navegador desde un proceso hijo de una TUI se comporte bien, y que el puerto
8111 esté libre.

---

## Recomendación

**Lo primero no es código: probarlo.** Instalar Codex, configurar el servidor y
ejecutar las herramientas una vez resuelve los puntos 2, 3 y 5 de golpe. Media
hora. Antes de ponerlo delante de treinta alumnos, no es opcional.

| | Qué | Esfuerzo | Estado |
|---|---|---|---|
| 1 | Sección de Codex en el README: TOML, ruta `~/.codex/`, variante Windows con `cmd /c` y `startup_timeout_sec` | 1 h | **pendiente de la prueba** |
| 2 | Ampliar `flexibleBoolean` | 15 min | ✅ **hecho el 19/09/2026** |
| 3 | `crc-compare-activities`: bajar el tope de 10 a 5, o aligerar la fila | 1-2 h | pendiente de la prueba |
| 4 | Coerción de números en los ~20 parámetros numéricos | 2-3 h | **solo si la prueba lo confirma** |

Lo que **no** se recomienda: tocar las 26 herramientas originales, ni añadir un
envoltorio propio de arranque. El problema de `npx` es de Codex y se resuelve en
el README, no en nuestro código.

**Para el aula:** con `npx -y` cada alumno descarga la versión más reciente en
el momento de instalar. Si se publica una versión intermedia durante el curso,
unos tendrán una y otros otra. Fijar la versión en las instrucciones
(`crc-strava-mcp@0.1.1`) evita treinta configuraciones distintas.

---

## Fuentes

Consultadas el 19 de septiembre de 2026.

- [Referencia de configuración de Codex](https://learn.chatgpt.com/docs/config-file/config-reference)
- [MCP en Codex — documentación oficial](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Issue #16229 — `npx` falla en Windows (abierto)](https://github.com/openai/codex/issues/16229)
- [Issue #3111 — `uvx`/`npx` sin herramientas en Windows (cerrado)](https://github.com/openai/codex/issues/3111)
- [Issue #7906 — truncado de 10 KB (cerrado)](https://github.com/openai/codex/issues/7906)
- [Issue #29396 — `invalid transport` con `startup_timeout_sec` (abierto)](https://github.com/openai/codex/issues/29396)
- [Guía de Chrome DevTools MCP en Codex para Windows](https://www.linkedin.com/pulse/ship-faster-set-up-chrome-devtools-mcp-openai-codex-cli-xinzhe-zhou-syqof)
- [Codex CLI v0.152.0 — límites de tokens por herramienta](https://codex.danielvaughan.com/2026/09/03/codex-cli-v0152-vim-search-mcp-per-tool-token-limits-planning-tool-opt-in/)
