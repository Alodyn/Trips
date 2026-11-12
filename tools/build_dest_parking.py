#!/usr/bin/env python3
"""Aparcar en destino (Madrid): SER, zona blanca, aparcamientos públicos y alquiler de plaza.

Entradas (descargadas el 12/11/2026, ver data/dest_parking.json → meta.sources):
  ../datos/ser/limite_ser.geojson   Geoportal Ayuntamiento de Madrid, capa 14 "Límite Zona S.E.R."
  ../datos/madrid/aparc_pub.csv     datos.madrid.es 202625-0 "Aparcamientos públicos municipales"
  ../otp/madrid-latest.osm.pbf      OpenStreetMap (Geofabrik), calles para los puntos de zona blanca
  data/zones.json                   corona A del CRTM = término municipal de Madrid

Salida: data/dest_parking.json
Uso: python tools/build_dest_parking.py   (necesita pyosmium y shapely)
"""
import csv, io, json, math
from pathlib import Path
import osmium
from shapely.geometry import shape, Point, Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parent.parent
DATOS = ROOT.parent / "datos"
PBF = ROOT.parent / "otp" / "madrid-latest.osm.pbf"

# --- SER -------------------------------------------------------------------
ser_geom = shape(json.load(open(DATOS / "ser" / "limite_ser.geojson"))["features"][0]["geometry"])
ser_simple = ser_geom.simplify(0.00004, preserve_topology=True)
ser_prep = prep(ser_geom)
ser_ring = ser_geom.exterior if isinstance(ser_geom, Polygon) else unary_union([p.exterior for p in ser_geom.geoms])

zones = json.load(open(ROOT / "data" / "zones.json"))["zones"]
zone_a = unary_union([Polygon(poly[0], poly[1:]) for z in zones if z["code"] == "A" for poly in z["polygons"]])
zone_a_prep = prep(zone_a)

KX, KY = 111320 * math.cos(math.radians(40.42)), 110570  # m por grado

def metres_to_ser(lon, lat):
    return ser_ring.distance(Point(lon, lat)) * (KX + KY) / 2  # aproximado, suficiente para una banda

# --- Zona blanca: nodos de calle fuera del SER, dentro de Madrid, cerca del borde ---
STREETS = {"residential", "living_street", "unclassified", "tertiary"}
BAND = (60, 700)
CELL = 150  # m

