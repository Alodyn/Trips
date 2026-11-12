import { recommendFare } from "./fares.js";
import { fuelCost } from "./fuel.js";
import { todayISO } from "./format.js";
import { chooseParkings } from "./parkride.js";
import { planTransit, transitIsReal } from "./transit.js";
import { routeCar } from "./tomtom.js";

export async function compareTrip({ origin, dest, departAt, profile, fuelQuote, parkings }) {
  const onDate = todayISO(departAt);
  const trips = Math.max(1, Number(profile.days) || 1) * (profile.roundTrip ? 2 : 1);
  const directZones = [origin.zone, dest.zone].filter(Boolean);

  const carCall = routeCar({ from: origin, to: dest, departAt })
    .then((route) => ({ ok: true, route }))
    .catch((error) => ({ ok: false, error }));

  const candidates = chooseParkings(origin, dest, parkings, 3);
  const legCalls = candidates.map(async (candidate) => {
    const transit = await planTransit({
      from: candidate.parking,
      to: dest,
      departAt
    });
    const zones = [candidate.parking.zone, dest.zone].filter(Boolean);
    const fare = zones.length
      ? recommendFare({ zones, age: profile.age, trips, onDate })
      : null;
    try {
      const route = await routeCar({ from: origin, to: candidate.parking, departAt });
      return { ok: true, route, candidate, transit, fare };
    } catch (error) {
      return { ok: false, error, candidate, transit, fare };
    }
  });

  const [carRaw, transitPlan, ...legs] = await Promise.all([
    carCall,
    planTransit({ from: origin, to: dest, departAt }),
    ...legCalls
  ]);

  const transitFare = directZones.length
    ? recommendFare({ zones: directZones, age: profile.age, trips, onDate })
    : null;

  return {
    departAt: departAt.toISOString(),
    trips,
    onDate,
    destZone: dest.zone || null,
    car: priceCar(carRaw, profile, fuelQuote, trips),
    transit: priceTransit(transitPlan, transitFare),
    combined: priceCombined(legs, profile, fuelQuote, trips)
  };
}

function priceCar(carRaw, profile, fuelQuote, trips) {
  if (!carRaw.ok) {
    return {
      ok: false,
      error: messageOf(carRaw.error),
      monthly: null,
      trip: null
    };
  }
  const km = carRaw.route.lengthM / 1000;
  const fuel = fuelQuote ? fuelCost(km, profile.cons, fuelQuote.eurPerLitre) : null;
  const trip = fuel ? fuel.euros : null;
  return {
    ok: true,
    route: carRaw.route,
    km,
    fuel,
    trip,
    monthly: trip == null ? null : trip * trips,
    parkingLabel: "No incluido"
  };
}

function priceTransit(plan, fare) {
  return {
    ok: Boolean(fare?.ok),
    plan,
    timeMin: transitIsReal(plan) ? plan.itinerary.durationMin : null,
    fare,
    trip: fare?.single?.price ?? null,
    monthly: fare?.best?.monthly ?? null
  };
}

function priceCombined(legs, profile, fuelQuote, trips) {
  const options = legs.map((leg) => {
    const km = leg.ok ? leg.route.lengthM / 1000 : null;
    const fuel = km != null && fuelQuote ? fuelCost(km, profile.cons, fuelQuote.eurPerLitre) : null;
    const single = leg.fare?.single?.price ?? null;
    const passMonthly = leg.fare?.best?.monthly ?? null;
    const trip = fuel && single != null ? fuel.euros + single : null;
    const parkingFree = leg.candidate.parking.fee === "Libre";
    const monthly = fuel && passMonthly != null && parkingFree ? fuel.euros * trips + passMonthly : null;
    return {
      ...leg,
      km,
      fuel,
      trip,
      monthly,
      complete: monthly != null,
      parkingFree,
      parkingNote: parkingFree
        ? "La capa lo marca libre. En los disuasorios de EMT hace falta título y una estancia de 5 a 16 h; si no, hay una tarifa de rotación que aquí no está publicada."
        : "Aparcamiento de pago. El importe de 2026 no está en los datos y no se pone a cero."
    };
  });
  return {
    ok: options.length > 0,
    options,
    picked: 0
  };
}

export function messageOf(error) {
  if (!error) return "No se ha podido calcular.";
  return error.userMessage || error.message || "No se ha podido calcular.";
}

/** Recalcula importes cuando cambian consumo, días, edad o el precio, sin volver a pedir la ruta. */
export function reprice(result, profile, fuelQuote) {
  if (!result) return result;
  const trips = Math.max(1, Number(profile.days) || 1) * (profile.roundTrip ? 2 : 1);
  const onDate = result.onDate;
  const next = {
    ...result,
    trips,
    car: result.car.ok
      ? priceCar({ ok: true, route: result.car.route }, profile, fuelQuote, trips)
      : result.car
  };
  if (result.transit.fare) {
    const fare = recommendFare({
      zones: result.transit.fare.zones,
      age: profile.age,
      trips,
      onDate
    });
    next.transit = priceTransit(result.transit.plan, fare);
  }
  next.combined = {
    ...result.combined,
    options: (result.combined.options || []).map((leg) => {
      const zones = leg.fare?.zones || [leg.candidate.parking.zone, result.destZone].filter(Boolean);
      const fare = zones.length
        ? recommendFare({ zones, age: profile.age, trips, onDate })
        : leg.fare;
      return priceCombined([{ ...leg, fare, ok: leg.ok, route: leg.route, candidate: leg.candidate, transit: leg.transit, error: leg.error }], profile, fuelQuote, trips).options[0];
    }),
    picked: result.combined.picked || 0
  };
  return next;
}
