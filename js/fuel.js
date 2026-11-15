/** Precio medio del Ministerio y coste de combustible, con la fórmula de Surtidor. */

import { CONFIG } from "../config.js";
import { norm } from "./format.js";

export const FUELS = [
  { id: "goa", key: "Precio Gasoleo A", label: "Diésel", long: "Gasóleo A" },
  { id: "g95", key: "Precio Gasolina 95 E5", label: "Gasolina 95", long: "Gasolina 95 E5" },
  { id: "g98", key: "Precio Gasolina 98 E5", label: "98", long: "Gasolina 98 E5" },
  { id: "glp", key: "Precio Gases licuados del petróleo", label: "GLP", long: "GLP" }
];

export function fuelById(id) {
  return FUELS.find((f) => f.id === id) || FUELS[0];
}

export function parsePrice(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** coste € = km × consumo (l/100 km) / 100 × precio €/l */
export function fuelCost(km, litresPer100, eurPerLitre) {
  if (![km, litresPer100, eurPerLitre].every((n) => Number.isFinite(Number(n)) && Number(n) >= 0)) {
    return null;
  }
  const litres = (Number(km) * Number(litresPer100)) / 100;
  return { litres, euros: litres * Number(eurPerLitre) };
}

let provinceCache = null;

export async function loadMadridStations() {
  if (provinceCache) return provinceCache;
  const url = `${CONFIG.fuelApi}/EstacionesTerrestres/FiltroProvincia/${CONFIG.madridProvinceId}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error("No se han podido cargar los precios del Ministerio.");
  const data = await res.json();
  provinceCache = {
    fecha: data.Fecha || "",
    stations: data.ListaEESSPrecio || []
  };
  return provinceCache;
}

export function averagePrice(stations, fuelId, municipality) {
  const fuel = fuelById(fuelId);
  const all = [];
  const local = [];
  const want = norm(municipality || "");
  for (const s of stations) {
    const price = parsePrice(s[fuel.key]);
    if (price == null) continue;
    all.push(price);
    if (want && (norm(s.Municipio) === want || norm(s.Localidad) === want)) local.push(price);
  }
  const useLocal = local.length >= 2;
  const bag = useLocal ? local : all;
  if (!bag.length) return null;
  const avg = bag.reduce((a, b) => a + b, 0) / bag.length;
  return {
    eurPerLitre: avg,
    n: bag.length,
    scope: useLocal ? "municipio" : "provincia",
    place: useLocal ? municipality : "Madrid",
    fuel
  };
}
