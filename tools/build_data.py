#!/usr/bin/env python3
"""Convierte los extractos CRTM del 12/11/2026 a JSON compactos.

Entrada esperada (no se versiona, pesa demasiado):
  datos/coronas_tarifarias.geojson
  datos/*_estaciones_zonas.csv
  datos/aparcamientos_disuasion.csv

Salida en data/: zones.json, stations.json, parkings.json
"""
import csv
import json
import math
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/trips-src/datos")
OUT = ROOT / "data"

# ~55 m en latitud. Suficiente para coronas y mantiene el punto dentro.
EPS = 0.0005


def perp_m(p, a, b):
    """Distancia en metros de p al segmento a-b. Coordenadas (lon, lat)."""
    lon0 = (a[0] + b[0]) * 0.5
    lat0 = (a[1] + b[1]) * 0.5
    kx = 111_320 * math.cos(math.radians(lat0))
    ky = 110_540
    ax, ay = 0.0, 0.0
    bx, by = (b[0] - a[0]) * kx, (b[1] - a[1]) * ky
    px, py = (p[0] - a[0]) * kx, (p[1] - a[1]) * ky
    den = bx * bx + by * by
    if den == 0:
        return math.hypot(px, py)
    t = max(0.0, min(1.0, (px * bx + py * by) / den))
    return math.hypot(px - t * bx, py - t * by)


def rdp(points, eps_m):
    if len(points) < 3:
        return points
    a, b = points[0], points[-1]
    idx, best = 0, -1.0
    for i in range(1, len(points) - 1):
        d = perp_m(points[i], a, b)
        if d > best:
            best, idx = d, i
    if best > eps_m:
        left = rdp(points[: idx + 1], eps_m)
        right = rdp(points[idx:], eps_m)
        return left[:-1] + right
    return [a, b]


def q(n):
    return round(float(n), 5)


def simplify_ring(ring, eps_m=55):
    if len(ring) < 4:
        return [[q(x), q(y)] for x, y in ring]
    open_ring = ring[:-1] if ring[0] == ring[-1] else ring
    simp = rdp(open_ring, eps_m)
    if len(simp) < 3:
        step = max(1, len(open_ring) // 24)
        simp = open_ring[::step]
    out = [[q(x), q(y)] for x, y in simp]
    if out[0] != out[-1]:
        out.append(out[0])
    return out


def in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat):
            x = (xj - xi) * (lat - yi) / (yj - yi + 0.0) + xi
            if lon < x:
                inside = not inside
        j = i
    return inside


def in_polygon(lon, lat, rings):
    if not rings or not in_ring(lon, lat, rings[0]):
        return False
    for hole in rings[1:]:
        if in_ring(lon, lat, hole):
            return False
    return True


def zone_at(lon, lat, zones):
    hits = []
    for z in zones:
        for poly in z["polygons"]:
            if in_polygon(lon, lat, poly):
                hits.append(z["code"])
                break
    return hits


def as_polygons(geom):
    t = geom["type"]
    c = geom["coordinates"]
    if t == "Polygon":
        return [c]
    if t == "MultiPolygon":
        return c
    raise SystemExit(f"geometría no soportada: {t}")


