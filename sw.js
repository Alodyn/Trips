const SHELL = "trips-shell-v4";
const DATA = "trips-data-v1";
const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./config.js",
  "./manifest.webmanifest",
  "./vehicles.json",
  "./js/app.js",
  "./js/compare.js",
  "./js/destpark.js",
  "./js/traffic.js",
  "./js/fares.js",
  "./js/format.js",
  "./js/fuel.js",
  "./js/geo.js",
  "./js/parkride.js",
  "./js/tomtom.js",
  "./js/transit.js",
  "./data/fares.json",
  "./data/zones.json",
  "./data/parkings.json",
  "./data/stations.json",
  "./data/station_parkings.json",
  "./data/dest_parking.json",
  "./fixtures/tomtom-sample.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-512-maskable.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== SHELL && key !== DATA).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const ministry = url.hostname.includes("minetur.gob.es") || url.hostname.includes("serviciosmin.gob.es");
  if (ministry) {
    event.respondWith(networkFirst(req, DATA));
    return;
  }
  // TomTom, teselas y fuentes se piden siempre a la red. No se cachean rutas.
  if (url.origin !== self.location.origin) return;
  event.respondWith(cacheFirst(req, SHELL));
});

async function cacheFirst(req, name) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) {
    const cache = await caches.open(name);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req, name) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(name);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    throw new Error("offline");
  }
}
