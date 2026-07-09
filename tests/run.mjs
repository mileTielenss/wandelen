/* Testsuite voor de Wandelen-PWA.
   - Unit-tests (pure logica, in de browser uitgevoerd)
   - E2E-tests voor elk scherm en elke flow (Playwright, gemockte externe services)
   - JS-coverage-rapport over js/*.js

   Draaien:  npm test
   Vereist:  Chromium (pad via $CHROME_PATH, anders Playwright-standaardlocatie). */

import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8199;
const BASE = `http://localhost:${PORT}`;
const CHROME =
  process.env.CHROME_PATH ||
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome']
    .find((p) => existsSync(p));

const TOUR = readFileSync(path.join(ROOT, 'tests/fixtures/tour.json'));
const LWN = readFileSync(path.join(ROOT, 'tests/fixtures/lwn.json'));
const TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);
const isOverpassHost = (u) => /overpass/.test(u.host);
const KOMOOT_URL =
  'https://www.komoot.com/nl-NL/tour/3096182502?ref=itd&share_token=aXx6nN2IJLfoOxE73lbsY981p3AN5PCoupTwbpWfjbXA0fgXPd';

/* ---------- statische server ---------- */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, BASE).pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});

/* ---------- assert-boekhouding ---------- */
let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log('  ✗', name, extra); }
}
const txt = async (page, sel) => ((await page.textContent(sel).catch(() => '')) || '').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- coverage ---------- */
const cov = new Map(); // url -> {len, bytes: Uint8Array}
function addCoverage(entries) {
  for (const e of entries) {
    if (!e.url.startsWith(BASE + '/js/')) continue;
    const src = e.source || '';
    const local = new Uint8Array(src.length);
    const ranges = [];
    for (const f of e.functions || []) for (const r of f.ranges || []) ranges.push(r);
    // Buitenste ranges eerst, binnenste overschrijven — benadert v8-semantiek.
    ranges.sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    for (const r of ranges) local.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, src.length));
    let agg = cov.get(e.url);
    if (!agg) { agg = { len: src.length, bytes: new Uint8Array(src.length) }; cov.set(e.url, agg); }
    for (let i = 0; i < Math.min(agg.len, local.length); i++) if (local[i]) agg.bytes[i] = 1;
  }
}

/* ---------- scenario-harnas ---------- */
let browser;
async function scenario(name, opts, fn) {
  console.log(`\n▶ ${name}`);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(opts.ctx || {}) });
  // Let op: op HOST matchen, anders onderschept /overpass/ ook onze eigen js/overpass.js.
  await context.route((u) => /cartocdn\.com|arcgisonline\.com|opentopomap\.org/.test(u.host), (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
  if (!opts.noOverpass) {
    await context.route(isOverpassHost, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: opts.overpassBody || LWN }));
  }
  if (!opts.noKomoot) {
    await context.route((u) => u.host === 'api.komoot.de', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: TOUR,
    }));
  }
  const page = await context.newPage();
  if (opts.init) await page.addInitScript(opts.init);
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  try { await fn(page, context); }
  catch (e) { t(`${name} — scenario voltooid`, false, e.message.slice(0, 180)); }
  try { addCoverage(await page.coverage.stopJSCoverage()); } catch (_) {}
  t(`${name} — geen JS-fouten`, errs.length === 0, errs.join(' | ').slice(0, 180));
  await context.close();
}

async function open(page) {
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.route-card', { timeout: 10000 });
}

// Markeer de default route als al-gecachet zodat de auto-tegeldownload niet stoort.
async function markCached(page) {
  await page.evaluate(async () => {
    const r = await DB.get('komoot-3096182502');
    if (r) { r.tileMaps = ['voyager', 'satellite', 'topo']; r.tilesCached = true; await DB.put(r); }
  });
}

/* ================================================================== */
server.listen(PORT);
browser = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });

