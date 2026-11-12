import { setFareDb } from "./fares.js";
import { zoneAt, buildStationIndex, stationMatch } from "./geo.js";
import { FUELS, fuelById, loadMadridStations, averagePrice } from "./fuel.js";
import { compareTrip, reprice, messageOf } from "./compare.js";
import { fixturesEnabled, searchPlaces, clearTomTomRejection } from "./tomtom.js";
import { transitIsReal, lineSummary } from "./transit.js";
import { buildParkPool, parkLabel } from "./parkride.js";
import { setDestParkingDb, destParkingDb, destKey } from "./destpark.js";
import { haversineKm } from "./geo.js";
import { euro, litrePrice, litres, kmText, roundMinutes, clock, esc, departureOn, norm, nextDayOfType } from "./format.js";

const THEMES = ["claro", "grafito", "grafito-oscuro", "medianoche"];
const THEME_COLOR = { claro: "#e4e8f2", grafito: "#303136", "grafito-oscuro": "#1a1b1d", medianoche: "#070b14" };

const state = {
  tab: "compare",
  view: "home",
  detail: "car",
  origin: null,
  dest: null,
  originText: "",
  destText: "",
  profile: null,
  favorites: [],
  recents: [],
  fuelQuote: null,
  fuelError: "",
  stationsFuel: null,
  result: null,
  busy: false,
  bootError: "",
  suggest: null,
  parkQuery: "",
  parkMode: "list",
  parkId: null,
  timeOpen: false,
  usualPark: null,
  destPrefs: {},
  traffic: {},
  sheetMode: "origin",
  toast: ""
};

let ZONES = [];
let STATIONS = new Map();
let PARKINGS = [];
let POOL = [];
let VEHICLES = [];
let cmpMap = null;
let parkMap = null;
let parkLayer = null;
let searchTimer = 0;
let searchAbort = null;
let searchSeq = 0;

const screen = document.getElementById("screen");

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* el móvil puede rechazar la cuota */ }
}

function defaultProfile(vehicles) {
  const volvo = vehicles.find((v) => v.make === "Volvo" && v.model === "S60" && v.yearFrom === 2010 && v.fuel === "goa" && v.cons === 4.5)
    || vehicles[0]
    || { make: "Coche", model: "", yearFrom: "", yearTo: "", engine: "", fuel: "goa", tank: null, cons: 6 };
  return {
    vehicle: {
      make: volvo.make, model: volvo.model, yearFrom: volvo.yearFrom, yearTo: volvo.yearTo,
      engine: volvo.engine, fuel: volvo.fuel, tank: volvo.tank, cons: volvo.cons
    },
    cons: volvo.cons,
    fuelId: FUELS.some((f) => f.id === volvo.fuel) ? volvo.fuel : "goa",
    age: 31,
    days: 21,
    roundTrip: true,
    depart: "08:00",
    returnAt: "15:00",
    dayType: "laborable",
    searchMin: 5,
    hasAbonoA: false
  };
}

