# Fixtures sinteticas · capa CRC

Series construidas a proposito, con valores fisiologicamente realistas
(FTP 250 W, 72 kg) y resultados derivados analiticamente, no copiados de
ninguna plataforma externa.

| Fixture | Que valida |
|---|---|
| 01-steady-endurance | 60 min a 180 W. Con potencia constante NP = media y VI = 1.0 por definicion matematica. Si el codigo no da esto, el NP esta mal. |
| 02-sweetspot | 3x12 min al 90% FTP. Variabilidad moderada, VI ~1.07, tipico de una sesion real de sweet spot. |
| 03-vo2max | 5x3 min al 136% FTP. Ademas comprueba que el mejor 5 min NO es 340 W: ningun bloque sostiene 300 s a esa potencia, asi que la ventana obligatoriamente incluye recuperacion. |
| 04-paradas | Rodaje constante con dos huecos sin muestras (45 s y 10 min). Como la potencia es constante, NP debe seguir siendo 190: si el codigo cruza el hueco o rellena con ceros, el valor cambia y el test lo caza. |
| 05-descenso-ceros | 10 min de descenso a 0 W. Los ceros son dato real: entran en la media (166 W) y no deben tratarse como ausencia. |
| 06-desacople-deriva | 60 min a 200 W con la FC subiendo linealmente de 135 a 145 bpm. Caso base del desacople: la potencia no cambia, asi que todo el efecto viene de la deriva cardiaca. Desacople 3.5097 %. |
| 07-desacople-hueco | Hueco asimetrico de 10 min. La mitad por tiempo valido cae en un punto distinto que la mitad por indice de rejilla: por tiempo valido da 6.6667 %, por indice daria 5.7692 %. El expected guarda ambos y el test comprueba que sale el primero. |
| 09-periodo | Cuatro actividades con fechas distintas para el barrido temporal (bestEffortInPeriod). El mejor 5 min (320 W, act. 1001) y el mejor 20 min (265 W, act. 1002) estan en actividades DISTINTAS a proposito. Incluye dos trampas: 1003 tiene el pico mas alto (400 W) pero potencia estimada, y 1004 tiene 450 W pero cae fuera de la ventana de 90 dias. |
| 08-desacople-filtros | Calentamiento de 10 min, tramo por debajo del rango de potencia y tramo parado. Valida que warmup_exclusion_min, moving_only y power_min/max_pct_ftp se aplican ANTES de partir en mitades. Quedan 3600 s utiles y el desacople es 6.6667 %. |

## Metodo declarado
- NP: media movil de 30 s sobre rejilla de 1 Hz, solo ventanas completas, sin cruzar huecos no validos.
- Duracion para TSS: segundos validos.
- Power curve: mejor media en 60, 300 y 1200 s, sin cruzar huecos.

## Desacople aerobico (06-08)

Las fixtures 01-05 llevan FC generada por formula a partir de la potencia
(`hr = 95 + 0.19*W`), asi que su FC no tiene deriva cardiaca real: sirven para
comprobar que el codigo corre, no para validar el desacople. Las fixtures 06-08
construyen la deriva a proposito.

Metodo declarado para el desacople:
- EF = media(potencia) / media(FC) de cada mitad, no la media de (P/FC) por muestra.
- Las mitades se parten por TIEMPO VALIDO de la muestra ya filtrada, no por indice del array.
- decoupling_pct = (EF1 - EF2) / EF1 * 100.
- Los filtros se aplican ANTES de partir en mitades.

## Deteccion de subidas (10-13) · v0.2

Perfiles de altitud construidos a proposito, a 5 m/s constantes para que
distancia y tiempo sean intercambiables (`distancia_m = t * 5`).

| Fixture | Que valida |
|---|---|
| 10-subida-limpia | 1 km llano, 5 km al 6 % y 1 km llano. Caso base: 300 m de desnivel, VAM 1080 m/h, score 30. |
| 11-falso-llano | 2 km al 6 %, 150 m de falso llano y otros 2 km al 6 %. Debe salir UNA subida: el llano no llega a los 200 m de tolerancia. Con `maxFlatRunM: 50` si se parte en dos. |
| 12-dos-subidas | Dos tramos de 2 km al 6 % separados por 1,5 km de descenso. Deben salir DOS subidas de 120 m cada una. |
| 13-llano-ruido | 10 km planos con +/- 1,5 m de ruido barometrico. No debe detectarse ninguna subida: todo el desnivel posible viene del ruido. |

Los valores esperados salen de la CONSTRUCCION del perfil (se sabe cuantos
metros se han subido porque se han puesto ahi), no de ejecutar el detector.

Nota sobre los bordes: el suavizado de 15 s difumina el codo del perfil, asi que
el tramo detectado se desplaza unos segundos respecto al construido (~0,1 % en
distancia). Esta medido y documentado en D40; los tests lo acotan en lugar de
ignorarlo.

## Barrido temporal (09)

Referencia temporal fija: `now = 2026-09-17`, asi que la ventana de 90 dias
empieza el 2026-06-19. El expected incluye `per_activity` con el mejor esfuerzo
de 300 s y 1200 s de cada actividad, y los valores derivados de VO2max
(16.6 + 8.87 * W/kg) y FTP (mejor 20 min * 0.95).

Si el resultado del barrido es 1003 o 1004, el filtro que falla es,
respectivamente, el de `device_watts` o el de la ventana temporal.

## Generadores
`generador-fixtures.py` reproduce los casos 01-05 y sus valores esperados.
`generador-fixtures-desacople.py` reproduce los casos 06-08.
`generador-fixtures-periodo.py` reproduce el caso 09.
`generador-fixtures-subidas.py` reproduce los casos 10-13.
Si se cambia el metodo de calculo, se regeneran y se documenta el cambio.