/* ---------- S1: unit-tests (pure logica) ---------- */
await scenario('S1 unit-tests', {}, async (page) => {
  await open(page);
  const results = await page.evaluate(() => {
    const out = [];
    const ok = (n, c, x = '') => out.push([n, !!c, String(x)]);

    // Komoot.parseUrl
    const p1 = Komoot.parseUrl('https://www.komoot.com/nl-nl/tour/123456?share_token=abC12&x=1');
    ok('parseUrl: id + share_token', p1 && p1.id === '123456' && p1.shareToken === 'abC12', JSON.stringify(p1));
    const p2 = Komoot.parseUrl('987654321');
    ok('parseUrl: kaal id', p2 && p2.id === '987654321' && p2.shareToken === null);
    ok('parseUrl: rommel → null', Komoot.parseUrl('hallo wereld') === null);
    ok('parseUrl: leeg → null', Komoot.parseUrl('') === null);
    ok('parseUrl: zonder token', (Komoot.parseUrl('https://komoot.com/tour/42424242') || {}).shareToken === null);

    // Geo
    const route = [[51.0, 5.0], [51.0, 5.01]];
    const cum = Geo.buildCum(route);
    ok('haversine: 0.001° lat ≈ 111 m', Math.abs(Geo.haversineM([51, 5], [51.001, 5]) - 111.2) < 2);
    ok('buildCum: stijgend', cum[0] === 0 && cum[1] > 600 && cum[1] < 800, cum[1]);
    const mid = Geo.projectOnRoute(51.0005, 5.005, route, cum);
    ok('projectOnRoute: halverwege ≈ 50%', Math.abs(mid.alongM - cum[1] / 2) < cum[1] * 0.05, mid.alongM);
    ok('projectOnRoute: dwarsafstand ≈ 56 m', Math.abs(mid.dist - 55.6) < 4, mid.dist);
    const start = Geo.projectOnRoute(51.0, 5.0, route, cum);
    ok('projectOnRoute: op start → along 0', start.alongM < 1 && start.dist < 1);
    ok('projectOnRoute: lege route → Infinity', Geo.projectOnRoute(51, 5, [], []).dist === Infinity);
    ok('nearestDistance: punt op lijn ≈ 0', Geo.nearestDistanceMeters(51.0, 5.005, route) < 1);
    const seg = Geo.segProject(51.001, 5.005, [51, 5], [51, 5.01]);
    ok('segProject: t = 0.5 midden', Math.abs(seg.t - 0.5) < 0.01, seg.t);
    ok('segProject: nul-segment', Geo.segProject(51, 5, [51, 5], [51, 5]).dist < 1);
    ok('minDistToSegments', Geo.minDistToSegments([51.0005, 5.005], [route]) < 60);

    // Overpass helpers
    const C = Overpass._test.colourToHex;
    ok('colour: named', C('red', null) === '#dc2626');
    ok('colour: NL naam', C('rood', null) === '#dc2626');
    ok('colour: hex passthrough', C('#aabbcc', null) === '#aabbcc');
    ok('colour: samengesteld white-red', C('white-red', null) === '#d1d5db');
    ok('colour: uit osmc', C(null, 'blue:white:blue_bar') === '#2563eb');
    ok('colour: onbekend → null', C('fuchsia-achtig', null) === null && C(null, null) === null);

    const st = Overpass._test.stitch([
      [[0, 0], [0, 1]],
      [[0, 2], [0, 1]],           // omgekeerd aansluitend op staart
      [[9, 9], [9, 8]],           // los segment: blijft eruit
    ]);
    ok('stitch: rijgt + keert om', st.length === 3 && st[0][1] === 0 && st[2][1] === 2, JSON.stringify(st));
    ok('stitch: leeg → leeg', Overpass._test.stitch([]).length === 0);

    const pr = Overpass._test.parseRoutes({ elements: [{
      type: 'relation', id: 7, tags: { name: 'Test', colour: 'red' },
      members: [{ type: 'way', geometry: [{ lat: 51, lon: 5 }, { lat: 51.001, lon: 5 }] }],
    }, { type: 'relation', id: 8, tags: {}, members: [] }] });
    ok('parseRoutes: relatie → route', pr.length === 1 && pr[0].id === 'osm-7' && pr[0].colour === '#dc2626'
      && pr[0].distance > 100 && pr[0].distance < 130, JSON.stringify(pr[0] && pr[0].distance));

    const pv = Overpass._test.parse({ elements: [
      { type: 'node', lat: 51, lon: 5, tags: { rwn_ref: '71' } },
      { type: 'node', lat: 51, lon: 5, tags: { rwn_ref: '71' } },   // dubbel → 1×
      { type: 'node', lat: 51.1, lon: 5.1, tags: { amenity: 'cafe', name: 'De Kroon' } },
      { type: 'way', center: { lat: 51.2, lon: 5.2 }, tags: { amenity: 'restaurant' } },
    ] });
    ok('parse: knooppunt gededupliceerd', pv.nodes.length === 1 && pv.nodes[0].ref === '71');
    ok('parse: horeca incl. way-center', pv.horeca.length === 2 && pv.horeca[0].n === 'De Kroon');

    ok('buildQuery bevat bbox', Overpass._test.buildQuery({ minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 }).includes('(1,2,3,4)'));
    const bc = Overpass.boundsFromCenter(51, 5, 1000);
    ok('boundsFromCenter ≈ ±0.009°', Math.abs((bc.maxLat - bc.minLat) - 0.01797) < 0.001);
    const bf = Overpass.boundsFromCoords([[51, 5, 0], [51.1, 5.1, 0]]);
    ok('boundsFromCoords met marge', bf.minLat < 51 && bf.maxLat > 51.1);

    // Tiles
    ok('planTiles > 0', Tiles.planTiles([[51.23, 5.32, 0], [51.24, 5.33, 0]], 'overview').length > 0);
    const es = Tiles.estimate([[51.23, 5.32, 0]], 'overview');
    ok('estimate: count & mb', es.count > 0 && es.mb > 0);
    ok('planBBox > planTiles-punt', Tiles.planBBox({ minLat: 51.2, minLng: 5.3, maxLat: 51.25, maxLng: 5.35 }, 'overview').length > 9);
    ok('estimateBBox mb > 0', Tiles.estimateBBox({ minLat: 51.2, minLng: 5.3, maxLat: 51.21, maxLng: 5.31 }, 'normal').mb > 0);
    ok('urlFor: substitutie', Tiles.urlFor(Tiles.getBasemap('voyager'), 1, 2, 3).endsWith('/3/1/2@2x.png'));
    ok('getBasemap: fallback op onbekend', Tiles.getBasemap('bestaat-niet').key === 'voyager');
    ok('detail fine ⊃ z18, topo geknipt op 17',
      Tiles.planTiles([[51.23, 5.32, 0]], 'fine', 'topo').every((t2) => t2.z <= 17));
    return out;
  });
  for (const [n, c, x] of results) t('unit: ' + n, c, x);

  const cache = await page.evaluate(async () => {
    await (await caches.open(Tiles.CACHE_NAME)).put('https://a.basemaps.cartocdn.com/x', new Response('t'));
    const n0 = await Tiles.cacheSize();
    await Tiles.clearAll();
    return { n0, n1: await Tiles.cacheSize() };
  });
  t('unit: cacheSize telt + clearAll leegt', cache.n0 === 1 && cache.n1 === 0, JSON.stringify(cache));
});

