# Strava MCP Server

**Talk to your Strava data using AI.**

Connect Claude to your Strava account and ask questions in plain English: "How far did I run this month?", "Analyze my last ride", or "Show me my fastest segments."

[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/r-huijts-strava-mcp-badge.png)](https://mseep.ai/app/r-huijts-strava-mcp)

<a href="https://glama.ai/mcp/servers/@r-huijts/strava-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@r-huijts/strava-mcp/badge" alt="Strava Server MCP server" />
</a>

---

## CRC fork

Este repositorio es un fork de [r-huijts/strava-mcp](https://github.com/r-huijts/strava-mcp) que
añade una **capa analítica determinista (CRC)** sobre los datos de Strava.

- **Qué añade.** Métricas de entrenamiento calculadas en TypeScript, no estimadas por el LLM:
  potencia normalizada (NP), intensity factor (IF), TSS, trabajo en kJ, curvas de potencia,
  desacople aeróbico, torque y VO2max estimado. Las fórmulas son puras, testeadas y declaran
  siempre su `method`.
- **Qué NO cambia.** Las herramientas originales del servidor mantienen su nombre, contrato y
  comportamiento. La capa CRC vive aislada en `src/crc/` y se registra aparte; el código original
  nunca importa de ella.
- **Privacidad.** Los datos solo se muestran al **propio usuario autenticado**. Una instancia =
  un atleta. Sin multitenencia, sin compartir entre usuarios y sin exportar a terceros. Al modelo
  solo se le devuelven métricas agregadas en JSON: las tools CRC nunca exponen streams crudos.

Documentación del fork:

- `docs/aceptacion-v0.1.md` — verificación de los criterios de aceptación, con lo que cumple y lo que no.
- `docs/decisiones.md` — todas las decisiones de diseño y por qué se tomaron.
- `CLAUDE.md` — reglas de desarrollo del fork.
- `docs/CRC_Strava_MCP_Especificacion_Tecnica_v0.1.docx` — especificación técnica.

## Uso de la capa CRC

Las herramientas CRC calculan métricas de entrenamiento de forma determinista en
TypeScript. El modelo interpreta los resultados, pero no los calcula: todo lo que
devuelven son números ya calculados, con su método declarado.

> Todas las respuestas CRC son JSON con la forma
> `{ tool, version, activity_id, available, inputs, method, metrics, quality, errors }`.
> El bloque `method` dice cómo se calculó cada cosa, y `quality`, hasta qué punto
> es fiable.

### 1. Configura tu perfil primero

Casi todo depende del FTP y del peso. Sin ellos las herramientas siguen
funcionando, pero omiten lo que no puede calcularse (IF, TSS, W/kg).

```
Guarda mi FTP: 250 W desde el 1 de enero de 2026
Guarda mi peso: 72 kg desde el 1 de enero de 2026
Guarda mi FC máxima: 190 ppm
```

Eso invoca `crc-set-performance-profile`. Cuatro detalles que importan:

- **El perfil es histórico.** Cada valor tiene su ventana `effective_from` /
  `effective_to`. Una actividad de marzo usa el FTP que tenías en marzo, no el de
  hoy. Si no hay valor vigente para esa fecha se devuelve `missing_parameter`:
  nunca se usa el actual por defecto.
- **Si omites la fecha, se asume hoy.**
- **El histórico no se pisa.** Cambiar un valor ya guardado exige
  `overwrite: true`; cerrar la vigencia del anterior al añadir uno nuevo exige
  `close_previous: true`.
- **AeT y MAP solo existen si los introduces tú**, con su fuente. Nunca se
  deducen de Strava.

El perfil vive en `~/.config/strava-mcp/crc-performance-profile.json`, con
escritura atómica.

### 2. Si no conoces tu FTP

```
No sé cuál es mi FTP, ¿puedes estimarlo?
```

`crc-estimate-ftp` busca tu mejor esfuerzo de 20 min de los últimos 90 días y
propone ese valor × 0,95.

**No guarda nada.** Devuelve la propuesta, de qué actividad y fecha sale, y un
bloque `to_persist` con la llamada exacta para guardarla si te convence. Guardar
es siempre una segunda decisión tuya, y el valor queda marcado con
`source: "estimated_20min"` para que todo lo que se derive de él lo refleje.

### 3. Analiza una actividad

```
Analiza mi última salida en bici
Dame las métricas de potencia de la actividad 1234567890
```

`crc-analyze-cycling-activity` compone todo aquello para lo que haya datos:

| Módulo | Qué devuelve | Necesita |
|---|---|---|
| `activity_details` | Nombre, distancia, desnivel, tipo | — |
| `power_metrics` | Media, NP, VI, IF, TSS, kJ, W/kg | Potencia (IF y TSS, además FTP) |
| `heartrate_summary` | Media, máx y mín de FC | FC |
| `cadence_summary` | Media, máx y mín de cadencia | Cadencia |
| `power_zones` | Tiempo en las 7 zonas de Coggan | Potencia + FTP |
| `heartrate_zones` | Tiempo en zonas de FC | FC + FC máxima |
| `decoupling` | Desacople aeróbico | Potencia + FC |

**Cada módulo puede fallar sin invalidar el resto.** Si sales sin pulsómetro
sigues teniendo toda la potencia; si no tienes FTP configurado sigues teniendo
NP, VI, media y kJ, y solo faltan IF y TSS.

### 4. Herramientas sueltas

```
¿Cuál es mi mejor potencia de 5 minutos en esa actividad?   → crc-power-curve
¿Cuánto tiempo pasé en zona 4?                              → crc-time-in-zones
¿Cuánto me desacoplé en la salida larga del domingo?        → crc-aerobic-decoupling
¿A qué cadencia genero más torque?                          → crc-torque-cadence
¿Cuánto trabajo hice por encima del umbral?                 → crc-work-above-ftp
Estima mi VO2max                                            → crc-estimate-vo2max
Compara mis tres últimas salidas largas                     → crc-compare-activities
```

`crc-compare-activities` acepta de 2 a 10 actividades y usa, en cada una, los
parámetros vigentes **en su fecha**. Distingue un cero legítimo
(`status: "ok"`, `value: 0`) de un dato que falta (`status: "missing_data"`).

### Lo que te dirá sin que lo preguntes

- **Si la potencia es estimada** en lugar de medida. Con potencia estimada no se
  calculan curva de potencia ni VO2max: no serían fiables.
- **Si hay huecos** en la grabación. Las ventanas móviles no los cruzan.
- **Si el FTP usado es una estimación**, porque IF y TSS heredan esa
  incertidumbre.
- **Si un esfuerzo pudo no ser máximo**, cosa que cambia cómo se lee el VO2max.

## Qué NO hace la v0.1

Deliberadamente fuera de alcance hasta validar la exactitud de esta capa:

- **Detección automática de intervalos** y detección de subidas.
- **Durabilidad** (cómo cae tu potencia tras N kJ acumulados).
- **Análisis longitudinal** y carga de entrenamiento: nada de CTL, ATL ni TSB.
- **Modelos CP / W′**.
- **Generación de informes**.

Tampoco infiere AeT ni MAP: o los configuras tú con su fuente, o no existen.

Dos límites más que conviene conocer:

- Las fórmulas están validadas contra fixtures sintéticas derivadas
  analíticamente, **no contra Intervals.icu ni WKO5**. Implementan el método que
  declaran; no se ha comprobado que coincidan con los de otras plataformas.
- El VO2max usa un modelo publicado sobre una muestra de 46 ciclistas varones.
  Extrapolarlo a otros perfiles es una limitación conocida, y la respuesta lo
  advierte en `quality.model_limitations`.

## Instalación como servidor MCP

Este fork **no está publicado en npm**: se instala desde el código fuente.

```bash
git clone <url-de-tu-fork> crc-strava-mcp
cd crc-strava-mcp
npm install
npm run build        # imprescindible: los clientes cargan dist/, no src/
```

> **Recompila tras cada `git pull`.** Los clientes MCP ejecutan `dist/server.js`,
> así que un cambio en `src/` que no se compile sencillamente no existe para
> ellos.

### Claude Desktop

Edita el archivo de configuración:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "crc-strava": {
      "command": "node",
      "args": ["/ruta/absoluta/a/crc-strava-mcp/dist/server.js"],
      "env": {
        "STRAVA_CLIENT_ID": "tu_client_id",
        "STRAVA_CLIENT_SECRET": "tu_client_secret"
      }
    }
  }
}
```

La ruta debe ser **absoluta**. En Windows, usa barras normales
(`C:/Users/tu-usuario/...`) o escapa las invertidas.

Después reinicia Claude Desktop del todo: cerrar la ventana no basta, hay que
salir desde la bandeja del sistema o el Dock.

### Codex CLI

Añade el servidor a `~/.codex/config.toml`:

```toml
[mcp_servers.crc-strava]
command = "node"
args = ["/ruta/absoluta/a/crc-strava-mcp/dist/server.js"]

