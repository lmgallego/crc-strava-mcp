# Estudio de viabilidad e implementación · CRC Strava MCP v0.1

*Revisión de la especificación técnica v0.1 contra el estado real del repositorio r-huijts/strava-mcp · 15 septiembre 2026*

---

## 1. Resumen ejecutivo

**Técnicamente es viable y relativamente acotado.** El repositorio base es pequeño (~5.100 líneas de TypeScript), compila sin errores y tiene una batería de tests con Vitest sobre la que construir. La capa CRC que describe la especificación es, en su mayor parte, matemática pura sobre arrays, lo que la hace muy testeable y poco dependiente de Strava.

**Estimación:** entre 25 y 35 días-persona de desarrollo para una persona con experiencia en TypeScript, incluyendo tests y documentación (detalle en la sección 7).

**Hay tres hallazgos que cambian el plan:**

1. **El riesgo de desalineación de streams es real y está confirmado en el código.** La función `downsampleStream` inserta picos y valles de forma independiente en cada señal, así que `watts[i]` y `heartrate[i]` pueden acabar sin corresponder a la misma muestra. La especificación acierta al exigir un módulo de alineación propio.
2. **El cliente Strava no expone una función de streams.** La herramienta original llama directamente a `stravaApi.get(...)` y además fuerza `resolution: 'low'` por defecto. La capa CRC necesita su propia función de obtención de streams en resolución nativa.
3. **El mayor riesgo no es técnico, es contractual.** El acuerdo de API de Strava (noviembre 2024, endurecido en junio 2026) restringe mostrar datos a terceros (p. ej. un entrenador) y el uso de datos de la API en sistemas de IA. Un MCP cuyo propósito es que Claude/Codex interprete datos de Strava para un entrenador choca frontalmente con eso. **Recomendación: diseñar la capa analítica independiente de la fuente** para poder usarla también sobre Intervals.icu o archivos FIT.

---

## 2. Estado real del repositorio base (verificado)

Se ha clonado la rama principal y ejecutado build y tests.

| Aspecto | Estado encontrado | Impacto en CRC |
|---|---|---|
| Versión | `@r-huijts/strava-mcp-server` 1.2.1, último commit 13/06/2026 | Proyecto activo pero con cadencia baja; el fork tendrá que absorber cambios manualmente. |
| Herramientas | 25 archivos en `src/tools/`, coincide con el README | Coherente con la especificación. |
| Registro | Llamadas `server.tool(...)` en línea dentro de `server.ts` | `registerCrcTools(server)` encaja sin fricción. |
| SDK MCP | `@modelcontextprotocol/sdk ^1.8.0`, API `server.tool` | Para devolver JSON estructurado conviene actualizar el SDK y usar `registerTool` con `outputSchema` / `structuredContent`. |
| Build | `npm run build` (tsc) **OK** | Sprint 0 parte de base sana. |
| Tests | **68/69 pasan**; falla `getAllActivities.toolFilter.test.ts` (filtro por tipo de actividad) | El criterio "npm test sin errores" exige arreglar o aislar este test en Sprint 0. |
| Streams | La tool usa `stravaApi` directamente; `resolution` por defecto `'low'` | CRC debe pedir resolución nativa por su cuenta. |
| Downsampling | `downsampleStream` se aplica por señal con inserción de picos independiente | **Desalineación confirmada.** No reutilizar para CRC. |
| IDs | Schemas `z.number().or(z.string())`; 8 funciones del cliente tipan IDs como `number` | Riesgo de pérdida de precisión con IDs de 64 bits; normalizar a string en la capa CRC y en la URL. |
| Booleanos | 4 usos de `z.boolean()` estricto | Algunos clientes MCP envían `"true"`; aplicar preprocesado. |
| Licencia | `LICENSE` es MIT; `package.json` declara ISC | Inconsistencia menor: mantener el aviso MIT original en el fork y aclarar la licencia en el `package.json`. |
| Credenciales | `~/.config/strava-mcp/config.json` | La ruta propuesta para el perfil CRC es coherente con esta convención. |

