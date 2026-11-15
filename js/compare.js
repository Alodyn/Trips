import { recommendFare } from "./fares.js";
import { fuelCost } from "./fuel.js";
import { todayISO } from "./format.js";
import { parkCandidates } from "./parkride.js";
import { planTransit, transitIsReal, parkRideHints } from "./transit.js";
import { haversineKm } from "./geo.js";
import { routeCar } from "./tomtom.js";
import { applyTraffic } from "./traffic.js";
import { planDestParking, priceParking } from "./destpark.js";

const PARK_BUFFER_S = 180;   // aparcar y llegar al andén
const UNPARK_BUFFER_S = 120; // a la vuelta, del andén al coche
const NEAR_DEST_KM = 3;

/**
 * Candidatos de park and ride: el habitual, la estación con aparcamiento más
 * cercana al origen en el sentido del viaje, los del corredor y los que propone
 * OTP. Sin los que están pegados al destino (eso es ir en coche).
 */
async function parkRideCandidates(origin, dest, departAt, pool, usual) {
  const picked = parkCandidates(origin, dest, pool, { usual, nearDestKm: NEAR_DEST_KM });
  const hints = await parkRideHints({ from: origin, to: dest, departAt });
  for (const hint of hints) {
    const match = pool
      .map((p) => ({ p, d: haversineKm(p, hint) }))
      .sort((a, b) => a.d - b.d)[0];
    if (!match || match.d > 0.7) continue;
    const parking = match.p;
    if (haversineKm(parking, dest) < NEAR_DEST_KM) continue;
    if (picked.some((row) => haversineKm(row.parking, parking) < 1.2)) continue;
    picked.push({
      parking,
      driveKm: haversineKm(origin, parking),
      remainKm: haversineKm(parking, dest),
      source: "otp"
    });
  }
  return picked.slice(0, 9);
}

export function tripsOf(profile, roundTrip) {
  return Math.max(1, Number(profile.days) || 1) * (roundTrip ? 2 : 1);
}

/**
 * Compara coche, transporte y combinada para la ida y, si hay hora de vuelta, para la vuelta.
 * traffic: { out: % | null, back: % | null } margen de tráfico del trayecto (null = automático).
 */
export async function compareTrip({ origin, dest, departAt, returnAt = null, profile, fuelQuote, parkings, usual = null, parkPrefs = {}, traffic = {} }) {
  const onDate = todayISO(departAt);
  const roundTrip = Boolean(profile.roundTrip && returnAt);
  const trips = tripsOf(profile, roundTrip);
  const directZones = [origin.zone, dest.zone].filter(Boolean);
  const drive = async (from, to, at, dir) => applyTraffic(await routeCar({ from, to, departAt: at }), at, traffic[dir] ?? null);

  const carCall = (async () => {
    const out = await drive(origin, dest, departAt, "out");
    const back = roundTrip ? await drive(dest, origin, returnAt, "back").catch(() => null) : null;
    let parking;
    try {
      parking = await planDestParking({
        origin, dest, departAt, returnAt: roundTrip ? returnAt : null, directOut: out, directBack: back,
        drive, planTransit, prefs: parkPrefs, searchMin: Number(profile.searchMin ?? 5)
      });
    } catch (err) {
      parking = { city: null, options: [], error: messageOf(err) };
    }
    return { ok: true, route: out, back, parking };
  })().catch((error) => ({ ok: false, error }));

  const candidates = await parkRideCandidates(origin, dest, departAt, parkings, usual);
  const legCalls = candidates.map(async (candidate) => {
    const zones = [candidate.parking.zone, dest.zone].filter(Boolean);
    const fare = zones.length ? recommendFare({ zones, age: profile.age, trips, onDate }) : null;
    let route = null;
    let error = null;
    try {
      route = await drive(origin, candidate.parking, departAt, "out");
    } catch (err) {
      error = err;
    }
    // El transporte sale del aparcamiento cuando se llega en coche, más lo que cuesta aparcar.
    const leaveAt = route ? new Date(departAt.getTime() + (route.s + PARK_BUFFER_S) * 1000) : departAt;
    const transit = await planTransit({ from: candidate.parking, to: dest, departAt: leaveAt });
    return route
      ? { ok: true, route, candidate, transit, fare, parkBufferMin: PARK_BUFFER_S / 60 }
      : { ok: false, error, candidate, transit, fare };
  });

  const [carRaw, transitPlan, transitBack, ...legs] = await Promise.all([
    carCall,
    planTransit({ from: origin, to: dest, departAt }),
    roundTrip ? planTransit({ from: dest, to: origin, departAt: returnAt }) : Promise.resolve(null),
    ...legCalls
  ]);

  const transitFare = directZones.length ? recommendFare({ zones: directZones, age: profile.age, trips, onDate }) : null;

  // Combinada: primero se ordena por la ida; la vuelta se calcula para las que se enseñan.
  const combined = priceCombined(legs, profile, fuelQuote, trips, departAt.toISOString(), roundTrip);
  if (roundTrip) {
    await Promise.all(combined.options.map(async (leg) => {
      if (!leg.ok) return;
      const transit = await planTransit({ from: dest, to: leg.candidate.parking, departAt: returnAt });
      if (!transitIsReal(transit)) { leg.back = { transit, route: null }; return; }
      const carAt = new Date(new Date(transit.itinerary.endTime).getTime() + UNPARK_BUFFER_S * 1000);
      try {
        const route = await drive(leg.candidate.parking, origin, carAt, "back");
        leg.back = { transit, route, unparkMin: UNPARK_BUFFER_S / 60, startIso: returnAt.toISOString() };
      } catch (err) {
        leg.back = { transit, route: null, error: messageOf(err) };
      }
    }));
  }

  const result = {
    departAt: departAt.toISOString(),
    returnAt: roundTrip ? returnAt.toISOString() : null,
    roundTrip,
    trips,
    days: Math.max(1, Number(profile.days) || 1),
    onDate,
    destZone: dest.zone || null,
    traffic,
    car: priceCar(carRaw, profile, fuelQuote, roundTrip, parkPrefs, ticketFor(profile, onDate)),
    transit: priceTransit(transitPlan, transitFare, transitBack, profile),
    combined: repriceCombined(combined, profile, fuelQuote, trips, roundTrip, departAt.toISOString())
  };
  return result;
}

