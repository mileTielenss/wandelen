/* Komoot-tours inlezen. Parseert een gedeelde tour-URL en haalt de coördinaten op. */
(function (global) {
  'use strict';

  // Publieke Komoot-API (CORS: access-control-allow-origin: *)
  const API = 'https://api.komoot.de/v007/tours/';
  // CORS-proxy's als fallback (sommige browsers/toestellen blokkeren de directe call).
  const PROXIES = [
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
  ];

  /** Haal tour-id en share_token uit een Komoot-URL. */
  function parseUrl(input) {
    if (!input) return null;
    const raw = String(input).trim();
    const idMatch = raw.match(/tour\/(\d+)/) || raw.match(/[?&]tour[_-]?id=(\d+)/i);
    if (!idMatch) {
      // Misschien plakte de gebruiker enkel een id
      if (/^\d{5,}$/.test(raw)) return { id: raw, shareToken: null };
      return null;
    }
    let shareToken = null;
    try {
      const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
      const params = new URLSearchParams(q);
      shareToken = params.get('share_token');
    } catch (_) { /* ignore */ }
    return { id: idMatch[1], shareToken };
  }

  function buildApiUrl(id, shareToken) {
    let u = API + encodeURIComponent(id) + '?_embedded=coordinates';
    if (shareToken) u += '&share_token=' + encodeURIComponent(shareToken);
    return u;
  }

  async function fetchJson(url) {
    const attempts = [url, ...PROXIES.map((p) => p(url))];
    let lastErr = null;
    for (const attempt of attempts) {
      try {
        const res = await fetch(attempt, { headers: { Accept: 'application/json' } });
        if (!res.ok) { lastErr = new Error('HTTP ' + res.status); continue; }
        return await res.json();
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Kon route niet ophalen');
  }

  /** Zet Komoot-JSON om naar ons interne routeformaat. */
  function toRoute(data, id) {
    const items =
      (data._embedded && data._embedded.coordinates && data._embedded.coordinates.items) || [];
    if (!items.length) throw new Error('Geen coördinaten gevonden in deze tour');
    const coords = items.map((c) => [
      +(+c.lat).toFixed(6),
      +(+c.lng).toFixed(6),
      c.alt != null ? +(+c.alt).toFixed(1) : 0,
    ]);
    return {
      id: 'komoot-' + id,
      source: 'komoot',
      komootId: String(id),
      name: (data.name || 'Komoot-route').trim(),
      sport: data.sport || 'hike',
      distance: Math.round(data.distance || 0),
      elevationUp: Math.round(data.elevation_up || 0),
      elevationDown: Math.round(data.elevation_down || 0),
      duration: data.duration || 0,
      coords,
      importedAt: new Date().toISOString(),
    };
  }

  /** Volledige flow: URL -> route-object (nog niet opgeslagen). */
  async function importFromUrl(input) {
    const parsed = parseUrl(input);
    if (!parsed) throw new Error('Dit lijkt geen geldige Komoot-tour URL');
    const url = buildApiUrl(parsed.id, parsed.shareToken);
    const data = await fetchJson(url);
    return toRoute(data, parsed.id);
  }

  global.Komoot = { parseUrl, importFromUrl };
})(window);
