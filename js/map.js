/* Kaartweergave: tekent de route, toont/volgt locatie, meldt of je nog op route zit.
   Zuinig: GPS staat uit tot je er expliciet om vraagt. */
(function (global) {
  'use strict';

  const OFF_ROUTE_M = 40; // verder dan dit = waarschuwing

  const MapView = {
    map: null,
    route: null,
    line: null,
    locMarker: null,
    accCircle: null,
    watchId: null,
    mode: 'idle', // idle | located | tracking
    wakeLock: null,
    _onModeChange: null,

    init(onModeChange) {
      this._onModeChange = onModeChange;
      this.map = L.map('map', {
        zoomControl: false,
        attributionControl: true,
        // Zuinig: geen vloeiende zoom-animaties nodig
        fadeAnimation: false,
        tap: true,
      });
      L.control.attribution({ prefix: false, position: 'bottomleft' }).addTo(this.map);
      // Geen zoomknoppen: touch-first (knijpen/scrollen zoomt) houdt de kaart rustig.

      this.tileLayer = L.tileLayer(Tiles.TILE_URL('{x}', '{y}', '{z}'), {
        maxZoom: 19,
        minZoom: 8,
        crossOrigin: true,
        attribution: '© OpenStreetMap',
        // Houd tegels in de cache voor soepel offline pannen
        keepBuffer: 4,
      });
      this.tileLayer.addTo(this.map);
    },

    show(route) {
      this.route = route;
      const latlngs = route.coords.map((c) => [c[0], c[1]]);

      if (this.line) this.line.remove();
      if (this.startMarker) this.startMarker.remove();
      if (this.endMarker) this.endMarker.remove();
      this.clearLocation();

      this.line = L.polyline(latlngs, {
        color: '#e11d48', weight: 5, opacity: 0.9, lineJoin: 'round', lineCap: 'round',
      }).addTo(this.map);

      // Start (groen) en einde (rood/vlag)
      this.startMarker = L.circleMarker(latlngs[0], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#16a34a', fillOpacity: 1,
      }).addTo(this.map).bindTooltip('Start', { direction: 'top' });
      this.endMarker = L.circleMarker(latlngs[latlngs.length - 1], {
        radius: 8, color: '#fff', weight: 2, fillColor: '#b91c1c', fillOpacity: 1,
      }).addTo(this.map).bindTooltip('Einde', { direction: 'top' });

      this._latlngs = latlngs;
      // Cumulatieve afstand (meters) vanaf de start, per punt — voor "hoe ver nog".
      this._cum = new Array(latlngs.length);
      this._cum[0] = 0;
      for (let i = 1; i < latlngs.length; i++) {
        this._cum[i] = this._cum[i - 1] + haversineM(latlngs[i - 1], latlngs[i]);
      }
      this._total = this._cum[latlngs.length - 1] || route.distance || 0;
      this.recenter();
    },

    recenter() {
      if (this.line) this.map.fitBounds(this.line.getBounds(), { padding: [40, 40] });
    },

    // ---------- Locatie (eenmalig) ----------
    locateOnce() {
      if (!('geolocation' in navigator)) { App.toast('Geen GPS beschikbaar'); return; }
      App.toast('Locatie bepalen…');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this._setMode('located');
          this._updateLocation(pos, false);
          const ll = [pos.coords.latitude, pos.coords.longitude];
          this.map.setView(ll, Math.max(this.map.getZoom(), 15), { animate: true });
        },
        (err) => App.toast('Locatie mislukt: ' + friendlyGeoError(err)),
        // Verse meting bij elke tik (geen oude gecachte positie) — dat is net de bedoeling.
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    },

    // ---------- Locatie volgen (tracking) ----------
    startTracking() {
      if (!('geolocation' in navigator)) { App.toast('Geen GPS beschikbaar'); return; }
      if (this.watchId != null) return;
      this._setMode('tracking');
      this._followed = true;
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this._updateLocation(pos, true);
          if (this._followed) {
            this.map.setView(
              [pos.coords.latitude, pos.coords.longitude],
              Math.max(this.map.getZoom(), 16),
              { animate: true }
            );
          }
        },
        (err) => App.toast('Tracking: ' + friendlyGeoError(err)),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 }
      );
      // Zodra de gebruiker zelf pant, stoppen we met auto-centreren (zuiniger + minder storend)
      this.map.once('dragstart', () => { this._followed = false; });
    },

    stopTracking() {
      if (this.watchId != null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      this.releaseWake();
      // Behoud de laatste positie-marker maar val terug naar 'located'
      this._setMode(this.locMarker ? 'located' : 'idle');
    },

    clearLocation() {
      this.stopTracking();
      if (this.locMarker) { this.locMarker.remove(); this.locMarker = null; }
      if (this.accCircle) { this.accCircle.remove(); this.accCircle = null; }
      this._setMode('idle');
      App.setOffRoute(null);
    },

    _updateLocation(pos, tracking) {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      const acc = pos.coords.accuracy || 0;
      const icon = L.divIcon({
        className: '', html: `<div class="loc-dot ${tracking ? 'tracking' : ''}"></div>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      });
      if (!this.locMarker) {
        this.locMarker = L.marker(ll, { icon, interactive: false, keyboard: false }).addTo(this.map);
      } else {
        this.locMarker.setLatLng(ll);
        this.locMarker.setIcon(icon);
      }
      if (acc > 0) {
        if (!this.accCircle) {
          this.accCircle = L.circle(ll, { radius: acc, color: '#2563eb', weight: 1, fillOpacity: 0.08 }).addTo(this.map);
        } else {
          this.accCircle.setLatLng(ll).setRadius(acc);
        }
      }
      // Afstand tot route + voortgang langs de route ("hoe ver nog")
      const p = projectOnRoute(pos.coords.latitude, pos.coords.longitude, this._latlngs, this._cum);
      App.setOffRoute({
        meters: p.dist,
        off: p.dist > OFF_ROUTE_M,
        accuracy: acc,
        alongM: p.alongM,
        totalM: this._total,
      });
    },

    _setMode(mode) {
      this.mode = mode;
      if (this._onModeChange) this._onModeChange(mode);
    },

    // ---------- Scherm aan houden (optioneel, enkel bij tracking) ----------
    async requestWake() {
      try {
        if ('wakeLock' in navigator) {
          this.wakeLock = await navigator.wakeLock.request('screen');
          this.wakeLock.addEventListener('release', () => {});
        }
      } catch (_) { /* niet ondersteund / geweigerd */ }
    },
    releaseWake() {
      if (this.wakeLock) { try { this.wakeLock.release(); } catch (_) {} this.wakeLock = null; }
    },

    invalidate() { if (this.map) setTimeout(() => this.map.invalidateSize(), 60); },
  };

  // ---------- Geometrie ----------
  /** Projecteer een punt op de route. Geeft de afstand tot de route (m) en
      hoeveel meter langs de route je zit (vanaf de start). */
  function projectOnRoute(lat, lng, latlngs, cum) {
    if (!latlngs || latlngs.length < 2) return { dist: Infinity, alongM: 0 };
    let best = { dist: Infinity, alongM: 0 };
    for (let i = 1; i < latlngs.length; i++) {
      const r = segProject(lat, lng, latlngs[i - 1], latlngs[i]);
      if (r.dist < best.dist) {
        const segLen = (cum[i] - cum[i - 1]) || 0;
        best = { dist: r.dist, alongM: cum[i - 1] + r.t * segLen };
      }
    }
    return best;
  }

  function nearestDistanceMeters(lat, lng, latlngs) {
    return projectOnRoute(lat, lng, latlngs, buildCum(latlngs)).dist;
  }

  function buildCum(latlngs) {
    const cum = [0];
    for (let i = 1; i < latlngs.length; i++) cum[i] = cum[i - 1] + haversineM(latlngs[i - 1], latlngs[i]);
    return cum;
  }

  /** Afstand van punt tot segment (m) + fractie t (0..1) van de projectie op het segment. */
  function segProject(lat, lng, a, b) {
    // Lokale equirectangular projectie in meters
    const R = 6371000;
    const latRef = (a[0] + b[0]) / 2;
    const kx = (Math.PI / 180) * R * Math.cos((latRef * Math.PI) / 180);
    const ky = (Math.PI / 180) * R;
    const px = (lng - a[1]) * kx, py = (lat - a[0]) * ky;
    const bx = (b[1] - a[1]) * kx, by = (b[0] - a[0]) * ky;
    const len2 = bx * bx + by * by;
    let t = len2 ? (px * bx + py * by) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = px - bx * t, dy = py - by * t;
    return { dist: Math.sqrt(dx * dx + dy * dy), t };
  }

  function haversineM(a, b) {
    const R = 6371000, toR = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toR, dLng = (b[1] - a[1]) * toR;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a[0] * toR) * Math.cos(b[0] * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  function friendlyGeoError(err) {
    if (!err) return 'onbekende fout';
    if (err.code === 1) return 'toegang geweigerd';
    if (err.code === 2) return 'positie onbeschikbaar';
    if (err.code === 3) return 'time-out';
    return err.message || 'fout';
  }

  global.MapView = MapView;
  global.Geo = { nearestDistanceMeters };
})(window);