/** Billete del último tramo en metro: 0 si ya tienes un abono que cubre la zona A. */
function ticketFor(profile, onDate) {
  if (profile.hasAbonoA) return 0;
  const fare = recommendFare({ zones: ["A"], age: profile.age, trips: 2, onDate });
  return fare?.single?.price ?? 1.5;
}

function priceCar(carRaw, profile, fuelQuote, roundTrip, parkPrefs = {}, ticket = 0) {
  if (!carRaw.ok) {
    return { ok: false, error: messageOf(carRaw.error), monthly: null, perDay: null };
  }
  const fuelFor = (k) => (fuelQuote ? fuelCost(k, profile.cons, fuelQuote.eurPerLitre) : null);
  const days = Math.max(1, Number(profile.days) || 1);
  const parking = carRaw.parking || { options: [] };
  const priced = priceParking(parking, { days, fuel: fuelFor, prefs: parkPrefs, ticket, roundTrip });
  const pick = priced.picked;
  const noData = !pick || pick.kind === "unknown";
  const fOut = fuelFor(carRaw.route.lengthM / 1000);
  const fBack = roundTrip && carRaw.back ? fuelFor(carRaw.back.lengthM / 1000) : null;
  const plainDay = fOut ? fOut.euros + (fBack ? fBack.euros : 0) : null;
  return {
    ok: true,
    route: carRaw.route,
    backRoute: carRaw.back,
    parkingRaw: parking,
    parkPrefs,
    ticket,
    park: noData ? null : pick,
    parkRows: priced.rows,
    outMin: noData ? Math.round(carRaw.route.s / 60) : pick.outMin,
    backMin: noData ? (carRaw.back ? Math.round(carRaw.back.s / 60) : null) : pick.backMin,
    timeMin: noData ? Math.round(carRaw.route.s / 60) : pick.outMin,
    perDay: noData ? plainDay : pick.perDay,
    monthly: noData ? (plainDay == null ? null : plainDay * days) : pick.monthly,
    parkingLabel: noData ? "No incluido" : null
  };
}

function priceTransit(plan, fare, back, profile) {
  const days = Math.max(1, Number(profile.days) || 1);
  return {
    ok: Boolean(fare?.ok),
    plan,
    back,
    timeMin: transitIsReal(plan) ? plan.itinerary.durationMin : null,
    backMin: transitIsReal(back) ? back.itinerary.durationMin + back.itinerary.waitMin : null,
    fare,
    trip: fare?.single?.price ?? null,
    monthly: fare?.best?.monthly ?? null,
    perDay: fare?.best?.monthly != null ? fare.best.monthly / days : null
  };
}