function icon(id, size = 20) {
  return `<svg class="ic" width="${size}" height="${size}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

function themeDots() {
  return `<div class="theme-dots" role="radiogroup" aria-label="Tema visual">${THEMES.map((name) =>
    `<button type="button" class="${name}${state.profile && document.documentElement.dataset.theme === name ? " is-active" : ""}" data-act="theme" data-theme="${name}" title="Tema ${name}" aria-label="Tema ${name}"></button>`
  ).join("")}</div>`;
}

function applyTheme(name) {
  if (!THEMES.includes(name)) name = "claro";
  document.documentElement.dataset.theme = name;
  localStorage.setItem("trips.v1.theme", name);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLOR[name];
  const scheme = document.querySelector('meta[name="color-scheme"]');
  if (scheme) scheme.content = name === "claro" ? "light" : "dark";
  document.querySelectorAll("button[data-act=theme]").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.theme === name);
  });
}

function profileLabel(age) {
  if (age <= 14) return "Infantil";
  if (age <= 25) return "Abono joven";
  if (age >= 65) return "Abono mayor";
  return "Abono normal";
}

function ageHint(age) {
  if (age <= 14) return "Hasta los 14 años el abono es gratuito, según la nota del CRTM vigente hasta el 31/12/2026.";
  if (age <= 25) return "Con 25 años o menos: <b>Abono Joven, 10 €</b> al mes en toda la región.";
  if (age >= 65) return "A partir de los 65 el abono es gratuito, vigente hasta el 31/12/2026.";
  return "Con 25 años o menos: <b>Abono Joven, 10 €</b> al mes en toda la región.";
}

function fuelLine() {
  if (state.fuelError) return `<p class="fuel-line err">${icon("i-pump", 14)}<span>${esc(state.fuelError)}</span></p>`;
  if (!state.fuelQuote) return `<p class="fuel-line">${icon("i-pump", 14)}<span>Consultando el precio oficial del Ministerio…</span></p>`;
  const q = state.fuelQuote;
  const where = q.scope === "municipio" ? `media de ${q.place}` : "media de la provincia de Madrid";
  return `<p class="fuel-line">${icon("i-pump", 14)}<span>${esc(q.fuel.long)} hoy <b>${esc(litrePrice(q.eurPerLitre))}</b> · ${esc(where)}, Ministerio${q.fecha ? ` · ${esc(q.fecha)}` : ""}</span></p>`;
}

function fixtureBanner() {
  if (!fixturesEnabled()) return "";
  return `<div class="fixture-banner"><strong>Muestra local.</strong> Ruta grabada de TomTom el 12/11/2026, salida a las 7:00. No es una llamada en vivo.</div>`;
}

function shortPlace(place, fallback) {
  if (!place) return fallback;
  const bit = place.label.split(",")[0];
  return bit.length > 28 ? bit.slice(0, 26) + "…" : bit;
}

function goEnabled() {
  return Boolean(state.origin && state.dest && !state.busy);
}

function bigTime(min, pending) {
  if (min == null) return `<div class="big">—</div><div class="sub">${esc(pending || "pendiente de horarios")}</div>`;
  if (min < 60) return `<div class="big">${min}<small>min</small></div>`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `<div class="big">${h}<small>h</small>${m ? " " + m : ""}</div>`;
}

function money(n) {
  return n == null ? "—" : euro(n);
}

function saveCell(monthly, carMonthly) {
  if (monthly == null || carMonthly == null) return { label: "Frente al coche", text: "—", cls: "neutral" };
  const diff = carMonthly - monthly;
  if (Math.abs(diff) < 0.5) return { label: "Frente al coche", text: "Igual", cls: "neutral" };
  if (diff > 0) return { label: "Ahorro/mes", text: euro(diff), cls: "good" };
  return { label: "De más", text: euro(-diff), cls: "bad" };
}

function cheapest() {
  if (!state.result) return null;
  const rows = [];
  if (state.result.car.monthly != null) rows.push(["car", state.result.car.monthly]);
  if (state.result.transit.monthly != null) rows.push(["transit", state.result.transit.monthly]);
  const leg = pickedLeg();
  if (leg?.monthly != null) rows.push(["combined", leg.monthly]);
  if (!rows.length) return null;
  rows.sort((a, b) => a[1] - b[1]);
  return rows[0][0];
}

function pickedLeg() {
  const options = state.result?.combined?.options || [];
  const i = state.result?.combined?.picked || 0;
  return options[i] || options[0] || null;
}

function zoneOf(place) {
  return place?.zone ? `<em class="zone-mini">Zona ${esc(place.zone)}</em>` : "";
}

function paint() {
  destroyMaps();
  const tab = state.tab;
  document.querySelectorAll("#tabbar button").forEach((b) => b.classList.toggle("is-active", b.dataset.tab === tab));
  if (tab === "favs") screen.innerHTML = viewFavs();
  else if (tab === "parks") screen.innerHTML = viewParks();
  else if (tab === "car") screen.innerHTML = viewCar();
  else if (state.view === "detail") screen.innerHTML = viewDetail();
  else if (state.view === "results") screen.innerHTML = viewResults();
  else screen.innerHTML = viewHome();
  renderSuggest();
  if (state.tab === "parks" && (state.parkMode === "map" || window.innerWidth >= 900)) requestAnimationFrame(drawParkMap);
  if (state.tab === "compare" && state.view === "results") requestAnimationFrame(drawCompareMap);
}

function viewHome() {
  const v = state.profile.vehicle;
  const fuel = fuelById(state.profile.fuelId);
  return `
    <header class="topbar">
      <div class="title-block"><h1>Trips</h1><p class="updated">Coche, transporte o las dos cosas</p></div>
      <div class="title-actions">${themeDots()}</div>
    </header>
    ${fixtureBanner()}
    <div class="home-grid">
      <div>
        <div class="od-wrap">
          <div class="glass od">
            <div class="od-line"></div>
            <div class="od-row">
              <span class="dot-o"></span>
              <label class="txt"><span class="lbl">Origen ${zoneOf(state.origin)}</span>
                <input id="in-origin" type="text" enterkeyhint="search" autocomplete="off" placeholder="Municipio, calle o lugar" value="${esc(state.originText)}"></label>
            </div>
            <div class="od-sep"></div>
            <div class="od-row">
              <span class="dot-d">${icon("i-pin", 18)}</span>
              <label class="txt"><span class="lbl">Destino ${zoneOf(state.dest)}</span>
                <input id="in-dest" type="text" enterkeyhint="search" autocomplete="off" placeholder="Hospital, estación, calle…" value="${esc(state.destText)}"></label>
            </div>
            <button type="button" class="icon-btn swap" data-act="swap" aria-label="Intercambiar origen y destino">${icon("i-swap", 18)}</button>
          </div>
          <div id="suggest"></div>
        </div>
        <div class="opt-row">
          <button type="button" class="filter-pill" data-act="time">${icon("i-clock", 16)}${esc(timePill())}</button>
          <button type="button" class="filter-pill${state.profile.roundTrip ? "" : " is-off"}" data-act="round">${icon("i-repeat", 16)}${state.profile.roundTrip ? "Ida y vuelta" : "Solo ida"}</button>
          <div class="time-pop" id="time-pop" ${state.timeOpen ? "" : "hidden"}>
            <label>Día</label>
            <div class="seg day-seg">${DAY_TYPES.map(([id, label]) => `<button type="button" class="${state.profile.dayType === id ? "is-active" : ""}" data-act="daytype" data-day="${id}">${label}</button>`).join("")}</div>
            <p class="tp-day">${esc(dayLabel(departDay()))}${dateOverride() ? " · fecha fijada en la dirección" : ""}</p>
            <div class="tp-row">
              <div><label for="depart">Salgo a las</label><input id="depart" type="time" value="${esc(state.profile.depart)}"></div>
              ${state.profile.roundTrip ? `<div><label for="return-at">Vuelvo a las</label><input id="return-at" type="time" value="${esc(state.profile.returnAt)}"></div>` : ""}
            </div>
            <p class="tp-note">La vuelta sale del destino a esa hora y marca cuánto tiempo aparcas. «Llegar a las» todavía no: cada opción saldría a una hora distinta.</p>
          </div>
        </div>
        <button type="button" class="glass car-chip" data-act="goto-car">
          <span class="cico">${icon("i-car", 22)}</span>
          <div><b>Mi coche · ${esc(v.make)} ${esc(v.model)}</b><small>${esc(fuel.label)} · ${esc(comma(state.profile.cons, 1))} l/100 km · ${esc(profileLabel(state.profile.age))}</small></div>
          ${icon("i-chev", 18).replace('class="ic"', 'class="ic chev"')}
        </button>
        ${fuelLine()}
        <button type="button" class="btn-primary" id="btn-go" data-act="go" ${goEnabled() ? "" : "disabled"}>${icon("i-mix", 20)}${state.busy ? "Calculando el tráfico…" : "Comparar 3 opciones"}</button>
      </div>
      <div>
        <div class="section-h"><h2>Recientes</h2></div>
        ${state.recents.length ? `<div class="card">${state.recents.map((r) => recentRow(r, false)).join("")}</div>` : `<div class="card empty">Cuando compares un trayecto, el precio calculado quedará aquí. Nada se inventa para rellenar la lista.</div>`}
      </div>
    </div>`;
}

function recentRow(item, starred) {
  const best = item.best;
  const price = best ? euro(best.monthly) : "—";
  const sub = [
    best ? best.label : "Sin cierre de precio",
    item.carMin ? `coche ${item.carMin} min` : null,
    item.zones ? item.zones : null
  ].filter(Boolean).join(" · ");
  return `<button type="button" class="fav" data-act="open-saved" data-id="${esc(item.id)}">
    <span class="star ${starred || item.star ? "is-on" : "off"}">${icon("i-star", 20)}</span>
    <span class="ft"><b>${esc(shortPlace(item.origin, "Origen"))} → ${esc(shortPlace(item.dest, "Destino"))}</b><small>${esc(sub)}</small></span>
    <span class="fr"><strong>${esc(price)}</strong><span>al mes</span></span>
  </button>`;
}

function viewResults() {
  const r = state.result;
  const title = `${shortPlace(state.origin, "Origen")} → ${shortPlace(state.dest, "Destino")}`;
  const days = `${state.profile.days} día${state.profile.days === 1 ? "" : "s"}${state.profile.roundTrip ? " · ida y vuelta" : " · solo ida"}`;
  const starOn = isFavorite() ? " is-on" : "";
  return `
    ${fixtureBanner()}
    <div class="nav">
      <button type="button" class="icon-btn" data-act="back" aria-label="Volver">${icon("i-back", 20)}</button>
      <div class="ttl"><b>${esc(title)}</b><small>${esc(state.result?.departAt ? departLabel(state.result.departAt) : state.profile.depart)}${state.result?.returnAt ? " · vuelta " + esc(clock(state.result.returnAt)) : ""} · ${esc(days)}</small></div>
      <button type="button" class="icon-btn${starOn}" data-act="star" aria-label="Guardar en favoritos">${starOn ? `<svg class="ic" width="18" height="18" style="fill:currentColor" aria-hidden="true"><use href="#i-star"/></svg>` : icon("i-star", 18)}</button>
    </div>
    <div class="results-grid">
      <div class="map-wrap">
        <div class="map-band"><div id="cmp-map" role="application" aria-label="Mapa del trayecto en coche"></div></div>
        <div class="map-legend"><span><i style="background:var(--amber)"></i>Coche</span><span><i style="background:#3c6fb5"></i>P+R</span></div>
        <a class="map-credit" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>
      </div>
      <div class="cards">
        ${cardCombined()}
        ${cardTransit()}
        ${cardCar()}
        <div class="source">${icon("i-info", 15)}<p class="note">${esc(sourceLine())}</p></div>
      </div>
    </div>`;
}

function departLabel(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", weekday: "short", day: "numeric", month: "numeric" });
  return `${day} ${clock(iso)}`;
}

function cardCar() {
  const car = state.result.car;
  const best = cheapest() === "car";
  const park = car.ok ? car.park : null;
  const out = car.ok ? car.outMin : null;
  const delay = car.ok ? Math.round((car.route.delayS || 0) / 60) : null;
  const meta = !car.ok
    ? car.error
    : park
      ? `${kmText((park.out?.route || car.route).lengthM)} · ${parkShort(park)}`
      : `${kmText(car.route.lengthM)} · ${delay ? delay + " min de retraso" : "sin retraso de tráfico en la respuesta"}`;
  return `<button type="button" class="card opt${best ? " is-best" : ""}" id="card-car" data-act="detail" data-mode="car">
    ${best ? `<span class="badge cheap tag">Más barata</span>` : ""}
    <div class="opt-top">
      <span class="mode-ic car">${icon("i-car", 22)}</span>
      <div class="opt-main"><div class="opt-name">Coche${park?.usual ? `<span class="opt-flag">Habitual</span>` : ""}</div><div class="opt-meta">${esc(meta)}<br><span class="pred">${icon("i-clock", 12)}Tiempos de coche: predicción${car.ok && (car.park?.out?.route || car.route).marginPct ? ` con +${(car.park?.out?.route || car.route).marginPct} % de tráfico` : ""}</span></div></div>
      <div class="opt-time">${bigTime(out, "sin tiempo")}<div class="sub">${car.ok ? `llegas ${esc(arriveAt(out))}` : ""}${car.ok && car.backMin != null ? `<br>vuelta ${esc(minText(car.backMin))}` : ""}</div></div>
    </div>
    <div class="opt-costs">
      <div><span>Al día</span><b>${esc(money(car.perDay))}</b></div>
      <div><span>Al mes</span><b class="amb">${esc(money(car.monthly))}</b></div>
      <div><span>Aparcar</span><b class="neutral">${esc(park ? parkPrice(park) : "No incluido")}</b></div>
    </div>
  </button>`;
}

/* ---------- Día, hora de ida y hora de vuelta ---------- */

const DAY_TYPES = [["laborable", "Laborable"], ["sabado", "Sábado"], ["domingo", "Domingo"]];

function dateOverride() {
  return new URLSearchParams(location.search).get("date");
}

/** Día del cálculo: ?date= si viene en la dirección; si no, el próximo del tipo elegido. */
function departDay() {
  const d = dateOverride();
  if (d) return d;
  return nextDayOfType(state.profile.dayType || "laborable", state.profile.depart);
}

function dayLabel(isoDay) {
  const [y, m, d] = isoDay.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12));
  return date.toLocaleDateString("es-ES", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
}

function timePill() {
  const day = departDay();
  const [y, m, d] = day.split("-").map(Number);
  const short = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("es-ES", { timeZone: "UTC", weekday: "short", day: "numeric", month: "numeric" });
  return `${short} · ${state.profile.depart}${state.profile.roundTrip ? " → " + state.profile.returnAt : ""}`;
}

function minText(min) {
  if (min == null) return "—";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}

function clockPlus(iso, min) {
  if (!iso || min == null) return "";
  return clock(new Date(new Date(iso).getTime() + min * 60000).toISOString());
}

/* ---------- Margen de tráfico por trayecto ---------- */

function routeKey() {
  if (!state.origin || !state.dest) return null;
  return `${state.origin.lat.toFixed(3)},${state.origin.lon.toFixed(3)}>${state.dest.lat.toFixed(3)},${state.dest.lon.toFixed(3)}`;
}

function trafficPrefs() {
  const key = routeKey();
  return { out: null, back: null, ...(key ? state.traffic[key] || {} : {}) };
}

function setTraffic(dir, value) {
  const key = routeKey();
  if (!key) return;
  state.traffic = { ...state.traffic, [key]: { ...trafficPrefs(), [dir]: value } };
  saveJSON("trips.v1.traffic", state.traffic);
  recompute();
}

/** Texto de predicción de un tramo en coche: qué dijo TomTom y qué usa Trips. */
function predText(route) {
  if (!route?.s) return "";
  const tt = Math.round(route.tomtomS / 60);
  const free = route.noTrafficS ? Math.round(route.noTrafficS / 60) : null;
  const used = Math.round(route.s / 60);
  const why = route.marginPct
    ? route.marginAuto
      ? ` + ${route.marginPct} % de ${route.rush?.label || "tráfico"} (índice TomTom de Madrid)`
      : ` + tu margen de ${route.marginPct} %`
    : "";
  return `Predicción: TomTom ${tt} min${free != null ? ` (sin tráfico ${free})` : ""}${why}${why ? ` = ${used} min` : ""}`;
}

/* ---------- Aparcar en destino ---------- */

function parkPrefsFor(dest) {
  if (!dest) return { own: false, rent: null, usual: null };
  return { own: false, rent: null, usual: null, ...(state.destPrefs[destKey(dest)] || {}) };
}

function currentRent() {
  const prefs = parkPrefsFor(state.dest);
  if (prefs.rent != null) return prefs.rent;
  const row = state.result?.car?.parkRows?.find((r) => r.kind === "rent");
  return row?.monthlyFixedRef ?? 100;
}

function savePrefs(patch) {
  const key = destKey(state.dest);
  const next = { ...parkPrefsFor(state.dest), ...patch };
  state.destPrefs = { ...state.destPrefs, [key]: next };
  saveJSON("trips.v1.destPrefs", state.destPrefs);
  return next;
}

function setParkPref(patch) {
  if (!state.dest) return;
  const next = savePrefs(patch);
  if (state.result) state.result = reprice(state.result, state.profile, state.fuelQuote, next);
  paint();
}

function arriveAt(min) {
  return clockPlus(state.result?.departAt, min);
}

function hopText(r) {
  const h = r.out?.hop;
  if (!h) return "";
  if (h.transit) return `${h.min} min en ${lineSummary(h.plan) ? "metro " + lineSummary(h.plan) : "transporte"}`;
  return `${h.min} min a pie`;
}

function parkShort(r) {
  if (r.kind === "own") return "plaza en destino";
  if (r.kind === "white") return r.inside ? "calle sin SER" : `${r.usual ? (r.point.street || "tu calle") : "zona blanca"} + ${hopText(r)}`;
  if (r.kind === "carpark") return `parking ${r.label.replace(/^Parking\s+/i, "")} + ${r.out.hop.min} min a pie`;
  if (r.kind === "rent") return `plaza alquilada + ${r.out.hop.min} min a pie`;
  if (r.kind === "ser") return "SER en la calle";
  return r.label;
}

function parkPrice(r) {
  if (r.kind === "own") return "Plaza propia";
  if (r.kind === "white") return r.ticketsDay ? `Gratis + ${euro(r.ticketsDay)} metro` : "Gratis";
  if (r.kind === "carpark") return r.day != null ? `${euro(r.day)}/día` : "sin dato";
  if (r.kind === "rent") return r.fixed != null ? `${euro(r.fixed, 0)}/mes` : "sin precio";
  if (r.kind === "ser") return r.valid ? `${euro(r.day)}/día` : "no válido";
  return "No incluido";
}

function parkRowSub(r) {
  const bits = [];
  if (r.outMin != null) bits.push(`ida ${minText(r.outMin)}${r.backMin != null ? ` · vuelta ${minText(r.backMin)}` : ""}`);
  if (r.kind === "white") {
    if (r.inside) bits.push("sin SER en el destino");
    else {
      bits.push(`${r.point?.edgeM ?? "?"} m fuera del SER · buscar sitio ${r.searchMin} min · ${hopText(r)}`);
      if (r.out.hop?.transit) bits.push(r.ticket ? `${euro(r.ticket)} por viaje en metro` : "metro incluido en tu abono");
    }
  }
  if (r.kind === "carpark") bits.push(`${r.park.address} · ${r.out.hop.min} min a pie · ${r.dayNote || ""}`.replace(/ · $/, ""));
  if (r.kind === "rent") bits.push(r.ref ? `referencia ${euro(r.ref.median, 0)}/mes (${r.ref.samples.length} anuncios, ${euro(Math.min(...r.ref.samples.map((x) => x.eur)), 0)}–${euro(Math.max(...r.ref.samples.map((x) => x.eur)), 0)}) · a pie ${r.out.hop.min} min, estimado` : "sin referencia de precio en esta zona: pon el tuyo");
  if (r.kind === "ser") bits.push(r.valid ? `${Math.round(r.ser.regulated / 60)} h reguladas` : r.why);
  return bits.filter(Boolean).join(" · ");
}

function parkAlternatives(car) {
  const rows = car.parkRows.filter((r) => r.kind !== "own" && r.kind !== "unknown");
  const prefs = car.parkPrefs || {};
  const order = (r) => (r.usual ? 0 : 1) * 10 + ({ white: 0, carpark: 1, rent: 2, ser: 3 }[r.kind]) + (r.variant === "transit" ? 0.5 : 0);
  rows.sort((a, b) => order(a) - order(b));
  const extra = rows.find((r) => r.kind === "carpark")?.others || [];
  return `<div class="card" style="padding:12px 12px 8px">
      <h3 class="sheet-label" style="margin-bottom:4px">Dónde dejar el coche${car.parkingRaw?.inSer ? " · el destino está en el SER" : ""}</h3>
      <div class="set dp-own"><div class="k">Tengo plaza en destino<small>Solo para este destino. Se guarda en este móvil.</small></div><button type="button" class="toggle${prefs.own ? " is-on" : ""}" data-act="own-spot" aria-pressed="${Boolean(prefs.own)}"><i></i></button></div>
      ${rows.map((r) => `<div class="cand dp-row${r === car.park ? " is-on" : ""}${r.valid ? "" : " is-off"}">
        <div class="dp-top"><b>${esc(dpTitle(r))}${r.usual ? `<span class="badge usual">Habitual</span>` : ""}${r === car.park ? `<span class="badge fast">Elegida</span>` : ""}${!r.valid ? `<span class="badge bad">No válido para jornada completa</span>` : ""}</b><span class="dp-m">${r.monthly != null ? esc(euro(r.monthly)) + "<small>/mes</small>" : "—"}</span></div>
        <small>${esc(parkRowSub(r))}</small>
        ${r.kind === "rent" ? `<div class="dp-rent"><span>Tu precio</span>${stepper("rent", r.fixed != null ? euro(r.fixed, 0) : "—")}${prefs.rent != null ? `<button type="button" class="usual-clear" data-act="rent-reset">Referencia</button>` : ""}</div>` : ""}
      </div>`).join("")}
      ${extra.length ? `<div class="dp-more"><small><b>Otros parkings cerca:</b> ${extra.map((r) => `${esc(r.label)} ${r.day != null ? esc(euro(r.day)) + "/día" : "sin dato"} (${r.out.hop.min} min a pie)`).join(" · ")}</small></div>` : ""}
      <button type="button" class="dp-link" data-act="goto-car">${icon("i-car", 14)}Ajustar tráfico, búsqueda y aparcamiento habitual</button>
    </div>`;
}

function dpTitle(r) {
  if (r.kind === "white") {
    if (r.inside) return "Calle sin SER";
    const street = r.point?.street || r.point?.label || "calle";
    if (r.variant === "transit") {
      const st = r.out.hop?.plan?.itinerary?.legs?.find((l) => l.mode !== "WALK");
      return `${street} + ${st ? `${MODE_LABEL[st.mode] || "transporte"} ${st.route || ""} desde ${st.from}` : "transporte"}`;
    }
    return `${street} + a pie`;
  }
  if (r.kind === "carpark") return r.label;
  if (r.kind === "rent") return "Plaza de garaje alquilada";
  if (r.kind === "ser") return "SER en la calle (no residente)";
  return r.label;
}

function cardTransit() {
  const t = state.result.transit;
  const best = cheapest() === "transit";
  const zones = (t.fare?.zones || []).join(" → ");
  const real = transitIsReal(t.plan);
  const meta = real
    ? `${lineSummary(t.plan)} · ${t.plan.itinerary.transfers} transbordo${t.plan.itinerary.transfers === 1 ? "" : "s"} · zonas ${zones || "—"}`
    : t.ok
      ? `Zonas ${zones || "—"} · ${t.plan?.status === "pending" ? "sin itinerario · horario pendiente" : (t.plan?.message || "sin itinerario")}`
      : (t.fare?.notes?.[0] || "Sin corona tarifaria");
  const save = saveCell(t.monthly, state.result.car.monthly);
  return `<button type="button" class="card opt${best ? " is-best" : ""}" id="card-transit" data-act="detail" data-mode="transit">
    ${best ? `<span class="badge cheap tag">Más barata</span>` : ""}
    <div class="opt-top">
      <span class="mode-ic tr">${icon("i-train", 22)}</span>
      <div class="opt-main"><div class="opt-name">Transporte público</div><div class="opt-meta">${esc(meta)}</div></div>
      <div class="opt-time">${bigTime(t.timeMin, "pendiente")}${real ? `<div class="sub">llegas ${esc(clock(t.plan.itinerary.endTime))}${t.backMin != null ? `<br>vuelta ${esc(minText(t.backMin))}` : ""}</div>` : ""}</div>
    </div>
    <div class="opt-costs">
      <div><span>Al día</span><b>${esc(money(t.perDay))}</b></div>
      <div><span>Al mes</span><b class="amb">${esc(money(t.monthly))}</b></div>
      <div><span>${esc(save.label)}</span><b class="${save.cls}">${esc(save.text)}</b></div>
    </div>
  </button>`;
}

function cardCombined() {
  const leg = pickedLeg();
  const best = cheapest() === "combined";
  if (!leg) {
    return `<button type="button" class="card opt" id="card-combined" data-act="detail" data-mode="combined">
      <div class="opt-top"><span class="mode-ic mix">${icon("i-mix", 22)}</span>
        <div class="opt-main"><div class="opt-name">Combinada</div><div class="opt-meta">No hay un aparcamiento disuasorio a medio camino entre estos puntos.</div></div>
        <div class="opt-time">${bigTime(null, "sin candidato")}</div></div>
    </button>`;
  }
  const full = leg.totalMin != null;
  const time = full ? leg.totalMin : (leg.ok ? Math.round(leg.route.s / 60) : null);
  const where = parkLabel(leg.candidate.parking);
  const meta = full
    ? `Coche a ${where} · ${lineSummary(leg.transit)}`
    : leg.ok
    ? `Coche hasta ${where} · transporte pendiente`
    : `${where} · ${comma(leg.candidate.driveKm, 1)} km en línea recta, sin tiempo de ruta`;
  const faster = fasterThanPicked();
  const save = saveCell(leg.monthly, state.result.car.monthly);
  return `<button type="button" class="card opt${best ? " is-best" : ""}" id="card-combined" data-act="detail" data-mode="combined">
    ${best ? `<span class="badge cheap tag">Más barata</span>` : ""}
    <div class="opt-top">
      <span class="mode-ic mix">${icon("i-mix", 22)}</span>
      <div class="opt-main"><div class="opt-name">Combinada${leg.candidate.usual ? `<span class="opt-flag">Habitual</span>` : ""}</div><div class="opt-meta">${esc(meta)}${faster ? `<br>${esc(faster)}` : ""}</div></div>
      <div class="opt-time">${bigTime(time, "coche sin muestra")}${full ? `<div class="sub">llegas ${esc(clock(leg.arrival))}${leg.backMin != null ? `<br>vuelta ${esc(minText(leg.backMin))}` : ""}</div>` : time != null ? `<div class="sub">solo el coche</div>` : ""}</div>
    </div>
    <div class="opt-costs">
      <div><span>Al día</span><b>${esc(money(leg.perDay))}</b></div>
      <div><span>Al mes</span><b class="amb">${esc(money(leg.monthly != null ? leg.monthly : leg.fare?.monthlyPass))}</b></div>
      <div><span>${esc(leg.monthly != null ? save.label : "Abono")}</span><b class="${leg.monthly != null ? save.cls : "neutral"}">${esc(leg.monthly != null ? save.text : (leg.fare?.outer || "—"))}</b></div>
    </div>
  </button>`;
}

const MODE_LABEL = { BUS: "Bus", RAIL: "Cercanías", SUBWAY: "Metro", TRAM: "Metro Ligero", WALK: "A pie" };
const MODE_COLOR = { BUS: "#2f9e5b", RAIL: "#d62b36", SUBWAY: "#2b5fb3", TRAM: "#3c8fd0" };

function lineColor(leg) {
  return leg.color ? `#${leg.color.replace(/^#/, "")}` : (MODE_COLOR[leg.mode] || "#5a6270");
}

