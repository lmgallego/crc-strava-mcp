# Changelog

Todos los cambios reseñables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y el
versionado es [SemVer](https://semver.org/lang/es/).

Este proyecto es un fork de [r-huijts/strava-mcp](https://github.com/r-huijts/strava-mcp)
que añade una capa analítica determinista (CRC). La numeración arranca de nuevo
en 0.1.0 porque el alcance y el contrato son distintos.

## [0.1.1] - 2026-09-18

Retoques de la interfaz de conexión, que es la primera pantalla que ve un
usuario nuevo. Sin cambios funcionales: ninguna herramienta cambia.

### Cambiado

- Toda la interfaz de conexión pasa a estar en español. Estaban sin traducir
  las páginas de éxito, error, redirección y credenciales ya guardadas.
- Los emojis de los iconos se sustituyen por SVG de trazo dibujados a mano, en
  el naranja de la propia paleta: un icono de enlace en el alta y un check
  dentro de un círculo al terminar. Van en línea en el HTML, sin librerías ni
  fuentes externas, para que la página funcione sin conexión.
- La página de alta explica por qué hace falta una aplicación propia de Strava:
  la plataforma exige credenciales por usuario y así los datos no pasan por
  ningún servidor intermedio.

## [0.1.0] - 2026-09-18

Primera versión publicable. Añade 12 herramientas CRC sobre las 26 originales
(38 en total) y una capa de cálculo determinista, testeada y trazable.

Los criterios de aceptación y lo que **no** cumple están en
[`docs/aceptacion-v0.1.md`](docs/aceptacion-v0.1.md); las decisiones de diseño,
en [`docs/decisiones.md`](docs/decisiones.md).

### Añadido

**Capa analítica CRC** — funciones puras, sin dependencias de Strava ni de MCP:

- Métricas de potencia: media, NP, VI, IF, TSS, trabajo en kJ y W/kg.
- Curva de potencia: mejor media sostenida por duración, de 1 s a 90 min.
- Desacople aeróbico con filtros (calentamiento, solo en movimiento, rango de
  potencia) y mitades por tiempo válido.
- Tiempo en zonas de potencia, FC o personalizadas, con fronteras semiabiertas.
- Torque y potencia por rangos de cadencia.
- Trabajo y esfuerzos por encima del FTP, con tolerancia a microcortes.
- VO2max estimado desde el mejor 5 min (Sitko et al., 2022, PMID 34225254).
- Estimación de FTP desde el mejor 20 min del historial.

**Herramientas MCP (12):** `crc-get-performance-profile`,
`crc-set-performance-profile`, `crc-analyze-cycling-activity`,
`crc-calculate-power-metrics`, `crc-power-curve`, `crc-aerobic-decoupling`,
`crc-time-in-zones`, `crc-torque-cadence`, `crc-work-above-ftp`,
`crc-compare-activities`, `crc-estimate-vo2max` y `crc-estimate-ftp`.

**Perfil de rendimiento con histórico** en
`~/.config/strava-mcp/crc-performance-profile.json`, con escritura atómica. FTP
y peso se resuelven por la fecha de la actividad: si no hay valor vigente se
devuelve `missing_parameter`, nunca el valor actual.

**Alineación de streams:** rejilla de 1 s con índice único compartido por todas
las señales, para que `watts[i]` y `heartrate[i]` sean siempre el mismo instante.
No se reutiliza el `downsampleStream` original, que las desalinea.

**Caché de streams** en disco, con topes de tamaño e invalidación por versión.

**Contrato de respuesta común** `{ tool, version, activity_id, available,
inputs, method, metrics, quality, errors }`, con saneado que convierte
`NaN`/`Infinity` en `null` y avisa. Un módulo no disponible devuelve
`available: false`, nunca `isError`.

**Distribución por npm:** instalable con `npx crc-strava-mcp`, sin clonar el
repositorio.

**Alta guiada:** la página de conexión explica los tres pasos, incluye enlace a
Strava y ofrece el *Authorization Callback Domain* con botón de copiar, avisando
de que es `localhost` a secas.

**CI** con Node 20: `npm ci`, `npm run build` y `npm test`.

### Cambiado

- `@modelcontextprotocol/sdk` 1.8.0 → 1.30.0 (y Zod a ^3.25, deduplicado).
- Los IDs de Strava se aceptan como `number | string` y se transportan como
  `string`, para no perder precisión con los enteros de 64 bits. Las 7
  herramientas que exigían `number` amplían el tipo sin romper compatibilidad.
- Los mensajes de error de autenticación dicen qué hacer en lugar de qué ha
  fallado, y están centralizados.
- Licencia declarada como MIT en `package.json`, coherente con el `LICENSE` que
  ya venía del proyecto original.

### Corregido

- `get-all-activities` filtraba mal por `activityTypes`: se preservan `type` y
  `sport_type` de la respuesta de Strava.
- `get-activity-photos` convertía el ID con `parseInt`, corrompiendo los IDs
  largos que su propio esquema aceptaba.
- `axios` 1.8.4 → 1.20.0: resuelve las tres vulnerabilidades que afectaban a
  producción (`form-data` crítica, `axios` alta, `follow-redirects` moderada).
  `npm audit --omit=dev` queda a cero.

### Seguridad y privacidad

- Una instancia = un atleta. `crc-compare-activities` rechaza cualquier
  actividad que no sea del usuario autenticado.
- Las credenciales viven en `~/.config/strava-mcp/config.json`, en el equipo del
  usuario. Cada usuario usa su propia aplicación de Strava.
- Al modelo solo se le devuelven métricas agregadas: las herramientas CRC nunca
  devuelven streams crudos.

### Fuera de alcance de esta versión

Sin detección de intervalos ni de subidas, sin durabilidad, sin análisis
longitudinal, sin CTL/ATL/TSB y sin modelos CP/W′. La detección de subidas está
desarrollada y a la espera de validación con datos reales para la 0.2.0.

### Sin verificar

- Las fórmulas están validadas contra fixtures sintéticas derivadas
  analíticamente, no contra Intervals.icu ni WKO5.
- No hay pruebas de integración contra la API real de Strava.
- Las herramientas no usan todavía `structuredContent` con `outputSchema`.

## Anterior al fork

Cambios heredados del proyecto original, previos a la capa CRC:

### Añadido
- Vitest y tests de regresión para el filtrado de `get-all-activities`.
- Script de humo por stdio para validar las herramientas contra `dist/server.js`.
- Campo `perceived_exertion` en el modelo detallado de actividad.