/* ---------- S2: startscherm + hernoemen/verwijderen ---------- */
await scenario('S2 startscherm & routebeheer', {}, async (page) => {
  await open(page);
  t('default route geseed', (await txt(page, '.route-card .name')) === 'from Lommel to Grote Heide');
  const secs = await page.$$eval('.section-title', (els) => els.map((e) => e.textContent.trim()));
  t('sectiekoppen aanwezig', secs.includes('Komoot-URL inladen') && secs.includes('Opgeslagen wandelingen'), secs.join(','));
  t('verkenknop netjes', (await txt(page, '#btn-explore')).includes('Nieuwe wandeling'));
  t('regio-knop bestaat niet meer', (await page.$('#explore-region')) === null);
  t('tegel-sheet bestaat niet meer', (await page.$('#tile-overlay')) === null);
  t('statuslampjes idle: internet uit + gps uit', (await txt(page, '#statusbar-list')).includes('internet uit'));

  // about-overlay
  await page.click('#btn-about');
  t('about zichtbaar', await page.isVisible('#about-overlay'));
  await page.click('#about-close');
  t('about dicht', await page.isHidden('#about-overlay'));

  // hernoemen via kebab
  await page.click('.route-card .kebab');
  await page.fill('#rename-input', 'Mijn lus');
  await page.click('#menu-save');
  await sleep(300);
  t('hernoemd', (await txt(page, '.route-card .name')) === 'Mijn lus');

  // lang indrukken opent menu (touch), annuleren sluit
  await page.dispatchEvent('.route-card', 'touchstart');
  await sleep(700);
  t('lang indrukken → menu', await page.isVisible('#menu-overlay'));
  await page.click('#menu-cancel');
  await page.dispatchEvent('.route-card', 'touchstart');
  await page.dispatchEvent('.route-card', 'touchmove'); // beweging annuleert
  await sleep(700);
  t('touchmove annuleert lang indrukken', await page.isHidden('#menu-overlay'));

  // verwijderen (confirm accepteren)
  page.on('dialog', (d) => d.accept());
  await page.click('.route-card .kebab');
  await page.click('#menu-delete');
  await sleep(400);
  t('route verwijderd → lege staat', await page.isVisible('#list-empty'));
});