def build_zones():
    raw = json.loads((SRC / "coronas_tarifarias.geojson").read_text())
    original = []
    simplified = []
    for feat in raw["features"]:
        code = feat["properties"]["CCORONATAR"]
        polys = []
        raw_polys = []
        for poly in as_polygons(feat["geometry"]):
            rings = [simplify_ring(ring) for ring in poly]
            polys.append(rings)
            raw_polys.append(poly)
        simplified.append({"code": code, "polygons": polys})
        original.append({"code": code, "polygons": raw_polys})
    order = ["A", "B1", "B2", "B3", "C1", "C2", "E1", "E2"]
    simplified.sort(key=lambda z: order.index(z["code"]))
    known = [
        ("Sol", -3.7033, 40.4169),
        ("Hospital 12 de Octubre", -3.6988, 40.3758),
        ("Griñón muestra", -3.8642, 40.2139),
        ("Getafe Centro", -3.7327, 40.3083),
        ("P+R Sector 3", -3.73777, 40.28828),
        ("Alcalá", -3.3635, 40.4818),
        ("Cercedilla", -4.0538, 40.7406),
        ("Aranjuez", -3.6026, 40.0334),
    ]
    print("Zonas conocidas (original → simplificada):")
    for name, lon, lat in known:
        a = zone_at(lon, lat, original)
        b = zone_at(lon, lat, simplified)
        flag = "OK" if a == b else "DIFIERE"
        print(f"  {flag:7} {name:24} {a} → {b}")
        if a != b:
            raise SystemExit(f"la simplificación mueve {name}")
    # Muestra aleatoria reproducible dentro del encuadre de la comunidad.
    import random
    rng = random.Random(20261112)
    agree = n = 0
    for _ in range(1500):
        lon = rng.uniform(-4.55, -3.05)
        lat = rng.uniform(39.90, 41.15)
        if zone_at(lon, lat, original) == zone_at(lon, lat, simplified):
            agree += 1
        n += 1
    print(f"Acuerdo en {agree}/{n} puntos aleatorios ({agree / n:.1%})")
    if agree / n < 0.995:
        raise SystemExit("la simplificación no conserva las coronas")
    doc = {
        "meta": {
            "source": "CoronasTarifarias_Vigentes_CRTM",
            "sourceUrl": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/CoronasTarifarias_Vigentes_CRTM/FeatureServer/0",
            "layerUpdated": "2025-05-08",
            "dataMonth": "2025-04",
            "extracted": "2026-11-12",
            "license": "https://www.crtm.es/licencia-de-uso",
            "note": "Polígonos simplificados con Douglas-Peucker (~55 m). La capa oficial es informativa y no sustituye al visor del CRTM. Coordenadas [lon, lat], WGS84. El primer anillo es el exterior; los siguientes, huecos.",
        },
        "zones": simplified,
    }
    path = OUT / "zones.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"zones.json {path.stat().st_size/1024:.0f} KB")
    return simplified


def build_stations():
    files = [
        ("metro", "metro_estaciones_zonas.csv", "4"),
        ("cercanias", "cercanias_estaciones_zonas.csv", "5"),
        ("metro_ligero", "metro_ligero_estaciones_zonas.csv", "10"),
        ("emt", "emt_estaciones_zonas.csv", "6"),
        ("interurbano", "interurbanos_estaciones_zonas.csv", "8"),
        ("urbano", "urbanos_estaciones_zonas.csv", "9"),
    ]
    modes = {}
    counts = {}
    for mode, fname, modo in files:
        rows = []
        with (SRC / fname).open(newline="", encoding="utf-8") as f:
            for rec in csv.DictReader(f):
                name = (rec.get("DENOMINACION") or "").strip()
                if not name:
                    continue
                zone = (rec.get("CORONATARIFARIA") or "").strip()
                muni = (rec.get("CODIGOMUNICIPIO") or "").strip()
                sid = (rec.get("IDESTACION") or "").strip()
                lines = (rec.get("LINEAS") or "").strip()
                # En bus las líneas alargan mucho y no hacen falta para la zona.
                if mode in ("emt", "interurbano", "urbano"):
                    lines = ""
                rows.append([name, zone, muni, sid, lines])
        modes[mode] = rows
        counts[mode] = len(rows)
    doc = {
        "meta": {
            "extracted": "2026-11-12",
            "inventoryDate": "2026-05-29",
            "license": "https://www.crtm.es/licencia-de-uso",
            "fields": ["name", "zone", "muni", "id", "lines"],
            "counts": counts,
            "note": "Campo CORONATARIFARIA de las capas de estaciones del CRTM (M4, M5, M6, M8, M9, M10). Zona vacía: parada sin corona (en Cercanías, casi siempre fuera del sistema tarifario). Estas capas no traen coordenadas: la zona de un punto del callejero sale de zones.json.",
            "sources": {
                "metro": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M4_Red/FeatureServer/0",
                "cercanias": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M5_Red/FeatureServer/0",
                "emt": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M6_Red/FeatureServer/0",
                "interurbano": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M8_Red/FeatureServer/0",
                "urbano": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M9_Red/FeatureServer/0",
                "metro_ligero": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/M10_Red/FeatureServer/0",
            },
        },
        "modes": modes,
    }
    path = OUT / "stations.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")))
    print(f"stations.json {path.stat().st_size/1024:.0f} KB", counts)
    return doc


