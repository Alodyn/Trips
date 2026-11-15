/**
 * Aparcar en destino para quien va a trabajar: una jornada entera, no una visita.
 *
 * Alternativas (data/dest_parking.json, solo Madrid por ahora):
 *  - zona blanca: la calle sin SER más cercana, coche hasta allí + búsqueda + a pie o un salto en transporte;
 *  - aparcamiento público: municipal (tarifa 2026 por minutos) o privado con precio de día publicado;
 *  - plaza alquilada al mes: precio que pone el usuario (por defecto, la referencia de la zona);
 *  - SER: solo si la estancia regulada cabe en el máximo para no residentes;
 *  - plaza propia en destino ("Tengo plaza en destino"): el comportamiento de siempre.
 * Los tiempos de búsqueda son estimaciones y la interfaz lo dice.
 */

import { haversineKm, pointInRing } from "./geo.js";
import { madridParts } from "./format.js";

export const SEARCH_MIN = { white: 12, whiteInside: 6, carpark: 3, rent: 2, ser: 8, own: 0 };
const NEAR_PARK_KM = 1.2;

let DOC = null;
export function setDestParkingDb(doc) { DOC = doc; }
export function destParkingDb() { return DOC; }

/** Clave por destino (unos 100 m) para "Tengo plaza en destino" y el alquiler. */
export function destKey(dest) {
  return `${dest.lat.toFixed(3)},${dest.lon.toFixed(3)}`;
}

export function inSer(p) {
  return Boolean(DOC?.ser?.polygon && pointInRing(p.lon, p.lat, DOC.ser.polygon));
}

/** Coste municipal por tramos de minutos (Madrid 2026). */
export function municipalCost(minutes, tariff) {
  if (!tariff) return null;
  if (minutes >= tariff.capFromMin) return tariff.cap;
  let left = minutes;
  let prev = 0;
  let euros = 0;
  for (const [upTo, perMin] of tariff.steps) {
    const span = Math.min(left, upTo - prev);
    if (span <= 0) break;
    euros += span * perMin;
    left -= span;
    prev = upTo;
  }
  return Math.round(Math.min(euros, tariff.cap) * 100) / 100;
}

/** Minutos de la estancia que caen en horario SER (laborables 9–21, sábados y agosto 9–15). */
export function serRegulatedMinutes(arrive, stayMin) {
  const hours = DOC?.ser?.hours;
  if (!hours) return 0;
  let total = 0;
  const STEP = 5;
  for (let t = arrive.getTime(); t < arrive.getTime() + stayMin * 60000; t += STEP * 60000) {
    const d = new Date(t);
    const p = madridParts(d);
    const dow = new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay();
    let span = null;
    if (dow === 0) span = null;
    else if (dow === 6 || p.m === 8) span = hours.saturday;
    else span = hours.weekday;
    if (span && p.hh >= span[0] && p.hh < span[1]) total += STEP;
  }
  return total;
}

export function serVerdict(arrive, stayMin) {
  const ser = DOC?.ser;
  const regulated = serRegulatedMinutes(arrive, stayMin);
  const blue = ser.nonResident.blue;
  if (regulated === 0) return { valid: true, regulated, cost: 0, label: "Fuera del horario SER" };
  if (regulated > blue.maxMin) {
    return {
      valid: false,
      regulated,
      cost: null,
      label: "No válido para jornada completa",
      why: `Tu estancia tiene ${String(Math.round((regulated / 60) * 10) / 10).replace(".", ",")} h en horario SER y el máximo para no residentes es de 4 h en azul y 2 h en verde`
    };
  }
  const row = blue.table.find(([m]) => regulated <= m) || blue.table[blue.table.length - 1];
  return { valid: true, regulated, cost: row[1], label: "Plaza azul" };
}

function walkMinEstimate(a, b) {
  return Math.max(1, Math.round((haversineKm(a, b) * 1.3) / 4.6 * 60));
}

/** Referencia de alquiler de plaza en la zona del destino, si la hay. */
export function rentReference(dest) {
  return (DOC?.garageRent || []).find((r) => haversineKm(r, dest) <= r.radiusKm) || null;
}

const DEFAULT_STAY_MIN = 540;