function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#1c2230" : "#fff";
}

function lineBadge(leg) {
  const bg = lineColor(leg);
  return `<span class="line-badge" style="background:${bg};color:${inkOn(bg)}">${esc(leg.route || MODE_LABEL[leg.mode] || leg.mode)}</span>`;
}

/** Tramos de un itinerario de OTP, en el formato de la maqueta. */
function legSteps(itinerary, destName) {
  const legs = itinerary.legs;
  return legs.map((leg, i) => {
    const toName = leg.to || destName;
    if (leg.mode === "WALK") {
      const what = i === 0 ? `A pie hasta ${toName}` : i === legs.length - 1 ? `A pie hasta ${destName}` : `Transbordo a pie hasta ${toName}`;
      return `<div class="step"><span class="node walk">${icon("i-walk", 16)}</span>
        <div><b>${esc(what)}</b><small>${esc(leg.distanceM < 1000 ? `${Math.max(10, Math.round(leg.distanceM / 10) * 10)} m` : kmText(leg.distanceM))} · ${esc(clock(leg.startTime))}–${esc(clock(leg.endTime))}</small></div>
        <span class="t">${leg.durationMin} min</span></div>`;
    }
    const prev = legs[i - 1];
    const wait = prev ? Math.max(0, Math.round((new Date(leg.startTime) - new Date(prev.endTime)) / 60000)) : 0;
    return `<div class="step"><span class="node" style="color:${lineColor(leg)}">${icon("i-train", 16)}</span>
      <div><b>${lineBadge(leg)} ${esc(MODE_LABEL[leg.mode] || leg.mode)} hasta ${esc(toName)}</b><small>Sale ${esc(clock(leg.startTime))} de ${esc(leg.from || "")}${wait ? ` · espera ${wait} min` : ""}${leg.headsign ? ` · dirección ${esc(leg.headsign)}` : ""}</small></div>
      <span class="t">${leg.durationMin} min</span></div>`;
  }).join("");
}

function legBadges(plan) {
  if (!transitIsReal(plan)) return "";
  return plan.itinerary.legs.filter((l) => l.mode !== "WALK").map(lineBadge).join("");
}

/** Si hay un candidato que llega antes que el elegido, se dice: no se esconde por ser el habitual. */
function fasterThanPicked() {
  const leg = pickedLeg();
  const best = (state.result?.combined?.options || []).find((o) => o.fastest);
  if (!leg || !best || best === leg || leg.totalMin == null) return "";
  const gain = leg.totalMin - best.totalMin;
  return gain >= 3 ? `${parkLabel(best.candidate.parking)} llega ${gain} min antes` : "";
}

function viewDetail() {
  const mode = state.detail;
  const title = mode === "car" ? "Coche" : mode === "transit" ? "Transporte público" : "Combinada";
  return `
    <div class="nav">
      <button type="button" class="icon-btn" data-act="back-results" aria-label="Volver a la comparación">${icon("i-back", 20)}</button>
      <div class="ttl"><b>${title}</b><small>${esc(shortPlace(state.origin, ""))} → ${esc(shortPlace(state.dest, ""))}</small></div>
      <button type="button" class="icon-btn" data-act="share" aria-label="Compartir resumen">${icon("i-share", 18)}</button>
    </div>
    <div class="scroll" id="detail">${mode === "car" ? detailCar() : mode === "transit" ? detailTransit() : detailCombined()}</div>`;
}

