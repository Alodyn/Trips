import { readFileSync } from "node:fs";
import { zoneAt } from "../js/geo.js";
import { setFareDb, recommendFare, cercaniasSingle } from "../js/fares.js";
import { fuelCost, averagePrice } from "../js/fuel.js";
import { chooseParkings } from "../js/parkride.js";
import { parseRoute, mapSearchResults, tomtomUserMessage } from "../js/tomtom.js";
import { transitIsReal } from "../js/transit.js";

const zones = JSON.parse(readFileSync(new URL("../data/zones.json", import.meta.url)));
const parkings = JSON.parse(readFileSync(new URL("../data/parkings.json", import.meta.url)));
const fares = JSON.parse(readFileSync(new URL("../data/fares.json", import.meta.url)));
const fixture = JSON.parse(readFileSync(new URL("../fixtures/tomtom-sample.json", import.meta.url)));
setFareDb(fares);

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const grinon = zoneAt(40.2139, -3.8642, zones.zones);
const hospital = zoneAt(40.3758, -3.6988, zones.zones);
assert(grinon === "B3", "Griñón debería ser B3, es " + grinon);
assert(hospital === "A", "Hospital debería ser A, es " + hospital);

const fare = recommendFare({ zones: ["B3", "A"], age: 31, trips: 42, onDate: "2026-11-12" });
assert(fare.outer === "B3", "corona exterior");
assert(fare.monthlyPass === 49.2, "abono B3 " + fare.monthlyPass);
assert(fare.best.kind === "pass", "conviene el abono, no los sencillos");
assert(fare.single.price === 3, "sencillo interurbano");

const joven = recommendFare({ zones: ["B3", "A"], age: 25, trips: 42, onDate: "2026-11-12" });
assert(joven.monthlyPass === 10, "abono joven");
const infantil = recommendFare({ zones: ["A"], age: 10, trips: 10, onDate: "2026-11-12" });
assert(infantil.monthlyPass === 0, "infantil");
const mayor = recommendFare({ zones: ["E2"], age: 70, trips: 40, onDate: "2026-11-12" });
assert(mayor.monthlyPass === 0, "mayor");

const zonaA = recommendFare({ zones: ["A"], age: 31, trips: 42, onDate: "2026-11-12" });
assert(zonaA.single.price === 1.5, "sencillo A");
assert(zonaA.monthlyTen != null && zonaA.best.kind === "pass", "en A el abono gana a 10 viajes con 42 viajes");
const pocos = recommendFare({ zones: ["A"], age: 31, trips: 4, onDate: "2026-11-12" });
assert(pocos.best.kind === "singles", "con 4 viajes conviene el sencillo");

const caducado = recommendFare({ zones: ["A"], age: 31, trips: 40, onDate: "2027-01-02" });
assert(caducado.price.basis === "official" && caducado.monthlyPass === 56.2, "en 2027 tarifa oficial");

const c9 = cercaniasSingle("verde");
assert(c9.price === 8.7, "cercanías verde");
const c2 = cercaniasSingle(2);
assert(c2.price === 1.7, "cercanías 2 zonas");

const pr = chooseParkings(
  { lat: 40.2139, lon: -3.8642 },
  { lat: 40.3758, lon: -3.6988 },
  parkings.items,
  3
);
console.log("Aparcamientos candidatos:");
for (const row of pr) {
  console.log(`  ${row.parking.name} zona ${row.parking.zone} t=${row.t.toFixed(2)} cruz=${row.crossKm.toFixed(1)} km recta ${row.driveKm.toFixed(1)}→${row.remainKm.toFixed(1)}`);
}
assert(pr.length === 3, "tienen que salir 3 candidatos");
assert(pr.every((r) => r.t > 0.12 && r.t < 0.9 && r.remainKm > 5), "los candidatos tienen que dejar tramo de transporte");
assert(pr.every((r) => r.parking.fee === "Libre"), "en este corredor los tres son de tarifa libre");

const route = parseRoute(fixture.routing.response);
assert(route.lengthM === 28868, "km grabados");
assert(route.travelS === 1611, "tiempo grabado");
assert(route.points.length > 100, "geometría");
const cost = fuelCost(route.lengthM / 1000, 4.5, 1.854);
assert(Math.abs(cost.litres - 1.29906) < 0.001, "litros");
const avg = averagePrice([
  { Municipio: "Griñón", Localidad: "Griñón", "Precio Gasoleo A": "1,800" },
  { Municipio: "Griñón", Localidad: "Griñón", "Precio Gasoleo A": "1,900" },
  { Municipio: "Madrid", Localidad: "Madrid", "Precio Gasoleo A": "2,000" }
], "goa", "Griñón");
assert(avg.scope === "municipio" && Math.abs(avg.eurPerLitre - 1.85) < 0.001, "media municipal");

const search = mapSearchResults(fixture.search.queries.hospital);
assert(/12 de Octubre/.test(search[0].label), "etiqueta del hospital");
assert(tomtomUserMessage(403, "InvalidReferer").includes("alodyn.github.io"), "mensaje de rechazo");
assert(transitIsReal({ status: "pending" }) === false, "no hay tiempo inventado");

const b1 = recommendFare({ zones: ["B1", "A"], age: 31, trips: 42, onDate: "2026-11-12" });
assert(b1.monthlyPass === 38.2, "abono B1 del P+R");
console.log("selfcheck ok", { grinon, hospital, abonoB3: fare.monthlyPass, abonoB1: b1.monthlyPass, minutos: Math.round(route.travelS / 60), euros: cost.euros.toFixed(2) });