function dedupe(points, km) {
  const out = [];
  for (const p of points) if (!out.some((q) => haversineKm(p, q) < km)) out.push(p);
  return out;
}

async function hopFor(planTransit, from, to, at, variant) {
  const plan = await planTransit({ from, to, departAt: at, walkOnly: variant === "walk", requireTransit: variant === "transit" });
  if (plan?.status !== "ok") return null;
  const it = plan.itinerary;
  const transit = it.legs.some((l) => l.mode !== "WALK");
  if (variant === "transit" && !transit) return null;
  return { min: it.durationMin + it.waitMin, plan, transit, variant };
}

/** Puntos de zona blanca que conviene probar: a pie (los más cercanos) y junto a estación (coche + metro). */
function whiteCandidates(dest) {
  const all = DOC.whiteStreets;
  const byDist = [...all].sort((a, b) => haversineKm(a, dest) - haversineKm(b, dest));
  const walk = dedupe(byDist, 0.3).slice(0, 5);
  const stations = (DOC.whiteStations || [])
    .map((st) => ({ st, km: haversineKm(st, dest) }))
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
  const metro = stations.map(({ st }) => all
    .filter((w) => w.st?.name === st.name)
    .sort((a, b) => a.st.m - b.st.m)[0]).filter(Boolean);
  return { walk, metro };
}

/**
 * Alternativas de aparcamiento en destino, con ida y (si hay) vuelta.
 * `drive(from, to, at, dir)` devuelve una ruta de TomTom con el margen de tráfico aplicado (`s`).
 */
