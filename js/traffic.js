/**
 * Tiempo de coche honesto.
 *
 * TomTom se pide con departAt en el futuro, traffic=true, routeType=fastest y
 * computeTravelTimeFor=all. Para una salida futura devuelve el perfil histórico:
 * travelTime = historicTrafficTravelTime = liveTrafficIncidentsTravelTime, y en
 * Alcalá → Marañón a las 8:00 de un lunes sale 35 min frente a 28 min sin tráfico
 * (+24 %). El TomTom Traffic Index de Madrid 2025 mide un 62 % de congestión media
 * en la hora punta de la mañana y un 59 % en la de la tarde. Trips toma el mayor
 * de los tiempos de TomTom y, en hora punta laborable, lo sube hasta lo que diría
 * ese índice sobre el tiempo sin tráfico. Es una predicción: cada trayecto guardado
 * admite un margen propio (en %) para corregirla con la experiencia.
 * https://www.tomtom.com/traffic-index/city/madrid/
 */

import { madridParts } from "./format.js";

export const RUSH = [
  { from: 7 * 60, to: 10 * 60, pct: 62, label: "hora punta de mañana" },
  { from: 17 * 60, to: 20 * 60, pct: 59, label: "hora punta de tarde" }
];
export const RUSH_SOURCE = "https://www.tomtom.com/traffic-index/city/madrid/";

export function rushAt(at) {
  const d = at instanceof Date ? at : new Date(at);
  const p = madridParts(d);
  const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
  if (dow === 0 || dow === 6) return null;
  const min = p.hh * 60 + p.mm;
  return RUSH.find((r) => min >= r.from && min < r.to) || null;
}

/** El mayor de los tiempos que da TomTom para esa salida. */
export function tomtomBestS(route) {
  return Math.max(route.travelS || 0, route.historicS || 0, route.liveS || 0);
}

export function autoMarginPct(route, at) {
  const rush = rushAt(at);
  const base = tomtomBestS(route);
  if (!rush || !route.noTrafficS || !base) return { pct: 0, rush };
  const target = route.noTrafficS * (1 + rush.pct / 100);
  return { pct: Math.max(0, Math.round((target / base - 1) * 100)), rush };
}

/**
 * Devuelve la ruta con `s` (segundos que usa Trips), `tomtomS`, `marginPct`,
 * `marginAuto` y `rush`. userPct null = automático.
 */
export function applyTraffic(route, at, userPct = null) {
  const base = tomtomBestS(route);
  const auto = autoMarginPct(route, at);
  const pct = userPct == null ? auto.pct : userPct;
  const s = Math.round(base * (1 + pct / 100));
  const departMs = new Date(at).getTime();
  return {
    ...route,
    tomtomS: base,
    s,
    marginPct: pct,
    marginAuto: userPct == null,
    autoPct: auto.pct,
    rush: auto.rush,
    departure: new Date(departMs).toISOString(),
    arrivalAdj: new Date(departMs + s * 1000).toISOString()
  };
}
