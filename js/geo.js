/** Punto en polígono. Los anillos van en [lon, lat]; el primero es el exterior. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = (yi > lat) !== (yj > lat)
      && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInPolygon(lon, lat, rings) {
  if (!rings?.length || !pointInRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (pointInRing(lon, lat, rings[h])) return false;
  }
  return true;
}

const RANK = { A: 1, B1: 2, B2: 3, B3: 4, C1: 5, C2: 6, E1: 7, E2: 8 };

/** Corona del punto. Si cae en más de una por un borde, la de menor rango. */
export function zoneAt(lat, lon, zones) {
  if (lat == null || lon == null || !zones) return null;
  const hits = [];
  for (const z of zones) {
    for (const poly of z.polygons) {
      if (pointInPolygon(lon, lat, poly)) {
        hits.push(z.code);
        break;
      }
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (RANK[a] || 9) - (RANK[b] || 9));
  return hits[0];
}

export function haversineKm(a, b) {
  const R = 6371;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Proyección local del punto sobre el segmento origen→destino. t=0 en origen, t=1 en destino. */
export function project(origin, dest, p) {
  const lat0 = ((origin.lat + dest.lat) / 2) * Math.PI / 180;
  const kx = 111.32 * Math.cos(lat0);
  const ky = 110.57;
  const dx = (dest.lon - origin.lon) * kx;
  const dy = (dest.lat - origin.lat) * ky;
  const px = (p.lon - origin.lon) * kx;
  const py = (p.lat - origin.lat) * ky;
  const den = dx * dx + dy * dy;
  const t = den ? (px * dx + py * dy) / den : 0;
  const cross = Math.hypot(px - t * dx, py - t * dy);
  return { t, crossKm: cross };
}

export function buildStationIndex(stationsDoc) {
  const index = new Map();
  const modes = stationsDoc?.modes || {};
  for (const [mode, rows] of Object.entries(modes)) {
    for (const row of rows) {
      const [name, zone, muni, id, lines] = row;
      if (!name || !zone) continue;
      const key = normalizeName(name);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push({ mode, name, zone, muni, id, lines });
    }
  }
  return index;
}

export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Si el nombre del lugar es exactamente una estación, devuelve su corona. */
export function stationMatch(label, index) {
  if (!label || !index) return null;
  const main = normalizeName(String(label).split(",")[0]);
  const hits = index.get(main);
  if (!hits?.length) return null;
  const zones = [...new Set(hits.map((h) => h.zone).filter(Boolean))];
  if (zones.length !== 1) return null;
  return { zone: zones[0], stations: hits };
}
