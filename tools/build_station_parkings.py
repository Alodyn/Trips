#!/usr/bin/env python3
"""Estaciones de Cercanías, Metro y Metro Ligero con aparcamiento cerca.

Cruza las paradas de los GTFS del CRTM (stops.txt de cercanias/metro/metroligero)
con los aparcamientos de OpenStreetMap (amenity=parking, sin access=private/customers)
y la lista CRTM/municipal de data/parkings.json. Escribe data/station_parkings.json.

Uso: python tools/build_station_parkings.py OSM.pbf GTFS_DIR
Necesita pyosmium. OSM: © colaboradores de OpenStreetMap, ODbL.
"""
import csv, io, json, math, sys, zipfile
from pathlib import Path
import osmium

ROOT = Path(__file__).resolve().parent.parent
pbf, gtfs = sys.argv[1], Path(sys.argv[2])
FEEDS = {"cercanias": "cercanias-gtfs.zip", "metro": "metro-gtfs.zip", "metro_ligero": "metroligero-gtfs.zip"}
RADIUS_M = 350
BBOX = (39.85, 41.22, -4.65, -3.05)

def dist(a, b):
    R = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))

class Parkings(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.rows = []
    def keep(self, tags):
        if tags.get("amenity") != "parking": return False
        if tags.get("access") in ("private", "customers", "no", "permit", "delivery"): return False
        if tags.get("parking") in ("street_side", "lane", "on_kerb", "half_on_kerb"): return False
        return True
    def add(self, kind, oid, tags, lat, lon):
        self.rows.append({"osm": f"{kind}/{oid}", "lat": round(lat, 6), "lon": round(lon, 6),
            "name": tags.get("name", ""), "capacity": tags.get("capacity", ""), "fee": tags.get("fee", ""),
            "park_ride": tags.get("park_ride", ""), "parking": tags.get("parking", ""), "operator": tags.get("operator", "")})
    def node(self, n):
        if self.keep(n.tags) and n.location.valid(): self.add("node", n.id, n.tags, n.location.lat, n.location.lon)
    def area(self, a):
        if not self.keep(a.tags): return
        pts = [(nd.lat, nd.lon) for ring in a.outer_rings() for nd in ring if nd.location.valid()]
        if not pts: return
        lat = sum(p[0] for p in pts) / len(pts); lon = sum(p[1] for p in pts) / len(pts)
        self.add("way" if a.from_way() else "relation", a.orig_id(), a.tags, lat, lon)

h = Parkings(); h.apply_file(pbf, locations=True)
osm = [p for p in h.rows if BBOX[0] <= p["lat"] <= BBOX[1] and BBOX[2] <= p["lon"] <= BBOX[3]]
crtm = json.load(open(ROOT / "data" / "parkings.json"))["items"]

stations = []
for mode, z in FEEDS.items():
    zf = zipfile.ZipFile(gtfs / z)
    seen = {}
    for r in csv.DictReader(io.TextIOWrapper(zf.open("stops.txt"), "utf-8-sig")):
        if r.get("location_type", "0") not in ("1",) and any(s.get("location_type") == "1" for s in []): pass
        try: lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        except ValueError: continue
        if r.get("location_type", "0") not in ("0", "1", ""): continue
        name = r["stop_name"].strip()
        key = name.lower()
        # una entrada por nombre de estación: la parada "padre" si existe
        if key in seen and r.get("location_type") != "1": continue
        seen[key] = {"mode": mode, "name": name, "lat": lat, "lon": lon, "stop": r["stop_id"]}
    stations += seen.values()

SMALL = {"de", "del", "la", "las", "el", "los", "y", "a", "en"}
def title(name):
    # El GTFS de Metro trae los nombres en mayúsculas: "PUERTA DE ARGANDA" → "Puerta de Arganda".
    if name != name.upper(): return name
    import re
    parts = re.split(r"(\s+|-|/)", name.lower())
    return "".join(w if (not w.strip() or w in "-/" or (i and w in SMALL)) else w[:1].upper() + w[1:] for i, w in enumerate(parts))

out = []
for s in stations:
    s["name"] = title(s["name"])
    near = []
    for p in crtm:
        d = dist((s["lat"], s["lon"]), (p["lat"], p["lon"]))
        if d <= RADIUS_M: near.append({"src": "crtm", "id": p["id"], "name": p["name"], "spaces": p.get("spaces"), "fee": p.get("fee"), "lat": p["lat"], "lon": p["lon"], "m": round(d)})
    for p in osm:
        d = dist((s["lat"], s["lon"]), (p["lat"], p["lon"]))
        if d <= RADIUS_M:
            cap = int(p["capacity"]) if str(p["capacity"]).isdigit() else None
            if cap is not None and cap < 20: continue
            fee = "Libre" if p["fee"] == "no" else ("De pago" if p["fee"] == "yes" else "")
            near.append({"src": "osm", "id": p["osm"], "name": p["name"], "spaces": cap, "fee": fee, "lat": p["lat"], "lon": p["lon"], "m": round(d), "pr": p["park_ride"] == "yes"})
    if not near: continue
    near.sort(key=lambda n: (n["src"] != "crtm", not n.get("pr"), n["fee"] == "De pago", -(n["spaces"] or 0), n["m"]))
    best = near[0]
    out.append({"mode": s["mode"], "name": s["name"], "lat": round(s["lat"], 6), "lon": round(s["lon"], 6),
                "parking": {k: best[k] for k in ("src", "id", "name", "spaces", "fee", "lat", "lon", "m")}, "others": len(near) - 1})

out.sort(key=lambda r: (r["mode"], r["name"]))
doc = {"meta": {"built": __import__("datetime").date.today().isoformat(), "radiusM": RADIUS_M,
        "sources": ["GTFS CRTM (cercanías, metro, metro ligero), licencia https://www.crtm.es/licencia-de-uso",
                    "OpenStreetMap amenity=parking, © colaboradores de OpenStreetMap, ODbL",
                    "data/parkings.json (CRTM AparcamientosCM y Ayuntamiento de Madrid)"],
        "note": "Aparcamiento más probable a menos de 350 m de cada estación. Sin tarifa en OSM, fee queda vacío: no se supone gratis."},
       "items": out}
json.dump(doc, open(ROOT / "data" / "station_parkings.json", "w"), ensure_ascii=False, separators=(",", ":"))
print(len(stations), "estaciones,", len(osm), "aparcamientos OSM,", len(out), "estaciones con aparcamiento")