[mcp_servers.crc-strava.env]
STRAVA_CLIENT_ID = "tu_client_id"
STRAVA_CLIENT_SECRET = "tu_client_secret"
```

### Claude Code

```bash
claude mcp add crc-strava -- node /ruta/absoluta/a/crc-strava-mcp/dist/server.js
```

### Credenciales y primera conexión

Las credenciales también pueden vivir en `~/.config/strava-mcp/config.json`, que
es donde las deja el asistente de autenticación:

```bash
npm run setup-auth
```

Con eso configurado, pide en el chat *"conecta mi cuenta de Strava"*
(`connect-strava`) y sigue el enlace. Comprueba el estado con *"¿estoy conectado
a Strava?"* (`check-strava-connection`).

**Una instancia = un atleta.** El servidor está pensado para tu propia cuenta: no
hay multiusuario, y `crc-compare-activities` rechaza cualquier actividad que no
sea tuya.

### Comprobar que funciona

```bash
npm run build && npm test           # 459 tests
node scripts/snapshot-tools.mjs     # debe listar 38 herramientas
```


## What Can You Do With This?

Once connected, just talk to Claude like you're talking to a friend who has access to all your Strava data:

### 🏃 Track Your Progress
> "How many kilometers did I run this month?"
> 
> "Compare my running stats from January to December"
> 
> "What's my longest ride ever?"

### 📊 Analyze Your Workouts
> "Break down my last cycling workout - show me power, heart rate, and cadence"
> 
> "How did my heart rate zones look during yesterday's run?"
> 
> "What was my average pace for each lap in my interval training?"

### 🗺️ Explore Routes & Segments
> "What are the most popular cycling segments near Central Park?"
> 
> "Show me my starred segments"
> 
> "Export my Sunday morning route as a GPX file"

### 🏆 Get Coaching Insights
> "Analyze my training load this week"
> 
> "How does my current fitness compare to last month?"
> 
> "Give me a summary of my cycling performance this year"

---

## Quick Start (3 Steps)

### Step 1: Add to Claude Desktop

Open your Claude Desktop configuration file:
- **Mac**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

Add this to the file:

```json
{
  "mcpServers": {
    "strava": {
      "command": "npx",
      "args": ["-y", "@r-huijts/strava-mcp-server"]
    }
  }
}
```

### Step 1 (alternative): Add to Claude Code

You can add this MCP server to claude code with the following command:

```
claude mcp add --transport stdio strava -- npx @r-huijts/strava-mcp-server
```

You can confirm successful instalation as follows:

```
% claude mcp list
Checking MCP server health...

