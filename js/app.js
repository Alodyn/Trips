import { setFareDb } from "./fares.js";
import { zoneAt, buildStationIndex, stationMatch } from "./geo.js";
import { FUELS, fuelById, loadMadridStations, averagePrice } from "./fuel.js";
import { compareTrip, reprice, messageOf } from "./compare.js";
import { fixturesEnabled, searchPlaces, clearTomTomRejection } from "./tomtom.js";
import { euro, litrePrice, litres, kmText, roundMinutes, clock, esc, nextDeparture, norm } from "./format.js";

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
  toast: ""
};

let ZONES = [];
let STATIONS = new Map();
let PARKINGS = [];
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
    depart: "08:00"
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
          <button type="button" class="filter-pill" data-act="time">${icon("i-clock", 16)}Salida ${esc(state.profile.depart)}</button>
          <button type="button" class="filter-pill${state.profile.roundTrip ? "" : " is-off"}" data-act="round">${icon("i-repeat", 16)}${state.profile.roundTrip ? "Ida y vuelta · L–V" : "Solo ida"}</button>
          <div class="time-pop" id="time-pop" ${state.timeOpen ? "" : "hidden"}>
            <label for="depart">Hora de salida</label>
            <input id="depart" type="time" value="${esc(state.profile.depart)}">
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
      <div class="ttl"><b>${esc(title)}</b><small>Salida ${esc(state.profile.depart)} · ${esc(days)}</small></div>
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

function cardCar() {
  const car = state.result.car;
  const best = cheapest() === "car";
  const time = car.ok ? roundMinutes(car.route.travelS) : null;
  const arrive = car.ok ? clock(car.route.arrival) : "";
  const delay = car.ok ? Math.round((car.route.delayS || 0) / 60) : null;
  const meta = !car.ok
    ? car.error
    : `${kmText(car.route.lengthM)} · ${delay ? delay + " min de retraso" : "sin retraso de tráfico en la respuesta"}`;
  return `<button type="button" class="card opt${best ? " is-best" : ""}" id="card-car" data-act="detail" data-mode="car">
    ${best ? `<span class="badge cheap tag">Más barata</span>` : ""}
    <div class="opt-top">
      <span class="mode-ic car">${icon("i-car", 22)}</span>
      <div class="opt-main"><div class="opt-name">Coche</div><div class="opt-meta">${esc(meta)}</div></div>
      <div class="opt-time">${bigTime(time, "sin tiempo")}<div class="sub">${car.ok && car.route.source === "fixture" ? `muestra · ${esc(clock(car.route.departure))}` : (arrive ? `llegas ${esc(arrive)}` : "")}</div></div>
    </div>
    <div class="opt-costs">
      <div><span>Viaje</span><b>${esc(money(car.trip))}</b></div>
      <div><span>Al mes</span><b class="amb">${esc(money(car.monthly))}</b></div>
      <div><span>Aparcar</span><b class="neutral">No incluido</b></div>
    </div>
  </button>`;
}

