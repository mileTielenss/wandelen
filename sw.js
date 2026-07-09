/* Service worker: app volledig offline + kaarttegels serveren uit cache. */
'use strict';

const APP_CACHE = 'wandelen-app-v2';
const TILE_CACHE = 'wandelen-tiles-v1';
// Tegelbronnen (host-achtervoegsels) die we offline cachen.
const TILE_DOMAINS = ['basemaps.cartocdn.com', 'arcgisonline.com', 'tile.opentopomap.org', 'tile.openstreetmap.org'];
function isTileHost(host) { return TILE_DOMAINS.some((d) => host === d || host.endsWith('.' + d) || host.endsWith(d)); }

const APP_ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/db.js',
  'js/komoot.js',
  'js/overpass.js',
  'js/tiles.js',
  'js/map.js',
  'js/app.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'data/default-route.json',
  'icons/favicon-64.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-180.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== APP_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Kaarttegels: cache-first (serveren zonder internet, en nieuw bekeken tegels bewaren)
  if (isTileHost(url.hostname)) {
    event.respondWith(tileStrategy(req));
    return;
  }

  // Eigen bestanden: cache-first met netwerk-fallback
  if (url.origin === self.location.origin) {
    event.respondWith(appStrategy(req));
    return;
  }

  // Alles anders (Komoot-API, proxy's): gewoon netwerk
});

async function tileStrategy(req) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Offline en niet gecachet: geef een lege placeholder-tegel
    return new Response(TRANSPARENT_TILE(), { headers: { 'Content-Type': 'image/svg+xml' } });
  }
}

async function appStrategy(req) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
    return res;
  } catch (e) {
    // Navigatie offline: val terug op de app-shell
    if (req.mode === 'navigate') {
      const shell = await cache.match('index.html');
      if (shell) return shell;
    }
    throw e;
  }
}

function TRANSPARENT_TILE() {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
    '<rect width="256" height="256" fill="#0b1220"/>' +
    '<text x="128" y="128" fill="#334155" font-size="12" text-anchor="middle" font-family="sans-serif">geen offline tegel</text>' +
    '</svg>';
}
