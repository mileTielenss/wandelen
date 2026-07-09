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
    gpsState: 'off', // off | searching | fix | denied
    lastFixAt: 0,
    wakeLock: null,
    _onModeChange: null,

    basemapKey: null,
    nodeLayer: null,
    horecaLayer: null,
    showNodes: true,
    showHoreca: true,

    init(onModeChange, opts) {
      this._onModeChange = onModeChange;
      opts = opts || {};
      this.map = L.map('map', {
        zoomControl: false,
        // Geen tegel-banner op de kaart; de bronvermelding staat in het ℹ️-scherm.
        attributionControl: false,
        // Zuinig: geen vloeiende zoom-animaties nodig
        fadeAnimation: false,
        tap: true,
      });
      // Geen zoomknoppen: touch-first (knijpen/scrollen zoomt) houdt de kaart rustig.

      this.showNodes = opts.showNodes !== false;
      this.showHoreca = opts.showHoreca !== false;
      this.setBasemap(opts.basemap || Tiles.DEFAULT_BASEMAP);
    },

    /** Wissel de onderliggende kaartlaag (scherp/satelliet/topo). */
    setBasemap(key) {
      const bm = Tiles.getBasemap(key);
      this.basemapKey = bm.key;
      if (this.tileLayer) this.tileLayer.remove();
      this.tileLayer = L.tileLayer(bm.url, {
        maxZoom: bm.maxZoom,
        maxNativeZoom: bm.maxNativeZoom,
        minZoom: 8,
        // tileSize 256: @2x-bronnen leveren 512px op 256 CSS-px = scherp.
        tileSize: 256,
        crossOrigin: true,
        attribution: bm.attribution,
        keepBuffer: 4,
      });
      this.tileLayer.addTo(this.map);
      this.tileLayer.bringToBack();
    },

    show(route) {
      if (this.exploreGroup) { this.exploreGroup.remove(); this.exploreGroup = null; }
      this.exploreMode = false;
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
      this.renderOverlays();
      this.recenter();
    },

    // ---------- Overlays: wandelknooppunten + horeca ----------
    renderOverlays() {
      if (this.nodeLayer) { this.nodeLayer.remove(); this.nodeLayer = null; }
      if (this.horecaLayer) { this.horecaLayer.remove(); this.horecaLayer = null; }
      const r = this.route;
      if (!r) return;

      // Knooppunten binnen ~200 m van de route (de knooppunten die je route volgt).
      const nodes = (r.nodes || []).filter(
        (n) => nearestDistanceMeters(n.lat, n.lng, this._latlngs) <= 200
      );
      this.nodeLayer = L.layerGroup(
        nodes.map((n) => L.marker([n.lat, n.lng], {
          icon: L.divIcon({
            className: '', html: `<div class="kp-badge">${escapeHtml(n.ref)}</div>`,
            iconSize: [30, 30], iconAnchor: [15, 15],
          }),
          keyboard: false,
        }).bindTooltip('Wandelknooppunt ' + n.ref, { direction: 'top' }))
      );

      // Horeca binnen ~450 m van de route (een kleine omweg waard).
      const horeca = (r.horeca || []).filter(
        (h) => nearestDistanceMeters(h.lat, h.lng, this._latlngs) <= 450
      );
      this.horecaLayer = L.layerGroup(
        horeca.map((h) => L.marker([h.lat, h.lng], {
          icon: L.divIcon({
            className: '', html: `<div class="horeca-pin" title="${escapeHtml(h.n)}">${horecaEmoji(h.t)}</div>`,
            iconSize: [24, 24], iconAnchor: [12, 12],
          }),
          keyboard: false,
        }).bindTooltip((h.n ? escapeHtml(h.n) + ' · ' : '') + horecaLabel(h.t), { direction: 'top' }))
      );

      this._nodeCount = nodes.length;
      this._horecaCount = horeca.length;
      this.applyOverlayVisibility();
    },

    applyOverlayVisibility() {
      if (this.nodeLayer) {
        if (this.showNodes) this.nodeLayer.addTo(this.map); else this.nodeLayer.remove();
      }
      if (this.horecaLayer) {
        if (this.showHoreca) this.horecaLayer.addTo(this.map); else this.horecaLayer.remove();
      }
    },

    setOverlayVisible(kind, on) {
      if (kind === 'nodes') this.showNodes = on;
      if (kind === 'horeca') this.showHoreca = on;
      this.applyOverlayVisibility();
    },

    recenter() {
      if (this.exploreMode && this.exploreGroup) {
        try { this.map.fitBounds(this.exploreGroup.getBounds(), { padding: [40, 40] }); } catch (_) {}
        return;
      }
      if (this.line) this.map.fitBounds(this.line.getBounds(), { padding: [40, 40] });
    },

    // ---------- Verken-modus: alle routes in de buurt tonen ----------
    clearRouteVisual() {
      if (this.line) { this.line.remove(); this.line = null; }
      if (this.startMarker) { this.startMarker.remove(); this.startMarker = null; }
      if (this.endMarker) { this.endMarker.remove(); this.endMarker = null; }
      if (this.nodeLayer) { this.nodeLayer.remove(); this.nodeLayer = null; }
      if (this.horecaLayer) { this.horecaLayer.remove(); this.horecaLayer = null; }
    },

    enterExplore() {
      this.clearRouteVisual();
      this.clearLocation();
      this.exploreMode = true;
      this.route = null;
      this._latlngs = null;
      this.exploreRoutes = [];
      this.selectedExploreId = null;
      if (this.exploreGroup) { this.exploreGroup.remove(); this.exploreGroup = null; }
      // Kaart-brede tik-fallback: een tik naast een route kiest de dichtstbijzijnde.
      // Blijft werken óók als de routelaag net hertekend wordt.
      if (!this._exploreTap) this._exploreTap = (e) => this._exploreNearestTap(e);
      this.map.off('click', this._exploreTap);
      this.map.on('click', this._exploreTap);
    },

    renderExplore(routes, onPick) {
      this.exploreMode = true;
      this.exploreRoutes = routes || [];
      this._onExplorePick = onPick;
      this.selectedExploreId = null;
      if (this.exploreGroup) { this.exploreGroup.remove(); }
      this.exploreGroup = L.layerGroup().addTo(this.map);
      this._exploreLayers = {};

      const bounds = [];
      this.exploreRoutes.forEach((rt, idx) => {
        const col = rt.colour || Overpass.FALLBACK[idx % Overpass.FALLBACK.length];
        rt._col = col;
        // Onzichtbare brede lijnen eronder = grote raakzone; je hoeft niet exact te tikken.
        const hits = rt.segments.map((seg) => L.polyline(seg, {
          color: '#000', weight: 26, opacity: 0, _hit: true,
        }));
        const lines = rt.segments.map((seg) => L.polyline(seg, {
          color: col, weight: 4, opacity: 0.72, lineJoin: 'round', lineCap: 'round',
        }));
        const grp = L.featureGroup([...hits, ...lines]);
        grp.on('click', () => this.selectExplore(rt.id));
        grp.addTo(this.exploreGroup);
        this._exploreLayers[rt.id] = grp;
        const gb = grp.getBounds();
        if (gb.isValid()) bounds.push(gb);
      });
      // Alleen op de routes inzoomen als we (nog) geen locatie tonen.
      if (bounds.length && !this.locMarker) {
        const fg = bounds.reduce((a, b) => a.extend(b), L.latLngBounds(bounds[0]));
        this.map.fitBounds(fg, { padding: [40, 40] });
      }
    },

    // Tik ergens op de kaart: kies de route binnen ~28 px van je vinger.
    _exploreNearestTap(e) {
      if (!this.exploreMode || !this.exploreRoutes.length || !e.latlng) return;
      const here = [e.latlng.lat, e.latlng.lng];
      let best = null, bestD = Infinity;
      for (const rt of this.exploreRoutes) {
        const d = minDistToSegments(here, rt.segments);
        if (d < bestD) { bestD = d; best = rt; }
      }
      const mpp = (40075016.686 * Math.cos((e.latlng.lat * Math.PI) / 180)) /
        (256 * Math.pow(2, this.map.getZoom()));
      if (best && bestD <= Math.max(30, 28 * mpp)) this.selectExplore(best.id);
    },

    selectExplore(id) {
      this.selectedExploreId = id;
      for (const rid of Object.keys(this._exploreLayers || {})) {
        const grp = this._exploreLayers[rid];
        const on = rid === id;
        grp.eachLayer((l) => {
          if (l.options._hit) return; // raakzone blijft onzichtbaar
          l.setStyle({ weight: on ? 7 : 3, opacity: on ? 1 : 0.3 });
        });
        if (on) grp.bringToFront();
      }
      const rt = this.exploreRoutes.find((r) => r.id === id);
      if (this._onExplorePick && rt) this._onExplorePick(rt);
    },

    clearExplore() {
      this.exploreMode = false;
      this.exploreRoutes = [];
      this._exploreLayers = {};
      this.selectedExploreId = null;
      if (this.exploreGroup) { this.exploreGroup.remove(); this.exploreGroup = null; }
      if (this._exploreTap) this.map.off('click', this._exploreTap);
      this.clearLocation();
    },

    // ---------- Locatie (eenmalig) ----------
    locateOnce(onFix, onErr, opts) {
      opts = opts || {};
      if (!('geolocation' in navigator)) { App.toast('Geen GPS beschikbaar'); this._setGps('denied'); if (onErr) onErr(); return; }
      App.toast('Locatie bepalen…');
      this._setGps('searching');
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          this._setMode('located');
          this._updateLocation(pos, false);
          const ll = [pos.coords.latitude, pos.coords.longitude];
          const z = this.exploreMode ? Math.max(this.map.getZoom() || 0, 14) : Math.max(this.map.getZoom() || 0, 15);
          this.map.setView(ll, z, { animate: true });
          // Eenmalige meting klaar → GPS-hardware staat weer uit, dus lampje uit.
          this._setGps('off');
          if (onFix) onFix(pos);
        },
        (err) => {
          this._setGps(err && err.code === 1 ? 'denied' : 'off');
          App.toast('Locatie mislukt: ' + friendlyGeoError(err));
          if (onErr) onErr(err);
        },
        // Normaal: verse, nauwkeurige meting bij elke tik. Verken-modus (fast):
        // een recente/grove fix volstaat om routes in de buurt te vinden — veel sneller.
        opts.fast
          ? { enableHighAccuracy: false, timeout: 8000, maximumAge: 120000 }
          : { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    },

    // ---------- Locatie volgen (tracking) ----------
    startTracking() {
      if (!('geolocation' in navigator)) { App.toast('Geen GPS beschikbaar'); this._setGps('denied'); return; }
      if (this.watchId != null) return;
      this._setMode('tracking');
      // Eerlijk zijn: pas "actief" claimen als er écht een fix binnenkomt.
      this._setGps('searching');
      this._followed = true;
      this.watchId = navigator.geolocation.watchPosition(
        (pos) => {
          this._setGps('fix');
          this._updateLocation(pos, true);
          if (this._followed) {
            this.map.setView(
              [pos.coords.latitude, pos.coords.longitude],
              Math.max(this.map.getZoom(), 16),
              { animate: true }
            );
          }
        },
        (err) => {
          if (err && err.code === 1) {
            // Toegang geweigerd: tracking heeft geen zin — stop en zeg het duidelijk.
            App.toast('GPS-toegang geweigerd — tracking gestopt');
            this.stopTracking();
            this._setGps('denied');
            return;
          }
          this._setGps('searching');
          App.toast('Tracking: ' + friendlyGeoError(err));
        },
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 2000 }
      );
      // Detecteer een wegvallend signaal: >30 s geen fix = terug naar "zoeken".
      this._staleTimer = setInterval(this._staleCheck.bind(this), 10000);
      // Zodra de gebruiker zelf pant, stoppen we met auto-centreren (zuiniger + minder storend)
      this.map.once('dragstart', () => { this._followed = false; });
    },

    _staleCheck() {
      if (this.gpsState === 'fix' && Date.now() - this.lastFixAt > 30000) {
        this._setGps('searching');
      }
    },

    stopTracking() {
      if (this.watchId != null) {
        navigator.geolocation.clearWatch(this.watchId);
        this.watchId = null;
      }
      if (this._staleTimer) { clearInterval(this._staleTimer); this._staleTimer = null; }
      this.releaseWake();
      // Behoud de laatste positie-marker maar val terug naar 'located'.
      this._setMode(this.locMarker ? 'located' : 'idle');
      // Watch is gestopt → GPS-hardware uit, dus lampje uit.
      this._setGps('off');
      // Bugfix: marker terug blauw — de rode (tracking)stijl geldt enkel tijdens volgen.
      if (this.locMarker) this.locMarker.setIcon(this._locIcon(false));
    },

    clearLocation() {
      this.stopTracking();
      if (this.locMarker) { this.locMarker.remove(); this.locMarker = null; }
      if (this.accCircle) { this.accCircle.remove(); this.accCircle = null; }
      this._setMode('idle');
      App.setOffRoute(null);
    },

    _locIcon(tracking) {
      return L.divIcon({
        className: '', html: `<div class="loc-dot ${tracking ? 'tracking' : ''}"></div>`,
        iconSize: [18, 18], iconAnchor: [9, 9],
      });
    },

    _updateLocation(pos, tracking) {
      const ll = [pos.coords.latitude, pos.coords.longitude];
      const acc = pos.coords.accuracy || 0;
      const icon = this._locIcon(tracking);
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
      // In verken-modus: welke routes loop je op? Anders: voortgang op je route.
      if (this.exploreMode) {
        const here = [pos.coords.latitude, pos.coords.longitude];
        const on = this.exploreRoutes
          .map((rt) => ({ rt, d: minDistToSegments(here, rt.segments) }))
          .filter((x) => x.d <= 30)
          .sort((a, b) => a.d - b.d)
          .map((x) => x.rt);
        if (App.onExploreLocate) App.onExploreLocate(on);
        return;
      }
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
      if (mode === 'idle') this.gpsState = 'off';
      if (this._onModeChange) this._onModeChange(mode);
      if (global.App && App.updateStatus) App.updateStatus();
    },

    _setGps(state) {
      this.gpsState = state;
      if (state === 'fix') this.lastFixAt = Date.now();
      if (global.App && App.updateStatus) App.updateStatus();
    },

    // ---------- Scherm aan houden (optioneel, enkel bij tracking) ----------
    async requestWake() {
      try {
        if ('wakeLock' in navigator) {
          this.wakeLock = await navigator.wakeLock.request('screen');
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

  // Kleinste afstand (m) van een punt tot een verzameling way-segmenten.
  function minDistToSegments(here, segments) {
    let best = Infinity;
    for (const seg of segments || []) {
      for (let i = 1; i < seg.length; i++) {
        const d = segProject(here[0], here[1], seg[i - 1], seg[i]).dist;
        if (d < best) best = d;
      }
    }
    return best;
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

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function horecaEmoji(_t) {
    // Eén herkenbaar koffieteken voor alle horeca (het type staat in de tooltip).
    return '☕';
  }
  function horecaLabel(t) {
    return ({
      cafe: 'Café', restaurant: 'Restaurant', bar: 'Bar', pub: 'Café/pub', fast_food: 'Snackbar',
      biergarten: 'Biergarten', ice_cream: 'IJssalon', bakery: 'Bakkerij',
    })[t] || 'Horeca';
  }

  function friendlyGeoError(err) {
    if (!err) return 'onbekende fout';
    if (err.code === 1) return 'toegang geweigerd';
    if (err.code === 2) return 'positie onbeschikbaar';
    if (err.code === 3) return 'time-out';
    return err.message || 'fout';
  }

  global.MapView = MapView;
  global.Geo = { nearestDistanceMeters, projectOnRoute, buildCum, segProject, haversineM, minDistToSegments };
})(window);