function detailCar() {
  const car = state.result.car;
  if (!car.ok) return `<div class="card empty">${esc(car.error)}</div>`;
  const park = car.park;
  const out = park?.out || { route: car.route, carS: car.route.s, hop: null };
  const back = park ? park.back : (car.backRoute ? { route: car.backRoute, carS: car.backRoute.s, hop: null } : null);
  const q = state.fuelQuote;
  const days = state.result.days;
  const dest = shortPlace(state.dest, "el destino");
  const where = !park ? "el destino" : park.kind === "white" && !park.inside ? (park.point.street || park.point.label || "la zona blanca") : park.kind === "carpark" ? park.label : park.kind === "rent" ? "tu plaza alquilada" : "el destino";
  const extraCar = park?.kind === "carpark" || park?.kind === "rent" ? 1 : 0;
  const carStep = (route, carS, toName, dir) => `<div class="step"><span class="node car">${icon("i-car", 16)}</span>
          <div><b>En coche hasta ${esc(toName)}</b><small>${esc(kmText(route.lengthM))} · ${esc(predText(route))}${extraCar ? " · +1 min de entrar o salir del garaje" : ""}</small></div>
          <span class="t">${Math.round(carS / 60)} min</span></div>`;
  const hopSteps = (hop, toName) => !hop ? "" : hop.plan?.status === "ok"
    ? legSteps(hop.plan.itinerary, toName)
    : `<div class="step"><span class="node walk">${icon("i-walk", 16)}</span><div><b>A pie hasta ${esc(toName)}</b><small>${hop.estimated ? "Estimado" : ""}</small></div><span class="t">${hop.min} min</span></div>`;
  const parkStep = park ? `<div class="step"><span class="node p">P</span>
          <div><b>${esc(park.kind === "own" ? "Aparcar en tu plaza" : park.kind === "white" ? "Buscar sitio en zona blanca" : park.kind === "carpark" ? "Entrar y aparcar" : park.kind === "rent" ? "Aparcar en la plaza alquilada" : "Aparcar en el SER")}${park.usual ? `<span class="opt-flag">Habitual</span>` : ""}</b><small>${esc(park.kind === "white" ? `Gratis, sin límite de horas. ${park.searchMin} min de búsqueda${park.usual ? ", el tuyo" : ", ajustable"}.` : park.kind === "carpark" ? `${parkPrice(park)} · ${park.dayNote || ""}` : park.kind === "rent" ? `${parkPrice(park)}, coste fijo al mes` : park.kind === "own" ? "Marcado como «Tengo plaza en destino»" : "")}</small></div>
          <span class="t">${park.searchMin ? park.searchMin + " min" : "—"}</span></div>` : `<div class="step"><span class="node">${icon("i-pin", 16)}</span>
          <div><b>Aparcamiento en destino</b><small>${esc(car.parkingRaw?.options?.find((o) => o.kind === "unknown")?.why || "No está en los datos.")} No se suma un precio de calle ni de parking.</small></div>
          <span class="t">—</span></div>`;
  const outMin = car.outMin;
  const backMin = car.backMin;
  const db = destParkingDb();
  const fuelOut = park?.fuelOut || car.fuel;
  const fuelBack = park?.fuelBack || null;
  const parkDay = park ? (park.day || 0) : null;
  const ticketsDay = park?.ticketsDay || 0;
  return `<div class="card">
      <div class="hero">
        <div><div class="big">${outMin}<small>min</small></div><div class="when">Ida: sales ${esc(clock(state.result.departAt))} · llegas ${esc(arriveAt(outMin))}${back && backMin != null ? `<br>Vuelta: ${esc(minText(backMin))}, ${esc(clock(state.result.returnAt))}–${esc(clockPlus(state.result.returnAt, backMin))}` : ""}</div></div>
        <div class="r"><strong>${esc(money(car.monthly))}</strong><span>al mes · ${esc(money(car.perDay))} al día</span></div>
      </div>
      <div class="leg-h">${icon("i-car", 14)}Ida · ${esc(clock(state.result.departAt))} → ${esc(arriveAt(outMin))}</div>
      <div class="steps">
        ${carStep(out.route, out.carS, where, "out")}
        ${parkStep}
        ${hopSteps(out.hop, dest)}
      </div>
      ${back ? `<div class="leg-h">${icon("i-repeat", 14)}Vuelta · ${esc(clock(state.result.returnAt))} → ${esc(backMin != null ? clockPlus(state.result.returnAt, backMin) : "—")}</div>
      <div class="steps">
        ${hopSteps(back.hop, where)}
        ${carStep(back.route, back.carS, shortPlace(state.origin, "el origen"), "back")}
      </div>` : ""}
    </div>
    ${car.parkRows?.some((r) => r.kind === "white" || r.kind === "carpark" || r.kind === "rent") ? parkAlternatives(car) : ""}
    <div class="card cost-card">
      <div class="ct head"><span>Coste</span><span>Al día</span><span>Al mes</span></div>
      <div class="ct"><span>Combustible<small>${fuelOut ? `${esc(litres(fuelOut.litres + (fuelBack?.litres || 0)))} × ${esc(litrePrice(q?.eurPerLitre))}${fuelBack ? ", ida y vuelta" : ""}` : "sin precio del Ministerio"}</small></span><b>${esc(money(fuelOut ? fuelOut.euros + (fuelBack?.euros || 0) : null))}</b><b>${esc(money(fuelOut ? (fuelOut.euros + (fuelBack?.euros || 0)) * days : null))}</b></div>
      <div class="ct"><span>Aparcamiento<small>${esc(!park ? "destino, no incluido" : park.kind === "rent" ? "plaza alquilada, fijo" : park.day ? `${euro(park.day)} al día, ${days} días` : park.kind === "white" ? "zona blanca" : "plaza propia")}</small></span><b>${esc(money(park ? parkDay + (park.fixed ? park.fixed / days : 0) : null))}</b><b>${esc(money(park ? parkDay * days + (park.fixed || 0) : null))}</b></div>
      ${park?.tickets ? `<div class="ct"><span>Metro, último tramo<small>${park.ticket ? `${park.tickets} sencillo${park.tickets === 1 ? "" : "s"} de ${euro(park.ticket)}` : "dentro de tu abono"}</small></span><b>${esc(euro(ticketsDay))}</b><b>${esc(euro(ticketsDay * days))}</b></div>` : ""}
      <div class="ct total"><span>Total</span><b>${esc(money(car.perDay))}</b><b>${esc(money(car.monthly))}</b></div>
    </div>
    ${notes(out.route.notice, `Los tiempos de coche son una predicción. TomTom da para una salida futura su perfil histórico; en hora punta laborable Trips lo sube hasta la congestión media del índice TomTom de Madrid 2025 (62 % por la mañana, 59 % por la tarde), y puedes poner tu propio margen en la pestaña Coche.`, park && db ? `Aparcar: ${db.ser.longStay.replace("Los ámbitos", "En el SER, los ámbitos")} Fuera de eso, un no residente puede estar 2 h en verde y 4 h en azul. ${db.ser.tariffNote} Zona blanca: calles fuera del SER según el Geoportal de Madrid y OpenStreetMap; gratis no quiere decir que haya sitio. Parkings: tarifa municipal 2026 o precio publicado por el operador; «sin dato» si no lo publica. Alquiler: anuncios de Idealista, Fotocasa, pisos.com y clasificados.st vistos el 12/11/2026.` : "")}`;
}

function detailTransit() {
  const t = state.result.transit;
  const fare = t.fare;
  if (!fare?.ok) return `<div class="card empty">${esc((fare?.notes || []).join(" ") || "No hay tarifa para estas coronas.")}</div>`;
  const preview = farePreview(fare);
  const real = transitIsReal(t.plan);
  const it = real ? t.plan.itinerary : null;
  const steps = real
    ? legSteps(it, shortPlace(state.dest, "el destino"))
    : `<div class="step"><span class="node">${icon("i-train", 16)}</span>
          <div><b>Metro, bus o cercanías</b><small>${esc(t.plan?.message || "Sin itinerario.")}</small></div>
          <span class="t">—</span></div>`;
  return `<div class="card">
      <div class="hero">
        <div>${real ? `<div class="big">${it.durationMin}<small>min</small></div><div class="when">Ida: sales ${esc(clock(it.startTime))} · llegas ${esc(clock(it.endTime))} · ${it.transfers} transbordo${it.transfers === 1 ? "" : "s"}${t.backMin != null ? `<br>Vuelta: ${esc(minText(t.backMin))}, llegas ${esc(clock(t.back.itinerary.endTime))}` : ""}</div>` : `<div class="big">—</div><div class="when">${esc(t.plan.message)}</div>`}</div>
        <div class="r"><strong>${esc(money(preview.best?.monthly))}</strong><span>al mes · sencillo ${esc(euro(preview.single.price))}</span></div>
      </div>
      <div class="leg-h">${icon("i-train", 14)}Ida${real ? ` · ${esc(clock(it.startTime))} → ${esc(clock(it.endTime))}` : ""}</div>
      <div class="steps">
        <div class="step"><span class="node"><span class="zone">${esc(state.origin.zone || "?")}</span></span>
          <div><b>${esc(shortPlace(state.origin, "Origen"))}</b><small>Corona ${esc(state.origin.zoneSource === "estacion" ? "de la estación" : "del polígono CRTM")}</small></div></div>
        ${steps}
        <div class="step"><span class="node"><span class="zone">${esc(state.dest.zone || "?")}</span></span>
          <div><b>${esc(shortPlace(state.dest, "Destino"))}</b><small>Zona ${esc(state.dest.zone || "fuera de corona")}</small></div></div>
      </div>
      ${state.result.roundTrip ? `<div class="leg-h">${icon("i-repeat", 14)}Vuelta · ${esc(clock(state.result.returnAt))} → ${transitIsReal(t.back) ? esc(clock(t.back.itinerary.endTime)) : "—"}</div>
      <div class="steps">${transitIsReal(t.back) ? legSteps(t.back.itinerary, shortPlace(state.origin, "el origen")) : `<div class="step"><span class="node">${icon("i-train", 16)}</span><div><b>Vuelta</b><small>${esc(t.back?.message || "Sin itinerario de vuelta.")}</small></div><span class="t">—</span></div>`}</div>` : ""}
    </div>
    ${fareBlock(preview)}
    ${notes(t.plan?.status === "ok" ? t.plan.message : "", ...fareNotes(preview, real))}`;
}