function priceCombined(legs, profile, fuelQuote, trips, departIso, roundTrip) {
  const departMs = departIso ? new Date(departIso).getTime() : NaN;
  const options = legs.map((leg) => {
    const transitOk = transitIsReal(leg.transit);
    const totalMin = leg.ok && transitOk
      ? Math.round((new Date(leg.transit.itinerary.endTime).getTime() - departMs) / 60000)
      : null;
    return { ...leg, totalMin, arrival: totalMin != null ? leg.transit.itinerary.endTime : null };
  });
  // Primero los que tienen tiempo completo, por hora de llegada; luego el resto.
  // Se enseñan los tres primeros y, si no está entre ellos, el habitual.
  options.sort((a, b) => (a.totalMin ?? Infinity) - (b.totalMin ?? Infinity));
  if (legs.length > 1 && options[0]?.totalMin != null) options[0].fastest = true;
  const shown = options.slice(0, 3);
  const usual = options.find((o) => o.candidate.usual);
  if (usual && !shown.includes(usual)) shown.push(usual);
  const picked = Math.max(0, shown.findIndex((o) => o.candidate.usual));
  return { ok: shown.length > 0, options: shown, picked };
}

/** Importes de la combinada: combustible de ida y vuelta, aparcamiento y abono. */
function priceCombinedLeg(leg, profile, fuelQuote, trips, roundTrip) {
  const days = Math.max(1, Number(profile.days) || 1);
  const fuelOf = (route) => (route && fuelQuote ? fuelCost(route.lengthM / 1000, profile.cons, fuelQuote.eurPerLitre) : null);
  const fuel = leg.ok ? fuelOf(leg.route) : null;
  const fuelBack = roundTrip ? fuelOf(leg.back?.route) : null;
  const single = leg.fare?.single?.price ?? null;
  const passMonthly = leg.fare?.best?.monthly ?? null;
  const parkingFree = leg.candidate.parking.fee === "Libre";
  const backOk = !roundTrip || Boolean(fuelBack);
  const fuelDay = fuel && backOk ? fuel.euros + (fuelBack ? fuelBack.euros : 0) : null;
  const monthly = fuelDay != null && passMonthly != null && parkingFree ? fuelDay * days + passMonthly : null;
  // De la hora de vuelta a casa, esperas incluidas.
  const backMin = roundTrip && leg.back?.route && transitIsReal(leg.back.transit)
    ? Math.round((new Date(leg.back.route.arrivalAdj) - new Date(leg.back.startIso)) / 60000)
    : null;
  return {
    ...leg,
    fuel,
    fuelBack,
    fuelDay,
    trip: fuel && single != null ? fuel.euros + single : null,
    monthly,
    perDay: monthly != null ? monthly / days : null,
    complete: monthly != null,
    backMin,
    backArrival: backMin != null ? leg.back.route.arrivalAdj : null,
    parkingFree,
    parkingNote: parkingFree
      ? "La capa lo marca libre. En los disuasorios de EMT hace falta título y una estancia de 5 a 16 h; si no, hay una tarifa de rotación que aquí no está publicada."
      : "Aparcamiento de pago. El importe de 2026 no está en los datos y no se pone a cero."
  };
}

function repriceCombined(combined, profile, fuelQuote, trips, roundTrip) {
  return {
    ...combined,
    options: (combined.options || []).map((leg) => priceCombinedLeg(leg, profile, fuelQuote, trips, roundTrip))
  };
}

export function messageOf(error) {
  if (!error) return "No se ha podido calcular.";
  return error.userMessage || error.message || "No se ha podido calcular.";
}

/** Recalcula importes cuando cambian consumo, días, edad, abono o precios, sin volver a pedir rutas. */
export function reprice(result, profile, fuelQuote, parkPrefs = result?.car?.parkPrefs || {}) {
  if (!result) return result;
  const roundTrip = result.roundTrip;
  const trips = tripsOf(profile, roundTrip);
  const onDate = result.onDate;
  const next = {
    ...result,
    trips,
    days: Math.max(1, Number(profile.days) || 1),
    car: result.car.ok
      ? priceCar({ ok: true, route: result.car.route, back: result.car.backRoute, parking: result.car.parkingRaw }, profile, fuelQuote, roundTrip, parkPrefs, ticketFor(profile, onDate))
      : result.car
  };
  if (result.transit.fare) {
    const fare = recommendFare({ zones: result.transit.fare.zones, age: profile.age, trips, onDate });
    next.transit = priceTransit(result.transit.plan, fare, result.transit.back, profile);
  }
  next.combined = {
    ...result.combined,
    options: (result.combined.options || []).map((leg) => {
      const zones = leg.fare?.zones || [leg.candidate.parking.zone, result.destZone].filter(Boolean);
      const fare = zones.length ? recommendFare({ zones, age: profile.age, trips, onDate }) : leg.fare;
      return priceCombinedLeg({ ...leg, fare }, profile, fuelQuote, trips, roundTrip);
    }),
    picked: result.combined.picked || 0
  };
  return next;
}
