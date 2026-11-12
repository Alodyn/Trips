/**
 * Transporte público con OpenTripPlanner 2 (GraphQL `plan`).
 *
 * El servidor se configura en CONFIG.otpBase o, para pruebas, con
 * `?otp=http://127.0.0.1:8080` (se recuerda en localStorage "trips.v1.otp";
 * `?otp=off` lo olvida). Sin servidor, `planTransit` devuelve "pending" y la
 * interfaz no pinta minutos.
 *
 * El tramo en coche del park and ride no se pide aquí. OTP no usa tráfico;
 * ese tramo lo calcula TomTom en js/tomtom.js y el transporte sale del
 * aparcamiento a la hora en que se llega en coche.
 *
 * Calidad de datos: el GTFS de interurbanos del CRTM trae viajes imposibles
 * (el 223 Alcalá–Av. América en 12 min, cuando el real ronda los 40 o más).
 * Cada itinerario se revisa por velocidad media de sus tramos; los viajes
 * imposibles se excluyen por `trip` y se vuelve a preguntar.
 */

import { CONFIG } from "../config.js";

const MAX_KMH = { BUS: 65, TRAM: 70, SUBWAY: 90, RAIL: 140, FERRY: 60 };
const MAX_ROUNDS = 6;
const WALK_REMARK_M = 1800;

const QUERY = `query Plan($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!, $banned: InputBanned, $modes: [TransportMode], $walkReluctance: Float) {
  plan(from: $from, to: $to, date: $date, time: $time, numItineraries: 5, banned: $banned, walkReluctance: $walkReluctance,
       transportModes: $modes) {
    itineraries {
      duration startTime endTime walkDistance numberOfTransfers
      legs {
        mode startTime endTime duration distance headsign
        from { name lat lon }
        to { name lat lon }
        route { gtfsId shortName longName color }
        trip { gtfsId }
      }
    }
  }
}`;

export function otpBase() {
  try {
    if (typeof location !== "undefined") {
      const flag = new URLSearchParams(location.search).get("otp");
      if (flag === "off") localStorage.removeItem("trips.v1.otp");
      else if (flag) localStorage.setItem("trips.v1.otp", flag.replace(/\/+$/, ""));
      const saved = localStorage.getItem("trips.v1.otp");
      if (saved) return saved;
    }
  } catch { /* sin almacenamiento */ }
  return CONFIG.otpBase || null;
}