strava: npx @r-huijts/strava-mcp-server - ✓ Connected
```

### Step 2: Restart Claude Desktop

Close and reopen Claude Desktop to load the new configuration.

### Step 3: Connect Your Strava

Just say to Claude:

> **"Connect my Strava account"**

A browser window will open. Enter your Strava API credentials, authorize the app, and you're done!

**That's it!** Start asking about your activities.

---

## Connecting Your Strava Account

### First Time Setup

When you say "Connect my Strava account", here's what happens:

1. **A browser window opens** showing a setup page
2. **Enter your Strava API credentials** (Client ID and Client Secret)
3. **Click "Continue to Strava"** - you'll be redirected to Strava
4. **Authorize the app** on Strava's website
5. **See the success message** - you can close the browser
6. **Done!** Claude confirms you're connected

Your credentials are saved locally at `~/.config/strava-mcp/config.json` and persist across sessions.

### Getting Your Strava API Credentials

You need to create a free Strava API application (one-time setup):

1. Go to [strava.com/settings/api](https://www.strava.com/settings/api)
2. Click "Create an App" (or view your existing app)
3. Fill in the form:
   - **Application Name**: Anything you want (e.g., "My Claude Assistant")
   - **Category**: Choose any
   - **Website**: Can be anything (e.g., `http://localhost`)
   - **Authorization Callback Domain**: Must be `localhost`