function detailCombined() {
  const options = state.result.combined.options || [];
  const leg = pickedLeg();
  if (!leg) return `<div class="card empty">No hay un aparcamiento disuasorio sensato entre el origen y el destino. En un trayecto corto, o fuera del corredor, Trips no fuerza un park and ride.</div>`;
  const min = leg.ok ? Math.round(leg.route.s / 60) : null;
  const preview = leg.fare?.ok ? farePreview(leg.fare) : null;
  const real = transitIsReal(leg.transit);
  const full = leg.totalMin != null;
  const monthly = leg.complete ? leg.monthly : preview?.best?.monthly;
  const parkName = parkLabel(leg.candidate.parking);
  const back = leg.back;
  const backReal = transitIsReal(back?.transit);
  const r = state.result;
  return `<div class="card">
      <div class="hero">
        <div><div class="big">${full ? leg.totalMin + "<small>min</small>" : min == null ? "—" : min + "<small>min</small>"}</div><div class="when">${full ? `Ida: sales ${esc(clock(r.departAt))} · llegas ${esc(clock(leg.arrival))}` : min == null ? "El tiempo en coche hasta el aparcamiento no está en esta muestra." : "Solo el tramo en coche. El transporte sigue pendiente de horarios."}${leg.backMin != null ? `<br>Vuelta: ${esc(minText(leg.backMin))}, ${esc(clock(r.returnAt))}–${esc(clock(leg.backArrival))}` : ""}</div></div>
        <div class="r"><strong>${esc(money(monthly))}</strong><span>${leg.complete ? "al mes, coche y abono" : "al mes, solo el abono"}</span></div>
      </div>
      <div class="leg-h">${icon("i-mix", 14)}Ida · ${esc(clock(r.departAt))} → ${esc(full ? clock(leg.arrival) : "—")}</div>
      <div class="steps">
        <div class="step"><span class="node car">${icon("i-car", 16)}</span>
          <div><b>Coche a ${esc(parkName)}</b><small>${leg.ok ? `${esc(kmText(leg.route.lengthM))} · ${esc(clock(r.departAt))}–${esc(clock(leg.route.arrivalAdj))} · ${esc(predText(leg.route))}` : esc(messageOf(leg.error))}</small></div>
          <span class="t">${min == null ? "—" : min + " min"}</span></div>
        <div class="step"><span class="node p">P</span>
          <div><b>Aparcar${leg.candidate.parking.kind === "pr" ? " en el P+R" : ""} ${esc(leg.candidate.parking.name)}${leg.candidate.usual ? `<span class="opt-flag">Habitual</span>` : ""}</b><small>${esc(parkFacts(leg.candidate.parking))}${leg.candidate.parking.src === "osm" ? " · aparcamiento de OpenStreetMap" : ""}</small></div>
          <span class="t">${leg.parkBufferMin ? leg.parkBufferMin + " min" : "—"}</span></div>
        ${real ? legSteps(leg.transit.itinerary, shortPlace(state.dest, "el destino")) : `<div class="step"><span class="node">${icon("i-train", 16)}</span>
          <div><b>Transporte hasta ${esc(shortPlace(state.dest, "el destino"))}</b><small>${esc(leg.transit?.message || "Pendiente de horarios.")} Zonas ${esc(leg.candidate.parking.zone || "?")} → ${esc(state.dest.zone || "?")}.</small></div>
          <span class="t">—</span></div>`}
      </div>
      ${r.roundTrip ? `<div class="leg-h">${icon("i-repeat", 14)}Vuelta por ${esc(parkName)} · ${esc(clock(r.returnAt))} → ${esc(leg.backArrival ? clock(leg.backArrival) : "—")}</div>
      <div class="steps">
        ${backReal ? legSteps(back.transit.itinerary, parkName) : `<div class="step"><span class="node">${icon("i-train", 16)}</span><div><b>Transporte hasta ${esc(parkName)}</b><small>${esc(back?.transit?.message || "Sin itinerario de vuelta.")}</small></div><span class="t">—</span></div>`}
        ${back?.route ? `<div class="step"><span class="node p">P</span><div><b>Del andén al coche</b><small>Margen fijo</small></div><span class="t">${back.unparkMin} min</span></div>
        <div class="step"><span class="node car">${icon("i-car", 16)}</span>
          <div><b>Coche a ${esc(shortPlace(state.origin, "casa"))}</b><small>${esc(kmText(back.route.lengthM))} · ${esc(predText(back.route))}</small></div>
          <span class="t">${Math.round(back.route.s / 60)} min</span></div>` : ""}
      </div>` : ""}
    </div>
    <div class="card" style="padding:12px 12px 8px">
      <h3 class="sheet-label" style="margin-bottom:4px">${["Candidato", "Dos candidatos", "Tres candidatos", "Cuatro candidatos"][options.length - 1] || "Candidatos"}</h3>
      ${options.map((row, i) => `<button type="button" class="cand${i === (state.result.combined.picked || 0) ? " is-on" : ""}" data-act="pick-leg" data-i="${i}">
        <b>${esc(parkLabel(row.candidate.parking))} · ${esc(row.candidate.parking.zone || "")}${row.candidate.usual ? `<span class="badge usual">Habitual</span>` : ""}${row.fastest ? `<span class="badge fast">Más rápida</span>` : ""}</b>
        <small>${row.totalMin != null ? `ida ${minText(row.totalMin)} · llegas ${esc(clock(row.arrival))}${row.backMin != null ? ` · vuelta ${minText(row.backMin)}` : ""} · ` : ""}${row.ok ? Math.round(row.route.s / 60) + " min en coche" : esc(messageOf(row.error))}${transitIsReal(row.transit) ? " · " + esc(lineSummary(row.transit)) : ""}</small>
      </button>`).join("")}
    </div>
    ${leg.fuel ? `<div class="card cost-card">
      <div class="ct head"><span>Coste</span><span>Al día</span><span>Al mes</span></div>
      <div class="ct"><span>Combustible<small>${esc(litres(leg.fuel.litres + (leg.fuelBack?.litres || 0)))} hasta el P+R${leg.fuelBack ? ", ida y vuelta" : ""}</small></span><b>${esc(money(leg.fuelDay))}</b><b>${esc(money(leg.fuelDay != null ? leg.fuelDay * r.days : null))}</b></div>
      <div class="ct"><span>Aparcamiento<small>${leg.parkingFree ? "marcado libre" : "de pago, no sumado"}</small></span><b>${leg.parkingFree ? "0,00 €" : "—"}</b><b>${leg.parkingFree ? "0,00 €" : "—"}</b></div>
      <div class="ct"><span>Transporte<small>${esc(preview?.best?.label || "abono")}</small></span><b>${esc(money(preview?.best?.monthly != null ? preview.best.monthly / r.days : null))}</b><b>${esc(money(preview?.best?.monthly))}</b></div>
      <div class="ct total"><span>Total</span><b>${esc(money(leg.perDay))}</b><b>${esc(money(leg.monthly))}</b></div>
    </div>` : ""}
    ${preview ? fareBlock(preview) : ""}
    ${notes(leg.route?.notice, real ? leg.transit.message : "", leg.parkingNote, "Los tramos en coche son una predicción con el margen de tráfico de la pestaña Coche.")}`;
}

/** Con itinerario, la nota de "sin itinerario" ya no es cierta: se explica qué es el sencillo. */
function fareNotes(fare, real) {
  return (fare.notes || []).map((n) => real && /^Sin itinerario/.test(n)
    ? "El precio del viaje es el sencillo interurbano de referencia (3,00 €); Cercanías y Metro tienen billete propio. El abono sí cubre todo el itinerario."
    : n);
}

function farePreview(fare) {
  return fare;
}

function fareBlock(fare) {
  const pass = fare.product;
  const price = fare.price?.amount;
  const official = pass?.officialPrice;
  return `<div class="card abono">
    <div class="abono-top"><h3>Abono recomendado</h3>
      <div class="seg mini">
        <button type="button" class="${fare.profile.id === "normal" ? "is-active" : ""}" data-act="age" data-age="31">Normal</button>
        <button type="button" class="${fare.profile.id === "joven" ? "is-active" : ""}" data-act="age" data-age="25">Joven</button>
      </div>
    </div>
    <div class="abono-main">
      <div style="display:flex;align-items:center"><span class="zone">${esc(pass?.zone === "*" ? fare.outer : pass?.zone || fare.outer)}</span>
        <div><b>${esc(fare.best?.label || "Abono")}</b><small>${official != null ? `Oficial ${esc(euro(official))}` : esc(pass?.discountNote || "")}${fare.best && fare.best.kind !== "pass" ? ` · al mes sale mejor ${esc(fare.best.label.toLowerCase())}` : ""}</small></div>
      </div>
      <strong>${esc(money(price))}</strong>
    </div>
  </div>
  <div class="card cost-card">
    <div class="ct head"><span>Si viajas ${state.result.trips} veces</span><span></span><span>Al mes</span></div>
    <div class="ct"><span>Sencillos<small>${esc(fare.single?.label || "")}</small></span><b></b><b>${esc(money(fare.monthlySingles))}</b></div>
    ${fare.monthlyTen != null ? `<div class="ct"><span>Bono de 10 viajes<small>solo zona A, EMT y ML1</small></span><b></b><b>${esc(euro(fare.monthlyTen))}</b></div>` : ""}
    <div class="ct"><span>Abono 30 días</span><b></b><b>${esc(money(fare.monthlyPass))}</b></div>
    <div class="ct total"><span>Conviene</span><b></b><b>${esc(fare.best?.label || "—")}</b></div>
  </div>`;
}

function notes(...parts) {
  const text = parts.filter(Boolean).join(" ");
  const fareNotes = "";
  return `<div class="source">${icon("i-info", 15)}<p class="note">${esc([sourceLine() + (text ? "." : ""), text].filter(Boolean).join(" "))}${fareNotes}</p></div>`;
}

function sourceLine() {
  const q = state.fuelQuote;
  const fuel = q ? `${q.fuel.long}: Ministerio (${q.scope === "municipio" ? q.place : "provincia"}), ${q.fecha || "hoy"}` : "Carburante: sin precio";
  const traffic = state.result?.car?.route?.source === "fixture" ? "Tráfico: muestra grabada de TomTom" : "Tráfico: TomTom";
  const timetable = transitIsReal(state.result?.transit?.plan) ? " · Horarios: GTFS CRTM en OpenTripPlanner" : "";
  return `${fuel} · ${traffic}${timetable} · Tarifas: CRTM 2026, rebaja hasta el 31/12/2026`;
}

function viewFavs() {
  return `<header class="topbar"><div class="title-block"><h1>Favoritos</h1><p class="updated">Guardados en este móvil</p></div></header>
    ${state.favorites.length ? `<div class="card">${state.favorites.map((r) => recentRow(r, true)).join("")}</div>` : `<div class="card empty">Todavía no hay favoritos. En la comparación, la estrella guarda el origen, el destino y el último precio calculado.</div>`}`;
}

/** Disuasorios con id propio. La capa CRTM reutiliza el mismo código en sitios distintos. */
function disuasorios() {
  return POOL.filter((p) => p.kind === "pr");
}

function filteredParks() {
  const base = disuasorios();
  const q = norm(state.parkQuery);
  if (!q) return base;
  return base.filter((p) => norm(`${p.name} ${p.muni} ${p.zone} ${p.fee}`).includes(q));
}

function viewParks() {
  const list = filteredParks();
  const listHidden = state.parkMode === "map" ? " is-hidden" : "";
  const mapHidden = state.parkMode === "list" ? " is-hidden" : "";
  return `<header class="topbar"><div class="title-block"><h1>Aparcamientos</h1><p class="updated">${disuasorios().length} disuasorios · CRTM y Ayuntamiento</p></div></header>
    <div class="park-tools">
      <input id="park-q" class="park-search" type="search" placeholder="Municipio, nombre o zona" value="${esc(state.parkQuery)}" autocomplete="off">
      <div class="seg park-seg" role="group" aria-label="Vista">
        <button type="button" class="${state.parkMode === "list" ? "is-active" : ""}" data-act="park-mode" data-mode="list">Lista</button>
        <button type="button" class="${state.parkMode === "map" ? "is-active" : ""}" data-act="park-mode" data-mode="map">Mapa</button>
      </div>
    </div>
    <div class="park-layout">
      <div class="park-list${listHidden}" id="park-list">${parkListHtml(list)}</div>
      <div class="park-map${mapHidden}"><div id="park-map" role="application" aria-label="Mapa de aparcamientos disuasorios"></div></div>
    </div>
    <p class="note" style="margin-top:8px">Mapa © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>. Tarifa Libre o Pago según la capa del CRTM, no un precio calculado. Esa capa repite el identificador (28_079_7 es La Garena y también Pavones); aquí cada sitio se distingue por el nombre.</p>`;
}

function parkListHtml(list) {
  if (!list.length) return `<div class="card empty">Ningún aparcamiento coincide con esa búsqueda.</div>`;
  return list.map((p) => `<button type="button" class="card park-row${p.id === state.parkId ? " is-on" : ""}" data-act="park" data-id="${esc(p.id)}">
    <b>${esc(p.name)}</b>
    <small>${esc(p.muni)} · zona ${esc(p.zone || "—")} · ${p.spaces ? p.spaces + " plazas · " : ""}${esc(p.fee)}${p.src === "ayuntamiento" ? " · Ayuntamiento" : ""}</small>
  </button>`).join("");
}

