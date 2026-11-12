/**
 * TomTom Search (geocodificación) y Routing (coche con tráfico).
 *
 * La clave está restringida a https://alodyn.github.io . Desde localhost
 * TomTom responde 403 InvalidReferer. En ese caso no se llama a otro
 * geocodificador: la interfaz enseña el rechazo.
 *
 * En localhost / 127.0.0.1, o con ?fixtures=1, se usa fixtures/tomtom-sample.json.
 * La ruta de ejemplo es una respuesta real grabada el 12/11/2026.
 * La búsqueda de esa muestra no se pudo grabar (Search ya respondía 403)
 * y reutiliza las coordenadas de aquella petición, con la forma del API.
 * ?fixtures=0 fuerza la red aunque sea en local, para ver el error.
 */

import { CONFIG } from "../config.js";
import { norm } from "./format.js";

const MADRID = { minLat: 39.85, maxLat: 41.22, minLon: -4.65, maxLon: -3.05 };
const mem = new Map();
let rejected = null;
let fixturePromise = null;

export function fixturesEnabled() {
  if (typeof location === "undefined") return false;
  const flag = new URLSearchParams(location.search).get("fixtures");
  if (flag === "0") return false;
  if (flag === "1") return true;
  const host = location.hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}

export function tomtomUserMessage(status, code) {
  if (status === 403 || code === "InvalidReferer" || code === "Forbidden") {
    return `TomTom ha rechazado la petición${code ? ` (${code})` : ""}. La clave solo está autorizada en alodyn.github.io.`;
  }
  if (status === 429) return "TomTom ha limitado las peticiones de esta clave. Conviene esperar un poco.";
  if (status) return `TomTom no ha completado la petición (${code || status}).`;
  return "No hay conexión con TomTom.";
}

export class TomTomError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = "TomTomError";
    this.status = extra.status || 0;
    this.code = extra.code || "";
    this.userMessage = extra.userMessage || message;
  }
}

async function loadFixture() {
  if (!fixturePromise) {
    const url = new URL("../fixtures/tomtom-sample.json", import.meta.url);
    fixturePromise = fetch(url).then((r) => {
      if (!r.ok) throw new TomTomError("No está la muestra local de TomTom.", { code: "FIXTURE" });
      return r.json();
    });
  }
  return fixturePromise;
}

function inMadrid(lat, lon) {
  return lat >= MADRID.minLat && lat <= MADRID.maxLat && lon >= MADRID.minLon && lon <= MADRID.maxLon;
}

export function mapSearchResults(payload) {
  const rows = [];
  for (const r of payload?.results || []) {
    if (!r.position) continue;
    const address = r.address || {};
    if (address.countryCode && address.countryCode !== "ES") continue;
    const poi = r.poi?.name;
    const free = address.freeformAddress || "";
    let label = poi || free || address.municipality || "Resultado";
    if (poi && free && !free.toLowerCase().includes(poi.toLowerCase())) {
      label = `${poi}, ${free}`;
    }
    rows.push({
      label: label.replace(/\s+/g, " ").trim(),
      lat: r.position.lat,
      lon: r.position.lon,
      municipality: address.municipality || address.localName || "",
      kind: poi ? "Lugar" : (r.entityType === "Municipality" ? "Municipio" : "Dirección")
    });
  }
  const here = rows.filter((r) => inMadrid(r.lat, r.lon));
  return here.length ? here : rows;
}

function fixtureSearch(fixture, query) {
  const q = norm(query);
  const bag = fixture.search.queries;
  let payload = null;
  if (/hospital|octubre|doce/.test(q)) payload = bag.hospital;
  else if (/grinon|calle real/.test(q)) payload = bag.grinon;
  if (!payload) {
    return {
      results: [],
      source: "fixture",
      notice: "La muestra local solo incluye Griñón y el Hospital 12 de Octubre."
    };
  }
  return {
    results: mapSearchResults(payload),
    source: "fixture",
    notice: "Búsqueda de la muestra local, con las coordenadas de la ruta grabada. No es una respuesta de Search capturada."
  };
}

function near(a, b, km = 0.4) {
  const dLat = (a.lat - b.lat) * 111;
  const dLon = (a.lon - b.lon) * 111 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot(dLat, dLon) <= km;
}

export function parseRoute(payload) {
  const route = payload?.routes?.[0];
  if (!route?.summary) {
    const code = payload?.detailedError?.code || "NO_ROUTE";
    const message = payload?.detailedError?.message || "TomTom no ha devuelto una ruta.";
    throw new TomTomError(message, { code, userMessage: tomtomUserMessage(0, code) || message });
  }
  const summary = route.summary;
  const points = (route.legs || [])
    .flatMap((leg) => leg.points || [])
    .map((p) => [p.latitude, p.longitude]);
  const noTraffic = summary.noTrafficTravelTimeInSeconds;
  const fromFreeFlow = noTraffic == null ? 0 : Math.max(0, summary.travelTimeInSeconds - noTraffic);
  const delayS = Math.max(summary.trafficDelayInSeconds || 0, fromFreeFlow);
  return {
    lengthM: summary.lengthInMeters,
    travelS: summary.travelTimeInSeconds,
    delayS,
    reportedDelayS: summary.trafficDelayInSeconds || 0,
    departure: summary.departureTime || null,
    arrival: summary.arrivalTime || null,
    points
  };
}

