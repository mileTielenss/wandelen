/* GPX-import: tracks (trk), routes (rte) of losse punten (wpt) uit een
   GPX-bestand of -URL omzetten naar ons routeformaat. Volledig client-side. */
(function (global) {
  'use strict';

  // Zelfde proxy-fallbacks als de Komoot-import: veel sites (zoals
  // nuttelozeborden.be) sturen geen CORS-headers mee.
  const PROXIES = [
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  ];

  function haversineM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  // Stabiel id uit de coördinaten, zodat her-import dezelfde route bijwerkt.
  function hashCoords(coords) {
    let h = 5381;
    for (const c of coords) {
      const s = c[0].toFixed(5) + ',' + c[1].toFixed(5);
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  function pointsFrom(doc, tag) {
    const out = [];
    const els = doc.getElementsByTagName(tag);
    for (const el of els) {
      const lat = parseFloat(el.getAttribute('lat'));
      const lng = parseFloat(el.getAttribute('lon'));
      if (!isFinite(lat) || !isFinite(lng)) continue;
      const eleEl = el.getElementsByTagName('ele')[0];
      const alt = eleEl ? parseFloat(eleEl.textContent) : NaN;
      out.push([+lat.toFixed(6), +lng.toFixed(6), isFinite(alt) ? +alt.toFixed(1) : 0]);
    }
    return out;
  }

  function firstText(doc, tag) {
    const el = doc.getElementsByTagName(tag)[0];
    const name = el && el.getElementsByTagName('name')[0];
    return name ? name.textContent.trim() : '';
  }

  /** GPX-tekst → route-object (nog niet opgeslagen). */
  function parse(xmlText, fallbackName) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('Dit is geen geldig GPX-bestand');
    }
    // Voorkeursvolgorde: echte track → geplande route → losse punten
    // (bv. bordjes-locaties); die laatste verbinden we in bestandsvolgorde.
    let coords = pointsFrom(doc, 'trkpt');
    let vorm = 'track';
    if (!coords.length) { coords = pointsFrom(doc, 'rtept'); vorm = 'route'; }
    if (!coords.length) { coords = pointsFrom(doc, 'wpt'); vorm = 'punten'; }
    if (coords.length < 2) throw new Error('Geen bruikbare punten in dit GPX-bestand');

    let distance = 0;
    let up = 0, down = 0;
    for (let i = 1; i < coords.length; i++) {
      distance += haversineM(coords[i - 1], coords[i]);
      const d = coords[i][2] - coords[i - 1][2];
      if (d > 0) up += d; else down -= d;
    }

    const name = firstText(doc, 'trk') || firstText(doc, 'rte') ||
      firstText(doc, 'metadata') || fallbackName || 'GPX-route';
    return {
      id: 'gpx-' + hashCoords(coords),
      source: 'gpx',
      name: name.slice(0, 60),
      sport: 'hike',
      distance: Math.round(distance),
      elevationUp: Math.round(up),
      elevationDown: Math.round(down),
      duration: 0,
      coords,
      gpxVorm: vorm, // 'punten' = verbonden losse locaties, geen gevolgd pad
      importedAt: new Date().toISOString(),
    };
  }

  function nameFromUrl(url) {
    const last = url.split('?')[0].split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last).replace(/\.gpx$/i, '').replace(/[-_]+/g, ' ').trim();
  }

  async function fetchText(url) {
    const attempts = [url, ...PROXIES.map((p) => p(url))];
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const res = await fetch(attempt);
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        return await res.text();
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  /** GPX-URL → route-object. */
  async function importFromUrl(url) {
    return parse(await fetchText(url), nameFromUrl(url));
  }

  /** Is dit een GPX-URL? (voor de gedeelde URL-balk met Komoot) */
  function isGpxUrl(input) {
    return /\.gpx(\?|#|$)/i.test(String(input).trim());
  }

  global.GPX = { parse, importFromUrl, isGpxUrl, _test: { hashCoords, nameFromUrl, fetchText } };
})(window);
