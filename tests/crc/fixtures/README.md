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

## Generadores
`generador-fixtures.py` reproduce los casos 01-05 y sus valores esperados.
`generador-fixtures-desacople.py` reproduce los casos 06-08.
Si se cambia el metodo de calculo, se regeneran y se documenta el cambio.
