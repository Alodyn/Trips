export function euro(n, digits = 2) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  }) + " €";
}

export function litrePrice(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("es-ES", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  }) + " €/l";
}

export function litres(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toLocaleString("es-ES", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }) + " l";
}

export function kmText(meters) {
  if (meters == null || !Number.isFinite(Number(meters))) return "—";
  const km = Number(meters) / 1000;
  return km.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " km";
}

export function roundMinutes(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return null;
  return Math.max(1, Math.round(Number(seconds) / 60));
}

export function clock(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("es-ES", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

export function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function todayISO(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(d);
  return parts;
}

export function madridParts(d = new Date()) {
  const map = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return {
    y: Number(map.year),
    m: Number(map.month),
    d: Number(map.day),
    hh: Number(map.hour),
    mm: Number(map.minute)
  };
}

/** Instante UTC cuya hora de pared en Madrid es la indicada. */
export function madridWallTime(y, m, d, hh, mm) {
  let t = Date.UTC(y, m - 1, d, hh - 1, mm);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  for (let i = 0; i < 4; i++) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const got = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
    const want = Date.UTC(y, m - 1, d, hh, mm);
    t += want - got;
  }
  return new Date(t);
}

/** Próxima ocurrencia de HH:MM en Madrid. Si ya pasó hoy, mañana. */
export function nextDeparture(hhmm, now = new Date()) {
  const [hh, mm] = hhmm.split(":").map(Number);
  const today = madridParts(now);
  let when = madridWallTime(today.y, today.m, today.d, hh, mm);
  if (when.getTime() < now.getTime() - 30 * 1000) {
    const tomorrow = new Date(now.getTime() + 26 * 3600 * 1000);
    const p = madridParts(tomorrow);
    when = madridWallTime(p.y, p.m, p.d, hh, mm);
  }
  return when;
}

export function num(v, digits = 2) {
  return Number(v).toLocaleString("es-ES", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}