class Streets(osmium.SimpleHandler):
    def __init__(self):
        super().__init__(); self.cells = {}
    def way(self, w):
        hw = w.tags.get("highway")
        if hw not in STREETS: return
        if w.tags.get("access") in ("private", "no") or w.tags.get("service"): return
        name = w.tags.get("name", "")
        for n in w.nodes:
            if not n.location.valid(): continue
            lon, lat = n.location.lon, n.location.lat
            if not (40.30 < lat < 40.56 and -3.84 < lon < -3.52): continue
            key = (int(lon * KX // CELL), int(lat * KY // CELL))
            if key in self.cells: continue
            p = Point(lon, lat)
            if ser_prep.contains(p) or not zone_a_prep.contains(p): 
                self.cells[key] = None; continue
            d = metres_to_ser(lon, lat)
            if not (BAND[0] <= d <= BAND[1]):
                self.cells[key] = None; continue
            self.cells[key] = {"lat": round(lat, 6), "lon": round(lon, 6), "street": name, "edgeM": round(d)}

h = Streets(); h.apply_file(str(PBF), locations=True)
white = [v for v in h.cells.values() if v]

# --- Estaciones de Metro, Metro Ligero y Cercanías (GTFS del CRTM) -----------
# Para la variante "coche + metro": aparcar en zona blanca junto a una estación y acabar en transporte.
import zipfile
GRAPH = ROOT.parent / "otp" / "graph"
FEEDS = {"metro": "metro-gtfs.zip", "metro_ligero": "metroligero-gtfs.zip", "cercanias": "cercanias-gtfs.zip"}
SMALL = {"de", "del", "la", "las", "el", "los", "y", "a", "en"}
def title(n):
    if n != n.upper(): return n
    return " ".join(w if (i and w in SMALL) else w.capitalize() for i, w in enumerate(n.lower().split()))
stations = []
for mode, fn in FEEDS.items():
    z = zipfile.ZipFile(GRAPH / fn)
    seen = {}
    for r in csv.DictReader(io.TextIOWrapper(z.open("stops.txt"), "utf-8-sig")):
        if r.get("location_type", "0") not in ("", "0"): continue
        name = title(r["stop_name"].strip())
        lat, lon = float(r["stop_lat"]), float(r["stop_lon"])
        if not (40.30 < lat < 40.56 and -3.84 < lon < -3.52): continue
        key = name.lower()
        if key in seen: continue
        p = Point(lon, lat)
        if ser_prep.contains(p) or not zone_a_prep.contains(p): continue
        if metres_to_ser(lon, lat) > 1500: continue
        seen[key] = 1
        stations.append({"name": name, "mode": mode, "lat": round(lat, 6), "lon": round(lon, 6)})
def near_station(p):
    best = None
    for st in stations:
        d = math.hypot((p["lat"] - st["lat"]) * KY, (p["lon"] - st["lon"]) * KX)
        if d <= 400 and (best is None or d < best[1]): best = (st, d)
    return best
for w in white:
    ns = near_station(w)
    if ns: w["st"] = {"name": ns[0]["name"], "mode": ns[0]["mode"], "m": round(ns[1])}

# --- Aparcamientos públicos municipales (rotación y mixtos) -----------------
TARIFF_MUNI = {
    "id": "madrid-municipal-2026",
    "label": "Tarifa municipal 2026 de rotación",
    "steps": [[30, 0.0513], [90, 0.0464], [660, 0.0615]],
    "capFromMin": 661, "cap": 39.35,
    "source": "https://www.madrid.es/portales/munimadrid/es/Inicio/El-Ayuntamiento/Carabanchel/Aparcamientos-publicos-de-concesion-municipal-rotatorios-mixtos-y-disuasorios-Tarifas-2026/?vgnextoid=06f4978b3303b910VgnVCM100000891ecb1aRCRD",
    "note": "Decreto de 12/12/2025. Euros por minuto por tramos, IVA incluido; de 661 min a 24 h, 39,35 €."
}
parks = []
raw = open(DATOS / "madrid" / "aparc_pub.csv", "rb").read().decode("latin1")
for r in csv.DictReader(io.StringIO(raw), delimiter=";"):
    if "disuasorio" in r["NOMBRE"].lower(): continue
    try: lat, lon = float(r["LATITUD"]), float(r["LONGITUD"])
    except ValueError: continue
    name = r["NOMBRE"].replace("Aparcamiento mixto. ", "").replace("Aparcamiento público. ", "").strip()
    parks.append({"id": "muni:" + r["PK"], "name": name, "kind": "municipal", "lat": round(lat, 6), "lon": round(lon, 6),
                  "address": f"{r['CLASE-VIAL'].title()} {r['NOMBRE-VIA'].title()} {r['NUM']}".strip(),
                  "tariff": TARIFF_MUNI["id"], "day": None,
                  "source": "https://datos.madrid.es/dataset/202625-0-aparcamientos-publicos"})

# Privados con tarifa publicada (revisados a mano el 12/11/2026). Sin precio de día publicado: day = null.
parks += [
    {"id": "priv:odonnell53", "name": "Parking O'Donnell 53 (Novotel)", "kind": "privado", "lat": 40.421578, "lon": -3.672311,
     "address": "Calle de O'Donnell 53", "day": 28.30, "dayNote": "importe máximo diario de la tarifa general",
     "source": "https://www.parking-odonnell53.com/tarifas/"},
    {"id": "priv:godoy-encinar", "name": "Parking Godoy y Encinar", "kind": "privado", "lat": 40.421737, "lon": -3.676344,
     "address": "Calle de O'Donnell 33", "day": 30.00, "dayNote": "reserva por día en ElParking (aparcacoches)",
     "source": "https://elparking.com/aparcar-en-madrid/parking-hospital-gregorio-maranon?page=2"},
    {"id": "priv:saba-maranon", "name": "Saba Hospital Gregorio Marañón", "kind": "privado", "lat": 40.421171, "lon": -3.671104,
     "address": "Calle de O'Donnell 50 / Doctor Castelo", "day": None, "hourly": 4.20,
     "dayNote": "4,20 €/h publicado; máximo diario sin dato",
     "source": "https://www.saba.es/es/parking-madrid/parking-saba-hospital-gregorio-maranon"},
]

# --- Alquiler mensual de plaza: referencias por zona ------------------------
rent = [{
    "area": "Retiro e Ibiza, entorno del Gregorio Marañón",
    "lat": 40.419045, "lon": -3.670785, "radiusKm": 1.6,
    "samples": [
        {"eur": 90, "where": "Doctor Esquerdo 125 (Estrella), garaje Apolo XI, «desde 90 €»", "url": "https://www.fotocasa.es/es/alquiler/garaje/madrid-capital/vigilancia-privada/181456224/d"},
        {"eur": 125, "where": "Doctor Esquerdo 102 (Niño Jesús), anuncio de 20/05/2026", "url": "https://www.pisos.com/alquilar/garaje-nino_jesus28007-64212319601_109800/"},
        {"eur": 130, "where": "O'Donnell 56, frente al hospital", "url": "https://es.clasificados.st/inmuebles/contacto/6497741/Espa%C3%B1a/Madrid/Alquilo-plaza-de-garaje-para-coche-en-la.html"},
        {"eur": 160, "where": "Doctor Esquerdo 27 (Fuente del Berro)", "url": "https://www.idealista.com/alquiler-garajes/madrid-madrid/"}
    ],
    "median": 128, "walkMin": 6,
    "note": "Cuatro anuncios vistos el 12/11/2026. No es un índice de precios: es una referencia para poner el tuyo."
}]

doc = {
    "meta": {
        "built": "2026-11-12",
        "sources": [
            {"name": "Límite Zona S.E.R.", "url": "https://sigma.madrid.es/hosted/rest/services/GEOPORTAL/SERVICIO_DE_ESTACIONAMIENTO_REGULADO/MapServer/14", "license": "CC BY 4.0, Ayuntamiento de Madrid"},
            {"name": "SER: horario y tiempos máximos", "url": "https://www.madrid.es/portales/munimadrid/es/Inicio/Movilidad-y-transportes/Servicio-de-Estacionamiento-Regulado-SER-Horario-delimitacion-territorial-y-ambitos-diferenciados-/?vgnextoid=6f18e4ce78dd6410VgnVCM1000000b205a0aRCRD"},
            {"name": "SER: tarifas base", "url": "https://www.madrid.es/portales/munimadrid/es/Inicio/Medio-ambiente/Servicio-de-Estacionamiento-Regulado-SER-Tarifas-y-vehiculos-no-sujetos-al-pago/?vgnextoid=972be4ce78dd6410VgnVCM1000000b205a0aRCRD"},
            {"name": "Aparcamientos públicos municipales", "url": "https://datos.madrid.es/dataset/202625-0-aparcamientos-publicos", "license": "CC BY 4.0"},
            {"name": "OpenStreetMap", "url": "https://www.openstreetmap.org/copyright", "license": "ODbL"}
        ],
        "note": "Zona blanca = calle fuera del SER dentro del término de Madrid, a 60–700 m del borde. Que sea gratis no garantiza sitio libre."
    },
    "ser": {
        "city": "Madrid",
        "polygon": [[round(x, 6), round(y, 6)] for x, y in ser_simple.exterior.coords],
        "hours": {"weekday": [9, 21], "saturday": [9, 15], "august": [9, 15], "sunday": None},
        "nonResident": {
            "blue": {"maxMin": 240, "table": [[60, 1.10], [120, 2.75], [180, 5.20], [240, 8.20]]},
            "green": {"maxMin": 120, "table": [[60, 2.05], [120, 4.10]]}
        },
        "rule": "Superado el máximo, no se puede volver a aparcar en el mismo barrio hasta una hora después.",
        "tariffNote": "Tarifa base. La etiqueta ambiental y el nivel de NO₂ la suben o la bajan; el parquímetro calcula la final.",
        "longStay": "Los ámbitos disuasorios de larga estancia (0,50 €/h, 12 h) solo existen en Cuesta de la Vega, Templo de Debod y Parque del Oeste."
    },
    "whiteStreets": white,
    "whiteStations": stations,
    "tariffs": {TARIFF_MUNI["id"]: TARIFF_MUNI},
    "carParks": parks,
    "garageRent": rent
}
out = ROOT / "data" / "dest_parking.json"
json.dump(doc, open(out, "w"), ensure_ascii=False, separators=(",", ":"))
print(f"{len(stations)} estaciones fuera del SER, {sum(1 for w in white if 'st' in w)} puntos junto a estación,")
print(f"{len(doc['ser']['polygon'])} vértices SER, {len(white)} puntos de zona blanca, {len(parks)} aparcamientos, {out.stat().st_size/1024:.0f} KB")