/* ---------- S3: Komoot-import (alle paden) ---------- */
await scenario('S3 Komoot-import', {}, async (page) => {
  await open(page);
  // ongeldige URL
  await page.fill('#url-input', 'https://voorbeeld.be/geen-tour');
  await page.click('#btn-load');
  await sleep(400);
  t('ongeldige URL → foutmelding', (await txt(page, '#load-status')).includes('Mislukt'));
  // lege input
  await page.fill('#url-input', '');
  await page.click('#btn-load');
  t('lege input → hint', (await txt(page, '#load-status')).includes('Plak eerst'));
  // geldige import van bestaande tour → bijgewerkt + geopend
  await page.fill('#url-input', KOMOOT_URL);
  await page.click('#btn-load');
  await page.waitForSelector('#screen-map.is-active', { timeout: 15000 });
  t('import opent de route op de kaart', (await txt(page, '#map-route-name')).includes('Lommel'));
  t('toast meldt bijwerken', (await txt(page, '#toast')).includes('bijgewerkt'));
});

await scenario('S3b import via ?url= + proxy-fallback', { noKomoot: true }, async (page, context) => {
  // Directe API faalt → corsproxy-fallback levert de tour
  await context.route((u) => u.host === 'api.komoot.de', (r) => r.fulfill({ status: 500, body: 'nee' }));
  await context.route((u) => /corsproxy\.io|allorigins/.test(u.host), (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: TOUR }));
  await page.goto(BASE + '/index.html?url=' + encodeURIComponent(KOMOOT_URL), { waitUntil: 'networkidle' });
  await page.waitForSelector('#screen-map.is-active', { timeout: 20000 });
  t('?url= import via proxy-fallback werkt', (await txt(page, '#map-route-name')).includes('Lommel'));
});

await scenario('S3c import: alles faalt', { noKomoot: true }, async (page, context) => {
  await context.route((u) => /api\.komoot\.de|corsproxy\.io|allorigins/.test(u.host), (r) => r.fulfill({ status: 500, body: 'nee' }));
  await open(page);
  await page.fill('#url-input', KOMOOT_URL);
  await page.click('#btn-load');
  await page.waitForFunction(() => /Mislukt/.test(document.getElementById('load-status').textContent), null, { timeout: 20000 });
  t('duidelijke foutmelding', (await txt(page, '#load-status')).includes('Controleer de URL'));
});