---

## 3. Evaluación de la especificación, punto por punto

### 3.1 Lo que está bien planteado

La separación entre datos, cálculo determinista e interpretación es correcta y es la principal fortaleza del documento. También lo son la regla de dependencia unidireccional (las tools originales no dependen de CRC), la resolución histórica de FTP/peso por fecha sin caer en el valor actual, el bloque `quality` obligatorio, los IDs como string y la prohibición de inferir AeT/MAP desde Strava. La ecuación de VO2max está bien etiquetada como estimación y con la advertencia correcta sobre que el mejor 5 min observado no equivale a un test máximo.

### 3.2 Huecos que hay que cerrar antes de programar

**Obtención de streams.** Añadir `getActivityStreamsRaw(accessToken, id: string, types)` en `stravaClient.ts` (o en `src/crc/streams/`) que pida `key_by_type=true`, `series_type=time` y **sin** parámetro `resolution` para obtener los datos nativos. Hay que verificar en la documentación actual de Strava el límite de puntos por resolución antes de fijar el comportamiento.

**Política de remuestreo y pausas.** La especificación dice "no asumir 1 Hz" pero no define qué hacer. Propuesta: remuestrear a una rejilla de 1 s sobre `time`; los huecos cortos (≤ `gap_fill_s`, p. ej. 3 s) se interpolan o se rellenan con el último valor; los huecos largos se marcan como no válidos. Para NP, decidir y documentar si las paradas cuentan como 0 W (como hacen la mayoría de plataformas cuando el dispositivo registra) o se excluyen. Esta decisión cambia NP, TSS y kJ, así que debe quedar en el campo `method` de cada salida.

**Duración para TSS.** La fórmula usa `duration_s`, pero no se indica si es tiempo en movimiento, tiempo transcurrido o segundos válidos de potencia. Recomendación: segundos válidos de la rejilla remuestreada, declarado en `inputs`.

**Ventanas que no crucen huecos.** En la power curve y en el mejor 5 min, una media móvil no debe atravesar un hueco largo; si lo hace, inflará o deflactará el resultado. Añadir tests específicos.

**Potencia estimada vs medida.** Strava distingue `device_watts`. Si la potencia es estimada, el stream de vatios puede no existir o no ser fiable. El bloque `quality` debe incluir `power_source: measured | estimated | none`, y VO2max/power curve deberían negarse con potencia estimada.

**Desacople aeróbico.** Dividir las mitades por tiempo válido, no por índice, y considerar un desfase de FC (la FC va retrasada respecto a la potencia). Aunque v0.1 no lo aplique, conviene dejar el parámetro `hr_lag_s` en el contrato.

**Perfil de rendimiento.** Validar que las ventanas `effective_from/effective_to` no se solapen para una misma métrica, y definir el comportamiento de la escritura concurrente del JSON (escritura atómica con archivo temporal y renombrado).

**Contrato de error.** La tabla de códigos es buena, pero hay que decidir si un módulo no disponible devuelve `isError: true` o JSON con `available: false`. Para el orquestador, lo segundo es preferible; `isError` solo para fallos de entrada o de red.

**Límites de API.** `crc-compare-activities` y el modo `rolling_period` de VO2max (90 días) pueden disparar muchas llamadas de streams. Strava aplica límites por ventanas de 15 minutos y diarios; hace falta una caché local de streams y un tope de actividades por llamada.

**Validación de la referencia de VO2max.** Confirmar el PMID y el artículo (Sitko et al.) directamente en PubMed antes de fijarlo en `model_reference`.

### 3.3 Mejoras de arquitectura recomendadas

**Núcleo analítico independiente de la fuente.** Convertir `src/crc/analytics/` y `src/crc/streams/` en un paquete sin dependencias de Strava (por ejemplo `@crc/analytics-core`) que reciba `AlignedStreams` y devuelva resultados. Así se puede reutilizar en ClawIntervals con streams de Intervals.icu o con archivos FIT, lo que además mitiga el riesgo contractual de la sección 4.

