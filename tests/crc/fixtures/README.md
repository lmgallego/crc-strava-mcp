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

## Metodo declarado
- NP: media movil de 30 s sobre rejilla de 1 Hz, solo ventanas completas, sin cruzar huecos no validos.
- Duracion para TSS: segundos validos.
- Power curve: mejor media en 60, 300 y 1200 s, sin cruzar huecos.

`generador-fixtures.py` reproduce los cinco casos y sus valores esperados.
Si se cambia el metodo de calculo, se regeneran y se documenta el cambio.