/* ---------- S4: kaart, overlays, kaartlagen ---------- */
await scenario('S4 kaart & overlays & lagen', {}, async (page) => {
  await open(page);
  await markCached(page);
  await page.click('.route-card');
  await sleep(1200);
  t('routelijn getekend', await page.$eval('#map', (el) => !!el.querySelector('.leaflet-overlay-pane path')));
  t('knooppunt-badges', (await page.$$('.kp-badge')).length > 5);
  const emoji = await page.$eval('.horeca-pin', (el) => el.textContent);
  t('horeca-pins met ☕', emoji === '☕');
  t('meta toont afstand + punten', (await txt(page, '#map-route-meta')).includes('km'));

  // kaartlagen-sheet
  await page.click('#btn-layers');
  t('tellingen in sheet', (await txt(page, '#ov-nodes-count')).includes('op deze route'));
  await page.check('input[name="basemap"][value="satellite"]');
  await sleep(600);
  const src = await page.$eval('#map img.leaflet-tile', (el) => el.src);
  t('satelliet-tegels actief', src.includes('arcgisonline'), src.slice(0, 60));
  await page.check('input[name="basemap"][value="topo"]');
  await sleep(600);
  t('topo-tegels actief', (await page.$eval('#map img.leaflet-tile', (el) => el.src)).includes('opentopomap'));
  await page.uncheck('#ov-nodes');
  await page.uncheck('#ov-horeca');
  await sleep(300);
  t('overlays verborgen', (await page.$$('.kp-badge')).length === 0 && (await page.$$('.horeca-pin')).length === 0);
  await page.click('#layers-close');

  // voorkeuren overleven herladen
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.route-card');
  await page.click('.route-card');
  await sleep(1000);
  t('voorkeur kaartlaag bewaard', (await page.$eval('#map img.leaflet-tile', (el) => el.src)).includes('opentopomap'));
  t('voorkeur overlays-uit bewaard', (await page.$$('.kp-badge')).length === 0);

  // recenter + terug
  await page.click('#btn-recenter');
  await page.click('#btn-back');
  t('terug op lijst', await page.isVisible('#screen-list.is-active'));
});

/* ---------- S5: locatie (eenmalig) + voortgang + lampjes ---------- */
await scenario('S5 locatie & voortgang', {
  ctx: { geolocation: { latitude: 51.234514, longitude: 5.321518 }, permissions: ['geolocation'] },
}, async (page, context) => {
  await open(page);
  await markCached(page);
  await page.click('.route-card');
  await sleep(800);
  await page.click('#btn-locate');
  await page.waitForSelector('.loc-dot', { timeout: 10000 });
  t('blauwe stip (niet tracking)', await page.$eval('.loc-dot', (el) => !el.classList.contains('tracking')));
  const banner = await txt(page, '#offroute-banner');
  t('banner: op de route + voortgang', banner.includes('Op de route') && banner.includes('km') && banner.includes('%'), banner);
  await sleep(400);
  t('gps-lampje weer uit na meting', (await txt(page, '#statusbar-map')).includes('gps uit'));

  // off-route locatie
  await context.setGeolocation({ latitude: 51.265, longitude: 5.362 });
  await page.click('#btn-locate');
  await page.waitForFunction(() => /van de route/.test(document.getElementById('offroute-banner').textContent), null, { timeout: 10000 });
  const b2 = await txt(page, '#offroute-banner');
  t('banner: naast de route + dichtstbij', b2.includes('van de route') && b2.includes('dichtstbij'), b2);
});

await scenario('S5b locatie-fout (time-out)', {
  init: `navigator.geolocation.getCurrentPosition = (ok, err) => setTimeout(() => err({ code: 3, message: 'timeout' }), 50);`,
}, async (page) => {
  await open(page);
  await markCached(page);
  await page.click('.route-card');
  await sleep(600);
  await page.click('#btn-locate');
  await sleep(600);
  t('toast meldt time-out', (await txt(page, '#toast')).includes('time-out'));
  t('gps-lampje uit na fout', (await txt(page, '#statusbar-map')).includes('gps uit'));
});

