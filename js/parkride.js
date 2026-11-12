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
