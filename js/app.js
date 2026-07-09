/* Hoofdlogica: schermen, routelijst, importeren, hernoemen, offline tegels. */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let _routes = [];
  let _current = null;      // geopende route op de kaart
  let _menuRoute = null;    // route in het hernoem/verwijder-menu
  let _tileAbort = null;

  const App = {
    async init() {
      this.registerSW();
      MapView.init((mode) => this._onMapMode(mode));
      this._wire();
      await this.seedDefault();
      await this.refreshList();
      this._handleSharedUrl();
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
          route.name = existing.name;          // behoud eigen naam
          route.tilesCached = existing.tilesCached;
          route.tileDetail = existing.tileDetail;
        }
        await DB.put(route);
        input.value = '';
        this.setLoadStatus(`“${route.name}” ingeladen ✓`, 'ok');
        await this.refreshList();
        setTimeout(() => this.setLoadStatus('', ''), 3500);
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

    // ---------- Offline tegels ----------
    openTileSheet() {
      if (!_current) return;
      this._updateTileEstimate();
      $('tile-progress').hidden = true;
      $('tile-progress-text').textContent = '0%';
      $('tile-bar-fill').style.width = '0%';
      $('tile-start').disabled = false;
      $('tile-start').textContent = 'Downloaden';
      this._show('tile-overlay');
    },
    _updateTileEstimate() {
      const detail = $('tile-detail').value;
      const est = Tiles.estimate(_current.coords, detail);
      $('tile-estimate').textContent =
        `± ${est.count} tegels · ongeveer ${est.mb} MB. Doe dit met wifi.`;
    },
    async startTileDownload() {
      if (!_current) return;
      const detail = $('tile-detail').value;
      $('tile-progress').hidden = false;
      $('tile-start').disabled = true;
      $('tile-cancel').textContent = 'Stop';
      _tileAbort = new AbortController();
      try {
        const result = await Tiles.download(
          _current.coords, detail,
          (done, total) => {
            const pct = Math.round((done / total) * 100);
            $('tile-bar-fill').style.width = pct + '%';
            $('tile-progress-text').textContent = `${pct}% (${done}/${total})`;
          },
          _tileAbort.signal
        );
        if (!result.cancelled) {
          _current.tilesCached = true;
          _current.tileDetail = detail;
          await DB.put(_current);
          await this.refreshList();
          this.toast(`Kaart offline opgeslagen (${result.ok} tegels)`);
          this._hide('tile-overlay');
        } else {
          this.toast('Download gestopt');
        }
      } catch (e) {
        this.toast('Download mislukt');
      } finally {
        _tileAbort = null;
        $('tile-cancel').textContent = 'Sluiten';
        $('tile-start').disabled = false;
      }
    },
    cancelTile() {
      if (_tileAbort) { _tileAbort.abort(); return; }
      this._hide('tile-overlay');
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

      $('btn-tiles').addEventListener('click', () => this.openTileSheet());
      $('tile-detail').addEventListener('change', () => this._updateTileEstimate());
      $('tile-start').addEventListener('click', () => this.startTileDownload());
      $('tile-cancel').addEventListener('click', () => this.cancelTile());

      $('menu-save').addEventListener('click', () => this.saveMenu());
      $('menu-cancel').addEventListener('click', () => this._hide('menu-overlay'));
      $('menu-delete').addEventListener('click', () => this.deleteMenu());

      // Overlays sluiten bij tik op achtergrond
      for (const id of ['menu-overlay', 'about-overlay']) {
        $(id).addEventListener('click', (e) => { if (e.target.id === id) this._hide(id); });
      }

      // Scherm-wakelock opnieuw aanvragen na terugkeer (indien actief gewenst)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && $('chk-awake').checked) {
          MapView.requestWake();
        }
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
