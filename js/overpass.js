/* Haalt wandelknooppunten en horeca op uit OpenStreetMap (Overpass API) voor
   het gebied van een route. Resultaat wordt bij de route bewaard, zodat de
   overlay daarna volledig offline werkt. */
(function (global) {
  'use strict';

  // Meerdere mirrors — de publieke server wisselt weleens 406/429 uit.
  const ENDPOINTS = [
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];

  const HORECA = 'cafe|restaurant|bar|pub|fast_food|biergarten|ice_cream';

  function buildQuery(b) {
    const bbox = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
    return `[out:json][timeout:20];(` +
      `node["rwn_ref"](${bbox});` +
      `node["lwn_ref"](${bbox});` +
      `nwr["amenity"~"^(${HORECA})$"](${bbox});` +
      `node["shop"="bakery"](${bbox});` +
      `);out center qt;`;
  }

  function delay(ms, signal) {
    return new Promise((res) => {
      const t = setTimeout(res, ms);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
    });
  }

  /** Snelle query: alle mirrors "hedged" parallel (2e start na 3,5s, 3e na 7s);
      het eerste geldige antwoord wint en de rest wordt afgebroken. */
  async function postQuery(q, timeoutMs) {
    timeoutMs = timeoutMs || 14000;
    const stop = new AbortController();
    const attempts = ENDPOINTS.map((ep, i) => (async () => {
      if (i > 0) {
        await delay(i * 3500, stop.signal);
        if (stop.signal.aborted) throw new Error('cancelled');
      }
      const ctrl = new AbortController();
      const onStop = () => ctrl.abort();
      stop.signal.addEventListener('abort', onStop, { once: true });
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: 'data=' + encodeURIComponent(q),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
      } finally {
        clearTimeout(timer);
        stop.signal.removeEventListener('abort', onStop);
      }
    })());
    try {
      const winner = await Promise.any(attempts);
      stop.abort();
      return winner;
    } catch (_) {
      stop.abort();
      throw new Error('Overpass niet bereikbaar');
    }
  }

  function parse(data) {
    const nodes = [];
    const horeca = [];
    const seen = new Set();
    for (const e of data.elements || []) {
      const t = e.tags || {};
      const lat = e.lat != null ? e.lat : (e.center && e.center.lat);
      const lng = e.lon != null ? e.lon : (e.center && e.center.lon);
      if (lat == null || lng == null) continue;
      const ref = t.rwn_ref || t.lwn_ref;
      const am = t.amenity || t.shop;
      if (ref && !am) {
        const key = ref + '@' + lat.toFixed(4) + ',' + lng.toFixed(4);
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push({ ref: String(ref).slice(0, 4), lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
      } else if (/^(cafe|restaurant|bar|pub|fast_food|biergarten|ice_cream|bakery)$/.test(am || '')) {
        horeca.push({ n: (t.name || '').slice(0, 36), t: am, lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
      }
    }
    return { nodes, horeca };
  }

  /** bounds = {minLat,minLng,maxLat,maxLng}. Geeft {nodes, horeca}. */
  async function fetchOverlays(bounds) {
    return parse(await postQuery(buildQuery(bounds)));
  }

  // ---------- Bewegwijzerde wandelroutes (lokale gekleurde lussen) ----------
  const NAMED = {
    red: '#dc2626', rood: '#dc2626', blue: '#2563eb', blauw: '#2563eb',
    green: '#16a34a', groen: '#16a34a', yellow: '#eab308', geel: '#eab308',
    white: '#d1d5db', wit: '#d1d5db', black: '#111827', zwart: '#111827',
    brown: '#92400e', bruin: '#92400e', orange: '#ea580c', oranje: '#ea580c',
    purple: '#7c3aed', paars: '#7c3aed', aqua: '#06b6d4', cyan: '#06b6d4',
    pink: '#db2777', roze: '#db2777', gray: '#6b7280', grey: '#6b7280', grijs: '#6b7280',
  };
  const FALLBACK = ['#e11d48', '#2563eb', '#16a34a', '#eab308', '#7c3aed', '#ea580c', '#06b6d4', '#db2777'];

  function colourToHex(c, osmc) {
    if (c) {
      const s = String(c).toLowerCase().trim();
      if (NAMED[s]) return NAMED[s];
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/.test(s)) return s;
      for (const p of s.split(/[-_ /]+/)) if (NAMED[p]) return NAMED[p];
    }
    if (osmc) { const first = String(osmc).split(':')[0]; if (NAMED[first]) return NAMED[first]; }
    return null;
  }

  function haversineM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function segLen(seg) { let t = 0; for (let i = 1; i < seg.length; i++) t += haversineM(seg[i - 1], seg[i]); return t; }

  // Rijg de losse ways aan elkaar tot één (zo goed mogelijk geordend) pad.
  function stitch(segs) {
    if (!segs.length) return [];
    const used = new Array(segs.length).fill(false);
    let si = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i].length > segs[si].length) si = i;
    let chain = segs[si].slice(); used[si] = true;
    const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5;
    let ext = true;
    while (ext) {
      ext = false;
      for (let i = 0; i < segs.length; i++) {
        if (used[i]) continue;
        const s = segs[i], head = chain[0], tail = chain[chain.length - 1];
        if (near(tail, s[0])) { chain = chain.concat(s.slice(1)); used[i] = true; ext = true; }
        else if (near(tail, s[s.length - 1])) { chain = chain.concat(s.slice(0, -1).reverse()); used[i] = true; ext = true; }
        else if (near(head, s[s.length - 1])) { chain = s.slice(0, -1).concat(chain); used[i] = true; ext = true; }
        else if (near(head, s[0])) { chain = s.slice(1).reverse().concat(chain); used[i] = true; ext = true; }
      }
    }
    return chain;
  }

  /** Officiële distance-tag ("14", "22,3", "144.2" = km) naar meters, of null. */
  function tagDistanceM(v) {
    if (!v) return null;
    const n = parseFloat(String(v).replace(',', '.'));
    if (!isFinite(n) || n <= 0) return null;
    // OSM-conventie is km; extreem grote waarden zijn (fout) in meters getagd.
    return n >= 1000 ? Math.round(n) : Math.round(n * 1000);
  }

  function parseRoutes(data) {
    const routes = [];
    for (const e of data.elements || []) {
      if (e.type !== 'relation') continue;
      const t = e.tags || {};
      const segs = [];
      for (const m of e.members || []) {
        if (m.type === 'way' && m.geometry && m.geometry.length > 1) {
          segs.push(m.geometry.map((g) => [+g.lat.toFixed(6), +g.lon.toFixed(6)]));
        }
      }
      if (!segs.length) continue;
      // De geometrie kan op het zoekgebied geclipt zijn (lange Wanderwege);
      // vertrouw daarom eerst de officiële distance-tag, dan pas de meting.
      const distance = tagDistanceM(t.distance) ||
        Math.round(segs.reduce((a, s) => a + segLen(s), 0));
      const coords = stitch(segs);
      routes.push({
        id: 'osm-' + e.id, source: 'osm', relId: e.id,
        name: (t.name || t.ref || 'Wandelroute').slice(0, 60),
        ref: t.ref || '',
        colour: colourToHex(t.colour || t.color, t['osmc:symbol']),
        distance,
        segments: segs,
        coords,
      });
    }
    // Kortste (lokale lussen) eerst.
    routes.sort((a, b) => a.distance - b.distance);
    return routes;
  }

  /** Query voor bewegwijzerde wandelroutes: lokale lussen (lwn) én regionale
      Wanderwege (rwn, gangbaar in Duitsland) of routes zonder network-tag.
      Het BE/NL-knooppuntennet (network:type=node_network) blijft er expliciet
      uit, en de geometrie wordt op het zoekgebied geclipt zodat lange
      trajecten de respons niet opblazen. */
  function routesQuery(b) {
    const bbox = `${b.minLat},${b.minLng},${b.maxLat},${b.maxLng}`;
    return `[out:json][timeout:20];(` +
      `rel["route"~"^(hiking|foot|walking)$"]["network"~"^(lwn|rwn)$"]["network:type"!="node_network"](${bbox});` +
      `rel["route"~"^(hiking|foot|walking)$"][!"network"](${bbox});` +
      `);out geom(${bbox}) qt;`;
  }

  async function fetchRoutes(bounds) {
    return parseRoutes(await postQuery(routesQuery(bounds), 16000));
  }

  function boundsFromCenter(lat, lng, radiusM) {
    const dLat = radiusM / 111320;
    const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
    return { minLat: lat - dLat, minLng: lng - dLng, maxLat: lat + dLat, maxLng: lng + dLng };
  }

  function boundsFromCoords(coords, marginDeg) {
    const m = marginDeg == null ? 0.012 : marginDeg;
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    for (const c of coords) {
      if (c[0] < minLat) minLat = c[0];
      if (c[0] > maxLat) maxLat = c[0];
      if (c[1] < minLng) minLng = c[1];
      if (c[1] > maxLng) maxLng = c[1];
    }
    return { minLat: minLat - m, minLng: minLng - m, maxLat: maxLat + m, maxLng: maxLng + m };
  }

  global.Overpass = {
    fetchOverlays, fetchRoutes, boundsFromCoords, boundsFromCenter, FALLBACK,
    // Interne functies, blootgesteld voor unit-tests.
    _test: { parse, parseRoutes, colourToHex, stitch, buildQuery, postQuery, routesQuery, tagDistanceM },
  };
})(window);