/* ---------- S6: tracking (incl. rode-bol-regressie) ---------- */
await scenario('S6 tracking & rode-bol-bug', {
  ctx: { geolocation: { latitude: 51.234514, longitude: 5.321518 }, permissions: ['geolocation'] },
}, async (page) => {
  await open(page);
  await markCached(page);
  await page.click('.route-card');
  await sleep(800);
  await page.click('#btn-track');
  await page.waitForSelector('.loc-dot.tracking', { timeout: 10000 });
  t('rode stip tijdens tracking', true);
  t('HUD zichtbaar', await page.isVisible('#track-hud'));
  t('lampje: gps volgt', (await txt(page, '#statusbar-map')).includes('gps volgt'));
  t('HUD toont voortgang', (await txt(page, '#track-text')).includes('km'));
  // scherm-aan-optie aan/uit (wakeLock-paden)
  await page.check('#chk-awake'); await sleep(200); await page.uncheck('#chk-awake');
  // stop → REGRESSIE: stip moet terug blauw
  await page.click('#btn-track-stop');
  await sleep(400);
  t('REGRESSIE: stip blauw na stop', await page.$eval('.loc-dot', (el) => !el.classList.contains('tracking')));
  t('lampje: gps uit na stop', (await txt(page, '#statusbar-map')).includes('gps uit'));
  t('HUD weg na stop', await page.isHidden('#track-hud'));
  // opnieuw starten en stoppen via de ➤-knop zelf
  await page.click('#btn-track');
  await page.waitForSelector('.loc-dot.tracking', { timeout: 10000 });
  await page.click('#btn-track');
  await sleep(300);
  t('➤-knop togglet tracking uit', await page.$eval('.loc-dot', (el) => !el.classList.contains('tracking')));
});

await scenario('S6b tracking geweigerd', {
  init: `navigator.geolocation.watchPosition = (ok, err) => { setTimeout(() => err({ code: 1, message: 'denied' }), 50); return 99; };`,
}, async (page) => {
  await open(page);
  await markCached(page);
  await page.click('.route-card');
  await sleep(600);
  await page.click('#btn-track');
  await sleep(600);
  t('toast: geweigerd + gestopt', (await txt(page, '#toast')).includes('geweigerd'));
  t('lampje: gps geweigerd', (await txt(page, '#statusbar-map')).includes('gps geweigerd'));
  t('HUD niet zichtbaar', await page.isHidden('#track-hud'));
});

/* ---------- S7: verkennen + volgen + regio-autocache ---------- */
await scenario('S7 verkennen & volgen', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.41 }, permissions: ['geolocation'] },
}, async (page) => {
  await open(page);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('routes gevonden', (await txt(page, '#explore-hint')).match(/\d+ routes/) !== null);
  const nPaths = (await page.$$('#map .leaflet-overlay-pane path')).length;
  t('routes getekend', nPaths > 3, String(nPaths));

  // brede raakzone aanwezig (onzichtbare dikke lijnen onder elke route)
  const hasHit = await page.evaluate(() => {
    const grp = MapView._exploreLayers[Object.keys(MapView._exploreLayers)[0]];
    let hit = false; grp.eachLayer((l) => { if (l.options._hit && l.options.weight >= 20) hit = true; });
    return hit;
  });
  t('brede raakzone per route', hasHit);

  // tik NAAST een route (kaart-klik) selecteert de dichtstbijzijnde
  await page.evaluate(() => {
    const rt = MapView.exploreRoutes[0];
    const p = rt.segments[0][0];
    MapView.map.setView(p, 15);
    // ~40 m naast de lijn tikken
    MapView.map.fire('click', { latlng: L.latLng(p[0] + 0.00035, p[1]) });
  });
  await sleep(300);
  t('tik naast route selecteert (tolerantie)', await page.evaluate(() => MapView.selectedExploreId !== null));
  t('keuze toont naam + afstand', (await txt(page, '#explore-info')).includes('km'));
  t('Volg-knop actief', await page.$eval('#explore-follow', (el) => !el.disabled));

  // 'Zoek hier' met identiek resultaat mag de laag NIET hertekenen (tik blijft raak)
  await page.evaluate(() => { window.__gid = MapView.exploreGroup._leaflet_id; });
  await page.click('#explore-search');
  await page.waitForFunction(() => !document.getElementById('explore-search').disabled, null, { timeout: 20000 });
  const preserved = await page.evaluate(() => MapView.exploreGroup._leaflet_id === window.__gid);
  t('identiek resultaat → geen hertekening', preserved);
  // herselecteer voor het vervolg (zoeken wist de keuze bewust)
  await page.evaluate(() => MapView.selectExplore(Object.keys(MapView._exploreLayers)[0]));
  await sleep(200);

  // regio-autocache: gebied offline opgeslagen zonder knop
  await page.waitForFunction(() => /Gebied offline opgeslagen/.test(document.getElementById('toast').textContent), null, { timeout: 60000 });
  const regs = await page.evaluate(async () => (await DB.allRegions()).map((r) => r.id));
  t('regio automatisch opgeslagen', regs.some((id) => id.startsWith('region-')), regs.join(','));

  // volg → route bewaard + geopend als gewone route
  await page.click('#explore-follow');
  await page.waitForFunction(() => !document.getElementById('explore-bar') || document.getElementById('explore-bar').hidden, null, { timeout: 15000 });
  await sleep(600);
  t('gevolgde route geopend', !(await txt(page, '#map-route-name')).includes('Nieuwe wandeling'));
  await page.click('#btn-back');
  await sleep(400);
  const names = await page.$$eval('.route-card .name', (els) => els.map((e) => e.textContent));
  t('gevolgde route in lijst', names.length === 2, names.join(','));

  // heropenen: cache toont meteen resultaat
  await page.click('#btn-explore');
  await sleep(250);
  t('cache: meteen routes zichtbaar', (await txt(page, '#explore-hint')).includes('routes'), await txt(page, '#explore-hint'));
});