export async function searchPlaces(query, { signal } = {}) {
  const q = String(query || "").trim();
  if (q.length < 3) return { results: [], source: "none", notice: "" };
  const cacheKey = "s:" + norm(q);
  if (mem.has(cacheKey)) return mem.get(cacheKey);

  if (fixturesEnabled()) {
    const found = fixtureSearch(await loadFixture(), q);
    if (found.results.length) mem.set(cacheKey, found);
    return found;
  }
  if (rejected) throw rejected;

  const bias = CONFIG.madridBias;
  const url = `${CONFIG.tomtomSearch}${encodeURIComponent(q)}.json?key=${encodeURIComponent(CONFIG.tomtomKey)}`
    + `&countrySet=ES&language=es-ES&limit=6&lat=${bias.lat}&lon=${bias.lon}&radius=${bias.radius}`
    + "&idxSet=Geo,PAD,Str,Addr,POI";
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new TomTomError("No hay conexión con TomTom.", { userMessage: "No hay conexión con TomTom." });
  }
  if (!res.ok) {
    const err = await errorFrom(res);
    if (res.status === 403 || res.status === 401) rejected = err;
    throw err;
  }
  const payload = await res.json();
  const found = { results: mapSearchResults(payload), source: "tomtom", notice: "" };
  mem.set(cacheKey, found);
  try { sessionStorage.setItem("trips.tomtom." + cacheKey, JSON.stringify(found)); } catch { /* cuota */ }
  return found;
}

export async function routeCar({ from, to, departAt, signal }) {
  const depart = departAt instanceof Date ? departAt.toISOString() : String(departAt);
  const cacheKey = `r:${from.lat.toFixed(4)},${from.lon.toFixed(4)}:${to.lat.toFixed(4)},${to.lon.toFixed(4)}:${depart.slice(0, 16)}`;
  if (mem.has(cacheKey)) return mem.get(cacheKey);
  try {
    const saved = sessionStorage.getItem("trips.tomtom." + cacheKey);
    if (saved) {
      const parsed = JSON.parse(saved);
      mem.set(cacheKey, parsed);
      return parsed;
    }
  } catch { /* sesión vacía */ }

  if (fixturesEnabled()) {
    const fixture = await loadFixture();
    const sample = fixture.routing;
    const hit = near(from, sample.from) && near(to, sample.to);
    if (!hit) {
      throw new TomTomError(
        "Ese tramo no está en la muestra local.",
        {
          code: "FIXTURE_MISS",
          userMessage: "Este tramo no está en la muestra local, así que no hay un tiempo de coche."
        }
      );
    }
    const route = parseRoute(sample.response);
    const out = {
      ...route,
      source: "fixture",
      notice: "Respuesta real de TomTom grabada el 12/11/2026 para salir a las 7:00. No es una llamada en vivo."
    };
    mem.set(cacheKey, out);
    return out;
  }
  if (rejected) throw rejected;

  const path = `${from.lat},${from.lon}:${to.lat},${to.lon}`;
  const url = `${CONFIG.tomtomRoute}${path}/json?key=${encodeURIComponent(CONFIG.tomtomKey)}`
    + `&traffic=true&travelMode=car&routeType=fastest&computeTravelTimeFor=all`
    + `&departAt=${encodeURIComponent(depart)}`;
  let res;
  try {
    res = await fetch(url, { signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    throw new TomTomError("No hay conexión con TomTom.", { userMessage: "No hay conexión con TomTom." });
  }
  if (!res.ok) {
    const err = await errorFrom(res);
    if (res.status === 403 || res.status === 401) rejected = err;
    throw err;
  }
  const route = parseRoute(await res.json());
  const out = { ...route, source: "tomtom", notice: "" };
  mem.set(cacheKey, out);
  try { sessionStorage.setItem("trips.tomtom." + cacheKey, JSON.stringify(out)); } catch { /* cuota */ }
  return out;
}

export function clearTomTomRejection() {
  rejected = null;
}

async function errorFrom(res) {
  let body = null;
  try { body = await res.json(); } catch { /* cuerpo vacío */ }
  const code = body?.detailedError?.code || String(res.status);
  const message = body?.detailedError?.message || "";
  return new TomTomError(message || code, {
    status: res.status,
    code,
    userMessage: tomtomUserMessage(res.status, code)
  });
}

export function restoreSessionCache() {
  /* La caché se lee perezosa en cada petición. Esta función existe para dejar
     claro que no hay una segunda caché persistente: solo sessionStorage. */
}