function viewCar() {
  const v = state.profile.vehicle;
  const q = state.fuelQuote;
  const theme = document.documentElement.dataset.theme;
  return `<div class="car-col">
    <header class="topbar"><div class="title-block"><h1>Coche y perfil</h1><p class="updated">Se guarda en este móvil. Sin cuenta.</p></div></header>
    <button type="button" class="glass car-head" data-act="vehicle">
      <span class="cico">${icon("i-car", 28)}</span>
      <div style="flex:1"><b>${esc(v.make)} ${esc(v.model)}</b><small>${esc(String(v.yearFrom))}–${esc(String(v.yearTo))} · ${v.tank ? esc(comma(v.tank, 1)) + " l · " : ""}${esc(v.engine || "")}</small></div>
      <span class="chip">Cambiar</span>
    </button>
    ${routeSettings()}
    <span class="sheet-label">Mi aparcamiento habitual de park and ride</span>
    ${usualParkHead()}
    <span class="sheet-label">Combustible</span>
    <div class="seg fuel-seg">${FUELS.map((f) => `<button type="button" class="${f.id === state.profile.fuelId ? "is-active" : ""}" data-act="fuel" data-fuel="${f.id}">${esc(f.label)}</button>`).join("")}</div>
    <div class="card group">
      <div class="set"><div class="k">Consumo<small>Mixto en ciudad y autovía</small></div>${stepper("cons", comma(state.profile.cons, 1) + " l")}</div>
      <div class="set"><div class="k">Precio de hoy<small>${q ? esc(q.scope === "municipio" ? "Media de " + q.place : "Media de Madrid") + " · Ministerio" : "Ministerio"}</small></div>
        <div class="v"><b style="color:var(--amber-2);font-weight:650">${q ? esc(litrePrice(q.eurPerLitre)) : "—"}</b></div></div>
    </div>
    <span class="sheet-label">Perfil para el abono</span>
    <div class="card group">
      <div class="set"><div class="k">Edad<small>${esc(profileLabel(state.profile.age))}${state.profile.age >= 26 && state.profile.age <= 64 ? ", 26–64 años" : ""}</small></div>${stepper("age", String(state.profile.age))}</div>
      <div class="set"><div class="k">Ya tengo abono con zona A<small>El metro del último tramo en coche sale gratis; si no, sencillo</small></div><button type="button" class="toggle${state.profile.hasAbonoA ? " is-on" : ""}" data-act="abono" aria-pressed="${Boolean(state.profile.hasAbonoA)}"><i></i></button></div>
    </div>
    <div class="profile-hint">${icon("i-info", 16)}<span>${ageHint(state.profile.age)}</span></div>
    <span class="sheet-label">Cálculo mensual</span>
    <div class="card group">
      <div class="set"><div class="k">Días al mes</div>${stepper("days", String(state.profile.days))}</div>
      <div class="set"><div class="k">Ida y vuelta<small>${state.profile.roundTrip ? `Vuelta a las ${esc(state.profile.returnAt)}; se cambia en Comparar` : "Solo se calcula la ida"}</small></div><button type="button" class="toggle${state.profile.roundTrip ? " is-on" : ""}" data-act="round" aria-pressed="${state.profile.roundTrip}"><i></i></button></div>
    </div>
    <span class="sheet-label">Apariencia</span>
    <div class="themes-row">${THEMES.map((name) => `<button type="button" data-act="theme" data-theme="${name}" class="${theme === name ? "is-active" : ""}"><i class="${name}"></i>${esc(labelTheme(name))}</button>`).join("")}</div>
  </div>`;
}

function parkFacts(p) {
  return [
    p.station ? `${p.station.modeName} ${p.station.name}` : p.muni,
    p.zone ? `zona ${p.zone}` : null,
    p.spaces ? `${p.spaces} plazas` : null,
    p.fee === "Libre" ? "gratis" : p.fee === "Sin dato" ? "tarifa sin dato" : p.fee ? p.fee.toLowerCase() : null
  ].filter(Boolean).join(" · ");
}

function usualParkHead() {
  const p = state.usualPark;
  return `<div class="glass car-head usual-head">
      <button type="button" class="usual-main" data-act="usual-park">
        <span class="cico p-ico">P</span>
        <div style="flex:1"><b>${p ? esc(parkLabel(p)) : "Sin elegir"}</b><small>${p ? esc(parkFacts(p)) : "Una estación o disuasorio donde sueles dejar el coche. La combinada lo calcula siempre."}</small></div>
        <span class="chip">${p ? "Cambiar" : "Elegir"}</span>
      </button>
      ${p ? `<button type="button" class="usual-clear" data-act="usual-clear">Quitar</button>` : ""}
    </div>`;
}

function openUsualPark() {
  state.sheetMode = "origin";
  document.getElementById("upk-title").textContent = "Mi aparcamiento habitual";
  document.querySelector("#sheet-park .lead").textContent = "Disuasorios del CRTM y estaciones de Cercanías, Metro y Metro Ligero con aparcamiento cerca. Se guarda en este móvil.";
  document.getElementById("upk-q").placeholder = "La Garena, Torrejón, Canillejas…";
  document.getElementById("backdrop").hidden = false;
  document.getElementById("sheet-park").hidden = false;
  const q = document.getElementById("upk-q");
  q.value = "";
  renderUsualParks("");
  q.focus();
}

function renderUsualParks(query) {
  const n = norm(query);
  const rows = POOL
    .filter((p) => !n || norm(`${p.name} ${p.muni} ${p.station?.name || ""} ${p.station?.modeName || ""} ${p.zone || ""}`).includes(n))
    .sort((a, b) => (b.kind === "pr") - (a.kind === "pr") || (b.station?.mode === "cercanias") - (a.station?.mode === "cercanias") || a.name.localeCompare(b.name, "es"))
    .slice(0, 40);
  const on = state.usualPark?.id;
  document.getElementById("upk-list").innerHTML = rows.map((p) =>
    `<button type="button" class="picker-row${p.id === on ? " is-on" : ""}" data-upk="${esc(p.id)}"><b>${esc(parkLabel(p))}${p.kind === "pr" ? ` <span class="tag-pr">P+R</span>` : ""}</b><small>${esc(parkFacts(p))}${p.src === "osm" ? " · aparcamiento de OSM" : ""}</small></button>`
  ).join("") || `<p class="note">Ninguna estación ni aparcamiento coincide.</p>`;
  document.querySelectorAll("#upk-list [data-upk]").forEach((btn) => {
    btn.addEventListener("click", () => chooseUsualPark(btn.dataset.upk));
  });
}

function chooseUsualPark(id) {
  const p = POOL.find((x) => x.id === id);
  if (!p) return;
  state.usualPark = p;
  saveJSON("trips.v1.usualPark", p);
  closeVehicle();
  toast(`${parkLabel(p)} queda como tu aparcamiento habitual.`);
  paint();
}

function labelTheme(name) {
  return { claro: "Claro", grafito: "Grafito", "grafito-oscuro": "Grafito oscuro", medianoche: "Medianoche" }[name] || name;
}

function stepper(field, text) {
  return `<div class="stepper"><button type="button" data-act="step" data-field="${field}" data-dir="-1" aria-label="Menos">−</button><b>${esc(text)}</b><button type="button" data-act="step" data-field="${field}" data-dir="1" aria-label="Más">+</button></div>`;
}

