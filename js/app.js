/* Hoofdlogica: schermen, routelijst, importeren, hernoemen, offline tegels. */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let _routes = [];
  let _current = null;      // geopende route op de kaart
  let _menuRoute = null;    // route in het hernoem/verwijder-menu

  const App = {
    async init() {
      this.registerSW();
      this._wrapFetch();
      this.prefs = this._loadPrefs();
      MapView.init((mode) => this._onMapMode(mode), {
        basemap: this.prefs.basemap,
        showNodes: this.prefs.showNodes,
        showHoreca: this.prefs.showHoreca,
      });
      this._wire();
      this.updateStatus();
      await this.seedDefault();
      await this.refreshList();
      try { this._regions = await DB.allRegions(); } catch (_) { this._regions = []; }
      this._handleSharedUrl();
    },

    // ---------- Status: internet + GPS ----------
    // Telt lopende externe requests, zodat het internet-lampje enkel brandt
    // terwijl de app écht iets opvraagt (en niet louter omdat er wifi is).
    _netCount: 0,
    _wrapFetch() {
      const orig = window.fetch.bind(window);
      const self = this;
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const external = /^https?:\/\//i.test(url) && !url.startsWith(location.origin);
        if (!external) return orig(input, init);
        self._netCount++;
        self.updateStatus();
        return orig(input, init).finally(() => {
          self._netCount = Math.max(0, self._netCount - 1);
          self.updateStatus();
        });
      };
    },

    updateStatus() {
      const online = navigator.onLine;
      const gps = MapView.gpsState || 'off';
      const tracking = MapView.mode === 'tracking';
      // Lampjes tonen GEBRUIK, geen beschikbaarheid: grijs = niet in gebruik.
      const gpsLabel = {
        off: 'gps uit',
        searching: 'gps zoekt…',
        fix: 'gps volgt',
        denied: 'gps geweigerd',
      }[gps] || 'gps uit';
      const gpsDot = {
        off: '',
        searching: 'mid pulse',
        fix: 'ok pulse',
        denied: 'bad',
      }[gps] || '';
      let netDot, netLabel;
      if (!online) { netDot = 'bad'; netLabel = 'offline'; }
      else if (this._netCount > 0) { netDot = 'ok pulse'; netLabel = 'internet actief'; }
      else { netDot = ''; netLabel = 'internet uit'; }
      const tile = this._tilePct != null
        ? `<span class="stat"><span class="sdot mid pulse"></span>kaart ⬇ ${this._tilePct}%</span>`
        : '';
      const html =
        `<span class="stat"><span class="sdot ${netDot}"></span>${netLabel}</span>` +
        `<span class="stat"><span class="sdot ${gpsDot}"></span>${gpsLabel}</span>` + tile;
      const a = $('statusbar-list'), b = $('statusbar-map');
      if (a) a.innerHTML = html;
      if (b) b.innerHTML = html;
      // Eerlijke HUD-tekst: geen "live tracking" claimen zonder echte fix.
      if (tracking && gps === 'searching') $('track-text').textContent = 'GPS-signaal zoeken…';
      if (tracking && gps === 'denied') $('track-text').textContent = 'GPS geweigerd';
    },

    _loadPrefs() {
      let p = {};
      try { p = JSON.parse(localStorage.getItem('wandelen-prefs') || '{}'); } catch (_) {}
      return {
        basemap: p.basemap || 'voyager',
        showNodes: p.showNodes !== false,
        showHoreca: p.showHoreca !== false,
      };
    },
    _savePrefs() {
      try { localStorage.setItem('wandelen-prefs', JSON.stringify(this.prefs)); } catch (_) {}
    },

    // ---------- Service worker ----------
    registerSW() {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      }
    },

    // ---------- Default route inladen (de meegeleverde Komoot-route) ----------
    async seedDefault() {
      try {
        const count = await DB.count();
        if (count > 0) return;
        const res = await fetch('data/default-route.json');
        if (!res.ok) return;
        const route = await res.json();
        route.importedAt = route.importedAt || new Date().toISOString();
        await DB.put(route);
      } catch (_) { /* geen default beschikbaar */ }
    },

    // ---------- Routelijst ----------
    async refreshList() {
      _routes = await DB.all();
      const list = $('route-list');
      list.innerHTML = '';
      $('list-empty').hidden = _routes.length > 0;

      for (const r of _routes) {
        const card = document.createElement('div');
        card.className = 'route-card';
        card.setAttribute('role', 'button');
        card.dataset.id = r.id;
        card.innerHTML = `
          <div class="thumb">${thumbSvg(r.coords)}</div>
          <div class="info">
            <div class="name"></div>
            <div class="meta">
              <span>${formatKm(r.distance)}</span>
              ${r.elevationUp ? `<span>↑ ${r.elevationUp} m</span>` : ''}
              <span>${sportLabel(r.sport)}</span>
              ${r.tilesCached ? '<span class="badge-offline">⬇ offline</span>' : ''}
            </div>
          </div>
          <button class="kebab" aria-label="Menu">⋯</button>`;
        card.querySelector('.name').textContent = r.name;

        let pressTimer = null;
        const openMenu = (e) => { e.stopPropagation(); this.openMenu(r); };
        card.querySelector('.kebab').addEventListener('click', openMenu);
        card.addEventListener('click', () => this.openRoute(r.id));
        card.addEventListener('touchstart', () => {
          pressTimer = setTimeout(() => { this.openMenu(r); }, 550);
        }, { passive: true });
        const cancel = () => clearTimeout(pressTimer);
        card.addEventListener('touchend', cancel);
        card.addEventListener('touchmove', cancel);

        list.appendChild(card);
      }
    },

    // ---------- Importeren van Komoot ----------
    async loadFromInput() {
      const input = $('url-input');
      const url = input.value.trim();
      if (!url) { this.setLoadStatus('Plak eerst een Komoot-URL.', 'error'); return; }
      $('btn-load').disabled = true;
      this.setLoadStatus('Route ophalen…', '');
      try {
        const route = await Komoot.importFromUrl(url);
        const existing = await DB.get(route.id);
        if (existing) {
          // Behoud alles wat lokaal al opgebouwd is: eigen naam, offline
          // tegels én de opgehaalde knooppunten/horeca.
          route.name = existing.name;
          route.tilesCached = existing.tilesCached;
          route.tileDetail = existing.tileDetail;
          route.tileMaps = existing.tileMaps;
          route.nodes = existing.nodes;
          route.horeca = existing.horeca;
          route.overlaysFetched = existing.overlaysFetched;
        }
        const existed = !!existing;
        await DB.put(route);
        input.value = '';
        this.setLoadStatus('', '');
        await this.refreshList();
        this.toast(existed
          ? `“${route.name}” stond er al — bijgewerkt en geopend`
          : `“${route.name}” ingeladen`);
        // Toon de route meteen — zo doet “Laden” altijd zichtbaar iets.
        this.openRoute(route.id);
      } catch (e) {
        this.setLoadStatus('Mislukt: ' + (e.message || 'kon route niet laden') +
          '. Controleer de URL (met share_token) en je internetverbinding.', 'error');
      } finally {
        $('btn-load').disabled = false;
      }
    },

    setLoadStatus(msg, kind) {
      const el = $('load-status');
      el.textContent = msg;
      el.className = 'load-status' + (kind ? ' ' + kind : '');
      el.hidden = !msg;
    },

    _handleSharedUrl() {
      // Ondersteun openen via ?url=<komoot> of ?tour=<id>
      try {
        const p = new URLSearchParams(location.search);
        const shared = p.get('url') || p.get('tour');
        if (shared) {
          $('url-input').value = shared;
          this.loadFromInput();
          history.replaceState(null, '', location.pathname);
        }
      } catch (_) {}
    },

    // ---------- Route openen op kaart ----------
    async openRoute(id) {
      const r = await DB.get(id);
      if (!r) return;
      _current = r;
      $('map-route-name').textContent = r.name;
      $('map-route-meta').textContent =
        `${formatKm(r.distance)} · ${r.coords.length} punten` +
        (r.elevationUp ? ` · ↑${r.elevationUp}m` : '');
      this.goto('map');
      MapView.invalidate();
      MapView.show(r);
      $('offroute-banner').hidden = true;
      this._resetLocButtons();
      this.maybeFetchOverlays(r);
      this.autoCacheTiles(r);
    },

    // Kaarttegels automatisch offline halen (hoogste detail) zodra er internet is.
    async autoCacheTiles(route) {
      if (!route || !navigator.onLine || this._tileJob) return;
      const bm = Tiles.getBasemap(this.prefs.basemap);
      const done = route.tileMaps || [];
      if (done.includes(bm.key)) return;
      this._tileJob = route.id + ':' + bm.key;
      this._tileAbortAuto = new AbortController();
      try {
        const result = await Tiles.download(
          route.coords, 'fine', bm,
          (d, t) => { this._tilePct = Math.round((d / t) * 100); this.updateStatus(); },
          this._tileAbortAuto.signal
        );
        if (!result.cancelled && result.ok > 0) {
          route.tilesCached = true;
          route.tileDetail = 'fine';
          route.tileMaps = [...new Set([...done, bm.key])];
          await DB.put(route);
          if (_current && _current.id === route.id) _current = route;
          this.refreshList();
          this.toast('Kaart offline opgeslagen ✓');
        }
      } catch (_) { /* stil: volgende keer opnieuw proberen */ }
      finally {
        this._tileJob = null;
        this._tilePct = null;
        this._tileAbortAuto = null;
        this.updateStatus();
      }
    },

    // Knooppunten + horeca ophalen (eenmalig, indien online) en offline bewaren.
    async maybeFetchOverlays(route) {
      if (route.overlaysFetched) return;
      if (!navigator.onLine) return;
      try {
        const bounds = Overpass.boundsFromCoords(route.coords);
        const { nodes, horeca } = await Overpass.fetchOverlays(bounds);
        route.nodes = nodes;
        route.horeca = horeca;
        route.overlaysFetched = true;
        await DB.put(route);
        if (_current && _current.id === route.id) {
          MapView.route = route;
          MapView.renderOverlays();
        }
        this.toast(`Knooppunten (${nodes.length}) & horeca (${horeca.length}) geladen`);
      } catch (_) { /* offline of Overpass onbereikbaar: stil overslaan */ }
    },

    // ---------- Verken: nieuwe wandeling (routes in de buurt) ----------
    startExplore() {
      this._exploreActive = true;
      _current = null;
      this._selectedExplore = null;
      $('map-route-name').textContent = 'Nieuwe wandeling';
      $('map-route-meta').textContent = 'routes in de buurt';
      this.goto('map');
      this._setExploreChrome(true);
      MapView.invalidate();
      MapView.enterExplore();
      $('explore-bar').hidden = false;
      $('explore-follow').disabled = true;
      $('explore-info').querySelector('strong').innerHTML = 'Routes in de buurt';

      // Toon meteen het laatste zoekresultaat (cache) — geen wachten op netwerk.
      const cache = this._exploreCache();
      if (cache) {
        this._exploreRoutes = cache.routes;
        this._exploreBounds = cache.bounds;
        MapView.renderExplore(cache.routes, (rt) => this._onExplorePick(rt));
        $('explore-hint').textContent = `${cache.routes.length} routes (vorige zoekactie) — locatie bepalen…`;
      } else {
        $('explore-hint').textContent = 'locatie bepalen…';
      }

      // Grove/recente GPS-fix volstaat hier en is veel sneller dan een verse precisiefix.
      MapView.locateOnce(
        () => this._exploreFetch(),
        () => {
          if (!cache) {
            MapView.map.setView(this._lastCenter || [51.23, 5.35], 13);
            $('explore-hint').textContent = 'geen GPS — verschuif de kaart en tik “Zoek hier”';
          }
          this._exploreFetch();
        },
        { fast: true }
      );
    },

    // Laatste verkenning uit de regio-opslag (max 7 dagen oud).
    _exploreCache() {
      const reg = (this._regions || []).find((r) => r.id === 'explore-cache');
      if (!reg || !reg.routes || !reg.routes.length) return null;
      const age = Date.now() - new Date(reg.savedAt || 0).getTime();
      if (age > 7 * 24 * 3600 * 1000) return null;
      return reg;
    },

    _setExploreChrome(on) {
      $('btn-track').hidden = on;
      $('offroute-banner').hidden = true;
    },

    async _exploreFetch() {
      const b = MapView.map.getBounds();
      const c = b.getCenter();
      this._lastCenter = [c.lat, c.lng];
      // Begrens het zoekgebied: een uitgezoomde kaart zou anders een gigantische
      // (trage) query opleveren. Max ~18 km hoog; anders 9 km rond het midden.
      let bounds = { minLat: b.getSouth(), minLng: b.getWest(), maxLat: b.getNorth(), maxLng: b.getEast() };
      const MAX_SPAN = 0.16;
      if ((bounds.maxLat - bounds.minLat) > MAX_SPAN || (bounds.maxLng - bounds.minLng) > MAX_SPAN * 1.7) {
        bounds = Overpass.boundsFromCenter(c.lat, c.lng, 9000);
      }
      $('explore-hint').textContent = 'routes ophalen…';
      $('explore-search').disabled = true;
      const mySeq = (this._exploreSeq = (this._exploreSeq || 0) + 1);
      try {
        let routes, fromCache = false;
        if (navigator.onLine) {
          routes = await Overpass.fetchRoutes(bounds);
        } else {
          routes = this._routesFromRegions(bounds);
          fromCache = true;
        }
        // Verouderd antwoord (gebruiker zocht ondertussen opnieuw)? Negeren.
        if (mySeq !== this._exploreSeq || !this._exploreActive) return;
        this._exploreRoutes = routes;
        this._exploreBounds = bounds;
        // Niet hertekenen over een gemaakte keuze heen.
        if (!this._selectedExplore) {
          MapView.renderExplore(routes, (rt) => this._onExplorePick(rt));
          $('explore-hint').textContent = routes.length
            ? `${routes.length} route${routes.length > 1 ? 's' : ''} — tik er één aan${fromCache ? ' (offline)' : ''}`
            : (fromCache ? 'geen offline routes voor dit gebied' : 'geen bewegwijzerde lussen hier gevonden');
        }
        // Bewaar als cache zodat de volgende keer meteen iets te zien is.
        if (!fromCache && routes.length) {
          const region = {
            id: 'explore-cache', name: '(auto) laatste verkenning',
            bounds, routes, savedAt: new Date().toISOString(),
          };
          DB.putRegion(region).then(async () => { this._regions = await DB.allRegions(); }).catch(() => {});
          // En haal het gebied (kaart + routes) automatisch offline binnen.
          this._autoCacheRegion(bounds, routes);
        }
      } catch (e) {
        if (mySeq !== this._exploreSeq || !this._exploreActive) return;
        // Netwerk faalde: val terug op offline regio's/cache.
        const fallback = this._routesFromRegions(bounds);
        if (fallback.length && !this._selectedExplore) {
          this._exploreRoutes = fallback;
          this._exploreBounds = bounds;
          MapView.renderExplore(fallback, (rt) => this._onExplorePick(rt));
          $('explore-hint').textContent = `${fallback.length} routes (offline cache) — tik er één aan`;
        } else if (!this._selectedExplore) {
          $('explore-hint').textContent = 'kon routes niet laden — probeer “Zoek hier”';
        }
      } finally {
        if (mySeq === this._exploreSeq) $('explore-search').disabled = false;
      }
    },

    _onExplorePick(rt) {
      this._selectedExplore = rt;
      const strong = $('explore-info').querySelector('strong');
      strong.innerHTML = `<span class="swatch" style="background:${rt._col}"></span>` +
        escapeHtmlApp(rt.name);
      $('explore-hint').textContent = `${formatKm(rt.distance)}${rt.ref ? ' · ' + escapeHtmlApp(rt.ref) : ''} — tik “Volg”`;
      $('explore-follow').disabled = false;
    },

    onExploreLocate(routesOn) {
      if (!this._exploreActive) return;
      if (routesOn && routesOn.length) {
        const names = routesOn.map((r) => r.name).slice(0, 3).join(', ');
        this.toast('Je staat op: ' + names);
      }
    },

    async followSelected() {
      const rt = this._selectedExplore;
      if (!rt) return;
      const route = {
        id: rt.id,
        source: 'osm',
        name: rt.name,
        colour: rt._col,
        sport: 'hike',
        coords: rt.coords.map((c) => [c[0], c[1], 0]),
        distance: rt.distance,
        elevationUp: 0, elevationDown: 0, duration: 0,
        importedAt: new Date().toISOString(),
      };
      await DB.put(route);
      this._exploreActive = false;
      this._setExploreChrome(false);
      $('explore-bar').hidden = true;
      MapView.clearExplore();
      await this.refreshList();
      this.openRoute(route.id);
    },

    _routesFromRegions(bounds) {
      // Offline: neem routes uit opgeslagen regio's die dit gebied overlappen.
      const cx = (bounds.minLat + bounds.maxLat) / 2, cy = (bounds.minLng + bounds.maxLng) / 2;
      let best = [];
      for (const reg of this._regions || []) {
        const rb = reg.bounds;
        if (cx >= rb.minLat && cx <= rb.maxLat && cy >= rb.minLng && cy <= rb.maxLng) {
          best = best.concat(reg.routes || []);
        }
      }
      // Dubbelen eruit (dezelfde route kan in meerdere regio's/cache zitten).
      const seen = new Set();
      return best.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    },

    // ---------- Hernoem / verwijder menu ----------
    openMenu(route) {
      _menuRoute = route;
      $('menu-title').textContent = route.name;
      $('rename-input').value = route.name;
      this._show('menu-overlay');
    },
    async saveMenu() {
      if (!_menuRoute) return;
      const name = $('rename-input').value.trim() || _menuRoute.name;
      _menuRoute.name = name;
      await DB.put(_menuRoute);
      if (_current && _current.id === _menuRoute.id) {
        _current.name = name;
        $('map-route-name').textContent = name;
      }
      this._hide('menu-overlay');
      await this.refreshList();
      this.toast('Naam opgeslagen');
    },
    async deleteMenu() {
      if (!_menuRoute) return;
      if (!confirm(`“${_menuRoute.name}” verwijderen?`)) return;
      await DB.remove(_menuRoute.id);
      this._hide('menu-overlay');
      await this.refreshList();
      this.toast('Route verwijderd');
    },

    // ---------- Verkende regio automatisch offline ----------
    // Na een geslaagde online zoekactie: sla het gebied stilletjes op (routes +
    // kaarttegels op overzichtsniveau), zodat je hier later offline kan kiezen.
    // Volg je daarna een route, dan cachet die zichzelf op hoogste detail.
    async _autoCacheRegion(bounds, routes) {
      if (!navigator.onLine || !routes.length || this._regionJob) return;
      const cx = (bounds.minLat + bounds.maxLat) / 2, cy = (bounds.minLng + bounds.maxLng) / 2;
      const id = 'region-' + Math.round(cx * 200) + '_' + Math.round(cy * 200);
      const existing = (this._regions || []).find((r) => r.id === id);
      const fresh = existing &&
        Date.now() - new Date(existing.savedAt || 0).getTime() < 30 * 24 * 3600 * 1000;
      if (fresh) return;
      this._regionJob = id;
      try {
        const bm = Tiles.getBasemap(this.prefs.basemap);
        const result = await Tiles.downloadBBox(
          bounds, 'normal', bm,
          (d, t) => { this._tilePct = Math.round((d / t) * 100); this.updateStatus(); }
        );
        const region = {
          id,
          name: 'Regio ' + cx.toFixed(3) + ', ' + cy.toFixed(3),
          bounds,
          routes: routes.map((r) => ({
            id: r.id, name: r.name, ref: r.ref, colour: r.colour, _col: r._col,
            distance: r.distance, segments: r.segments, coords: r.coords,
          })),
          basemap: bm.key,
          savedAt: new Date().toISOString(),
        };
        await DB.putRegion(region);
        this._regions = await DB.allRegions();
        if (result.ok > 0) this.toast('Gebied offline opgeslagen ✓');
      } catch (_) { /* stil: volgende keer opnieuw */ }
      finally {
        this._regionJob = null;
        this._tilePct = null;
        this.updateStatus();
      }
    },

    // ---------- Kaartlagen ----------
    openLayers() {
      const bm = this.prefs.basemap;
      const radio = document.querySelector(`input[name="basemap"][value="${bm}"]`);
      if (radio) radio.checked = true;
      $('ov-nodes').checked = this.prefs.showNodes;
      $('ov-horeca').checked = this.prefs.showHoreca;
      const nc = MapView._nodeCount, hc = MapView._horecaCount;
      $('ov-nodes-count').textContent = nc != null ? `(${nc} op deze route)` : '';
      $('ov-horeca-count').textContent = hc != null ? `(${hc} in de buurt)` : '';
      $('overlays-note').textContent = (_current && !_current.overlaysFetched && !navigator.onLine)
        ? 'Knooppunten/horeca nog niet geladen — verbind één keer met internet.'
        : 'Overlays worden bij de route offline bewaard.';
      this._show('layers-overlay');
    },
    setBasemap(key) {
      this.prefs.basemap = key;
      this._savePrefs();
      MapView.setBasemap(key);
      // Nieuwe kaartlaag → ook die automatisch offline halen voor de open route.
      if (_current) this.autoCacheTiles(_current);
    },
    setOverlay(kind, on) {
      if (kind === 'nodes') this.prefs.showNodes = on;
      if (kind === 'horeca') this.prefs.showHoreca = on;
      this._savePrefs();
      MapView.setOverlayVisible(kind, on);
    },

    // ---------- Locatie-knoppen ----------
    _resetLocButtons() {
      $('track-hud').hidden = true;
      $('btn-track').classList.remove('track-on');
      $('btn-track').classList.add('track-off');
      $('chk-awake').checked = false;
    },
    toggleLocate() { MapView.locateOnce(); },
    toggleTrack() {
      if (MapView.mode === 'tracking') {
        MapView.stopTracking();
      } else {
        MapView.startTracking();
      }
    },
    _onMapMode(mode) {
      const trackBtn = $('btn-track');
      const hud = $('track-hud');
      if (mode === 'tracking') {
        trackBtn.classList.add('track-on');
        trackBtn.classList.remove('track-off');
        hud.hidden = false;
      } else {
        trackBtn.classList.remove('track-on');
        trackBtn.classList.add('track-off');
        hud.hidden = true;
        $('chk-awake').checked = false;
      }
    },

    setOffRoute(info) {
      const banner = $('offroute-banner');
      if (!info) { banner.hidden = true; return; }
      banner.hidden = false;
      const m = Math.round(info.meters);
      const total = info.totalM || 0;
      const along = Math.max(0, Math.min(info.alongM || 0, total));
      const remain = Math.max(0, total - along);
      const pct = total ? Math.round((along / total) * 100) : 0;
      const acc = info.accuracy > 30 ? ` · GPS ±${Math.round(info.accuracy)}m` : '';

      // Voortgangsregel: "km 10,2 van 18,8 · nog 8,6 km · 54%"
      const prog = total
        ? `km ${kmNum(along)} van ${kmNum(total)} · nog ${km(remain)} · ${pct}%`
        : '';

      if (info.off) {
        banner.className = 'offroute';
        banner.innerHTML =
          `<span class="ln1">⚠ ${m} m van de route${acc}</span>` +
          (prog ? `<span class="ln2">dichtstbij ${prog}</span>` : '');
      } else {
        banner.className = 'offroute on-route';
        banner.innerHTML =
          `<span class="ln1">✓ Op de route${acc}</span>` +
          (prog ? `<span class="ln2">${prog}</span>` : '');
      }

      // Tijdens tracking ook in de HUD tonen
      if (MapView.mode === 'tracking' && total) {
        $('track-text').textContent = `nog ${km(remain)} · ${pct}%`;
      }
    },

    // ---------- Navigatie ----------
    goto(screen) {
      $('screen-list').classList.toggle('is-active', screen === 'list');
      $('screen-map').classList.toggle('is-active', screen === 'map');
      if (screen === 'list') {
        if (this._exploreActive) {
          this._exploreActive = false;
          MapView.clearExplore();
          this._setExploreChrome(false);
          $('explore-bar').hidden = true;
        }
        MapView.clearLocation();
        _current = null;
      }
    },

    // ---------- Overlays ----------
    _show(id) { $(id).hidden = false; },
    _hide(id) { $(id).hidden = true; },

    toast(msg) {
      const t = $('toast');
      t.textContent = msg;
      t.hidden = false;
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
    },

    // ---------- Event-bedrading ----------
    _wire() {
      $('btn-load').addEventListener('click', () => this.loadFromInput());
      $('url-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.loadFromInput();
      });
      $('btn-about').addEventListener('click', () => this._show('about-overlay'));
      $('about-close').addEventListener('click', () => this._hide('about-overlay'));

      $('btn-back').addEventListener('click', () => this.goto('list'));
      $('btn-recenter').addEventListener('click', () => MapView.recenter());
      $('btn-locate').addEventListener('click', () => this.toggleLocate());
      $('btn-track').addEventListener('click', () => this.toggleTrack());
      $('btn-track-stop').addEventListener('click', () => MapView.stopTracking());
      $('chk-awake').addEventListener('change', (e) => {
        if (e.target.checked) MapView.requestWake();
        else MapView.releaseWake();
      });

      $('btn-layers').addEventListener('click', () => this.openLayers());
      $('layers-close').addEventListener('click', () => this._hide('layers-overlay'));
      for (const radio of document.querySelectorAll('input[name="basemap"]')) {
        radio.addEventListener('change', (e) => { if (e.target.checked) this.setBasemap(e.target.value); });
      }
      $('ov-nodes').addEventListener('change', (e) => this.setOverlay('nodes', e.target.checked));
      $('ov-horeca').addEventListener('change', (e) => this.setOverlay('horeca', e.target.checked));

      $('btn-explore').addEventListener('click', () => this.startExplore());
      $('explore-search').addEventListener('click', () => {
        // Expliciet opnieuw zoeken: wis de vorige keuze zodat het nieuwe resultaat telt.
        this._selectedExplore = null;
        $('explore-follow').disabled = true;
        $('explore-info').querySelector('strong').innerHTML = 'Routes in de buurt';
        this._exploreFetch();
      });
      $('explore-follow').addEventListener('click', () => this.followSelected());

      $('menu-save').addEventListener('click', () => this.saveMenu());
      $('menu-cancel').addEventListener('click', () => this._hide('menu-overlay'));
      $('menu-delete').addEventListener('click', () => this.deleteMenu());

      // Overlays sluiten bij tik op achtergrond
      for (const id of ['menu-overlay', 'about-overlay', 'layers-overlay']) {
        $(id).addEventListener('click', (e) => { if (e.target.id === id) this._hide(id); });
      }

      // Internet-status live bijhouden
      window.addEventListener('online', () => this.updateStatus());
      window.addEventListener('offline', () => this.updateStatus());

      // Scherm-wakelock opnieuw aanvragen na terugkeer (indien actief gewenst)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && $('chk-awake').checked) {
          MapView.requestWake();
        }
        this.updateStatus();
      });
    },
  };

  // ---------- Helpers ----------
  function formatKm(m) {
    if (!m) return '– km';
    return (m / 1000).toFixed(1).replace('.', ',') + ' km';
  }
  function km(m) { return (m / 1000).toFixed(1).replace('.', ',') + ' km'; }
  function kmNum(m) { return (m / 1000).toFixed(1).replace('.', ','); }
  function escapeHtmlApp(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sportLabel(s) {
    const map = { hike: 'Wandelen', touringbicycle: 'Fietsen', mtb: 'MTB', jogging: 'Joggen', racebike: 'Racefiets' };
    return map[s] || 'Route';
  }
  function thumbSvg(coords) {
    if (!coords || coords.length < 2) return '';
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const c of coords) {
      if (c[0] < minLat) minLat = c[0];
      if (c[0] > maxLat) maxLat = c[0];
      if (c[1] < minLng) minLng = c[1];
      if (c[1] > maxLng) maxLng = c[1];
    }
    const W = 52, H = 52, pad = 7;
    const spanLat = maxLat - minLat || 1e-6;
    const spanLng = maxLng - minLng || 1e-6;
    const scale = Math.min((W - 2 * pad) / spanLng, (H - 2 * pad) / spanLat);
    const ox = (W - spanLng * scale) / 2, oy = (H - spanLat * scale) / 2;
    // Sample max ~60 punten voor een lichte thumbnail
    const step = Math.max(1, Math.floor(coords.length / 60));
    let d = '';
    for (let i = 0; i < coords.length; i += step) {
      const x = ox + (coords[i][1] - minLng) * scale;
      const y = oy + (maxLat - coords[i][0]) * scale; // y omgekeerd
      d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
      <path d="${d}" fill="none" stroke="#e11d48" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  global.App = App;
  document.addEventListener('DOMContentLoaded', () => App.init());
})(window);