export async function planDestParking(ctx) {
  const { origin, dest, departAt, returnAt, directOut, directBack, drive, planTransit, prefs = {}, searchMin = 5 } = ctx;
  if (!DOC) return { city: null, options: [] };
  const destInSer = inSer(dest);
  const madrid = dest.zone === "A";
  const options = [];
  const arriveDirect = new Date(departAt.getTime() + directOut.s * 1000);
  const stayMin = returnAt ? Math.max(30, Math.round((returnAt - arriveDirect) / 60000)) : DEFAULT_STAY_MIN;
  const usual = prefs.usual || null;
  const usualSearch = usual?.searchMin ?? searchMin;
  const backDirect = (extraMin) => directBack ? { route: directBack, carS: directBack.s + extraMin * 60 } : null;

  options.push({ kind: "own", label: "Plaza en destino", searchMin: 0, out: { route: directOut, carS: directOut.s, hop: null }, back: directBack ? { ...backDirect(0), hop: null } : null, day: 0, valid: true });

  if (!madrid) {
    options.push({ kind: "unknown", label: "Aparcar en destino", searchMin: 0, out: { route: directOut, carS: directOut.s, hop: null }, back: directBack ? { ...backDirect(0), hop: null } : null, day: null, valid: false, why: "Fuera de Madrid no hay datos de aparcamiento todavía." });
    return { city: null, inSer: false, stayMin, options };
  }

  /** Zona blanca en un punto con una variante de último tramo, ida y vuelta. */
  const whiteRow = async (point, variant, { isUsual = false, hopOut = null } = {}) => {
    const sMin = isUsual ? usualSearch : searchMin;
    const route = await drive(origin, point, departAt, "out");
    const at = new Date(departAt.getTime() + (route.s + sMin * 60) * 1000);
    const hop = await hopFor(planTransit, point, dest, at, variant) || (variant === "walk" ? hopOut : null);
    if (!hop) return null;
    let back = null;
    if (returnAt) {
      const hopBack = await hopFor(planTransit, dest, point, returnAt, variant);
      if (hopBack) {
        const carBack = await drive(point, origin, new Date(returnAt.getTime() + hopBack.min * 60000), "back");
        back = { hop: hopBack, route: carBack, carS: carBack.s };
      }
    }
    return {
      kind: "white", variant, usual: isUsual, inside: false, point,
      label: `${variant === "transit" ? "Coche + metro" : "Zona blanca"} · ${point.street || point.label || "calle sin SER"}`,
      searchMin: sMin, out: { route, carS: route.s, hop }, back, day: 0, valid: true
    };
  };

  const rows = [];
  if (!destInSer) {
    options.push({ kind: "white", variant: "walk", inside: true, label: "Calle sin SER junto al destino", searchMin, out: { route: directOut, carS: directOut.s, hop: { min: 3, estimated: true } }, back: directBack ? { ...backDirect(3), hop: { min: 3, estimated: true } } : null, day: 0, valid: true });
  } else {
    const { walk, metro } = whiteCandidates(dest);
    const at = new Date(arriveDirect.getTime() + searchMin * 60000);
    const walkHops = (await Promise.all(walk.map(async (p) => ({ p, hop: await hopFor(planTransit, p, dest, at, "walk") }))))
      .filter((h) => h.hop).sort((a, b) => a.hop.min - b.hop.min).slice(0, 2);
    const metroHops = (await Promise.all(metro.map(async (p) => ({ p, hop: await hopFor(planTransit, p, dest, at, "transit") }))))
      .filter((h) => h.hop).sort((a, b) => a.hop.min - b.hop.min).slice(0, 1);
    const tasks = [
      ...walkHops.map(({ p, hop }) => whiteRow(p, "walk", { hopOut: hop })),
      ...metroHops.map(({ p }) => whiteRow(p, "transit"))
    ];
    if (usual) tasks.push(whiteRow(usual, "walk", { isUsual: true }), whiteRow(usual, "transit", { isUsual: true }));
    const done = (await Promise.all(tasks.map((t) => t.catch(() => null)))).filter(Boolean);
    const tot = (r) => r.out.carS / 60 + r.searchMin + r.out.hop.min;
    const bestWalk = done.filter((r) => !r.usual && r.variant === "walk").sort((a, b) => tot(a) - tot(b))[0];
    const bestMetro = done.filter((r) => !r.usual && r.variant === "transit").sort((a, b) => tot(a) - tot(b))[0];
    rows.push(...done.filter((r) => r.usual), ...[bestWalk, bestMetro].filter(Boolean));
    options.push(...rows);
  }

  // Aparcamientos públicos cerca.
  const tariff = (id) => DOC.tariffs?.[id] || null;
  const near = DOC.carParks
    .map((cp) => ({ cp, km: haversineKm(cp, dest) }))
    .filter((r) => r.km <= NEAR_PARK_KM)
    .sort((a, b) => a.km - b.km)
    .slice(0, 6);
  const parkAt = new Date(arriveDirect.getTime() + (60 + SEARCH_MIN.carpark * 60) * 1000);
  const parkRows = await Promise.all(near.map(async ({ cp }) => {
    const day = cp.tariff ? municipalCost(stayMin, tariff(cp.tariff)) : cp.day;
    const hop = await hopFor(planTransit, cp, dest, parkAt, "walk");
    const hopMin = hop ? hop.min : walkMinEstimate(cp, dest);
    return {
      kind: "carpark", label: cp.name, park: cp, searchMin: SEARCH_MIN.carpark,
      out: { route: directOut, carS: directOut.s + 60, hop: hop || { min: hopMin, estimated: true } },
      back: directBack ? { ...backDirect(1), hop: { min: hopMin, estimated: !hop } } : null,
      day, source: cp.tariff ? tariff(cp.tariff).source : cp.source, valid: true
    };
  }));
  const priced = parkRows.filter((r) => r.day != null).sort((a, b) => a.day - b.day || a.out.hop.min - b.out.hop.min);
  const unpriced = parkRows.filter((r) => r.day == null);
  if (priced[0]) options.push({ ...priced[0], others: [...priced.slice(1), ...unpriced] });
  else if (unpriced[0]) options.push({ ...unpriced[0], others: unpriced.slice(1) });

  // Plaza alquilada al mes.
  const ref = rentReference(dest);
  const rentWalk = ref?.walkMin ?? 6;
  options.push({
    kind: "rent", label: "Plaza de garaje alquilada", searchMin: SEARCH_MIN.rent,
    out: { route: directOut, carS: directOut.s + 60, hop: { min: rentWalk, estimated: true } },
    back: directBack ? { ...backDirect(1), hop: { min: rentWalk, estimated: true } } : null,
    day: 0, monthlyFixedRef: ref?.median ?? null, ref, valid: true
  });

  // SER.
  const serArrive = new Date(arriveDirect.getTime() + SEARCH_MIN.ser * 60000);
  const ser = serVerdict(serArrive, stayMin);
  options.push({
    serArrive: serArrive.toISOString(),
    kind: "ser", label: "SER en la calle", searchMin: SEARCH_MIN.ser,
    out: { route: directOut, carS: directOut.s, hop: { min: 3, estimated: true } },
    back: directBack ? { ...backDirect(3), hop: { min: 3, estimated: true } } : null,
    day: ser.valid ? ser.cost : null, valid: ser.valid, why: ser.why, ser
  });

  return { city: "Madrid", inSer: destInSer, stayMin, options };
}