function madridDateTime(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function legSpeedKmh(leg) {
  return leg.duration > 0 ? (leg.distance / leg.duration) * 3.6 : Infinity;
}

/** Tramos de transporte con una velocidad media que no puede ser real. */
export function impossibleLegs(itinerary) {
  return (itinerary.legs || []).filter((leg) => leg.trip && leg.distance > 3000
    && legSpeedKmh(leg) > (MAX_KMH[leg.mode] || 140));
}

async function ask(base, variables, signal) {
  const res = await fetch(`${base}/otp/gtfs/v1`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables })
  });
  if (!res.ok) throw new Error(`OTP ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(body.errors[0].message || "OTP");
  return body.data?.plan?.itineraries || [];
}

const SMALL = new Set(["de", "del", "la", "las", "el", "los", "y", "a", "en"]);

/** El GTFS de Metro trae las paradas en mayúsculas: "PUERTA DE ARGANDA" → "Puerta de Arganda". */
export function stopName(name) {
  if (!name || name !== name.toUpperCase() || !/[A-ZÁÉÍÓÚÑ]{3}/.test(name)) return name;
  return name.toLowerCase().split(/(\s+|-|\.|\/)/).map((w, i) => {
    if (!w.trim() || /^[-./]$/.test(w)) return w;
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join("");
}

function mapLeg(leg) {
  return {
    mode: leg.mode,
    from: leg.from?.name === "Origin" ? null : stopName(leg.from?.name),
    to: leg.to?.name === "Destination" ? null : stopName(leg.to?.name),
    route: leg.route?.shortName || null,
    routeId: leg.route?.gtfsId || null,
    color: leg.route?.color || null,
    headsign: stopName(leg.headsign) || null,
    startTime: new Date(leg.startTime).toISOString(),
    endTime: new Date(leg.endTime).toISOString(),
    durationMin: Math.max(1, Math.round(leg.duration / 60)),
    distanceM: Math.round(leg.distance)
  };
}

/**
 * `walkOnly`: solo a pie (último tramo andando).
 * `requireTransit`: el mejor itinerario que use al menos un tramo de transporte
 * (para comparar "andando" con "en metro" aunque andar sea más rápido).
 */
export async function planTransit({ from, to, departAt, signal, walkOnly = false, requireTransit = false }) {
  const base = otpBase();
  if (!base) {
    return {
      status: "pending",
      reason: "no-otp",
      itinerary: null,
      message: "Pendiente de horarios. El planificador (OpenTripPlanner) todavía no está conectado."
    };
  }
  const when = madridDateTime(departAt instanceof Date ? departAt : new Date(departAt));
  const variables = {
    from: { lat: from.lat, lon: from.lon },
    to: { lat: to.lat, lon: to.lon },
    date: when.date,
    time: when.time,
    banned: null,
    modes: walkOnly ? [{ mode: "WALK" }] : [{ mode: "TRANSIT" }, { mode: "WALK" }],
    // Para forzar una alternativa en transporte se penaliza andar; los minutos que se pintan son los reales del itinerario.
    walkReluctance: requireTransit ? 6 : 2
  };
  const bannedTrips = [];
  const flagged = new Map();
  let itineraries = [];
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      itineraries = await ask(base, variables, signal);
      const bad = itineraries.flatMap(impossibleLegs);
      if (!bad.length) break;
      for (const leg of bad) {
        bannedTrips.push(leg.trip.gtfsId);
        const key = leg.route?.shortName || leg.mode;
        if (!flagged.has(key)) {
          flagged.set(key, { route: key, minutes: Math.round(leg.duration / 60), km: Math.round(leg.distance / 1000) });
        }
      }
      variables.banned = { trips: [...new Set(bannedTrips)].join(",") };
      if (round === MAX_ROUNDS - 1) itineraries = itineraries.filter((it) => !impossibleLegs(it).length);
    }
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    return { status: "error", reason: "otp", itinerary: null, message: "El planificador de horarios no responde." };
  }
  if (requireTransit) itineraries = itineraries.filter((it) => it.legs.some((l) => l.mode !== "WALK"));
  if (!itineraries.length) {
    return { status: "none", reason: "no-route", itinerary: null, message: "OpenTripPlanner no encuentra un itinerario a esa hora." };
  }
  const departMs = new Date(departAt).getTime();
  const best = [...itineraries].sort((a, b) => a.endTime - b.endTime || a.numberOfTransfers - b.numberOfTransfers)[0];
  const legs = best.legs.map(mapLeg);
  const flaggedList = [...flagged.values()];
  const remarks = [];
  if (flaggedList.length) {
    remarks.push(`Descartados horarios imposibles del CRTM: ${flaggedList.map((f) => `${f.route} (${f.km} km en ${f.minutes} min)`).join(", ")}.`);
  }
  if (legs.some((l) => l.mode === "SUBWAY")) {
    remarks.push("Metro con los horarios de 2025 adaptados: el GTFS oficial está caducado.");
  }
  const firstWalk = legs[0]?.mode === "WALK" ? legs[0].distanceM : 0;
  if (firstWalk > WALK_REMARK_M) remarks.push(`Empieza con ${(firstWalk / 1000).toFixed(1).replace(".", ",")} km a pie.`);
  return {
    status: "ok",
    itinerary: {
      durationMin: Math.round(best.duration / 60),
      waitMin: Math.max(0, Math.round((best.startTime - departMs) / 60000)),
      startTime: new Date(best.startTime).toISOString(),
      endTime: new Date(best.endTime).toISOString(),
      transfers: best.numberOfTransfers,
      walkM: Math.round(best.walkDistance),
      legs
    },
    flagged: flaggedList,
    remarks,
    message: remarks.join(" ")
  };
}

export function transitIsReal(plan) {
  return Boolean(
    plan
    && plan.status === "ok"
    && plan.itinerary
    && Number.isFinite(plan.itinerary.durationMin)
  );
}

/** Líneas de un itinerario, en orden: "C2 · 9". */
export function lineSummary(plan) {
  if (!transitIsReal(plan)) return "";
  return plan.itinerary.legs.filter((l) => l.mode !== "WALK").map((l) => l.route || l.mode).join(" · ");
}

const PR_QUERY = `query PR($from: InputCoordinates!, $to: InputCoordinates!, $date: String!, $time: String!) {
  plan(from: $from, to: $to, date: $date, time: $time, numItineraries: 6,
       transportModes: [{ mode: CAR, qualifier: PARK }, { mode: TRANSIT }, { mode: WALK }]) {
    itineraries { legs { mode to { name lat lon } } }
  }
}`;

/**
 * Aparcamientos disuasorios que propone el park and ride de OTP (sin tráfico).
 * Solo se usan como candidatos: el tiempo en coche lo vuelve a pedir TomTom.
 */
export async function parkRideHints({ from, to, departAt, signal }) {
  const base = otpBase();
  if (!base) return [];
  const when = madridDateTime(departAt instanceof Date ? departAt : new Date(departAt));
  try {
    const res = await fetch(`${base}/otp/gtfs/v1`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: PR_QUERY,
        variables: { from: { lat: from.lat, lon: from.lon }, to: { lat: to.lat, lon: to.lon }, date: when.date, time: when.time }
      })
    });
    if (!res.ok) return [];
    const body = await res.json();
    const out = [];
    for (const it of body.data?.plan?.itineraries || []) {
      const car = (it.legs || []).find((l) => l.mode === "CAR");
      if (car?.to && Number.isFinite(car.to.lat)) out.push({ name: car.to.name, lat: car.to.lat, lon: car.to.lon });
    }
    return out;
  } catch {
    return [];
  }
}