**Adaptador de fuente.** `src/crc/sources/strava.ts` convierte la respuesta de Strava en `AlignedStreams`. Añadir en el futuro `intervals.ts` o `fit.ts` no toca las fórmulas.

**Golden tests cruzados.** Usar un par de actividades reales exportadas como FIT y comparar NP, TSS, kJ y power curve con los valores de Intervals.icu o WKO5 con tolerancias declaradas (p. ej. ±1 W en NP, ±1 % en TSS).

---

## 4. Riesgo contractual con Strava (crítico)

Este es el punto que puede invalidar el caso de uso aunque el código sea perfecto.

En noviembre de 2024 Strava modificó su acuerdo de API con tres cambios principales: los datos de actividad solo pueden mostrarse al propio usuario; se prohíbe usar datos obtenidos vía API en modelos de IA o aplicaciones similares; y se añaden protecciones sobre su aspecto y funcionalidad. En junio de 2026 añadió requisitos de suscripción para el nivel Standard y endureció el control sobre cómo se enrutan los datos, incluyendo sistemas de IA que hacen llamadas autorizadas a través de intermediarios.

Consecuencias para CRC Strava MCP:

| Escenario | Riesgo |
|---|---|
| Un ciclista usa el MCP en local con su propia app de Strava y su Claude, para sus propios datos | Moderado. Es el uso del repo original, pero sigue implicando enviar datos de la API a un LLM. |
| Un entrenador analiza datos de sus atletas con el MCP | Alto. Choca con la restricción de mostrar datos solo al propietario. |
| Producto comercial CRC distribuido a clientes | Muy alto sin aprobación escrita de Strava. |

**Decisión tomada (15/09/2026): los datos solo se mostrarán al propio usuario.** Con esto queda resuelta la restricción de visualización: el modelo de uso pasa a ser "cada ciclista conecta su propia cuenta y ve solo sus análisis", sin panel de entrenador ni datos compartidos. Sigue abierto el punto de enviar datos de la API a un LLM (Claude/Codex). Para reducirlo: el cálculo se hace en local y de forma determinista, al LLM solo llegan métricas agregadas (no streams crudos), no se entrena ni se ajusta ningún modelo con los datos, no se almacenan fuera del equipo del usuario, y cada usuario usa su propia app de API de Strava. Aun así, conviene confirmarlo por escrito con Strava si el producto se distribuye.

Implicaciones de diseño de esta decisión: perfil y caché por usuario (una instancia = un atleta), sin multitenencia, sin exportar ni compartir informes a terceros desde el MCP, y `crc-compare-activities` limitado a actividades del atleta autenticado (comprobar `athlete.id` de cada actividad).

**Recomendaciones:** revisar el texto vigente del acuerdo de API y la situación de la app en el portal de desarrolladores; si el objetivo es comercial o de entrenador, pedir aprobación escrita a Strava antes de invertir; y en paralelo, mantener el núcleo analítico agnóstico para que Intervals.icu (que ya es la base de tu operación con ~22 atletas) o archivos FIT sean la fuente principal. Este estudio no es asesoramiento legal; si el proyecto va a comercializarse, conviene una revisión profesional del acuerdo.

---

## 5. Stack y dependencias

Node ≥ 18 (recomendado 20 LTS), TypeScript 5.x, Zod 3 para schemas, Vitest para tests, Axios (ya presente). No hace falta ninguna librería numérica: medias móviles, integración trapezoidal y bins se implementan en pocas decenas de líneas y así se controla exactamente el método. Actualizar `@modelcontextprotocol/sdk` a una versión reciente para usar `registerTool` con `outputSchema`, comprobando que las 25 tools originales siguen registrándose igual.

---

## 6. Diseño de módulos clave

**`alignedStreams.ts`.** Entrada: diccionario de streams de Strava (`key_by_type`). Salida: `AlignedStreams` sobre rejilla de 1 s más un vector `valid[]`. Garantiza longitudes idénticas y aplica un único vector de índices si se reduce resolución.

