"""
Fixtures sinteticas para el desacople aerobico (seccion 7.5).

Las fixtures 01-05 llevan FC derivada de la potencia por formula
(hr = 95 + 0.19*W), asi que su FC no tiene deriva cardiaca: sirven para
comprobar que el codigo corre, no para validar el desacople. Estas tres
construyen la deriva a proposito.

EF = media(potencia) / media(FC) de cada mitad.
decoupling_pct = (EF1 - EF2) / EF1 * 100.
Las mitades se parten por TIEMPO VALIDO de la muestra ya filtrada,
no por indice del array.

Todos los valores esperados se derivan aqui con aritmetica directa,
independiente de la implementacion TypeScript.
"""
import json
import os

OUT = os.path.dirname(os.path.abspath(__file__))
FTP, KG = 250, 72.0


def ef_halves(samples):
    """samples: lista de (t, watts, hr) ya filtrada. Parte por tiempo valido."""
    n = len(samples)
    half = n // 2  # cada muestra vale 1 s de tiempo valido
    first, second = samples[:half], samples[half:]

    def ef(block):
        p = sum(s[1] for s in block) / len(block)
        h = sum(s[2] for s in block) / len(block)
        return p / h, p, h

    ef1, p1, h1 = ef(first)
    ef2, p2, h2 = ef(second)
    return {
        "first_half_ef": round(ef1, 6),
        "second_half_ef": round(ef2, 6),
        "decoupling_pct": round((ef1 - ef2) / ef1 * 100, 4),
        "valid_seconds": n,
        "first_half_seconds": len(first),
        "second_half_seconds": len(second),
        "first_half_mean_power_w": round(p1, 4),
        "first_half_mean_hr_bpm": round(h1, 4),
        "second_half_mean_power_w": round(p2, 4),
        "second_half_mean_hr_bpm": round(h2, 4),
    }


def dump(name, desc, time, watts, hr, moving, expected, filters, notes):
    streams = {
        "activity_id": name,
        "synthetic": True,
        "device_watts": True,
        "streams": {
            "time": {"data": time},
            "watts": {"data": watts},
            "heartrate": {"data": hr},
            "moving": {"data": moving},
        },
    }
    exp = {
        "fixture": name,
        "description": desc,
        "inputs": {"ftp_w": FTP, "weight_kg": KG, "filters": filters},
        "expected": expected,
        "method": {
            "ef": "EF = media(potencia) / media(FC) por mitad",
            "halves": "mitades por tiempo valido de la muestra filtrada, no por indice",
            "decoupling": "(EF1 - EF2) / EF1 * 100",
            "derivation": "calculado analiticamente sobre la serie sintetica",
        },
        "notes": notes,
    }
    json.dump(streams, open(f"{OUT}/{name}.streams.json", "w"))
    json.dump(exp, open(f"{OUT}/{name}.expected.json", "w"), indent=2, ensure_ascii=False)
    print(name, "dec", expected["decoupling_pct"], "%", "valid", expected["valid_seconds"])


# --- 06: deriva cardiaca lineal, sin huecos ni filtros --------------------
# 60 min a 200 W con la FC subiendo linealmente de 135 a 145 bpm.
n = 3600
time = list(range(n))
watts = [200.0] * n
hr = [135.0 + 10.0 * i / (n - 1) for i in range(n)]
moving = [True] * n
dump(
    "06-desacople-deriva",
    "60 min a 200 W con deriva cardiaca lineal de 135 a 145 bpm. Caso base del desacople.",
    time, watts, hr, moving,
    ef_halves(list(zip(time, watts, hr))),
    {"warmup_exclusion_min": 0, "moving_only": False},
    "Potencia constante y FC creciente: todo el desacople viene de la FC. "
    "Si el codigo promediara EF por muestra en vez de media(P)/media(FC), el valor cambia.",
)

# --- 07: hueco asimetrico -> mitad por tiempo valido != mitad por indice ---
# 1200 s a FC 140, hueco de 600 s sin muestras, 600 s a FC 140, 1800 s a FC 150.
seg = [(1200, 200.0, 140.0), (600, None, None), (600, 200.0, 140.0), (1800, 200.0, 150.0)]
time, watts, hr, moving = [], [], [], []
t = 0
for dur, w, h in seg:
    for _ in range(dur):
        if w is not None:  # el hueco simplemente no aporta muestras
            time.append(t)
            watts.append(w)
            hr.append(h)
            moving.append(True)
        t += 1
samples = list(zip(time, watts, hr))
exp07 = ef_halves(samples)
# Contraste: como saldria si se partiera por indice de la rejilla (mal).
grid_mid = (time[-1] - time[0] + 1) // 2
by_index_first = [s for s in samples if s[0] < grid_mid]
by_index_second = [s for s in samples if s[0] >= grid_mid]
p1 = sum(s[1] for s in by_index_first) / len(by_index_first)
h1 = sum(s[2] for s in by_index_first) / len(by_index_first)
p2 = sum(s[1] for s in by_index_second) / len(by_index_second)
h2 = sum(s[2] for s in by_index_second) / len(by_index_second)
exp07["wrong_if_split_by_grid_index"] = round(((p1 / h1) - (p2 / h2)) / (p1 / h1) * 100, 4)
dump(
    "07-desacople-hueco",
    "Hueco asimetrico de 10 min. La mitad por tiempo valido cae en un punto distinto "
    "que la mitad por indice de rejilla, y el desacople resultante es otro.",
    time, watts, hr, moving, exp07,
    {"warmup_exclusion_min": 0, "moving_only": False},
    "Partir por indice de rejilla da wrong_if_split_by_grid_index en vez de decoupling_pct. "
    "El test comprueba que NO sale ese valor.",
)

# --- 08: filtros (warmup, moving_only, rango de potencia) -----------------
# warmup 600 s / bloque util / tramo flojo fuera de rango / tramo parado / bloque util
seg = [
    (600, 120.0, 110.0, True),    # calentamiento: fuera por warmup_exclusion_min=10
    (1800, 200.0, 140.0, True),   # util
    (300, 50.0, 120.0, True),     # fuera por power_min_pct_ftp (50 W < 56% de 250)
    (200, 200.0, 145.0, False),   # fuera por moving_only
    (1800, 200.0, 150.0, True),   # util
]
time, watts, hr, moving = [], [], [], []
t = 0
for dur, w, h, mv in seg:
    for _ in range(dur):
        time.append(t)
        watts.append(w)
        hr.append(h)
        moving.append(mv)
        t += 1

WARMUP_S = 600
PMIN, PMAX = 0.56 * FTP, 1.50 * FTP
kept = [
    (tt, w, h)
    for tt, w, h, mv in zip(time, watts, hr, moving)
    if tt >= WARMUP_S and mv and PMIN <= w <= PMAX
]
exp08 = ef_halves(kept)
exp08["excluded_seconds"] = len(time) - len(kept)
dump(
    "08-desacople-filtros",
    "Calentamiento, tramo por debajo del rango de potencia y tramo parado. "
    "Solo quedan los dos bloques utiles: 1800 s a FC 140 y 1800 s a FC 150.",
    time, watts, hr, moving, exp08,
    {
        "warmup_exclusion_min": 10,
        "moving_only": True,
        "power_min_pct_ftp": 0.56,
        "power_max_pct_ftp": 1.50,
    },
    "Valida que los tres filtros se aplican ANTES de partir en mitades. "
    "Sin filtrar, las mitades caerian en otro sitio y el desacople seria distinto.",
)