await scenario('S7b verkennen offline (regio-fallback, dedup)', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.41 }, permissions: ['geolocation'] },
}, async (page, context) => {
  await open(page);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => /Gebied offline/.test(document.getElementById('toast').textContent), null, { timeout: 60000 });
  await page.click('#btn-back');
  // offline: explore-cache én regio bevatten dezelfde routes → geen dubbelen
  await context.setOffline(true);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /routes/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  const hint = await txt(page, '#explore-hint');
  const n = parseInt(hint, 10);
  const unique = await page.evaluate(async () => {
    const regs = await DB.allRegions();
    return new Set(regs.flatMap((r) => (r.routes || []).map((x) => x.id))).size;
  });
  t('offline verkennen uit opslag, gededupliceerd', n === unique, `hint=${hint} uniek=${unique}`);
  t('offline-lampje brandt', (await txt(page, '#statusbar-map')).includes('offline'));
});

await scenario('S7c verkennen: hedged mirrors + bbox-klem', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.41 }, permissions: ['geolocation'] },
  noOverpass: true,
}, async (page, context) => {
  let capturedBody = '';
  await context.route((u) => u.host === 'overpass.kumi.systems', () => { /* hangt */ });
  await context.route((u) => /overpass-api\.de|overpass\.private\.coffee/.test(u.host), (r) => {
    capturedBody = r.request().postData() || '';
    r.fulfill({ status: 200, contentType: 'application/json', body: LWN });
  });
  await open(page);
  const t0 = Date.now();
  await page.click('#btn-explore');
  await page.waitForFunction(() => /tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 25000 });
  t('hedged: resultaat < 9 s ondanks hangende mirror', Date.now() - t0 < 9000, `${Date.now() - t0} ms`);
  // uitzoomen → zoekgebied geklemd
  await page.evaluate(() => MapView.map.setZoom(9));
  await sleep(500);
  await page.click('#explore-search');
  await page.waitForFunction(() => !document.getElementById('explore-search').disabled, null, { timeout: 25000 });
  const m = decodeURIComponent(capturedBody).match(/\((\d+\.\d+),(\d+\.\d+),(\d+\.\d+),(\d+\.\d+)\)/);
  t('bbox geklemd tot ±0.16°', m && (+m[3] - +m[1]) < 0.2, m && (+m[3] - +m[1]).toFixed(3));
});

await scenario('S7d verkennen: niets gevonden + netwerkfout', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.41 }, permissions: ['geolocation'] },
  overpassBody: '{"elements":[]}',
}, async (page, context) => {
  await open(page);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /geen bewegwijzerde/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('lege uitslag netjes gemeld', true);
  // alle mirrors kapot → nette fout (geen regio's opgeslagen in deze context)
  // Later geregistreerde routes krijgen voorrang op de harnas-mock.
  await context.route(isOverpassHost, (r) => r.fulfill({ status: 500, body: 'kapot' }));
  await page.click('#explore-search');
  await page.waitForFunction(() => /kon routes niet laden/.test(document.getElementById('explore-hint').textContent), null, { timeout: 30000 });
  t('netwerkfout netjes gemeld', true);
});