function comma(n, d = 1) {
  return Number(n).toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function renderSuggest() {
  const box = document.getElementById("suggest");
  if (!box) return;
  const s = state.suggest;
  if (!s) { box.innerHTML = ""; return; }
  if (s.error) {
    box.innerHTML = `<div class="suggest"><div class="suggest-msg err">${esc(s.error)}</div></div>`;
    return;
  }
  if (!s.items?.length) {
    box.innerHTML = s.notice ? `<div class="suggest"><div class="suggest-msg">${esc(s.notice)}</div></div>` : "";
    return;
  }
  box.innerHTML = `<div class="suggest" role="listbox">${s.items.map((it, i) =>
    `<button type="button" data-act="pick" data-i="${i}"><span>${esc(it.label)}</span><span class="tag">${esc(it.kind)}</span></button>`
  ).join("")}${s.notice ? `<div class="suggest-msg">${esc(s.notice)}</div>` : ""}</div>`;
}

function placeFrom(item) {
  const polygon = zoneAt(item.lat, item.lon, ZONES);
  const station = stationMatch(item.label, STATIONS);
  const zone = station?.zone || polygon;
  return {
    label: item.label,
    lat: item.lat,
    lon: item.lon,
    municipality: item.municipality || "",
    zone: zone || null,
    zoneSource: station?.zone ? "estacion" : (polygon ? "corona" : null)
  };
}

function refreshFuel() {
  if (!state.stationsFuel) return;
  const muni = state.origin?.municipality || "";
  const avg = averagePrice(state.stationsFuel, state.profile.fuelId, muni);
  state.fuelQuote = avg ? { ...avg, fecha: state.fuelFecha || "" } : null;
  if (state.result) state.result = reprice(state.result, state.profile, state.fuelQuote);
}

async function bootFuel() {
  try {
    const pack = await loadMadridStations();
    state.stationsFuel = pack.stations;
    state.fuelFecha = pack.fecha;
    state.fuelError = "";
    refreshFuel();
  } catch (err) {
    state.fuelError = err.message || "No se ha podido leer el precio del Ministerio.";
  }
  const line = document.getElementById("fuel-line") || document.querySelector(".fuel-line");
  if (line && state.view === "home" && state.tab === "compare") {
    line.outerHTML = fuelLine();
  } else if (state.tab === "car" || state.view === "detail" || state.view === "results") {
    paint();
  }
}

function onType(field, value) {
  if (field === "origin") { state.originText = value; state.origin = null; }
  else { state.destText = value; state.dest = null; }
  state.suggest = null;
  const btn = document.getElementById("btn-go");
  if (btn) btn.disabled = !goEnabled();
  clearTimeout(searchTimer);
  if (value.trim().length < 3) {
    state.suggest = null;
    renderSuggest();
    return;
  }
  searchTimer = setTimeout(() => runSearch(field, value), 450);
}

async function runSearch(field, value) {
  if (searchAbort) searchAbort.abort();
  searchAbort = new AbortController();
  const seq = ++searchSeq;
  try {
    const found = await searchPlaces(value, { signal: searchAbort.signal });
    if (seq !== searchSeq) return;
    const active = field === "origin" ? state.originText : state.destText;
    if (active !== value) return;
    state.suggest = { field, items: found.results, notice: found.notice || "", error: "" };
    renderSuggest();
  } catch (err) {
    if (err?.name === "AbortError" || seq !== searchSeq) return;
    state.suggest = { field, items: [], notice: "", error: err.userMessage || err.message };
    renderSuggest();
  }
}

function pickSuggest(index) {
  const item = state.suggest?.items?.[index];
  if (!item) return;
  const place = placeFrom(item);
  if (state.suggest.field === "dest") {
    state.dest = place;
    state.destText = item.label;
  } else {
    state.origin = place;
    state.originText = item.label;
  }
  state.suggest = null;
  refreshFuel();
  paint();
}

async function goCompare({ quiet = false } = {}) {
  if (!goEnabled()) return;
  state.busy = true;
  if (!quiet) state.view = "home";
  paint();
  try {
    clearTomTomRejection();
    const day = departDay();
    const departAt = departureOn(day, state.profile.depart);
    let returnAt = state.profile.roundTrip ? departureOn(day, state.profile.returnAt || "15:00") : null;
    if (returnAt && returnAt <= departAt) returnAt = new Date(returnAt.getTime() + 24 * 3600 * 1000);
    const result = await compareTrip({
      origin: state.origin,
      dest: state.dest,
      departAt,
      returnAt,
      profile: state.profile,
      fuelQuote: state.fuelQuote,
      parkings: POOL,
      usual: state.usualPark,
      parkPrefs: parkPrefsFor(state.dest),
      traffic: trafficPrefs()
    });
    result.combined.picked = Math.max(0, (result.combined.options || []).findIndex((o) => o.candidate.usual));
    state.result = result;
    rememberRecent();
    state.view = "results";
    state.tab = "compare";
  } catch (err) {
    state.bootError = err.userMessage || err.message;
    toast(state.bootError);
  } finally {
    state.busy = false;
    paint();
  }
}

/* ---------- Este trayecto: tráfico, búsqueda y aparcamiento habitual en destino ---------- */

function routeSettings() {
  if (!state.origin || !state.dest) {
    return `<span class="sheet-label">Este trayecto</span>
    <div class="card empty" style="margin-bottom:16px">Elige origen y destino en Comparar para ajustar el margen de tráfico y tu aparcamiento habitual en destino.</div>`;
  }
  const tp = trafficPrefs();
  const car = state.result?.car;
  const outR = car?.ok ? (car.park?.out?.route || car.route) : null;
  const backR = car?.ok ? (car.park?.back?.route || car.backRoute) : null;
  const row = (dir, label, route, user) => {
    const auto = route?.autoPct ?? null;
    const value = user ?? auto;
    const text = value == null ? "auto" : `+${value} %`;
    return `<div class="set"><div class="k">${label}<small>${route ? esc(predText(route)) : "Se ve al comparar"}${user == null ? " · automático" : ""}</small></div>
      <div class="v-col">${stepper(dir === "out" ? "m-out" : "m-back", text)}${user != null ? `<button type="button" class="usual-clear" data-act="m-reset" data-dir="${dir}">Automático</button>` : ""}</div></div>`;
  };
  const prefs = parkPrefsFor(state.dest);
  const u = prefs.usual;
  const search = u?.searchMin ?? state.profile.searchMin ?? 5;
  return `<span class="sheet-label">Este trayecto · ${esc(shortPlace(state.origin, "Origen"))} → ${esc(shortPlace(state.dest, "Destino"))}</span>
    <div class="card group">
      ${row("out", "Margen de tráfico, ida", outR, tp.out)}
      ${state.profile.roundTrip ? row("back", "Margen de tráfico, vuelta", backR, tp.back) : ""}
    </div>
    <div class="profile-hint">${icon("i-info", 16)}<span>Los tiempos de coche son predicciones. Si sueles tardar más o menos, ajusta el margen: se guarda para este trayecto.</span></div>
    <span class="sheet-label">Aparcamiento habitual en destino</span>
    <div class="glass car-head usual-head">
      <button type="button" class="usual-main" data-act="dest-park">
        <span class="cico p-ico">P</span>
        <div style="flex:1"><b>${u ? esc(u.street || u.label || "Tu punto") : "Sin elegir"}</b><small>${u ? esc(destParkFacts(u)) : "Una calle de zona blanca donde sueles aparcar. Se calcula siempre, a pie y en metro."}</small></div>
        <span class="chip">${u ? "Cambiar" : "Elegir"}</span>
      </button>
      ${u ? `<button type="button" class="usual-clear" data-act="dest-park-clear">Quitar</button>` : ""}
    </div>
    <div class="card group">
      <div class="set"><div class="k">Buscar sitio<small>${u ? "En tu calle habitual" : "En zona blanca, por defecto"}</small></div>${stepper("search", search + " min")}</div>
    </div>`;
}

function destParkFacts(u) {
  return [
    u.edgeM != null ? `${u.edgeM} m fuera del SER` : null,
    u.st ? `${u.st.mode === "cercanias" ? "Cercanías" : u.st.mode === "metro_ligero" ? "Metro Ligero" : "Metro"} ${u.st.name} a ${u.st.m} m` : null,
    state.dest ? `${comma(haversineKm(u, state.dest), 1)} km del destino` : null
  ].filter(Boolean).join(" · ");
}

/** Calles de zona blanca cerca del destino, una fila por calle (su punto más cercano a una estación o al destino). */
function destParkRows(query) {
  const db = destParkingDb();
  if (!db || !state.dest) return [];
  const n = norm(query);
  const byStreet = new Map();
  for (const w of db.whiteStreets) {
    if (!w.street) continue;
    const km = haversineKm(w, state.dest);
    if (km > 3) continue;
    if (n && !norm(`${w.street} ${w.st?.name || ""}`).includes(n)) continue;
    const prev = byStreet.get(w.street);
    const score = (w.st ? w.st.m / 1000 : 1) + km;
    if (!prev || score < prev.score) byStreet.set(w.street, { ...w, km, score });
  }
  return [...byStreet.values()].sort((a, b) => a.km - b.km).slice(0, 40);
}

function renderDestParks(query) {
  const on = parkPrefsFor(state.dest).usual;
  const rows = destParkRows(query);
  document.getElementById("upk-list").innerHTML = rows.map((w, i) =>
    `<button type="button" class="picker-row${on && on.street === w.street ? " is-on" : ""}" data-dpk="${i}"><b>${esc(w.street)}${w.st ? ` <span class="tag-pr">${esc(w.st.mode === "cercanias" ? "C" : "M")}</span>` : ""}</b><small>${esc(destParkFacts(w))}</small></button>`
  ).join("") || `<p class="note">Ninguna calle sin SER coincide cerca de este destino.</p>`;
  document.querySelectorAll("#upk-list [data-dpk]").forEach((btn) => {
    btn.addEventListener("click", () => chooseDestPark(rows[Number(btn.dataset.dpk)]));
  });
}

function openDestPark() {
  if (!state.dest) { toast("Elige primero un destino en Comparar."); return; }
  state.sheetMode = "dest";
  document.getElementById("upk-title").textContent = "Aparcamiento habitual en destino";
  document.querySelector("#sheet-park .lead").textContent = `Calles fuera del SER cerca de ${shortPlace(state.dest, "tu destino")} (Geoportal de Madrid y OpenStreetMap). Se guarda para este destino.`;
  const q = document.getElementById("upk-q");
  q.placeholder = "Manuel Machado, Estrella, Moratalaz…";
  q.value = "";
  document.getElementById("backdrop").hidden = false;
  document.getElementById("sheet-park").hidden = false;
  renderDestParks("");
  q.focus();
}

function chooseDestPark(w) {
  if (!w) return;
  const prev = parkPrefsFor(state.dest).usual;
  savePrefs({ usual: { lat: w.lat, lon: w.lon, street: w.street, st: w.st || null, edgeM: w.edgeM, searchMin: prev?.searchMin ?? state.profile.searchMin ?? 5 } });
  closeVehicle();
  toast(`${w.street} queda como tu aparcamiento habitual en destino.`);
  recompute();
}

/** Vuelve a calcular con los ajustes nuevos sin sacar al usuario de donde está (TomTom va de caché). */
async function recompute() {
  paint();
  if (!state.result || !goEnabled()) return;
  const keep = { tab: state.tab, view: state.view, detail: state.detail };
  await goCompare({ quiet: true });
  Object.assign(state, keep);
  paint();
}

function rememberRecent() {
  const bestRows = [];
  if (state.result.car.monthly != null) bestRows.push({ label: "Coche", monthly: state.result.car.monthly });
  if (state.result.transit.monthly != null) bestRows.push({ label: "Transporte", monthly: state.result.transit.monthly });
  const leg = pickedLeg();
  if (leg?.monthly != null) bestRows.push({ label: "Combinada", monthly: leg.monthly });
  bestRows.sort((a, b) => a.monthly - b.monthly);
  const item = {
    id: `${state.origin.lat.toFixed(4)},${state.origin.lon.toFixed(4)}>${state.dest.lat.toFixed(4)},${state.dest.lon.toFixed(4)}`,
    origin: state.origin,
    dest: state.dest,
    best: bestRows[0] || null,
    carMin: state.result.car.ok ? state.result.car.outMin : null,
    zones: [state.origin.zone, state.dest.zone].filter(Boolean).join(" → ")
  };
  state.recents = [item, ...state.recents.filter((r) => r.id !== item.id)].slice(0, 8);
  saveJSON("trips.v1.recents", state.recents);
}

function isFavorite() {
  if (!state.origin || !state.dest) return false;
  const id = `${state.origin.lat.toFixed(4)},${state.origin.lon.toFixed(4)}>${state.dest.lat.toFixed(4)},${state.dest.lon.toFixed(4)}`;
  return state.favorites.some((f) => f.id === id);
}

function toggleFavorite() {
  if (!state.result) return;
  const id = `${state.origin.lat.toFixed(4)},${state.origin.lon.toFixed(4)}>${state.dest.lat.toFixed(4)},${state.dest.lon.toFixed(4)}`;
  if (isFavorite()) state.favorites = state.favorites.filter((f) => f.id !== id);
  else {
    const saved = state.recents.find((r) => r.id === id);
    if (saved) state.favorites = [{ ...saved, star: true }, ...state.favorites.filter((f) => f.id !== id)];
  }
  saveJSON("trips.v1.favorites", state.favorites);
  paint();
}

function openSaved(id) {
  const item = state.favorites.find((f) => f.id === id) || state.recents.find((r) => r.id === id);
  if (!item) return;
  state.origin = item.origin;
  state.dest = item.dest;
  state.originText = item.origin.label;
  state.destText = item.dest.label;
  state.tab = "compare";
  state.view = "home";
  state.result = null;
  refreshFuel();
  paint();
}

function step(field, dir) {
  const p = state.profile;
  if (field === "cons") p.cons = Math.round(Math.min(20, Math.max(2, p.cons + dir * 0.1)) * 10) / 10;
  if (field === "age") p.age = Math.min(100, Math.max(0, p.age + dir));
  if (field === "days") p.days = Math.min(31, Math.max(1, p.days + dir));
  if (field === "rent") { setParkPref({ rent: Math.max(0, Math.round(((currentRent() ?? 0) + dir * 5) / 5) * 5) }); return; }
  if (field === "m-out" || field === "m-back") {
    const d = field === "m-out" ? "out" : "back";
    const car = state.result?.car;
    const route = d === "out" ? (car?.park?.out?.route || car?.route) : (car?.park?.back?.route || car?.backRoute);
    const now = trafficPrefs()[d] ?? route?.autoPct ?? 0;
    setTraffic(d, Math.min(150, Math.max(-30, now + dir * 5)));
    return;
  }
  if (field === "search") {
    const prefs = state.dest ? parkPrefsFor(state.dest) : {};
    if (prefs.usual) {
      savePrefs({ usual: { ...prefs.usual, searchMin: Math.min(30, Math.max(0, (prefs.usual.searchMin ?? 5) + dir)) } });
    } else {
      p.searchMin = Math.min(30, Math.max(0, (p.searchMin ?? 5) + dir));
      saveJSON("trips.v1.profile", p);
    }
    recompute();
    return;
  }

  saveJSON("trips.v1.profile", p);
  if (state.result) state.result = reprice(state.result, p, state.fuelQuote);
  paint();
}

function setAge(age) {
  state.profile.age = Number(age);
  saveJSON("trips.v1.profile", state.profile);
  if (state.result) state.result = reprice(state.result, state.profile, state.fuelQuote);
  paint();
}

function setFuel(id) {
  state.profile.fuelId = id;
  saveJSON("trips.v1.profile", state.profile);
  refreshFuel();
  paint();
}

function shareText() {
  const lines = [`${state.origin?.label || ""} → ${state.dest?.label || ""}`];
  const car = state.result?.car;
  if (car?.ok) lines.push(`Coche: ida ${car.outMin} min${car.backMin != null ? `, vuelta ${car.backMin} min` : ""}, ${car.park ? parkShort(car.park) + ", " : "aparcamiento no incluido, "}${money(car.perDay)} al día, ${money(car.monthly)} al mes.`);
  else if (car) lines.push(`Coche: ${car.error}`);
  const t = state.result?.transit;
  if (t) lines.push(`Transporte: tiempo pendiente de horarios. ${t.monthly != null ? money(t.monthly) + " al mes." : ""} Zonas ${(t.fare?.zones || []).join(" → ")}.`);
  const leg = pickedLeg();
  if (leg) lines.push(`Combinada vía ${parkLabel(leg.candidate.parking)}: ${leg.totalMin != null ? leg.totalMin + " min en total" : (leg.ok ? roundMinutes(leg.route.travelS) + " min en coche, transporte pendiente" : "transporte pendiente")}. ${leg.monthly != null ? money(leg.monthly) + " al mes." : "Abono " + money(leg.fare?.monthlyPass) + "."}`);
  lines.push(sourceLine());
  return lines.join("\n");
}

async function share() {
  const text = shareText();
  try {
    if (navigator.share) {
      await navigator.share({ title: "Trips", text });
      return;
    }
  } catch { /* el usuario ha cancelado */ }
  try {
    await navigator.clipboard.writeText(text);
    toast("Resumen copiado");
  } catch {
    toast("No se ha podido copiar el resumen");
  }
}

function toast(text) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 2800);
}

function destroyMaps() {
  if (cmpMap) { cmpMap.remove(); cmpMap = null; }
  if (parkMap) { parkMap.remove(); parkMap = null; parkLayer = null; }
}

function tileLayer() {
  return L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  });
}