def build_parkings(zones):
    items = []
    with (SRC / "aparcamientos_disuasion.csv").open(newline="", encoding="utf-8") as f:
        for rec in csv.DictReader(f):
            items.append({
                "id": rec["id"],
                "name": rec["nombre"],
                "muni": rec["municipio"],
                "spaces": int(float(rec["plazas"])) if rec["plazas"] else None,
                "fee": rec["tarifa"],
                "zone": rec["zona"],
                "lat": round(float(rec["lat"]), 6),
                "lon": round(float(rec["lon"]), 6),
                "src": "crtm",
            })
    # Los tres disuasorios del Ayuntamiento que no están en la capa CRTM
    # (estudio del 12/11/2026, CSV datos.madrid.es, CC BY 4.0).
    extra = [
        ("ayto-fuente-de-la-mora", "Fuente de la Mora", "Madrid", 40.48444, -3.66450, "24 h"),
        ("ayto-islazul", "Islazul", "Madrid", 40.36522, -3.73792, ""),
        ("ayto-pitis", "Pitis", "Madrid", 40.49419, -3.72724, "24 h"),
    ]
    have = {(p["name"].lower(), round(p["lat"], 3), round(p["lon"], 3)) for p in items}
    for pid, name, muni, lat, lon, hours in extra:
        key = (name.lower(), round(lat, 3), round(lon, 3))
        if key in have:
            continue
        hits = zone_at(lon, lat, zones)
        items.append({
            "id": pid,
            "name": name,
            "muni": muni,
            "spaces": None,
            "fee": "Libre",
            "zone": hits[0] if len(hits) == 1 else (hits[-1] if hits else None),
            "lat": lat,
            "lon": lon,
            "hours": hours,
            "src": "ayuntamiento",
            "note": "No está en AparcamientosCM. Coordenadas del CSV municipal de disuasorios (12/11/2026).",
        })
    items.sort(key=lambda p: (p["muni"], p["name"]))
    doc = {
        "meta": {
            "extracted": "2026-11-12",
            "license": "https://www.crtm.es/licencia-de-uso",
            "sources": [
                {
                    "id": "crtm",
                    "name": "AparcamientosCM",
                    "url": "https://services5.arcgis.com/UxADft6QPcvFyDU1/arcgis/rest/services/AparcamientosCM/FeatureServer/0",
                    "updated": "2025-12-16T09:40:00+01:00",
                },
                {
                    "id": "ayuntamiento",
                    "name": "Aparcamientos públicos municipales disuasorios",
                    "url": "https://datos.madrid.es/dataset/300531-0-aparcamientos-publicos",
                    "license": "https://creativecommons.org/licenses/by/4.0/",
                    "note": "Solo se añaden Fuente de la Mora, Islazul y Pitis, que no salen en la capa del CRTM.",
                },
            ],
            "feeNote": "Libre / Pago es el campo del CRTM, no una tarifa calculada. En los disuasorios de EMT la gratuidad exige título de transporte y una estancia de 5 a 16 h.",
        },
        "items": items,
    }
    path = OUT / "parkings.json"
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=2))
    print(f"parkings.json {len(items)} sitios, {path.stat().st_size/1024:.0f} KB")
    return items


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    zones = build_zones()
    build_stations()
    build_parkings(zones)


if __name__ == "__main__":
    main()