/* ---------- S8: auto-tegelcache + volledig offline ---------- */
await scenario('S8 auto-cache & offline herstart', {}, async (page, context) => {
  await open(page);
  await page.click('.route-card');
  await page.waitForFunction(() => /offline opgeslagen/.test(document.getElementById('toast').textContent), null, { timeout: 120000 });
  const marked = await page.evaluate(async () => {
    const r = await DB.get('komoot-3096182502');
    return { cached: r.tilesCached, maps: r.tileMaps, detail: r.tileDetail };
  });
  t('route gemarkeerd als gecachet (fine)', marked.cached && marked.detail === 'fine' && marked.maps.includes('voyager'), JSON.stringify(marked));
  const nTiles = await page.evaluate(async () => (await (await caches.open('wandelen-tiles-v1')).keys()).length);
  t('tegels in Cache Storage', nTiles > 500, String(nTiles));
  // tweede keer openen → geen nieuwe download (tileMaps bevat basemap al)
  await page.click('#btn-back'); await sleep(300);
  await page.click('.route-card'); await sleep(800);
  t('geen her-download bij tweede keer', (await txt(page, '#statusbar-map')).includes('internet uit') || !(await txt(page, '#statusbar-map')).includes('kaart ⬇'));
  await page.click('#btn-back');

  // service worker actief → volledig offline herladen
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.route-card', { timeout: 10000 });
  t('offline herladen: lijst werkt (SW)', true);
  await page.click('.route-card');
  await sleep(1500);
  t('offline: routelijn', await page.$eval('#map', (el) => !!el.querySelector('.leaflet-overlay-pane path')));
  const loaded = (await page.$$('#map .leaflet-tile-loaded')).length;
  t('offline: tegels uit cache', loaded > 3, String(loaded));
});

/* ---------- S9: statuslampjes-levenscyclus ---------- */
await scenario('S9 statuslampjes', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.41 }, permissions: ['geolocation'] },
  noOverpass: true,
}, async (page, context) => {
  await context.route(isOverpassHost, async (r) => {
    await sleep(2000);
    r.fulfill({ status: 200, contentType: 'application/json', body: LWN });
  });
  await open(page);
  t('idle: internet uit', (await txt(page, '#statusbar-list')).includes('internet uit'));
  await page.click('#btn-explore');
  await sleep(1200);
  t('bezig: internet actief', (await txt(page, '#statusbar-map')).includes('internet actief'));
  await page.waitForFunction(() => /tik er één aan|geen/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('statusbar-map').textContent.includes('internet uit'), null, { timeout: 60000 });
  t('klaar: internet weer uit', true);
  // visibilitychange-pad
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  t('visibilitychange verwerkt', true);
});

/* ================================================================== */
await browser.close();
server.close();

/* ---------- coverage-rapport ---------- */
console.log('\n──────── COVERAGE (js/*.js) ────────');
let totC = 0, totL = 0;
const rows = [...cov.entries()].sort();
for (const [url, { len, bytes }] of rows) {
  let c = 0;
  for (let i = 0; i < len; i++) c += bytes[i];
  totC += c; totL += len;
  console.log(`  ${(url.replace(BASE + '/', '')).padEnd(18)} ${(100 * c / len).toFixed(1).padStart(5)}%  (${c}/${len} bytes)`);
}
console.log(`  ${'TOTAAL'.padEnd(18)} ${totL ? (100 * totC / totL).toFixed(1) : '0'}%`);
console.log('  (sw.js draait in een worker en valt buiten page-coverage; offline-gedrag is functioneel getest in S8.)');

console.log(`\n──────── RESULTAAT: ${pass} geslaagd, ${fail} gefaald ────────`);
if (failures.length) { console.log('Gefaald:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