function drawCompareMap() {
  const node = document.getElementById("cmp-map");
  if (!node || !window.L || !state.result) return;
  cmpMap = L.map(node, { zoomControl: false, attributionControl: true });
  tileLayer().addTo(cmpMap);
  const color = getComputedStyle(document.documentElement).getPropertyValue("--route-line").trim() || "#b56c10";
  const layers = [];
  if (state.origin) layers.push(L.marker([state.origin.lat, state.origin.lon], { icon: divIcon("o") }).addTo(cmpMap));
  if (state.dest) layers.push(L.marker([state.dest.lat, state.dest.lon], { icon: divIcon("d") }).addTo(cmpMap));
  const carLine = state.result.car.ok ? (state.result.car.park?.out?.route || state.result.car.route) : null;
  if (carLine?.points?.length) {
    layers.push(L.polyline(carLine.points, { color, weight: 5, opacity: 0.9 }).addTo(cmpMap));
  }
  const leg = pickedLeg();
  for (const row of state.result.combined.options || []) {
    const on = row === leg;
    layers.push(L.marker([row.candidate.parking.lat, row.candidate.parking.lon], { icon: divIcon(on ? "p" : "pdim") })
      .bindTooltip(parkLabel(row.candidate.parking), { direction: "top" })
      .addTo(cmpMap));
  }
  const bounds = layers.length ? L.featureGroup(layers).getBounds().pad(0.18) : null;
  if (bounds) cmpMap.fitBounds(bounds);
  setTimeout(() => {
    if (!cmpMap) return;
    cmpMap.invalidateSize();
    if (bounds) cmpMap.fitBounds(bounds);
  }, 60);
}

function drawParkMap() {
  const node = document.getElementById("park-map");
  if (!node || !window.L) return;
  parkMap = L.map(node, { zoomControl: true });
  tileLayer().addTo(parkMap);
  parkLayer = L.layerGroup().addTo(parkMap);
  const list = filteredParks();
  for (const p of list) {
    const marker = L.marker([p.lat, p.lon], { icon: divIcon(p.id === state.parkId ? "p" : "pdim") });
    marker.bindPopup(`<strong>${esc(p.name)}</strong><br>${esc(p.muni)} · zona ${esc(p.zone || "—")}<br>${p.spaces ? p.spaces + " plazas · " : ""}${esc(p.fee)}`);
    marker.addTo(parkLayer);
    if (p.id === state.parkId) marker.openPopup();
  }
  if (list.length) parkMap.fitBounds(L.latLngBounds(list.map((p) => [p.lat, p.lon])).pad(0.12));
  setTimeout(() => parkMap && parkMap.invalidateSize(), 80);
}

function divIcon(kind) {
  const html = kind === "o" ? '<div class="pin-o"></div>'
    : kind === "d" ? '<div class="pin-d"></div>'
    : `<div class="pin-p${kind === "pdim" ? " is-dim" : ""}">P</div>`;
  const size = kind === "o" || kind === "d" ? 16 : 26;
  return L.divIcon({ className: "pin-wrap", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
}

function openVehicle() {
  document.getElementById("backdrop").hidden = false;
  document.getElementById("sheet-vehicle").hidden = false;
  document.getElementById("veh-q").value = "";
  renderVehicles("");
  document.getElementById("veh-q").focus();
}
function closeVehicle() {
  document.getElementById("backdrop").hidden = true;
  document.getElementById("sheet-vehicle").hidden = true;
  const park = document.getElementById("sheet-park");
  if (park) park.hidden = true;
}
function renderVehicles(q) {
  const n = norm(q);
  const rows = VEHICLES.filter((v) => !n || norm(`${v.make} ${v.model} ${v.engine}`).includes(n)).slice(0, 40);
  document.getElementById("veh-list").innerHTML = rows.map((v, i) => {
    const realIndex = VEHICLES.indexOf(v);
    return `<button type="button" class="picker-row" data-veh="${realIndex}"><b>${esc(v.make)} ${esc(v.model)}</b><small>${esc(String(v.yearFrom))}–${esc(String(v.yearTo))} · ${esc(v.engine)} · ${esc(comma(v.cons, 1))} l/100 km · ${esc(fuelById(v.fuel).label)}</small></button>`;
  }).join("") || `<p class="note">Ningún vehículo coincide.</p>`;
  document.querySelectorAll("#veh-list [data-veh]").forEach((btn) => {
    btn.addEventListener("click", () => chooseVehicle(Number(btn.dataset.veh)));
  });
}
function chooseVehicle(index) {
  const v = VEHICLES[index];
  if (!v) return;
  state.profile.vehicle = {
    make: v.make, model: v.model, yearFrom: v.yearFrom, yearTo: v.yearTo,
    engine: v.engine, fuel: v.fuel, tank: v.tank, cons: v.cons
  };
  state.profile.cons = v.cons;
  if (FUELS.some((f) => f.id === v.fuel)) state.profile.fuelId = v.fuel;
  saveJSON("trips.v1.profile", state.profile);
  refreshFuel();
  closeVehicle();
  paint();
}

function onScreenClick(e) {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "theme") { applyTheme(t.dataset.theme); paint(); }
  else if (act === "swap") {
    [state.origin, state.dest] = [state.dest, state.origin];
    [state.originText, state.destText] = [state.destText, state.originText];
    state.suggest = null;
    refreshFuel();
    paint();
  } else if (act === "time") { state.timeOpen = !state.timeOpen; paint(); }
  else if (act === "round") {
    state.profile.roundTrip = !state.profile.roundTrip;
    saveJSON("trips.v1.profile", state.profile);
    if (state.result) state.result = reprice(state.result, state.profile, state.fuelQuote);
    paint();
  } else if (act === "goto-car") { state.tab = "car"; paint(); }
  else if (act === "go") goCompare();
  else if (act === "pick") pickSuggest(Number(t.dataset.i));
  else if (act === "back") { state.view = "home"; paint(); }
  else if (act === "back-results") { state.view = "results"; paint(); }
  else if (act === "detail") { state.detail = t.dataset.mode; state.view = "detail"; paint(); }
  else if (act === "star") toggleFavorite();
  else if (act === "share") share();
  else if (act === "open-saved") openSaved(t.dataset.id);
  else if (act === "step") step(t.dataset.field, Number(t.dataset.dir));
  else if (act === "daytype") { state.profile.dayType = t.dataset.day; saveJSON("trips.v1.profile", state.profile); paint(); }
  else if (act === "abono") {
    state.profile.hasAbonoA = !state.profile.hasAbonoA;
    saveJSON("trips.v1.profile", state.profile);
    if (state.result) state.result = reprice(state.result, state.profile, state.fuelQuote);
    paint();
  }
  else if (act === "m-reset") setTraffic(t.dataset.dir, null);
  else if (act === "dest-park") openDestPark();
  else if (act === "dest-park-clear") { savePrefs({ usual: null }); recompute(); }
  else if (act === "own-spot") setParkPref({ own: !parkPrefsFor(state.dest).own });
  else if (act === "rent-reset") setParkPref({ rent: null });
  else if (act === "fuel") setFuel(t.dataset.fuel);
  else if (act === "age") setAge(t.dataset.age);
  else if (act === "vehicle") openVehicle();
  else if (act === "usual-park") openUsualPark();
  else if (act === "usual-clear") {
    state.usualPark = null;
    localStorage.removeItem("trips.v1.usualPark");
    paint();
  }
  else if (act === "park-mode") { state.parkMode = t.dataset.mode; paint(); }
  else if (act === "park") {
    state.parkId = t.dataset.id;
    state.parkMode = window.innerWidth >= 900 ? state.parkMode : "map";
    paint();
  } else if (act === "pick-leg") {
    state.result.combined.picked = Number(t.dataset.i);
    paint();
  }
}

function onScreenInput(e) {
  if (e.target.id === "in-origin") onType("origin", e.target.value);
  if (e.target.id === "in-dest") onType("dest", e.target.value);
  if (e.target.id === "depart") {
    state.profile.depart = e.target.value || "08:00";
    saveJSON("trips.v1.profile", state.profile);
    const pill = document.querySelector('[data-act="time"]');
    if (pill) pill.lastChild.textContent = timePill();
  }
  if (e.target.id === "return-at") {
    state.profile.returnAt = e.target.value || "15:00";
    saveJSON("trips.v1.profile", state.profile);
    const pill = document.querySelector('[data-act="time"]');
    if (pill) pill.lastChild.textContent = timePill();
  }
  if (e.target.id === "park-q") {
    state.parkQuery = e.target.value;
    const list = document.getElementById("park-list");
    if (list) list.innerHTML = parkListHtml(filteredParks());
    if (parkMap) { destroyMaps(); requestAnimationFrame(drawParkMap); }
  }
}

async function boot() {
  screen.innerHTML = `<div class="card empty"><strong>Preparando Trips</strong><br>Zonas, tarifas y aparcamientos.</div>`;
  try {
    const file = (path) => fetch(new URL(path, import.meta.url)).then((r) => {
      if (!r.ok) throw new Error("No se ha podido cargar " + path);
      return r.json();
    });
    const [fares, zonesDoc, stationsDoc, parkingsDoc, vehiclesDoc, stationParksDoc, destParkDoc] = await Promise.all([
      file("../data/fares.json"),
      file("../data/zones.json"),
      file("../data/stations.json"),
      file("../data/parkings.json"),
      file("../vehicles.json"),
      file("../data/station_parkings.json").catch(() => ({ items: [] })),
      file("../data/dest_parking.json").catch(() => null)
    ]);
    setFareDb(fares);
    ZONES = zonesDoc.zones;
    STATIONS = buildStationIndex(stationsDoc);
    PARKINGS = parkingsDoc.items;
    POOL = buildParkPool(PARKINGS, stationParksDoc.items, (lat, lon) => zoneAt(lat, lon, ZONES));
    state.usualPark = loadJSON("trips.v1.usualPark", null);
    setDestParkingDb(destParkDoc);
    state.destPrefs = loadJSON("trips.v1.destPrefs", {});
    state.traffic = loadJSON("trips.v1.traffic", {});
    VEHICLES = [];
    for (const make of vehiclesDoc.makes || []) {
      for (const model of make.models || []) {
        for (const variant of model.variants || []) {
          VEHICLES.push({ make: make.name, model: model.name, ...variant });
        }
      }
    }
    state.profile = { ...defaultProfile(VEHICLES), ...loadJSON("trips.v1.profile", {}) };
    if (!state.profile.vehicle) state.profile = defaultProfile(VEHICLES);
    state.favorites = loadJSON("trips.v1.favorites", []);
    state.recents = loadJSON("trips.v1.recents", []);
    applyTheme(localStorage.getItem("trips.v1.theme") || "claro");
    paint();
    bootFuel();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
  } catch (err) {
    screen.innerHTML = `<div class="card empty"><strong>No se han podido cargar los datos</strong><br>${esc(err.message || "")}</div>`;
  }
}

screen.addEventListener("click", onScreenClick);
screen.addEventListener("input", onScreenInput);
screen.addEventListener("mousedown", (e) => {
  if (e.target.closest("#suggest")) e.preventDefault();
});
document.getElementById("tabbar").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tab]");
  if (!btn) return;
  state.tab = btn.dataset.tab;
  if (state.tab === "compare" && state.view !== "detail" && state.view !== "results") state.view = "home";
  paint();
});
document.getElementById("veh-close").addEventListener("click", closeVehicle);
document.getElementById("backdrop").addEventListener("click", closeVehicle);
document.getElementById("veh-q").addEventListener("input", (e) => renderVehicles(e.target.value));
document.getElementById("upk-close").addEventListener("click", closeVehicle);
document.getElementById("upk-q").addEventListener("input", (e) => (state.sheetMode === "dest" ? renderDestParks(e.target.value) : renderUsualParks(e.target.value)));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeVehicle();
    state.suggest = null;
    const wasTime = state.timeOpen;
    state.timeOpen = false;
    if (wasTime) paint();
    else renderSuggest();
  }
});

boot();
