"""
Fixtures sinteticas para las zonas de FC de Coggan y la estimacion del umbral.

LTHR de referencia: 165 bpm. FC maxima: 190 bpm.

Cortes de Coggan sobre el LTHR, redondeados a latidos enteros (un pulsometro
no da decimales). Con LTHR = 165:

  Z1 recuperacion  [0, 114)    corte 0.69 * 165 = 113.85 -> 114
  Z2 aerobico      [114, 139)  corte 0.84 * 165 = 138.6  -> 139
  Z3 tempo         [139, 157)  corte 0.95 * 165 = 156.75 -> 157
  Z4 umbral        [157, 174)  tope  1.05 * 165 = 173.25 -> 173, +1 = 174
  Z5 VO2max        [174, 191)  cerrada en FC maxima (190) + 1

Los segundos por zona se fijan por construccion: cada bloque dura lo que se
le dice y su FC cae dentro de una zona conocida.
"""
import json
import os

OUT = os.path.dirname(os.path.abspath(__file__))
LTHR = 165
HR_MAX = 190


def cortes(lthr):
    return {
        "z1_z2": round(0.69 * lthr),
        "z2_z3": round(0.84 * lthr),
        "z3_z4": round(0.95 * lthr),
        "z4_z5": round(1.05 * lthr) + 1,
    }


C = cortes(LTHR)


def dump(name, desc, bloques, expected, notes):
    """bloques: lista de (duracion_s, hr_bpm, watts)."""
    time, hr, watts = [], [], []
    t = 0
    for dur, h, w in bloques:
        for _ in range(dur):
            time.append(t)
            hr.append(h)
            watts.append(w)
            t += 1
    streams = {
        "activity_id": name,
        "synthetic": True,
        "device_watts": True,
        "streams": {
            "time": {"data": time},
            "heartrate": {"data": hr},
            "watts": {"data": watts},
        },
    }
    exp = {
        "fixture": name,
        "description": desc,
        "inputs": {"hr_threshold_bpm": LTHR, "hr_max_bpm": HR_MAX},
        "zone_bounds": {
            "Z1": [0, C["z1_z2"]],
            "Z2": [C["z1_z2"], C["z2_z3"]],
            "Z3": [C["z2_z3"], C["z3_z4"]],
            "Z4": [C["z3_z4"], C["z4_z5"]],
            "Z5": [C["z4_z5"], HR_MAX + 1],
        },
        "expected": expected,
        "method": {
            "cuts": "round(pct * LTHR) a latidos enteros; cada corte es tope de una zona y suelo de la siguiente",
            "z4_top": "Z4 incluye su tope (1.05 * LTHR); Z5 empieza un latido mas arriba",
            "z5_top": "Z5 cerrada en hr_max_bpm + 1; por encima queda sin clasificar",
            "derivation": "segundos por zona fijados por construccion de los bloques",
        },
        "notes": notes,
    }
    json.dump(streams, open(f"{OUT}/{name}.streams.json", "w"))
    json.dump(exp, open(f"{OUT}/{name}.expected.json", "w"), indent=2, ensure_ascii=False)
    print(f"{name}: {desc[:60]}")


# --- 14: una salida que pasa por las cinco zonas -------------------------
# Cada bloque cae claramente dentro de una zona, lejos de las fronteras.
bloques14 = [
    (600, 100, 90),   # Z1
    (1200, 125, 150),  # Z2
    (900, 148, 200),   # Z3
    (600, 165, 250),   # Z4 (justo el LTHR)
    (300, 180, 320),   # Z5
]
dump(
    "14-zonas-pulso",
    "Salida que recorre las cinco zonas de FC, con cada bloque lejos de las fronteras.",
    bloques14,
    {
        "valid_seconds": sum(d for d, _, _ in bloques14),
        "seconds_by_zone": {"Z1": 600, "Z2": 1200, "Z3": 900, "Z4": 600, "Z5": 300},
        "classified_seconds": sum(d for d, _, _ in bloques14),
        "unclassified_seconds": 0,
    },
    "Caso base. La suma por zona debe igualar los segundos validos.",
)

# --- 15: latidos justo en las fronteras ----------------------------------
# Cada valor es un corte o el latido anterior: comprueba que no hay hueco ni
# doble conteo. El corte pertenece SIEMPRE a la zona superior.
frontera = [
    (60, C["z1_z2"] - 1, 100),  # ultimo Z1
    (60, C["z1_z2"], 150),      # primer Z2
    (60, C["z2_z3"] - 1, 180),  # ultimo Z2
    (60, C["z2_z3"], 200),      # primer Z3
    (60, C["z3_z4"] - 1, 220),  # ultimo Z3
    (60, C["z3_z4"], 240),      # primer Z4
    (60, C["z4_z5"] - 1, 300),  # ultimo Z4
    (60, C["z4_z5"], 330),      # primer Z5
    (60, HR_MAX, 350),          # justo la FC maxima: ultimo Z5
]
dump(
    "15-zonas-frontera",
    "Un minuto en cada latido frontera y en el inmediatamente anterior.",
    frontera,
    {
        "valid_seconds": 540,
        "seconds_by_zone": {"Z1": 60, "Z2": 120, "Z3": 120, "Z4": 120, "Z5": 120},
        "classified_seconds": 540,
        "unclassified_seconds": 0,
        "boundary_values": {
            "z1_z2": C["z1_z2"],
            "z2_z3": C["z2_z3"],
            "z3_z4": C["z3_z4"],
            "z4_z5": C["z4_z5"],
            "hr_max": HR_MAX,
        },
    },
    "El latido del corte pertenece a la zona SUPERIOR. La FC maxima entra en Z5.",
)

# --- 16: FC por encima de la maxima --------------------------------------
sobre_max = [(600, 150, 200), (120, HR_MAX + 8, 260)]
dump(
    "16-zonas-sobre-maxima",
    "Dos minutos por encima de la FC maxima registrada (artefacto o maxima desactualizada).",
    sobre_max,
    {
        "valid_seconds": 720,
        "seconds_by_zone": {"Z1": 0, "Z2": 0, "Z3": 600, "Z4": 0, "Z5": 0},
        "classified_seconds": 600,
        "unclassified_seconds": 120,
    },
    "Los 120 s por encima de la maxima NO se suman a Z5: quedan sin clasificar. "
    "Aqui la suma por zona iguala classified_seconds, no valid_seconds.",
)

# --- 17: estimacion del umbral de FC -------------------------------------
# Mejor FC media de 20 min: el bloque de 1200 s a 170 bpm.
# 170 * 0.98 = 166.6 -> 167 bpm.
est = [(900, 140, 180), (1200, 170, 260), (600, 130, 150)]
dump(
    "17-estimacion-umbral",
    "Bloque de 20 min a 170 bpm rodeado de tramos mas suaves.",
    est,
    {
        "valid_seconds": 2700,
        "best_20min_hr_bpm": 170.0,
        "best_20min_start_time_s": 900,
        "factor": 0.98,
        "estimated_hr_threshold_bpm": round(170 * 0.98),
    },
    "170 * 0.98 = 166.6, que redondea a 167 bpm. El mejor 20 min esta en t=900.",
)

print("\nCortes con LTHR", LTHR, "->", C, "| Z5 cierra en", HR_MAX + 1)
