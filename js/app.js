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
      // Alleen naar de DOM schrijven als er echt iets wijzigt: tijdens een
      // tegel-download wisselt de request-teller duizenden keren zonder dat
      // de tekst verandert — die hertekeningen kosten enkel batterij.
      if (html !== this._statusHtml) {
        this._statusHtml = html;
        $('statusbar-list').innerHTML = html;
        $('statusbar-map').innerHTML = html;
      }
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

    // ---------- Importeren: Komoot-URL, GPX-URL of GPX-bestand ----------
    async loadFromInput() {
      const input = $('url-input');
      const url = input.value.trim();
      if (!url) { this.setLoadStatus('Plak eerst een link (Komoot of GPX).', 'error'); return; }
      $('btn-load').disabled = true;
      this.setLoadStatus('Route ophalen…', '');
      try {
        const route = await this._importFromUrl(url);
        input.value = '';
        await this._saveImported(route);
      } catch (e) {
        this.setLoadStatus('Mislukt: ' + e.message +
          '. Plak een Komoot-tour (met share_token) of een directe GPX-link.', 'error');
      } finally {
        $('btn-load').disabled = false;
      }
    },

    // Elke link aanvaarden en de juiste bron kiezen: .gpx → GPX, een Komoot-tour
    // → Komoot, en anders eerst GPX proberen (veel “interessante” links zijn een
    // direct GPX-bestand) met Komoot als terugval.
    async _importFromUrl(url) {
      if (GPX.isGpxUrl(url)) return GPX.importFromUrl(url);
      if (Komoot.parseUrl(url)) return Komoot.importFromUrl(url);
      // Geen .gpx en geen Komoot-tour → meteen een duidelijke boodschap i.p.v.
      // gokken (en op het netwerk blijven hangen op een willekeurige link).
      throw new Error('Onbekende link — plak een Komoot-tour of een directe GPX-link (.gpx)');
    },

    async loadFromFile(file) {
      this.setLoadStatus('GPX-bestand lezen…', '');
      try {
        const route = GPX.parse(await file.text(), file.name.replace(/\.gpx$/i, ''));
        await this._saveImported(route);
      } catch (e) {
        this.setLoadStatus('Mislukt: ' + e.message, 'error');
      }
    },

    async _saveImported(route) {
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
      await DB.put(route);
      this.setLoadStatus('', '');
      await this.refreshList();
      this.toast(existing
        ? `“${route.name}” stond er al — bijgewerkt en geopend`
        : (route.gpxVorm === 'punten'
          ? `“${route.name}”: losse punten verbonden (geen gevolgd pad)`
          : `“${route.name}” ingeladen`));
      // Toon de route meteen — zo doet “Laden” altijd zichtbaar iets.
      this.openRoute(route.id);
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
      this._ensureCountryOverlays();
      $('explore-bar').hidden = false;
      $('explore-follow').disabled = true;
      $('explore-info').querySelector('strong').innerHTML = 'Routes in de buurt';

      // Toon meteen het laatste zoekresultaat (cache) — geen wachten op netwerk.
      const cache = this._exploreCache();
      if (cache) {
        this._exploreRoutes = cache.routes;
        this._exploreBounds = cache.bounds;
        MapView.renderExplore(cache.routes, (rt) => this._onExplorePick(rt));
        this._renderAreaOverlays({ nodes: cache.nodes || [], horeca: cache.horeca || [] }, cache.bounds);
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
      const reg = this._regions.find((r) => r.id === 'explore-cache');
      if (!reg || !reg.routes || !reg.routes.length) return null;
      const age = Date.now() - new Date(reg.savedAt || 0).getTime();
      if (age > 7 * 24 * 3600 * 1000) return null;
      return reg;
    },

    _setExploreChrome(on) {
      $('btn-track').hidden = on;
      // ⤢ heeft in verkennen pas zin als er een route gekozen is.
      $('btn-recenter').hidden = on;
      $('offroute-banner').hidden = true;
    },

    async _exploreFetch(force) {
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
      const mySeq = (this._exploreSeq = (this._exploreSeq || 0) + 1);
      const onPick = (rt) => this._onExplorePick(rt);
      // Vroeg zetten: de landdata-overlay (be-overlays) rendert op dit gebied
      // zodra ze binnen is, ook als er (nog) geen routes zijn.
      this._exploreBounds = bounds;

      // Opslag-eerst: is dit gebied al eens (vers, <30 dagen) opgehaald, gebruik
      // dan de bewaarde routes — geen internet nodig. “Zoek hier” (force) haalt
      // wél opnieuw op via het netwerk.
      if (!force) {
        const stored = this._routesFromRegions(bounds, true);
        if (stored.length) {
          this._exploreRoutes = stored;
          this._exploreBounds = bounds;
          this._renderAreaOverlays(this._overlaysFromRegions(bounds), bounds);
          if (!this._selectedExplore) {
            const shownIds = new Set(MapView.exploreRoutes.map((r) => r.id));
            const same = stored.length === shownIds.size && stored.every((r) => shownIds.has(r.id));
            if (!same) MapView.renderExplore(stored, onPick);
            $('explore-hint').textContent =
              `${stored.length} route${stored.length > 1 ? 's' : ''} (opgeslagen) — tik er één aan`;
          }
          return;
        }
      }

      $('explore-search').disabled = true;
      // Nieuwe zoekactie breekt de vorige (nog lopende) stroom af.
      if (this._exploreAbort) this._exploreAbort.abort();
      const ctrl = (this._exploreAbort = new AbortController());
      const stale = () => mySeq !== this._exploreSeq || !this._exploreActive;

      if (!navigator.onLine) {
        // Offline: alles uit de lokale opslag.
        const routes = this._routesFromRegions(bounds);
        this._exploreRoutes = routes;
        this._exploreBounds = bounds;
        this._renderAreaOverlays(this._overlaysFromRegions(bounds), bounds);
        if (!this._selectedExplore) {
          MapView.renderExplore(routes, onPick);
          $('explore-hint').textContent = routes.length
            ? `${routes.length} route${routes.length > 1 ? 's' : ''} (offline) — tik er één aan`
            : 'geen offline routes voor dit gebied';
        }
        $('explore-search').disabled = false;
        return;
      }

      // Knooppunten/horeca: toon meteen wat lokaal is (België = instant), en
      // haal op de achtergrond vers op — dit blokkeert het tekenen niet.
      this._renderAreaOverlays(this._overlaysFromRegions(bounds), bounds);
      const overlaysP = Overpass.fetchOverlaysArea(bounds, ctrl.signal).catch(() => null);

      try {
        // Fase 1 — piepkleine lijst-query: meteen weten hoeveel routes er zijn.
        $('explore-hint').textContent = 'routes zoeken…';
        const list = await Overpass.fetchRouteList(bounds, ctrl.signal);
        if (stale()) return;
        if (!list.length) {
          if (!this._selectedExplore) {
            MapView.renderExplore([], onPick);
            $('explore-hint').textContent = 'geen bewegwijzerde lussen hier gevonden';
          }
          $('explore-search').disabled = false;
          return;
        }

        // Fase 2 — geometrie in kleine, parallelle brokjes; elk brokje verschijnt
        // meteen op de kaart (progressief laden i.p.v. wachten op alles).
        if (!this._selectedExplore) MapView.startExploreRender(onPick);
        const ids = list.map((l) => l.id);
        const chunks = [];
        for (let i = 0; i < ids.length; i += 6) chunks.push(ids.slice(i, i + 6));
        const all = [];
        $('explore-hint').textContent = `0 van ${list.length} routes laden…`;
        await this._runPool(chunks, 3, async (chunk) => {
          let part;
          try { part = await Overpass.fetchRoutesByIds(chunk, ctrl.signal); }
          catch (_) { return; } // één brokje mislukt → de rest komt gewoon door
          if (stale()) return;
          all.push(...part);
          if (!this._selectedExplore) MapView.addExploreRoutes(part);
          $('explore-hint').textContent = this._selectedExplore
            ? $('explore-hint').textContent
            : `${all.length} van ${list.length} routes — tik er één aan`;
        });
        if (stale()) return;
        if (!all.length) throw new Error('geen geometrie');

        this._exploreRoutes = all;
        this._exploreBounds = bounds;
        if (!this._selectedExplore) {
          $('explore-hint').textContent = `${all.length} route${all.length > 1 ? 's' : ''} — tik er één aan`;
        }

        // Overlays vers (buiten België de enige bron) + alles offline bewaren.
        const ov = (await overlaysP) || this._overlaysFromRegions(bounds);
        if (!stale() && !this._selectedExplore) this._renderAreaOverlays(ov, bounds);
        const region = {
          id: 'explore-cache', name: '(auto) laatste verkenning',
          bounds, routes: all, nodes: ov.nodes, horeca: ov.horeca,
          savedAt: new Date().toISOString(),
        };
        DB.putRegion(region).then(async () => { this._regions = await DB.allRegions(); }).catch(() => {});
        this._autoCacheRegion(bounds, all, ov);
      } catch (e) {
        if (stale()) return;
        // Netwerk faalde: val terug op offline regio's/cache.
        const fallback = this._routesFromRegions(bounds);
        if (fallback.length && !this._selectedExplore) {
          this._exploreRoutes = fallback;
          this._exploreBounds = bounds;
          MapView.renderExplore(fallback, onPick);
          this._renderAreaOverlays(this._overlaysFromRegions(bounds), bounds);
          $('explore-hint').textContent = `${fallback.length} routes (offline cache) — tik er één aan`;
        } else if (!this._selectedExplore) {
          $('explore-hint').textContent = 'kon routes niet laden — probeer “Zoek hier”';
        }
      } finally {
        if (mySeq === this._exploreSeq) $('explore-search').disabled = false;
      }
    },

    // Kleine concurrency-pool: draai `fn` over `items` met max `conc` tegelijk.
    async _runPool(items, conc, fn) {
      let i = 0;
      const worker = async () => { while (i < items.length) await fn(items[i++]); };
      await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
    },

    _onExplorePick(rt) {
      this._selectedExplore = rt;
      $('btn-recenter').hidden = false;
      const strong = $('explore-info').querySelector('strong');
      strong.innerHTML = `<span class="swatch" style="background:${rt._col}"></span>` +
        escapeHtmlApp(rt.name);
      $('explore-hint').textContent = `${formatKm(rt.distance)}${rt.ref ? ' · ' + escapeHtmlApp(rt.ref) : ''} — tik “Volg”`;
      $('explore-follow').disabled = false;
    },

    // Tik op lege kaart tijdens verkennen: keuze wissen, verder kunnen zoeken.
    onExploreDeselect() {
      if (!this._exploreActive) return;
      this._selectedExplore = null;
      $('btn-recenter').hidden = true;
      $('explore-info').querySelector('strong').innerHTML = 'Routes in de buurt';
      const n = MapView.exploreRoutes.length;
      $('explore-hint').textContent = `${n} route${n > 1 ? 's' : ''} — tik er één aan`;
      $('explore-follow').disabled = true;
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

    _routesFromRegions(bounds, freshOnly) {
      // Routes uit opgeslagen regio's die dit gebied overlappen. Met freshOnly
      // tellen enkel recent (<30 dagen) opgehaalde regio's mee (opslag-eerst);
      // zonder telt alles (offline is oude data beter dan geen).
      const cx = (bounds.minLat + bounds.maxLat) / 2, cy = (bounds.minLng + bounds.maxLng) / 2;
      let best = [];
      for (const reg of this._regions) {
        if (freshOnly &&
            Date.now() - new Date(reg.savedAt || 0).getTime() > 30 * 24 * 3600 * 1000) continue;
        const rb = reg.bounds;
        if (cx >= rb.minLat && cx <= rb.maxLat && cy >= rb.minLng && cy <= rb.maxLng) {
          best = best.concat(reg.routes || []);
        }
      }
      // Dubbelen eruit (dezelfde route kan in meerdere regio's/cache zitten).
      const seen = new Set();
      return best.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
    },

    // Knooppunten + horeca uit alle opgeslagen regio's die dit gebied overlappen,
    // gefilterd op het zoekgebied (de landdekkende records zijn véél groter).
    _overlaysFromRegions(bounds) {
      const cx = (bounds.minLat + bounds.maxLat) / 2, cy = (bounds.minLng + bounds.maxLng) / 2;
      const inB = (p) => p.lat >= bounds.minLat && p.lat <= bounds.maxLat &&
        p.lng >= bounds.minLng && p.lng <= bounds.maxLng;
      const nodes = [], horeca = [];
      const seenN = new Set(), seenH = new Set();
      for (const reg of this._regions) {
        const rb = reg.bounds;
        if (!(cx >= rb.minLat && cx <= rb.maxLat && cy >= rb.minLng && cy <= rb.maxLng)) continue;
        for (const n of reg.nodes || []) {
          if (!inB(n)) continue;
          const k = n.ref + '@' + n.lat.toFixed(4) + ',' + n.lng.toFixed(4);
          if (!seenN.has(k)) { seenN.add(k); nodes.push(n); }
        }
        for (const h of reg.horeca || []) {
          if (!inB(h)) continue;
          const k = h.n + '@' + h.lat.toFixed(4) + ',' + h.lng.toFixed(4);
          if (!seenH.has(k)) { seenH.add(k); horeca.push(h); }
        }
      }
      return { nodes, horeca };
    },

    // Meer dan ~400 markers per soort tekent geen enkel scherm vlot; hou de
    // dichtstbijzijnde bij het midden van het zoekgebied.
    _renderAreaOverlays(ov, bounds) {
      const cx = (bounds.minLat + bounds.maxLat) / 2, cy = (bounds.minLng + bounds.maxLng) / 2;
      const CAP = 400;
      const d2 = (p) => (p.lat - cx) * (p.lat - cx) + (p.lng - cy) * (p.lng - cy);
      const cap = (list) => {
        if (list.length <= CAP) return list;
        return list.slice().sort((x, y) => d2(x) - d2(y)).slice(0, CAP);
      };
      MapView.renderExploreOverlays(cap(ov.nodes), cap(ov.horeca));
    },

    // Eenmalig: de meegeleverde knooppunten + horeca van heel België (±2,7 MB)
    // in de lokale opslag zetten. Daarna nooit meer wachten op Overpass hiervoor.
    async _ensureCountryOverlays() {
      if (this._beJob || !navigator.onLine) return;
      if (this._regions.some((r) => r.id === 'be-overlays')) return;
      this._beJob = true;
      try {
        const res = await fetch('data/be-overlays.json');
        if (!res.ok) return;
        const d = await res.json();
        await DB.putRegion({
          id: 'be-overlays', name: 'België: knooppunten & horeca',
          bounds: d.bounds, routes: [], nodes: d.nodes, horeca: d.horeca,
          savedAt: new Date().toISOString(),
        });
        this._regions = await DB.allRegions();
        this.toast('Knooppunten & horeca van heel België offline ✓');
        // Meteen tonen in het lopende zoekbeeld — maar alleen als er echt iets
        // bijkwam (anders wissen we net getekende overlays in een race).
        if ((d.nodes.length || d.horeca.length) && this._exploreActive && this._exploreBounds) {
          this._renderAreaOverlays(this._overlaysFromRegions(this._exploreBounds), this._exploreBounds);
        }
      } catch (_) { /* volgende keer opnieuw */ }
      finally { this._beJob = false; }
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
    async _autoCacheRegion(bounds, routes, overlays) {
      if (!navigator.onLine || !routes.length || this._regionJob) return;
      const cx = (bounds.minLat + bounds.maxLat) / 2, cy = (bounds.minLng + bounds.maxLng) / 2;
      const id = 'region-' + Math.round(cx * 200) + '_' + Math.round(cy * 200);
      const existing = this._regions.find((r) => r.id === id);
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
          nodes: (overlays && overlays.nodes) || [],
          horeca: (overlays && overlays.horeca) || [],
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
      const waar = MapView.exploreMode ? 'in dit gebied' : 'op deze route';
      $('ov-nodes-count').textContent = nc != null ? `(${nc} ${waar})` : '';
      $('ov-horeca-count').textContent = hc != null ? `(${hc} ${MapView.exploreMode ? 'in dit gebied' : 'in de buurt'})` : '';
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
      $('btn-gpx').addEventListener('click', () => $('gpx-file').click());
      $('gpx-file').addEventListener('change', (e) => {
        if (e.target.files.length) this.loadFromFile(e.target.files[0]);
        e.target.value = '';
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
        // Expliciet opnieuw zoeken: wis de vorige keuze en haal vers op via het
        // netwerk (force), ook als er al opgeslagen routes voor dit gebied zijn.
        this._selectedExplore = null;
        $('explore-follow').disabled = true;
        $('btn-recenter').hidden = true;
        $('explore-info').querySelector('strong').innerHTML = 'Routes in de buurt';
        this._exploreFetch(true);
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
