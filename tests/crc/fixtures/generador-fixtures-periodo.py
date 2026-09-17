"""
Fixtures sinteticas para el barrido temporal (bestEffortInPeriod).

Cuatro actividades con fechas distintas dentro y fuera de la ventana de 90
dias, construidas para que se sepa de antemano cual contiene el mejor esfuerzo
de 5 min y cual el de 20 min, y que NO sean la misma actividad.

Referencia temporal fija: 2026-09-17 (now). La ventana de 90 dias empieza el
2026-06-19.

Los valores esperados se derivan aqui con aritmetica directa, sin usar la
implementacion TypeScript.
"""
import json
import os

OUT = os.path.dirname(os.path.abspath(__file__))
NOW = "2026-09-17"
KG = 72.0


def best_mean(power, time, dur):
    """Mejor media sostenida de dur segundos sin cruzar huecos."""
    n = len(power)
    best, start = None, None
    for i in range(dur - 1, n):
        wt = time[i - dur + 1 : i + 1]
        wp = power[i - dur + 1 : i + 1]
        if wt[-1] - wt[0] != dur - 1:
            continue
        m = sum(wp) / dur
        if best is None or m > best:
            best, start = m, wt[0]
    return (round(best, 2), start) if best is not None else (None, None)


def build(segs):
    time, power = [], []
    t = 0
    for dur, w in segs:
        for _ in range(dur):
            time.append(t)
            power.append(float(w))
            t += 1
    return time, power


# (id, fecha, device_watts, segmentos)
ACTIVITIES = [
    # Dentro de la ventana. Mejor 5 min del conjunto: 320 W.
    ("1001", "2026-09-10T08:00:00Z", True, [(600, 200), (300, 320), (600, 200)]),
    # Dentro. Mejor 20 min del conjunto: 265 W, en otra actividad distinta.
    ("1002", "2026-08-20T08:00:00Z", True, [(600, 210), (1200, 265), (600, 205)]),
    # Dentro pero con potencia ESTIMADA: debe descartarse pese a tener 400 W.
    ("1003", "2026-08-01T08:00:00Z", False, [(600, 250), (300, 400), (600, 250)]),
    # FUERA de la ventana de 90 dias (hace mas de 100 dias), con 450 W.
    ("1004", "2026-05-01T08:00:00Z", True, [(600, 250), (1200, 450), (600, 250)]),
]

streams_out = {}
por_actividad = {}

for act_id, date, dw, segs in ACTIVITIES:
    time, power = build(segs)
    streams_out[act_id] = {
        "activity_id": act_id,
        "start_date": date,
        "device_watts": dw,
        "synthetic": True,
        "streams": {"time": {"data": time}, "watts": {"data": power}},
    }
    b5, s5 = best_mean(power, time, 300)
    b20, s20 = best_mean(power, time, 1200)
    por_actividad[act_id] = {
        "date": date,
        "device_watts": dw,
        "best_300s": {"power_w": b5, "start_time_s": s5},
        "best_1200s": {"power_w": b20, "start_time_s": s20},
    }

# --- Esperado del barrido: solo actividades con device_watts True y en ventana
EN_VENTANA = {"1001", "1002", "1003"}  # 1004 queda fuera por fecha
ELEGIBLES = {a for a in EN_VENTANA if por_actividad[a]["device_watts"]}


def mejor(dur_key):
    candidatas = [
        (a, por_actividad[a][dur_key])
        for a in ELEGIBLES
        if por_actividad[a][dur_key]["power_w"] is not None
    ]
    a, d = max(candidatas, key=lambda x: x[1]["power_w"])
    return {
        "activity_id": a,
        "power_w": d["power_w"],
        "start_time_s": d["start_time_s"],
        "activity_date": por_actividad[a]["date"],
    }


mejor5 = mejor("best_300s")
mejor20 = mejor("best_1200s")

# VO2max y FTP derivados a mano a partir de esos mejores esfuerzos.
wkg5 = mejor5["power_w"] / KG
vo2 = 16.6 + 8.87 * wkg5
ftp = mejor20["power_w"] * 0.95

expected = {
    "fixture": "09-periodo",
    "description": (
        "Cuatro actividades: dos validas dentro de la ventana, una con potencia "
        "estimada que debe descartarse y una fuera de los 90 dias. El mejor 5 min "
        "y el mejor 20 min estan en actividades DISTINTAS a proposito."
    ),
    "now": NOW,
    "inputs": {"weight_kg": KG, "window_days": 90},
    "per_activity": por_actividad,
    "expected": {
        "in_window": sorted(EN_VENTANA),
        "eligible": sorted(ELEGIBLES),
        "best_300s": mejor5,
        "best_1200s": mejor20,
        "vo2max": {
            "best_5min_power_w": mejor5["power_w"],
            "relative_power_wkg": round(wkg5, 4),
            "estimated_vo2max": round(vo2, 2),
            "source_activity_id": mejor5["activity_id"],
        },
        "ftp": {
            "best_20min_power_w": mejor20["power_w"],
            "factor": 0.95,
            "estimated_ftp_w": round(ftp, 2),
            "source_activity_id": mejor20["activity_id"],
        },
    },
    "method": {
        "best_effort": "mejor media sostenida sin cruzar huecos no validos",
        "vo2max": "16.6 + 8.87 * (mejor 5 min / peso)",
        "ftp": "mejor 20 min * 0.95",
        "eligibility": "solo device_watts=true y dentro de la ventana de 90 dias",
        "derivation": "calculado analiticamente sobre las series sinteticas",
    },
    "notes": (
        "1003 tiene el pico mas alto de 5 min (400 W) pero potencia estimada: si "
        "aparece en el resultado, el filtro de device_watts no funciona. "
        "1004 tiene 450 W en 20 min pero esta fuera de la ventana: si aparece, el "
        "filtro temporal no funciona."
    ),
}

json.dump(streams_out, open(f"{OUT}/09-periodo.streams.json", "w"))
json.dump(expected, open(f"{OUT}/09-periodo.expected.json", "w"), indent=2, ensure_ascii=False)

print("mejor 5 min :", mejor5)
print("mejor 20 min:", mejor20)
print("vo2max      :", round(vo2, 2), "ml/kg/min  (", round(wkg5, 4), "W/kg )")
print("ftp         :", round(ftp, 2), "W")
