/** Abonos y sencillos CRTM 2026. Los precios viven en data/fares.json. */

let DB = null;

export function setFareDb(db) {
  DB = db;
}

export function fareDb() {
  return DB;
}

function onOrBefore(date, until) {
  if (!until) return true;
  return String(date) <= String(until);
}

function profileFor(age) {
  const years = Number(age);
  for (const p of DB.profiles) {
    if (years >= p.ageMin && years <= p.ageMax) return p;
  }
  return DB.profiles.find((p) => p.id === "normal");
}

function zoneByCode(code) {
  return DB.zones.find((z) => z.code === code) || null;
}

function passProduct(zone, profileId) {
  if (profileId === "normal") {
    return DB.passes.find((p) => p.profile === "normal" && p.zone === zone) || null;
  }
  return DB.passes.find((p) => p.profile === profileId) || null;
}

function priceOf(product, onDate) {
  if (!product) return { amount: null, basis: "missing" };
  const discounted = product.userPrice != null && onOrBefore(onDate, product.validTo);
  if (discounted) return { amount: product.userPrice, basis: "user" };
  if (product.officialPrice != null) return { amount: product.officialPrice, basis: "official" };
  return { amount: null, basis: "unknown" };
}

/**
 * Elige el abono que cubre las coronas recorridas y lo compara con sencillos
 * (y con el bono de 10 viajes cuando el viaje se queda en la zona A).
 *
 * @param {object} args
 * @param {string[]} args.zones Coronas CRTM del tramo en transporte.
 * @param {number} args.age
 * @param {number} args.trips Viajes sencillos al mes (días × ida, o × 2 si hay vuelta).
 * @param {string} [args.onDate] YYYY-MM-DD en Madrid.
 */
export function recommendFare({ zones, age, trips, onDate }) {
  if (!DB) throw new Error("Tarifas no cargadas");
  const date = onDate || "2026-11-12";
  const unique = [...new Set((zones || []).filter(Boolean))];
  const profile = profileFor(age);
  const notes = [];
  if (!unique.length) {
    return {
      ok: false,
      profile,
      zones: [],
      notes: ["Origen o destino fuera de las coronas del CRTM. No hay abono que aplicar."]
    };
  }

  const ranked = unique
    .map(zoneByCode)
    .filter(Boolean)
    .sort((a, b) => b.rank - a.rank);
  if (!ranked.length) {
    return {
      ok: false,
      profile,
      zones: unique,
      notes: ["Esas coronas no están en la tabla de abonos."]
    };
  }
  const outer = ranked[0];
  let product = passProduct(outer.code, profile.id);
  let coversAll = unique.every((z) => outer.includes.includes(z));

  if (profile.id !== "normal") {
    product = passProduct("*", profile.id);
    coversAll = true;
  } else if (!coversAll) {
    const covering = DB.zones
      .filter((z) => unique.every((code) => z.includes.includes(code)))
      .sort((a, b) => a.rank - b.rank);
    if (covering.length) {
      product = passProduct(covering[0].code, "normal");
      coversAll = true;
    } else {
      notes.push("Estas coronas no caben en un solo abono zonal (C1 y C2, o E1 y E2, son ramas distintas). Se muestra el de mayor rango y no un interzonal: esa tabla no está en los datos.");
    }
  }

  const priced = priceOf(product, date);
  if (priced.basis === "official") {
    notes.push("La rebaja vigente hasta el 31/12/2026 ya no aplica en la fecha del cálculo. Se usa la tarifa oficial del BOCM.");
  }
  if (priced.basis === "unknown") {
    notes.push("La gratuidad de este perfil está fechada hasta el 31/12/2026 y no hay un precio de reposición en los datos.");
  }

  const single = selectSingle(unique);
  const ten = selectTen(unique, date);
  const tripCount = Math.max(0, Number(trips) || 0);
  const monthlyPass = priced.amount;
  const monthlySingles = single && tripCount ? round2(single.price * tripCount) : null;
  const monthlyTen = ten && tripCount ? round2(Math.ceil(tripCount / ten.trips) * ten.unit) : null;

  const options = [];
  if (monthlyPass != null) {
    options.push({
      kind: "pass",
      monthly: monthlyPass,
      label: product.profile === "normal"
        ? `Abono 30 días ${product.zone}`
        : `Abono ${profile.label}`
    });
  }
  if (monthlySingles != null) {
    options.push({ kind: "singles", monthly: monthlySingles, label: single.label });
  }
  if (monthlyTen != null) {
    options.push({ kind: "ten", monthly: monthlyTen, label: ten.label });
  }
  options.sort((a, b) => a.monthly - b.monthly);
  const best = options[0] || null;

  if (profile.id === "joven") {
    notes.push("Abono Joven: 15 a 25 años, válido en toda la región.");
  }
  if (single?.id === "interurbano") {
    notes.push("Sin itinerario, el sencillo es el interurbano entre municipios (3,00 €). Metro o Cercanías pueden costar otra cosa; el abono sí está calculado con las coronas.");
  }
  if (single?.id === "metro-a") {
    notes.push("En zona A el sencillo de Metro y el de EMT cuestan lo mismo, 1,50 €.");
  }

  return {
    ok: monthlyPass != null || monthlySingles != null,
    profile,
    zones: unique,
    outer: outer.code,
    coversAll,
    product,
    price: priced,
    single,
    ten,
    trips: tripCount,
    monthlyPass,
    monthlySingles,
    monthlyTen,
    best,
    perTripWithPass: monthlyPass != null && tripCount ? monthlyPass / tripCount : null,
    notes
  };
}

export function selectSingle(zones) {
  const unique = [...new Set((zones || []).filter(Boolean))];
  if (!unique.length) return null;
  if (unique.length === 1 && unique[0] === "A") {
    return DB.singles.find((s) => s.id === "metro-a");
  }
  return DB.singles.find((s) => s.id === "interurbano");
}

function selectTen(zones, onDate) {
  const unique = [...new Set((zones || []).filter(Boolean))];
  if (unique.length !== 1 || unique[0] !== "A") return null;
  const product = DB.singles.find((s) => s.id === "ten-metro-emt-ml1");
  if (!product) return null;
  const discounted = onOrBefore(onDate, product.validTo);
  const unit = discounted ? product.price : (product.officialPrice ?? null);
  if (unit == null) return null;
  return { ...product, unit, basis: discounted ? "user" : "official" };
}

/** Sencillo de Cercanías Renfe por número de zonas Renfe (1–7) o "verde". No son coronas CRTM. */
export function cercaniasSingle(renfeZones) {
  if (!DB) throw new Error("Tarifas no cargadas");
  if (renfeZones === "verde") {
    return DB.cercanias.find((r) => r.renfeZones === "verde") || null;
  }
  const n = Number(renfeZones);
  return DB.cercanias.find((r) => r.min != null && n >= r.min && n <= r.max) || null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
