/* KML-import: een routelijn (LineString) + genummerde punten (Point) uit een
   KML-bestand of een Google My Maps-kaart omzetten naar ons routeformaat.
   Bedoeld voor routes die enkel als "digitaal routeplan" bestaan — zoals de
   Nutteloze Borden-wandelingen, waar de punten de genummerde bordjes zijn. */
(function (global) {
  'use strict';

  // Zelfde proxy-fallbacks als Komoot/GPX: Google en veel sites sturen geen
  // CORS-headers mee bij het rechtstreeks ophalen van de KML.
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

  function hashCoords(coords) {
    let h = 5381;
    for (const c of coords) {
      const s = c[0].toFixed(5) + ',' + c[1].toFixed(5);
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
  }

  // KML zet coördinaten als "lng,lat,alt" (let op: lengte éérst).
  function coordList(geo) {
    const c = geo.getElementsByTagName('coordinates')[0];
    if (!c) return [];
    return c.textContent.trim().split(/\s+/).map((tok) => {
      const [lng, lat, alt] = tok.split(',').map(Number);
      return [+lat.toFixed(6), +lng.toFixed(6), isFinite(alt) ? +alt.toFixed(1) : 0];
    }).filter((p) => isFinite(p[0]) && isFinite(p[1]));
  }

  function tagText(el, tag) {
    const n = el.getElementsByTagName(tag)[0];
    return n ? n.textContent.trim() : '';
  }

  // Badge-tekst: het bordnummer vooraan de naam ("12. …") of anders de volgorde.
  function refFromName(name, seq) {
    const m = name.match(/^\s*(\d+)/);
    return m ? m[1] : String(seq);
  }

  /** KML-tekst → route-object (nog niet opgeslagen). */
  function parse(xmlText, fallbackName) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('Dit is geen geldige KML');
    }
    let coords = [];
    const waypoints = [];
    for (const pm of doc.getElementsByTagName('Placemark')) {
      const line = pm.getElementsByTagName('LineString')[0];
      const point = pm.getElementsByTagName('Point')[0];
      if (line) {
        coords = coords.concat(coordList(line));
      } else if (point) {
        const ll = coordList(point)[0];
        if (ll) {
          const nm = tagText(pm, 'name');
          waypoints.push({ ref: refFromName(nm, waypoints.length + 1), name: nm, lat: ll[0], lng: ll[1] });
        }
      }
    }
    // Geen getekende lijn? Verbind dan de punten in volgorde (zoals losse GPX-punten).
    let vorm = 'track';
    if (coords.length < 2) {
      coords = waypoints.map((n) => [n.lat, n.lng, 0]);
      vorm = 'punten';
    }
    if (coords.length < 2) throw new Error('Geen bruikbare route in deze KML');

    let distance = 0, up = 0, down = 0;
    for (let i = 1; i < coords.length; i++) {
      distance += haversineM(coords[i - 1], coords[i]);
      const d = coords[i][2] - coords[i - 1][2];
      if (d > 0) up += d; else down -= d;
    }

    const dName = doc.getElementsByTagName('Document')[0];
    const name = (dName && tagText(dName, 'name')) || fallbackName || 'KML-route';
    return {
      id: 'kml-' + hashCoords(coords),
      source: 'kml',
      name: name.slice(0, 60),
      sport: 'hike',
      distance: Math.round(distance),
      elevationUp: Math.round(up),
      elevationDown: Math.round(down),
      duration: 0,
      coords,
      // Genummerde route-eigen punten (bv. de bordjes): altijd zichtbaar op de kaart,
      // los van de knooppunten-schakelaar (zie MapView._setWaypoints).
      waypoints,
      // Brengt de KML eigen punten mee, dan halen we géén OSM-knooppunten op die de
      // kaart zouden vervuilen (maybeFetchOverlays slaat over als dit gezet is).
      overlaysFetched: waypoints.length > 0,
      gpxVorm: vorm,     // 'punten' = verbonden losse locaties, geen gevolgd pad
      importedAt: new Date().toISOString(),
    };
  }

  // Google My Maps-viewer/-bewerklink → de publieke KML-export ervan.
  function mymapsKmlUrl(url) {
    const m = String(url).match(/google\.[^/]*\/maps\/d\/.*[?&]mid=([^&#]+)/);
    return m ? 'https://www.google.com/maps/d/kml?mid=' + m[1] + '&forcekml=1' : null;
  }

  function nameFromUrl(url) {
    const last = url.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(last).replace(/\.kml$/i, '').replace(/[-_]+/g, ' ').trim();
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

  /** KML- of Google My Maps-URL → route-object. */
  async function importFromUrl(url) {
    const kmlUrl = mymapsKmlUrl(url) || url;
    return parse(await fetchText(kmlUrl), nameFromUrl(url));
  }

  /** Herkent een .kml-link of een Google My Maps-link (voor de gedeelde URL-balk). */
  function isKmlUrl(input) {
    const s = String(input).trim();
    return /\.kml(\?|#|$)/i.test(s) || !!mymapsKmlUrl(s);
  }

  global.KML = { parse, importFromUrl, isKmlUrl, _test: { hashCoords, coordList, refFromName, mymapsKmlUrl, nameFromUrl, fetchText } };
})(window);