function cardTransit() {
  const t = state.result.transit;
  const best = cheapest() === "transit";
  const zones = (t.fare?.zones || []).join(" → ");
  const meta = t.ok
    ? `Zonas ${zones || "—"} · sin itinerario · horario pendiente`
    : (t.fare?.notes?.[0] || "Sin corona tarifaria");
  const save = saveCell(t.monthly, state.result.car.monthly);
  return `<button type="button" class="card opt${best ? " is-best" : ""}" id="card-transit" data-act="detail" data-mode="transit">
    ${best ? `<span class="badge cheap tag">Más barata</span>` : ""}
    <div class="opt-top">
      <span class="mode-ic tr">${icon("i-train", 22)}</span>
      <div class="opt-main"><div class="opt-name">Transporte público</div><div class="opt-meta">${esc(meta)}</div></div>
      <div class="opt-time">${bigTime(t.timeMin, "pendiente")}</div>
    </div>
    <div class="opt-costs">
      <div><span>Viaje</span><b>${t.trip != null ? esc(euro(t.trip)) : "—"}</b></div>
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
  const time = leg.ok ? roundMinutes(leg.route.travelS) : null;
  const meta = leg.ok
    ? `Coche hasta ${leg.candidate.parking.name} · transporte pendiente`
    : `${leg.candidate.parking.name} · ${comma(leg.candidate.driveKm, 1)} km en línea recta, sin tiempo de ruta`;
  const save = saveCell(leg.monthly, state.result.car.monthly);
  return `<button type="button" class="card opt${best ? " is-best" : ""}" id="card-combined" data-act="detail" data-mode="combined">
    ${best ? `<span class="badge cheap tag">Más barata</span>` : ""}
    <div class="opt-top">
      <span class="mode-ic mix">${icon("i-mix", 22)}</span>
      <div class="opt-main"><div class="opt-name">Combinada</div><div class="opt-meta">${esc(meta)}</div></div>
      <div class="opt-time">${bigTime(time, "coche sin muestra")}${time != null ? `<div class="sub">solo el coche</div>` : ""}</div>
    </div>
    <div class="opt-costs">
      <div><span>Viaje</span><b>${esc(money(leg.trip))}</b></div>
      <div><span>Al mes</span><b class="amb">${esc(money(leg.monthly != null ? leg.monthly : leg.fare?.monthlyPass))}</b></div>
      <div><span>${esc(leg.monthly != null ? save.label : "Abono")}</span><b class="${leg.monthly != null ? save.cls : "neutral"}">${esc(leg.monthly != null ? save.text : (leg.fare?.outer || "—"))}</b></div>
    </div>
  </button>`;
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
  const min = roundMinutes(car.route.travelS);
  const delay = Math.round((car.route.delayS || 0) / 60);
  const q = state.fuelQuote;
  return `<div class="card">
      <div class="hero">
        <div><div class="big">${min}<small>min</small></div><div class="when">Sales ${esc(clock(car.route.departure) || state.profile.depart)} · llegas ${esc(clock(car.route.arrival))}${car.route.source === "fixture" ? ". Es la hora de la respuesta grabada." : ""}</div></div>
        <div class="r"><strong>${esc(money(car.monthly))}</strong><span>al mes · ${esc(money(car.trip))} el viaje</span></div>
      </div>
      <div class="steps">
        <div class="step"><span class="node car">${icon("i-car", 16)}</span>
          <div><b>En coche hasta el destino</b><small>${esc(kmText(car.route.lengthM))} · ${delay ? delay + " min de retraso respecto a circular sin tráfico" : "TomTom no indica retraso de tráfico en esta respuesta"}</small></div>
          <span class="t">${min} min</span></div>
        <div class="step"><span class="node">${icon("i-pin", 16)}</span>
          <div><b>Aparcamiento en destino</b><small>No está en los datos. No se suma un precio de calle ni de parking.</small></div>
          <span class="t">—</span></div>
      </div>
    </div>
    <div class="card cost-card">
      <div class="ct head"><span>Coste</span><span>Viaje</span><span>Al mes</span></div>
      <div class="ct"><span>Combustible<small>${car.fuel ? `${esc(litres(car.fuel.litres))} × ${esc(litrePrice(q?.eurPerLitre))}` : "sin precio del Ministerio"}</small></span><b>${esc(money(car.trip))}</b><b>${esc(money(car.monthly))}</b></div>
      <div class="ct"><span>Aparcamiento<small>destino, no incluido</small></span><b>—</b><b>—</b></div>
      <div class="ct total"><span>Total</span><b>${esc(money(car.trip))}</b><b>${esc(money(car.monthly))}</b></div>
    </div>
    ${notes(car.route.notice)}`;
}

function detailTransit() {
  const t = state.result.transit;
  const fare = t.fare;
  if (!fare?.ok) return `<div class="card empty">${esc((fare?.notes || []).join(" ") || "No hay tarifa para estas coronas.")}</div>`;
  const preview = farePreview(fare);
  return `<div class="card">
      <div class="hero">
        <div><div class="big">—</div><div class="when">${esc(t.plan.message)}</div></div>
        <div class="r"><strong>${esc(money(preview.best?.monthly))}</strong><span>al mes · sencillo ${esc(euro(preview.single.price))}</span></div>
      </div>
      <div class="steps">
        <div class="step"><span class="node"><span class="zone">${esc(state.origin.zone || "?")}</span></span>
          <div><b>${esc(shortPlace(state.origin, "Origen"))}</b><small>Corona ${esc(state.origin.zoneSource === "estacion" ? "de la estación" : "del polígono CRTM")}</small></div></div>
        <div class="step"><span class="node">${icon("i-train", 16)}</span>
          <div><b>Metro, bus o cercanías</b><small>El itinerario y los transbordos llegarán con OpenTripPlanner. Hasta entonces no hay un tiempo.</small></div>
          <span class="t">—</span></div>
        <div class="step"><span class="node"><span class="zone">${esc(state.dest.zone || "?")}</span></span>
          <div><b>${esc(shortPlace(state.dest, "Destino"))}</b><small>Zona ${esc(state.dest.zone || "fuera de corona")}</small></div></div>
      </div>
    </div>
    ${fareBlock(preview)}
    ${notes(...preview.notes)}`;
}

function detailCombined() {
  const options = state.result.combined.options || [];
  const leg = pickedLeg();
  if (!leg) return `<div class="card empty">No hay un aparcamiento disuasorio sensato entre el origen y el destino. En un trayecto corto, o fuera del corredor, Trips no fuerza un park and ride.</div>`;
  const min = leg.ok ? roundMinutes(leg.route.travelS) : null;
  const preview = leg.fare?.ok ? farePreview(leg.fare) : null;
  const monthly = leg.complete ? leg.monthly : preview?.best?.monthly;
  return `<div class="card">
      <div class="hero">
        <div><div class="big">${min == null ? "—" : min + "<small>min</small>"}</div><div class="when">${min == null ? "El tiempo en coche hasta el aparcamiento no está en esta muestra." : "Solo el tramo en coche. El transporte sigue pendiente de horarios."}</div></div>
        <div class="r"><strong>${esc(money(monthly))}</strong><span>${leg.complete ? "al mes, coche y abono" : "al mes, solo el abono"}</span></div>
      </div>
      <div class="steps">
        <div class="step"><span class="node car">${icon("i-car", 16)}</span>
          <div><b>Coche al P+R ${esc(leg.candidate.parking.name)}</b><small>${leg.ok ? `${esc(kmText(leg.route.lengthM))} por la ruta de TomTom` : esc(messageOf(leg.error))}. En línea recta hay ${esc(comma(leg.candidate.driveKm, 1))} km; eso no es el tiempo de viaje.</small></div>
          <span class="t">${min == null ? "—" : min + " min"}</span></div>
        <div class="step"><span class="node p">P</span>
          <div><b>${esc(leg.candidate.parking.name)}</b><small>${esc(leg.candidate.parking.muni)} · zona ${esc(leg.candidate.parking.zone || "—")} · ${leg.candidate.parking.spaces ? leg.candidate.parking.spaces + " plazas · " : ""}${esc(leg.candidate.parking.fee)}. ${esc(leg.parkingNote)}</small></div>
          <span class="t">—</span></div>
        <div class="step"><span class="node">${icon("i-train", 16)}</span>
          <div><b>Transporte hasta ${esc(shortPlace(state.dest, "el destino"))}</b><small>${esc(leg.transit?.message || "Pendiente de horarios.")} Zonas ${esc(leg.candidate.parking.zone || "?")} → ${esc(state.dest.zone || "?")}.</small></div>
          <span class="t">—</span></div>
      </div>
    </div>
    <div class="card" style="padding:12px 12px 8px">
      <h3 class="sheet-label" style="margin-bottom:4px">Tres candidatos</h3>
      ${options.map((row, i) => `<button type="button" class="cand${i === (state.result.combined.picked || 0) ? " is-on" : ""}" data-act="pick-leg" data-i="${i}">
        <b>${esc(row.candidate.parking.name)} · ${esc(row.candidate.parking.zone || "")}</b>
        <small>${row.ok ? esc(kmText(row.route.lengthM)) + " · " + roundMinutes(row.route.travelS) + " min en coche" : esc(messageOf(row.error))} · quedan ${esc(comma(row.candidate.remainKm, 1))} km en línea recta</small>
      </button>`).join("")}
    </div>
    ${leg.fuel ? `<div class="card cost-card">
      <div class="ct head"><span>Coste</span><span>Viaje</span><span>Al mes</span></div>
      <div class="ct"><span>Combustible<small>${esc(litres(leg.fuel.litres))} hasta el P+R</small></span><b>${esc(euro(leg.fuel.euros))}</b><b>${esc(euro(leg.fuel.euros * state.result.trips))}</b></div>
      <div class="ct"><span>Aparcamiento<small>${leg.parkingFree ? "marcado libre" : "de pago, no sumado"}</small></span><b>${leg.parkingFree ? "0,00 €" : "—"}</b><b>${leg.parkingFree ? "0,00 €" : "—"}</b></div>
      <div class="ct"><span>Transporte<small>${esc(preview?.single?.label || "sencillo")}</small></span><b>${esc(euro(preview?.single?.price))}</b><b>${esc(money(preview?.best?.monthly))}</b></div>
      <div class="ct total"><span>Total</span><b>${esc(money(leg.trip))}</b><b>${esc(money(leg.monthly))}</b></div>
    </div>` : ""}
    ${preview ? fareBlock(preview) : ""}
    ${notes(leg.route?.notice, leg.parkingNote)}`;
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
  return `<div class="source">${icon("i-info", 15)}<p class="note">${esc([sourceLine(), text].filter(Boolean).join(" "))}${fareNotes}</p></div>`;
}

function sourceLine() {
  const q = state.fuelQuote;
  const fuel = q ? `${q.fuel.long}: Ministerio (${q.scope === "municipio" ? q.place : "provincia"}), ${q.fecha || "hoy"}` : "Carburante: sin precio";
  const traffic = state.result?.car?.route?.source === "fixture" ? "Tráfico: muestra grabada de TomTom" : "Tráfico: TomTom";
  return `${fuel} · ${traffic} · Tarifas: CRTM 2026, rebaja hasta el 31/12/2026`;
}

function viewFavs() {
  return `<header class="topbar"><div class="title-block"><h1>Favoritos</h1><p class="updated">Guardados en este móvil</p></div></header>
    ${state.favorites.length ? `<div class="card">${state.favorites.map((r) => recentRow(r, true)).join("")}</div>` : `<div class="card empty">Todavía no hay favoritos. En la comparación, la estrella guarda el origen, el destino y el último precio calculado.</div>`}`;
}

function filteredParks() {
  const q = norm(state.parkQuery);
  if (!q) return PARKINGS;
  return PARKINGS.filter((p) => norm(`${p.name} ${p.muni} ${p.zone} ${p.fee}`).includes(q));
}

function viewParks() {
  const list = filteredParks();
  const listHidden = state.parkMode === "map" ? " is-hidden" : "";
  const mapHidden = state.parkMode === "list" ? " is-hidden" : "";
  return `<header class="topbar"><div class="title-block"><h1>Aparcamientos</h1><p class="updated">${PARKINGS.length} disuasorios · CRTM y Ayuntamiento</p></div></header>
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
    <p class="note" style="margin-top:8px">Mapa © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>. Tarifa Libre o Pago según la capa del CRTM, no un precio calculado.</p>`;
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
    </div>
    <div class="profile-hint">${icon("i-info", 16)}<span>${ageHint(state.profile.age)}</span></div>
    <span class="sheet-label">Cálculo mensual</span>
    <div class="card group">
      <div class="set"><div class="k">Días al mes</div>${stepper("days", String(state.profile.days))}</div>
      <div class="set"><div class="k">Ida y vuelta</div><button type="button" class="toggle${state.profile.roundTrip ? " is-on" : ""}" data-act="round" aria-pressed="${state.profile.roundTrip}"><i></i></button></div>
    </div>
    <span class="sheet-label">Apariencia</span>
    <div class="themes-row">${THEMES.map((name) => `<button type="button" data-act="theme" data-theme="${name}" class="${theme === name ? "is-active" : ""}"><i class="${name}"></i>${esc(labelTheme(name))}</button>`).join("")}</div>
  </div>`;
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

async function goCompare() {
  if (!goEnabled()) return;
  state.busy = true;
  state.view = "home";
  paint();
  try {
    clearTomTomRejection();
    const departAt = nextDeparture(state.profile.depart);
    const result = await compareTrip({
      origin: state.origin,
      dest: state.dest,
      departAt,
      profile: state.profile,
      fuelQuote: state.fuelQuote,
      parkings: PARKINGS
    });
    result.combined.picked = 0;
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
    carMin: state.result.car.ok ? roundMinutes(state.result.car.route.travelS) : null,
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
  if (car?.ok) lines.push(`Coche: ${roundMinutes(car.route.travelS)} min, ${kmText(car.route.lengthM)}, ${money(car.trip)} el viaje, ${money(car.monthly)} al mes.`);
  else if (car) lines.push(`Coche: ${car.error}`);
  const t = state.result?.transit;
  if (t) lines.push(`Transporte: tiempo pendiente de horarios. ${t.monthly != null ? money(t.monthly) + " al mes." : ""} Zonas ${(t.fare?.zones || []).join(" → ")}.`);
  const leg = pickedLeg();
  if (leg) lines.push(`Combinada vía ${leg.candidate.parking.name}: ${leg.ok ? roundMinutes(leg.route.travelS) + " min en coche, " : ""}transporte pendiente. ${leg.monthly != null ? money(leg.monthly) + " al mes." : "Abono " + money(leg.fare?.monthlyPass) + "."}`);
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
  if (state.result.car.ok && state.result.car.route.points?.length) {
    layers.push(L.polyline(state.result.car.route.points, { color, weight: 5, opacity: 0.9 }).addTo(cmpMap));
  }
  const leg = pickedLeg();
  for (const row of state.result.combined.options || []) {
    const on = row === leg;
    layers.push(L.marker([row.candidate.parking.lat, row.candidate.parking.lon], { icon: divIcon(on ? "p" : "pdim") })
      .bindTooltip(row.candidate.parking.name, { direction: "top" })
      .addTo(cmpMap));
  }
  if (layers.length) cmpMap.fitBounds(L.featureGroup(layers).getBounds().pad(0.18));
  setTimeout(() => cmpMap && cmpMap.invalidateSize(), 60);
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
  } else if (act === "time") { state.timeOpen = !state.timeOpen; paint(); document.getElementById("depart")?.focus(); }
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
  else if (act === "fuel") setFuel(t.dataset.fuel);
  else if (act === "age") setAge(t.dataset.age);
  else if (act === "vehicle") openVehicle();
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
    if (pill) pill.lastChild.textContent = `Salida ${state.profile.depart}`;
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
    const [fares, zonesDoc, stationsDoc, parkingsDoc, vehiclesDoc] = await Promise.all([
      file("../data/fares.json"),
      file("../data/zones.json"),
      file("../data/stations.json"),
      file("../data/parkings.json"),
      file("../vehicles.json")
    ]);
    setFareDb(fares);
    ZONES = zonesDoc.zones;
    STATIONS = buildStationIndex(stationsDoc);
    PARKINGS = parkingsDoc.items;
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
