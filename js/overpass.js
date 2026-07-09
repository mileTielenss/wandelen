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
    return `[out:json][timeout:60];(` +
      `node["rwn_ref"](${bbox});` +
      `node["lwn_ref"](${bbox});` +
      `nwr["amenity"~"^(${HORECA})$"](${bbox});` +
      `node["shop"="bakery"](${bbox});` +
      `);out center;`;
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
    const q = buildQuery(bounds);
    let lastErr = null;
    for (const ep of ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(ep, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
          body: 'data=' + encodeURIComponent(q),
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        return parse(await res.json());
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Overpass niet bereikbaar');
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

  global.Overpass = { fetchOverlays, boundsFromCoords };
})(window);
