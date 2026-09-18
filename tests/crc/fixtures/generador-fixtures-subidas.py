"""
Fixtures sinteticas para la deteccion de subidas (Sprint 8, v0.2).

Perfiles de altitud construidos a proposito. Los valores esperados salen de la
CONSTRUCCION (se sabe cuantos metros se han subido porque se han puesto ahi),
no de ejecutar el detector.

Velocidad constante de 5 m/s (18 km/h) para que distancia y tiempo sean
intercambiables y las cuentas se puedan repasar a mano:
  distancia_m = t * 5     desnivel_m = pendiente * distancia_m
"""
import json
import math
import os
import random

OUT = os.path.dirname(os.path.abspath(__file__))
V = 5.0  # m/s
KG = 72.0


def build(segments, noise_m=0.0, seed=7):
    """segments: lista de (metros, pendiente_fraccion). Devuelve streams."""
    rnd = random.Random(seed)
    time, distance, altitude, watts = [], [], [], []
    t, d, a = 0, 0.0, 100.0  # se arranca a 100 m para que no haya altitudes negativas

    for length_m, grade in segments:
        steps = int(round(length_m / V))
        for _ in range(steps):
            time.append(t)
            distance.append(round(d, 3))
            # El ruido se anade SOLO a la senal publicada, no al modelo real.
            altitude.append(round(a + (rnd.uniform(-noise_m, noise_m) if noise_m else 0.0), 3))
            # Potencia coherente con la pendiente, para las metricas por subida.
            watts.append(150.0 + 2500.0 * max(grade, 0.0))
            t += 1
            d += V
            a += V * grade
    return time, distance, altitude, watts


def climb_expectation(length_m, grade, start_t):
    """Valores derivados por construccion de un tramo de subida."""
    gain = length_m * grade
    duration_s = length_m / V
    return {
        "start_time_s": start_t,
        "end_time_s": start_t + int(duration_s),
        "distance_m": length_m,
        "elevation_gain_m": round(gain, 1),
        "avg_grade_pct": round(grade * 100, 2),
        "duration_s": int(duration_s),
        "vam_m_per_h": round(gain / (duration_s / 3600), 1),
        "difficulty_score": round((length_m / 1000) * (grade * 100), 1),
    }


def dump(name, desc, segs, expected, notes, noise_m=0.0):
    time, distance, altitude, watts = build(segs, noise_m=noise_m)
    streams = {
        "activity_id": name,
        "synthetic": True,
        "device_watts": True,
        "streams": {
            "time": {"data": time},
            "distance": {"data": distance},
            "altitude": {"data": altitude},
            "watts": {"data": watts},
        },
    }
    exp = {
        "fixture": name,
        "description": desc,
        "inputs": {"weight_kg": KG, "speed_m_s": V, "noise_m": noise_m},
        "expected": expected,
        "method": {
            "derivation": "valores derivados de la construccion del perfil, no del detector",
            "gain": "desnivel = longitud * pendiente, por construccion",
            "vam": "desnivel / (duracion_h)",
            "score": "distancia_km * pendiente_media_% (escala propia CRC)",
        },
        "notes": notes,
    }
    json.dump(streams, open(f"{OUT}/{name}.streams.json", "w"))
    json.dump(exp, open(f"{OUT}/{name}.expected.json", "w"), indent=2, ensure_ascii=False)
    print(f"{name}: {expected['climb_count']} subida(s)")


# --- 10: subida limpia de 5 km al 6 % ------------------------------------
# 1 km llano + 5 km al 6 % + 1 km llano.
c = climb_expectation(5000, 0.06, start_t=200)
dump(
    "10-subida-limpia",
    "1 km llano, 5 km al 6 % (300 m de desnivel) y 1 km llano. Una sola subida.",
    [(1000, 0.0), (5000, 0.06), (1000, 0.0)],
    {"climb_count": 1, "climbs": [c], "total_elevation_gain_m": c["elevation_gain_m"]},
    "Caso base. 5000 m x 6 % = 300 m. VAM = 300 / (1000 s / 3600) = 1080 m/h. "
    "Score = 5 x 6 = 30 -> 'media'.",
)

# --- 11: falso llano en medio que NO debe partir la subida ---------------
# 2 km al 6 %, 150 m llanos (por debajo del limite de 200 m), 2 km al 6 %.
gain11 = 2000 * 0.06 + 0 + 2000 * 0.06
dist11 = 2000 + 150 + 2000
dur11 = dist11 / V
dump(
    "11-falso-llano",
    "2 km al 6 %, 150 m de falso llano y otros 2 km al 6 %. Debe salir UNA subida, "
    "no dos: el llano no llega a los 200 m de tolerancia.",
    [(1000, 0.0), (2000, 0.06), (150, 0.0), (2000, 0.06), (1000, 0.0)],
    {
        "climb_count": 1,
        "climbs": [
            {
                "start_time_s": 200,
                "distance_m": dist11,
                "elevation_gain_m": round(gain11, 1),
                "avg_grade_pct": round(gain11 / dist11 * 100, 2),
                "duration_s": int(dur11),
                "vam_m_per_h": round(gain11 / (dur11 / 3600), 1),
                "difficulty_score": round((dist11 / 1000) * (gain11 / dist11 * 100), 1),
            }
        ],
        "total_elevation_gain_m": round(gain11, 1),
    },
    "El llano de 150 m esta por debajo de max_flat_run_m (200), asi que no rompe la "
    "subida. La pendiente media baja a 240/4150 = 5,78 %, que sigue por encima del 3 %.",
)

# --- 12: dos subidas separadas por un descenso largo ---------------------
c12a = climb_expectation(2000, 0.06, start_t=200)
c12b = climb_expectation(2000, 0.06, start_t=200 + 400 + 300)
dump(
    "12-dos-subidas",
    "2 km al 6 %, 1,5 km de descenso al -4 % y otros 2 km al 6 %. Deben salir DOS subidas.",
    [(1000, 0.0), (2000, 0.06), (1500, -0.04), (2000, 0.06), (1000, 0.0)],
    {
        "climb_count": 2,
        "climbs": [c12a, c12b],
        "total_elevation_gain_m": round(c12a["elevation_gain_m"] + c12b["elevation_gain_m"], 1),
    },
    "El descenso de 1500 m supera con creces los 200 m de tolerancia, asi que parte "
    "el tramo en dos subidas de 120 m de desnivel cada una.",
)

# --- 13: llano con ruido barometrico: ninguna subida ---------------------
dump(
    "13-llano-ruido",
    "10 km completamente llanos con +/- 1,5 m de ruido barometrico. No debe detectarse "
    "ninguna subida.",
    [(10000, 0.0)],
    {"climb_count": 0, "climbs": [], "total_elevation_gain_m": 0.0},
    "El perfil real es plano: todo el desnivel que pudiera acumularse viene del ruido. "
    "Si el detector encuentra una subida aqui, esta inventando desnivel.",
    noise_m=1.5,
)