4. Copy your **Client ID** and **Client Secret**

That's it! You only need to do this once.

### Managing Your Connection

- **Check status**: "Am I connected to Strava?"
- **Reconnect**: "Connect my Strava account" (use `force: true` to reconnect)
- **Disconnect**: "Disconnect my Strava account"

---

## Installation Options

### Option A: Just Use It (Recommended)

No installation needed! The `npx` command in the Quick Start automatically downloads and runs the latest version.

### Option B: Install Globally

If you prefer to install it once:

```bash
npm install -g @r-huijts/strava-mcp-server
```

Then update your Claude config to use:

```json
{
  "mcpServers": {
    "strava": {
      "command": "strava-mcp-server"
    }
  }
}
```

**Note:** Even though the package name is `@r-huijts/strava-mcp-server`, the executable name remains `strava-mcp-server` for backward compatibility.

### Option C: Build from Source

For developers who want to modify the code:

   ```bash
   git clone https://github.com/r-huijts/strava-mcp.git
   cd strava-mcp
   npm install
   npm run build
   ```

Then point Claude to your local build:

```json
{
  "mcpServers": {
    "strava": {
      "command": "node",
      "args": ["/path/to/strava-mcp/dist/server.js"]
    }
  }
}
```

---

## Example Conversations

### Morning Check-in

> **You**: What did I do for exercise this week?
>
> **Claude**: Looking at your Strava activities this week, you completed:
> - Monday: 5.2km run (28:15)
> - Wednesday: 45km bike ride (1:32:00)
> - Saturday: 10km run (52:30)
> 
> Total: 60.2km across 3 activities. Nice consistency!

### Workout Analysis

> **You**: Analyze my last cycling workout in detail
>
> **Claude**: Here's a breakdown of your ride "Evening Loop" from yesterday:
> 
> **Overview**
> - Distance: 42.3 km
> - Time: 1:28:45
> - Avg Speed: 28.6 km/h
> 
> **Power Analysis**
> - Average Power: 185W
> - Normalized Power: 198W
> - Max Power: 520W
> 
> **Heart Rate**
> - Average: 142 bpm
> - Max: 175 bpm
> - Time in Zone 4+: 23 minutes
> 
> Your power-to-heart-rate ratio suggests good aerobic efficiency...

### Finding New Routes

> **You**: Find me some challenging cycling climbs near Boulder, Colorado
>
> **Claude**: Here are popular climbing segments near Boulder:
> 
> 1. **Flagstaff Road** - 5.2km, 6.8% avg grade
> 2. **Sunshine Canyon** - 3.8km, 7.2% avg grade  
> 3. **Left Hand Canyon** - 8.1km, 4.5% avg grade
> 
> Want me to star any of these so you can find them easily later?

---

## Available Tools

### Account & Profile

| What you can ask | What it does |
|------------------|--------------|
| "Connect my Strava account" | Links your Strava to Claude |
| "Check my Strava connection" | Shows connection status |
| "Disconnect my Strava account" | Unlinks Strava and clears stored tokens |
| "Get my Strava profile" | Shows your profile info |
| "What shoes do I have?" | Lists your shoes and usage distance |
| "What are my training zones?" | Shows HR and power zones |

### Activities

| What you can ask | What it does |
|------------------|--------------|
| "Show my recent activities" | Lists your latest workouts |
| "Get all my runs from January" | Fetches activities with filters |
| "Analyze activity 12345" | Detailed info about one activity |
| "Show the laps from my last run" | Lap-by-lap breakdown |
| "Get heart rate data from my ride" | Time-series workout data (optimized compact format) |
| "Show photos from my hike" | Activity photos |

### Stats & Progress

| What you can ask | What it does |
|------------------|--------------|
| "What are my running stats?" | YTD and all-time totals |
| "How far have I cycled this year?" | Activity totals by type |
| "What's my longest ride?" | Personal records |

### Segments