function restay(o, stayMin) {
  if (!stayMin) return o;
  if (o.kind === "carpark") {
    const dayOf = (r) => (r.park?.tariff ? municipalCost(stayMin, DOC?.tariffs?.[r.park.tariff]) : r.day);
    const others = (o.others || []).map((r) => ({ ...r, day: dayOf(r) }));
    const t = o.park?.tariff ? DOC.tariffs[o.park.tariff] : null;
    return { ...o, day: dayOf(o), others, dayNote: t ? `${t.label}, ${String(Math.round(stayMin / 6) / 10).replace(".", ",")} h` : (o.park?.dayNote || "") };
  }
  if (o.kind === "ser" && o.serArrive && DOC) {
    const ser = serVerdict(new Date(o.serArrive), stayMin);
    return { ...o, ser, valid: ser.valid, why: ser.why, day: ser.valid ? ser.cost : null };
  }
  return o;
}

/**
 * Pone números a cada alternativa (ida, vuelta, al día, al mes) y elige una.
 * prefs: { own, rent, usual }. ticket: precio del sencillo de Metro en el último tramo (0 si ya hay abono).
 */
export function priceParking(analysis, { days, fuel, prefs, stayMin, ticket = 0, roundTrip = true }) {
  const rows = (analysis?.options || []).map((o0) => {
    const o = restay(o0, stayMin ?? analysis.stayMin);
    const back = roundTrip ? o.back : null;
    const fOut = o.out?.route ? fuel(o.out.route.lengthM / 1000) : null;
    const fBack = back?.route ? fuel(back.route.lengthM / 1000) : null;
    const fixed = o.kind === "rent" ? (prefs.rent ?? o.monthlyFixedRef) : 0;
    const tickets = (o.out?.hop?.transit ? 1 : 0) + (back?.hop?.transit ? 1 : 0);
    const ticketsDay = tickets * ticket;
    const missingBack = roundTrip && !back;
    const known = fOut && (!back || fBack) && o.valid && (o.kind !== "rent" || fixed != null) && o.day != null && !missingBack;
    const fuelDay = known ? fOut.euros + (fBack ? fBack.euros : 0) : null;
    const perDay = known ? fuelDay + o.day + ticketsDay + (fixed ? fixed / days : 0) : null;
    const monthly = known ? (fuelDay + o.day + ticketsDay) * days + (fixed || 0) : null;
    const outMin = o.out?.carS != null ? Math.round(o.out.carS / 60) + o.searchMin + (o.out.hop?.min || 0) : null;
    const backMin = back?.carS != null ? Math.round(back.carS / 60) + (back.hop?.min || 0) : null;
    return { ...o, back, fuelOut: fOut, fuelBack: fBack, fuelDay, fixed, tickets, ticket, ticketsDay, perDay, monthly, outMin, backMin, totalMin: outMin, dayMin: outMin != null && (backMin != null || !roundTrip) ? outMin + (backMin || 0) : null };
  });
  const both = (r) => r.dayMin ?? r.outMin ?? Infinity;
  let picked;
  if (prefs.own) picked = rows.find((r) => r.kind === "own");
  else {
    const usual = rows.filter((r) => r.usual && r.monthly != null).sort((a, b) => both(a) - both(b));
    if (usual[0]) {
      picked = usual[0];
      usual[0].fasterUsual = true;
    } else {
      const pool = rows.filter((r) => r.kind !== "own" && r.monthly != null && r.outMin != null);
      pool.sort((a, b) => a.monthly - b.monthly || both(a) - both(b));
      picked = pool[0] || rows.find((r) => r.kind === "unknown") || rows.find((r) => r.kind === "own");
    }
  }
  return { rows, picked };
}
