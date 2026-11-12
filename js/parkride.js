import { haversineKm, project } from "./geo.js";

/**
 * Tres aparcamientos disuasorios a lo largo del corredor, no los más cercanos
 * al origen ni los del destino. El tiempo de coche se pide después a TomTom;
 * aquí solo se elige con la geometría.
 */
export function chooseParkings(origin, dest, parkings, limit = 3) {
  const od = haversineKm(origin, dest);
  if (!Number.isFinite(od) || od < 2) return [];
  const scored = [];
  for (const parking of parkings) {
    const op = haversineKm(origin, parking);
    const pd = haversineKm(parking, dest);
    if (op < 1.5 || pd < 1.5) continue;
    const { t, crossKm } = project(origin, dest, parking);
    if (t < 0.12 || t > 0.9) continue;
    const crossLimit = Math.max(5, od * 0.22);
    if (crossKm > crossLimit) continue;
    const detourRatio = (op + pd) / od;
    if (detourRatio > 1.38) continue;
    const along = 1 - Math.min(1, Math.abs(t - 0.5) / 0.5);
    const crossScore = 1 - Math.min(crossKm, crossLimit) / crossLimit;
    const free = parking.fee === "Libre" ? 1 : 0.15;
    const size = Math.min(parking.spaces || 0, 900) / 900;
    const score = along * 1.4 + crossScore * 2.6 + free * 0.7 + size * 0.45 - (detourRatio - 1) * 2.2;
    scored.push({
      parking,
      score,
      t,
      crossKm,
      driveKm: op,
      remainKm: pd,
      detourRatio
    });
  }
  scored.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const row of scored) {
    if (picked.some((p) => haversineKm(p.parking, row.parking) < 1.2)) continue;
    picked.push(row);
    if (picked.length === limit) break;
  }
  return picked;
}

const MODE_NAME = { cercanias: "Cercanías", metro: "Metro", metro_ligero: "Metro Ligero" };

/**
 * Lista única de sitios donde dejar el coche: los disuasorios del CRTM y del
 * Ayuntamiento, más las estaciones de Cercanías, Metro y Metro Ligero con un
 * aparcamiento de OSM a menos de 350 m (data/station_parkings.json).
 * Si el aparcamiento de una estación ya es un disuasorio CRTM, se queda el CRTM
 * y se le apunta la estación.
 */
export function buildParkPool(parkings, stationParks, zoneOf) {
  // Los id de la capa CRTM se repiten (28_079_7 es La Garena y también Pavones):
  // en la lista se añade el nombre para que cada sitio tenga uno propio.
  const pool = parkings.map((p) => ({ ...p, id: `pr:${p.id}:${slug(p.name)}`, layerId: p.id, kind: "pr" }));
  for (const row of stationParks || []) {
    const station = { name: row.name, mode: row.mode, modeName: MODE_NAME[row.mode] || row.mode, lat: row.lat, lon: row.lon };
    const pk = row.parking;
    if (pk.src === "crtm") {
      const hit = pool.find((p) => p.kind === "pr" && haversineKm(p, pk) < 0.05);
      if (hit) {
        if (!hit.station || row.mode === "cercanias") hit.station = station;
        continue;
      }
    }
    if (pool.some((p) => haversineKm(p, pk) < 0.25)) continue;
    const item = {
      id: `osm:${pk.id}`,
      name: row.name,
      muni: "",
      spaces: pk.spaces || null,
      fee: pk.fee || "Sin dato",
      zone: zoneOf(row.lat, row.lon),
      lat: pk.lat,
      lon: pk.lon,
      src: "osm",
      kind: "station",
      station,
      walkM: pk.m
    };
    pool.push(item);
  }
  return pool;
}

function slug(text) {
  return String(text || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function parkLabel(p) {
  if (!p) return "";
  if (p.kind === "station") return `${p.station.modeName} ${p.name}`;
  return p.name;
}

/**
 * Candidatos de park and ride para un trayecto.
 * - Siempre el aparcamiento habitual, esté donde esté.
 * - Siempre la estación con aparcamiento más cercana al origen que quede en el
 *   sentido del viaje (más cerca del destino que el propio origen).
 * - Después, los del corredor por puntuación (sin el filtro de "a medio camino":
 *   aparcar al lado de casa es lo normal).
 * Fuera los que están pegados al destino: eso ya es ir en coche.
 */
export function parkCandidates(origin, dest, pool, { usual = null, limit = 7, nearDestKm = 3 } = {}) {
  const od = haversineKm(origin, dest);
  if (!Number.isFinite(od) || od < 2) return usual ? [row(origin, dest, usual, { usual: true })] : [];
  const eligible = [];
  for (const parking of pool) {
    const op = haversineKm(origin, parking);
    const pd = haversineKm(parking, dest);
    if (pd < nearDestKm || pd > od - 0.5) continue;
    const { t, crossKm } = project(origin, dest, parking);
    if (t < -0.1 || t > 0.95) continue;
    const crossLimit = Math.max(6, od * 0.3);
    if (crossKm > crossLimit) continue;
    const detourRatio = (op + pd) / od;
    if (detourRatio > 1.5) continue;
    const crossScore = 1 - Math.min(crossKm, crossLimit) / crossLimit;
    const free = parking.fee === "Libre" ? 1 : parking.fee === "Sin dato" ? 0.35 : 0.15;
    const size = Math.min(parking.spaces || 0, 900) / 900;
    const rail = parking.station?.mode === "cercanias" ? 0.5 : parking.station ? 0.25 : 0;
    const score = crossScore * 2.6 + free * 0.9 + size * 0.45 + rail - (detourRatio - 1) * 2.2;
    eligible.push({ parking, score, t, crossKm, driveKm: op, remainKm: pd, detourRatio });
  }
  const out = [];
  const take = (r, flags = {}) => {
    const same = out.find((o) => o.parking.id === r.parking.id);
    if (same) { Object.assign(same, flags); return; }
    if (out.length >= limit && !flags.usual) return;
    out.push({ ...r, ...flags });
  };
  if (usual) {
    const live = pool.find((p) => p.id === usual.id) || usual;
    take(row(origin, dest, live), { usual: true });
  }
  const nearest = eligible.filter((r) => r.parking.station).sort((a, b) => a.driveKm - b.driveKm)[0];
  if (nearest) take(nearest, { nearest: true });
  eligible.sort((a, b) => b.score - a.score);
  for (const r of eligible) {
    if (out.length >= limit) break;
    if (out.some((o) => haversineKm(o.parking, r.parking) < 1.2)) continue;
    take(r);
  }
  return out;
}

function row(origin, dest, parking, flags = {}) {
  const { t, crossKm } = project(origin, dest, parking);
  return { parking, t, crossKm, driveKm: haversineKm(origin, parking), remainKm: haversineKm(parking, dest), score: 0, ...flags };
}
