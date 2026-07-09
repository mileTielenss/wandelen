/* Offline kaarttegels: selecteert enkel de tegels rond de route (corridor),
   downloadt ze en bewaart ze in de Cache Storage. De service worker serveert
   ze daarna zonder internet. Ondersteunt meerdere kaartlagen (basemaps),
   incl. scherpe @2x-tegels voor retina-schermen. */
(function (global) {
  'use strict';

  const CACHE_NAME = 'wandelen-tiles-v1';

  // Vaste subdomeinen (geen {s}) → deterministische URL's, dus betrouwbaar te cachen.
  // Alle bronnen zijn CORS-vrij en zonder API-sleutel.
  const BASEMAPS = {
    voyager: {
      key: 'voyager',
      name: 'Kaart — scherp (@2x)',
      // 512px-tegels op 256 CSS-px = dubbele resolutie, haarscherp op gsm.
      url: 'https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png',
      maxZoom: 20, maxNativeZoom: 20, avgKB: 42,
      hosts: ['a.basemaps.cartocdn.com'],
      attribution: '© OpenStreetMap-bijdragers © CARTO',
    },
    satellite: {
      key: 'satellite',
      name: 'Satelliet (luchtfoto)',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 19, maxNativeZoom: 19, avgKB: 22,
      hosts: ['server.arcgisonline.com'],
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
    topo: {
      key: 'topo',
      name: 'Topografisch (hoogtelijnen)',
      url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
      maxZoom: 17, maxNativeZoom: 17, avgKB: 34,
      hosts: ['a.tile.opentopomap.org'],
      attribution: '© OpenStreetMap © OpenTopoMap (CC-BY-SA)',
    },
  };
  const DEFAULT_BASEMAP = 'voyager';
  const ALL_HOSTS = [...new Set(Object.values(BASEMAPS).flatMap((b) => b.hosts))];

  const DETAIL = {
    overview: [12, 13, 14],
    normal: [12, 13, 14, 15, 16],
    fine: [12, 13, 14, 15, 16, 17, 18],
  };

  function getBasemap(key) { return BASEMAPS[key] || BASEMAPS[DEFAULT_BASEMAP]; }

  function urlFor(basemap, x, y, z) {
    return basemap.url
      .replace('{z}', z).replace('{x}', x).replace('{y}', y);
  }

  function lng2tileX(lng, z) { return Math.floor(((lng + 180) / 360) * Math.pow(2, z)); }
  function lat2tileY(lat, z) {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
  }

  /** Verzamel de set tegels die de route raakt, met buffer rondom. */
  function corridorTiles(coords, zoom, buffer) {
    buffer = buffer == null ? 1 : buffer;
    const set = new Set();
    const max = Math.pow(2, zoom) - 1;
    for (let i = 0; i < coords.length; i++) {
      const x = lng2tileX(coords[i][1], zoom);
      const y = lat2tileY(coords[i][0], zoom);
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

  function planTiles(coords, detail, basemap) {
    const bm = typeof basemap === 'string' ? getBasemap(basemap) : (basemap || getBasemap());
    const zooms = (DETAIL[detail] || DETAIL.normal).filter((z) => z <= bm.maxNativeZoom);
    let tiles = [];
    for (const z of zooms) {
      const buffer = z >= 14 ? 1 : 2;
      tiles = tiles.concat(corridorTiles(coords, z, buffer));
    }
    return tiles;
  }

  function estimate(coords, detail, basemap) {
    const bm = typeof basemap === 'string' ? getBasemap(basemap) : (basemap || getBasemap());
    const n = planTiles(coords, detail, bm).length;
    return { count: n, mb: +((n * bm.avgKB) / 1024).toFixed(1) };
  }

  /** Download tegels van de gekozen basemap met beperkte gelijktijdigheid. */
  async function download(coords, detail, basemap, onProgress, signal) {
    const bm = typeof basemap === 'string' ? getBasemap(basemap) : (basemap || getBasemap());
    const tiles = planTiles(coords, detail, bm);
    const cache = await caches.open(CACHE_NAME);
    let done = 0, ok = 0;
    const total = tiles.length;
    const CONCURRENCY = 6;
    let idx = 0;

    async function worker() {
      while (idx < total) {
        if (signal && signal.aborted) return;
        const t = tiles[idx++];
        const url = urlFor(bm, t.x, t.y, t.z);
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
    try { return (await (await caches.open(CACHE_NAME)).keys()).length; }
    catch (_) { return 0; }
  }
  async function clearAll() { try { await caches.delete(CACHE_NAME); } catch (_) {} }

  global.Tiles = {
    CACHE_NAME, BASEMAPS, DEFAULT_BASEMAP, ALL_HOSTS,
    getBasemap, urlFor, planTiles, estimate, download, cacheSize, clearAll, DETAIL,
  };
})(window);