| What you can ask | What it does |
|------------------|--------------|
| "Show my starred segments" | Your favorite segments |
| "Find segments near [location]" | Discover popular segments |
| "Get details on segment 12345" | Segment info and leaderboard |
| "Star this segment" | Save to favorites |
| "Show my efforts on [segment]" | Your attempts on a segment |

### Routes

| What you can ask | What it does |
|------------------|--------------|
| "List my saved routes" | Your created routes |
| "Get details for my [route name]" | Route info |
| "Export [route] as GPX" | Download for GPS devices |
| "Export [route] as TCX" | Download for GPS devices |

### Clubs

| What you can ask | What it does |
|------------------|--------------|
| "What clubs am I in?" | Lists your Strava clubs |

### Workouts

| What you can ask | What it does |
|------------------|--------------|
| "Turn this workout into a Zwift file" | Formats a workout plan into a structured file (currently Zwift `.zwo`) |

### Server

| What you can ask | What it does |
|------------------|--------------|
| "What version is the Strava server?" | Shows the MCP server version and metadata |

---

## Troubleshooting

### "Connect my Strava account" doesn't open a browser

- Make sure Claude Desktop is running the MCP server (check for errors in Claude)
- Try restarting Claude Desktop
- Check that port 8111 isn't blocked by a firewall

### "Authentication failed" or "Invalid token"

- Your token may have expired - say "Connect my Strava account" to reconnect
- Make sure your Strava API application is still active at [strava.com/settings/api](https://www.strava.com/settings/api)

### "Missing credentials" error

- You need to complete the OAuth flow - say "Connect my Strava account"
- If you're using environment variables, make sure all 4 are set (see Developer section)

### Claude doesn't see the Strava tools

- Make sure your `claude_desktop_config.json` is valid JSON (no trailing commas!)
- Restart Claude Desktop after making config changes
- Check Claude's developer console for error messages

### JSONRPC.ProtocolTransportError after package name change

If you're getting a JSONRPC error after updating to `@r-huijts/strava-mcp-server`:

1. **Clear npx cache**: Run `rm -rf ~/.npm/_npx` in terminal
2. **Verify config** uses `@r-huijts/strava-mcp-server` (not the old `strava-mcp-server`)
3. **Restart Claude Desktop** completely (quit and reopen)
4. **Test manually**: Run `npx -y @r-huijts/strava-mcp-server` - you should see "Starting Strava MCP Server v1.2.1..."

---

## For Developers

<details>
<summary>Click to expand technical details</summary>

### Environment Variables

Instead of using the browser-based auth, you can set environment variables:

| Variable | Description |
|----------|-------------|
| `STRAVA_CLIENT_ID` | Your Strava Application Client ID |
| `STRAVA_CLIENT_SECRET` | Your Strava Application Client Secret |
| `STRAVA_ACCESS_TOKEN` | OAuth access token |
| `STRAVA_REFRESH_TOKEN` | OAuth refresh token |
| `ROUTE_EXPORT_PATH` | Directory for GPX/TCX exports |

### Token Refresh

The server automatically refreshes expired tokens. New tokens are saved to both `process.env` and `~/.config/strava-mcp/config.json`.

### Config Priority

1. Environment variables (highest)
2. `~/.config/strava-mcp/config.json`
3. Local `.env` file

### Building & Testing

```bash
npm install
npm run build
npm test
```

### Activity Streams Optimization

The `get-activity-streams` tool uses a compact format by default, reducing payload size by ~70-80% while preserving all data:

- **Compact format** (default): Raw arrays with metadata, ~70-80% smaller, ideal for LLM processing
- **Verbose format**: Human-readable objects with formatted values (backward compatible)
- **Smart chunking**: Large activities automatically split into ~50KB chunks
- **Optional downsampling**: Can reduce very large datasets while preserving key features

The compact format includes comprehensive metadata (units, descriptions, statistics) so LLMs can understand the raw numeric data.

### API Reference

The server implements the Model Context Protocol (MCP) and exposes 25 tools for Strava API v3. See the source code in `src/tools/` for implementation details.

### Contributing

Contributions welcome! Please submit a Pull Request.

</details>

---

## License

MIT License - see LICENSE file for details.

---

**Questions?** Open an issue on [GitHub](https://github.com/r-huijts/strava-mcp/issues).