**`streamQuality.ts`.** Calcula disponibilidad por señal, cobertura, número y duración de huecos, segundos válidos, fuente de potencia y lista de advertencias. Todas las tools lo reutilizan.

**`profileResolver.ts`.** `resolve(metric, date) → {value, unit, source, effective_from} | missing_parameter`. Nunca devuelve el valor actual si la fecha cae fuera de toda ventana.

**`crcToolResponse.ts`.** Envoltorio común `{tool, version, activity_id, inputs, method, metrics, quality, errors}` con saneado final que convierte `NaN`/`Infinity` en `null` más un warning.

---

## 7. Plan revisado y estimación

| Sprint | Objetivo | Trabajo concreto | Días |
|---|---|---|---|
| 0 | Fork y baseline | Fork, renombrar paquete, arreglar o aislar el test que falla, CI con build+test | 1–2 |
| 1 | Robustez MCP | IDs como string extremo a extremo, preprocesado de booleanos, actualización del SDK, `registerCrcTools` | 3–4 |
| 2 | Streams y perfil | Cliente de streams nativo, `AlignedStreams`, `streamQuality`, perfil con histórico y escritura atómica, caché de streams | 5–6 |
| 3 | Potencia | power metrics y power curve con golden tests contra Intervals.icu/WKO5 | 4–5 |
| 4 | Fisiología de campo | decoupling, zonas, torque-cadencia, work above FTP | 5–6 |
| 5 | VO2max | modos activity y rolling_period, control de potencia estimada, límites de API | 2–3 |
| 6 | Orquestación | analyze activity y compare activities, disponibilidad parcial por módulo | 3–4 |
| 7 | QA y documentación | fixtures con frecuencias irregulares, regresión, README y ejemplos | 2–3 |
| **Total** | | | **25–33** |

Se recomienda añadir un **Sprint −1 de medio día**: revisión del acuerdo de API de Strava y decisión sobre el caso de uso (personal, entrenador o comercial). Su resultado condiciona si merece la pena invertir en la capa Strava o priorizar el adaptador de Intervals.icu.

---

## 8. Decisiones pendientes

| # | Decisión | Propuesta |
|---|---|---|
| 1 | Caso de uso y cumplimiento con Strava | **Decidido:** solo visible para el propio usuario. Pendiente: confirmar el uso con LLM con Strava |
| 2 | Tratamiento de pausas en NP/kJ | Rejilla 1 s, huecos cortos rellenos, largos excluidos; declarado en `method` |
| 3 | Duración usada en TSS | Segundos válidos |
| 4 | Potencia estimada | Rechazar en power curve y VO2max |
| 5 | Formato de salida MCP | `structuredContent` + texto JSON de respaldo |
| 6 | Módulo no disponible | `available: false`, sin `isError` |
| 7 | Tope de actividades en compare / rolling | p. ej. 10 por llamada y caché local |
| 8 | Núcleo analítico como paquete independiente | Sí, para reutilizar en ClawIntervals |
| 9 | Tolerancias de golden tests | NP ±1 W, TSS ±1 %, kJ ±0,5 % |

---

## 9. Próximos pasos

Con la visualización limitada al propio usuario ya decidida, queda confirmar con Strava el envío de métricas agregadas a un LLM. En paralelo, hacer el fork y dejar el baseline en verde. Con eso, arrancar por `AlignedStreams` y `powerMetrics`, que son la base de todo lo demás y permiten validar el enfoque con dos o tres actividades reales comparadas contra Intervals.icu.

---

**Fuentes consultadas:** código de r-huijts/strava-mcp (rama principal, clonado y ejecutado el 15/09/2026); comunicado de Strava sobre el acuerdo de API (nov. 2024); análisis de DC Rainmaker (nov. 2024); TechRepublic y Apps for Strava sobre los cambios de junio 2026; especificación CRC Strava MCP v0.1.
