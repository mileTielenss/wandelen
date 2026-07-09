/* Offline kaarttegels: selecteert enkel de tegels rond de route (corridor),
   downloadt ze en bewaart ze in de Cache Storage. De service worker serveert
   ze daarna zonder internet. */
(function (global) {
  'use strict';

  const TILE_URL = (x, y, z) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const CACHE_NAME = 'wandelen-tiles-v1';

  const DETAIL = {
    overview: [12, 13, 14],
    normal: [12, 13, 14, 15, 16],
    fine: [12, 13, 14, 15, 16, 17],
  };

  function lng2tileX(lng, z) {
    return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
  }
  function lat2tileY(lat, z) {
    const r = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z)
    );
  }

  /** Verzamel de set tegels die de route raakt, met 1 tegel buffer rondom. */
  function corridorTiles(coords, zoom, buffer) {
    buffer = buffer == null ? 1 : buffer;
    const set = new Set();
    const max = Math.pow(2, zoom) - 1;
    for (let i = 0; i < coords.length; i++) {
      const x = lng2tileX(coords[i][1], zoom);
      const y = lat2tileY(coords[i][0], zoom);
      // Vul ook tussenliggende tegels bij grote sprongen tussen punten
      if (i > 0) {
        const px = lng2tileX(coords[i - 1][1], zoom);
        const py = lat2tileY(coords[i - 1][0], zoom);
        const steps = Math.max(Math.abs(x - px), Math.abs(y - py));
        for (let s = 1; s < steps; s++) {
          const ix = Math.round(px + ((x - px) * s) / steps);
          const iy = Math.round(py + ((y - py) * s) / steps);
          addBuffered(set, ix, iy, buffer, max);
        }
      }
      addBuffered(set, x, y, buffer, max);
    }
    return [...set].map((k) => {
      const [tx, ty] = k.split('/').map(Number);
      return { x: tx, y: ty, z: zoom };
    });
  }

  function addBuffered(set, x, y, buffer, max) {
    for (let dx = -buffer; dx <= buffer; dx++) {
      for (let dy = -buffer; dy <= buffer; dy++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx > max || ny > max) continue;
        set.add(nx + '/' + ny);
      }
    }
  }

  function planTiles(coords, detail) {
    const zooms = DETAIL[detail] || DETAIL.normal;
    let tiles = [];
    for (const z of zooms) {
      // grovere zooms hebben minder buffer nodig
      const buffer = z >= 16 ? 1 : z >= 14 ? 1 : 2;
      tiles = tiles.concat(corridorTiles(coords, z, buffer));
    }
    return tiles;
  }

  function estimate(coords, detail) {
    const n = planTiles(coords, detail).length;
    return { count: n, mb: +((n * 18) / 1024).toFixed(1) }; // ~18KB/tegel gemiddeld
  }

  /** Download tegels met beperkte gelijktijdigheid en meld voortgang. */
  async function download(coords, detail, onProgress, signal) {
    const tiles = planTiles(coords, detail);
    const cache = await caches.open(CACHE_NAME);
    let done = 0, ok = 0;
    const total = tiles.length;
    const CONCURRENCY = 6;
    let idx = 0;

    async function worker() {
      while (idx < total) {
        if (signal && signal.aborted) return;
        const t = tiles[idx++];
        const url = TILE_URL(t.x, t.y, t.z);
        try {
          const match = await cache.match(url);
          if (!match) {
            const res = await fetch(url, { mode: 'cors' });
            if (res.ok) { await cache.put(url, res.clone()); ok++; }
          } else { ok++; }
        } catch (_) { /* sla mislukte tegel over */ }
        done++;
        if (onProgress && (done % 3 === 0 || done === total)) onProgress(done, total, ok);
      }
    }

    const workers = [];
    for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
    await Promise.all(workers);
    return { total, ok, cancelled: !!(signal && signal.aborted) };
  }

  async function cacheSize() {
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      return keys.length;
    } catch (_) { return 0; }
  }

  async function clearAll() {
    try { await caches.delete(CACHE_NAME); } catch (_) { /* ignore */ }
  }

  global.Tiles = { TILE_URL, CACHE_NAME, planTiles, estimate, download, cacheSize, clearAll, DETAIL };
})(window);
