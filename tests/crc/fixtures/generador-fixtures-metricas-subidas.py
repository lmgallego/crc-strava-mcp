"""
Fixture para las metricas nuevas de subidas (Sprint 11).

Tres subidas iguales en perfil (2 km al 6 %) pero con potencia y FC
decrecientes, para que las pendientes de regresion sean conocidas de antemano.

Velocidad constante 5 m/s, igual que las fixtures 10-13, asi que cada subida
dura 400 s y sube 120 m.

Valores derivados aqui con aritmetica directa:

  dificultad = pendiente_% ^ 2 * distancia_km = 6^2 * 2 = 72  -> "suave"
  VAM        = 120 m / (400 s / 3600) = 1080 m/h
  EI         = VAM / (W/kg)

Regresion sobre el indice de subida (0, 1, 2) con valores equiespaciados:
la pendiente es exactamente la diferencia constante entre subidas.
"""
import json
import os

OUT = os.path.dirname(os.path.abspath(__file__))
V = 5.0
KG = 70.0

# (potencia_W, fc_bpm) de cada subida. Diferencias constantes a proposito.
SUBIDAS = [(280, 150), (260, 156), (240, 162)]
LONGITUD_M = 2000
PENDIENTE = 0.06
LLANO_M = 1000


def regresion(valores):
    """Pendiente e interseccion sobre x = 0, 1, 2, ... (formula cerrada)."""
    n = len(valores)
    mx = (n - 1) / 2
    my = sum(valores) / n
    sxy = sum((i - mx) * (v - my) for i, v in enumerate(valores))
    sxx = sum((i - mx) ** 2 for i in range(n))
    slope = sxy / sxx
    return round(slope, 4), round(my - slope * mx, 4)


time, distance, altitude, watts, hr = [], [], [], [], []
t, d, a = 0, 0.0, 100.0
inicios = []

for i, (w, h) in enumerate(SUBIDAS):
    # Llano previo, para separar las subidas.
    for _ in range(int(LLANO_M / V)):
        time.append(t); distance.append(round(d, 3)); altitude.append(round(a, 3))
        watts.append(150.0); hr.append(120.0)
        t += 1; d += V
    inicios.append(t)
    for _ in range(int(LONGITUD_M / V)):
        time.append(t); distance.append(round(d, 3)); altitude.append(round(a, 3))
        watts.append(float(w)); hr.append(float(h))
        t += 1; d += V; a += V * PENDIENTE

# Llano final.
for _ in range(int(LLANO_M / V)):
    time.append(t); distance.append(round(d, 3)); altitude.append(round(a, 3))
    watts.append(150.0); hr.append(120.0)
    t += 1; d += V

gain = LONGITUD_M * PENDIENTE
duracion = LONGITUD_M / V
vam = gain / (duracion / 3600)
dificultad = (PENDIENTE * 100) ** 2 * (LONGITUD_M / 1000)

potencias = [w for w, _ in SUBIDAS]
frecuencias = [h for _, h in SUBIDAS]
slope_p, inter_p = regresion(potencias)
slope_h, inter_h = regresion(frecuencias)

expected = {
    "fixture": "18-metricas-subidas",
    "description": (
        "Tres subidas identicas de 2 km al 6 % con potencia y FC decrecientes, "
        "para que las pendientes de regresion sean exactas."
    ),
    "inputs": {"weight_kg": KG, "speed_m_s": V},
    "expected": {
        "climb_count": 3,
        "per_climb": {
            "distance_m": LONGITUD_M,
            "elevation_gain_m": gain,
            "avg_grade_pct": round(PENDIENTE * 100, 2),
            "duration_s": int(duracion),
            "vam_m_per_h": round(vam, 1),
            "difficulty_score": round(dificultad, 1),
            "difficulty_tier": "suave",
        },
        "power_by_climb": potencias,
        "hr_by_climb": frecuencias,
        "efficiency_index_by_climb": [round(vam / (w / KG), 2) for w in potencias],
        "trend_power": {"slope": slope_p, "intercept": inter_p, "n": 3, "r_squared": 1.0},
        "trend_hr": {"slope": slope_h, "intercept": inter_h, "n": 3, "r_squared": 1.0},
    },
    "method": {
        "difficulty": "pendiente_% ^ 2 * distancia_km",
        "vam": "desnivel / (duracion_h)",
        "ei": "VAM / (W/kg)",
        "trend": "regresion lineal sobre el indice de subida (0, 1, 2)",
        "derivation": "valores derivados de la construccion, no del detector",
    },
    "notes": (
        "Con potencias equiespaciadas (280, 260, 240) la pendiente de la regresion "
        "es exactamente -20 W por subida y el ajuste es perfecto (r2 = 1). Lo mismo "
        "con la FC: +6 bpm por subida."
    ),
}

streams = {
    "activity_id": "18-metricas-subidas",
    "synthetic": True,
    "device_watts": True,
    "streams": {
        "time": {"data": time},
        "distance": {"data": distance},
        "altitude": {"data": altitude},
        "watts": {"data": watts},
        "heartrate": {"data": hr},
    },
}

json.dump(streams, open(f"{OUT}/18-metricas-subidas.streams.json", "w"))
json.dump(expected, open(f"{OUT}/18-metricas-subidas.expected.json", "w"), indent=2, ensure_ascii=False)

print("dificultad :", round(dificultad, 1), "-> suave")
print("VAM        :", round(vam, 1), "m/h")
print("EI         :", [round(vam / (w / KG), 2) for w in potencias])
print("trend pot  : slope", slope_p, "intercept", inter_p)
print("trend FC   : slope", slope_h, "intercept", inter_h)
