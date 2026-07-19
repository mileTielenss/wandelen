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

// Query-bewuste Overpass-mock: beantwoordt de drie querytypes (lijst / geometrie
// per id / overlays) uit één dataset, zodat progressief laden juiste tellingen geeft.
function overpassHandler(datasetStr) {
  const dataset = JSON.parse(datasetStr.toString());
  const rels = (dataset.elements || []).filter((e) => e.type === 'relation');
  const pts = (dataset.elements || []).filter((e) => e.type !== 'relation');
  return (r) => {
    const q = decodeURIComponent((r.request().postData() || '').replace(/^data=/, ''));
    let els;
    const idm = q.match(/rel\(id:([\d,]+)\)/);
    if (idm) { const ids = new Set(idm[1].split(',').map(Number)); els = rels.filter((e) => ids.has(e.id)); }
    else if (/out center/.test(q)) els = pts;
    else els = rels;
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements: els }) });
  };
}
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
  const _t0 = Date.now();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...(opts.ctx || {}) });
  // Let op: op HOST matchen, anders onderschept /overpass/ ook onze eigen js/overpass.js.
  await context.route((u) => /cartocdn\.com|arcgisonline\.com|opentopomap\.org/.test(u.host), (r) =>
    r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
  if (!opts.noOverpass) {
    // De app doet nu drie soorten Overpass-queries (progressief laden):
    //  · lijst    `…;out tags qt;`      → relaties met tags (geen geometrie nodig)
    //  · geometrie `rel(id:…);out geom` → enkel de gevraagde relaties, mét geometrie
    //  · overlays  `…;out center qt;`   → knooppunten + horeca
    // Deze mock beantwoordt elk type uit één dataset, zodat tellingen kloppen.
    const handler = opts.overpassBody != null
      ? (r) => r.fulfill({ status: 200, contentType: 'application/json', body: opts.overpassBody })
      : overpassHandler(opts.overpassData || LWN);
    await context.route(isOverpassHost, handler);
  }
  if (!opts.noKomoot) {
    await context.route((u) => u.host === 'api.komoot.de', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' }, body: TOUR,
    }));
  }
  if (!opts.realCountry) {
    // Landdekkende overlays leeg mocken zodat scenario-tellingen deterministisch blijven.
    await context.route((u) => u.pathname.endsWith('/data/be-overlays.json'), (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: '{"bounds":{"minLat":49.45,"minLng":2.5,"maxLat":51.6,"maxLng":6.5},"nodes":[],"horeca":[]}',
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
  if (opts.allowErrors) t(`${name} — fouten verwacht en afgehandeld`, true);
  else t(`${name} — geen JS-fouten`, errs.length === 0, errs.join(' | ').slice(0, 180));
  await context.close();
  console.log(`  ⏱  ${name}: ${((Date.now() - _t0) / 1000).toFixed(1)}s`);
}

async function open(page) {
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForSelector('.route-card', { timeout: 10000 });
  // Hedged-mirror stagger sterk verlagen: de foutpaden hoeven in de test niet
  // telkens 3,5–7 s op de echte staggers te wachten. De hedge-LOGICA blijft
  // getest (mirror 2 start ná mirror 1), enkel véél sneller.
  await page.evaluate(() => Overpass._test.setHedgeMs(120));
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
  const results = await page.evaluate(async () => {
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

    // Duitsland-steun: verbrede routequery + officiële distance-tags
    const rq = Overpass._test.areaQuery({ minLat: 50.5, minLng: 6.2, maxLat: 50.6, maxLng: 6.3 });
    ok('areaQuery: lwn én rwn (Wanderwege)', rq.includes('(lwn|rwn)'));
    ok('areaQuery: knooppuntennet uitgesloten', rq.includes('"network:type"!="node_network"'));
    ok('areaQuery: routes zonder network-tag ook', rq.includes('[!"network"]'));
    ok('areaQuery: VOLLEDIGE routegeometrie (geen clip)', rq.includes('out geom qt') && !rq.includes('out geom('));
    ok('areaQuery: knooppunten + horeca in dezelfde aanvraag',
      rq.includes('rwn_ref') && rq.includes('amenity') && rq.includes('out center qt'));

    // Progressieve queries: lijst (out tags), geometrie per id (out geom)
    const lq = Overpass._test.listQuery({ minLat: 51, minLng: 5, maxLat: 51.1, maxLng: 5.1 });
    ok('listQuery: enkel tags, geen geometrie', lq.includes('out tags qt') && !lq.includes('out geom'));
    ok('listQuery: bbox aanwezig', lq.includes('(51,5,51.1,5.1)'));
    const gq = Overpass._test.geomQuery([12, 34, 56]);
    ok('geomQuery: rel op id + geometrie', gq.includes('rel(id:12,34,56)') && gq.includes('out geom qt'));
    ok('Komoot.importFromUrl: rommel → reject',
      await Komoot.importFromUrl('geen tour hier').then(() => false, () => true));

    // Progressieve helpers: robuust tegen lege/afwijkende antwoorden.
    ok('fetchRoutesByIds: lege ids → geen query',
      (await Overpass.fetchRoutesByIds([])).length === 0);
    {
      const ac = new AbortController(); ac.abort();
      ok('postQuery: reeds afgebroken signal → gooit',
        await Overpass._test.postQuery('[out:json];', 5000, ac.signal).then(() => false, (e) => /afgebroken/.test(e.message)));
    }
    {
      // fetchRouteList moet robuust zijn tegen antwoorden zonder elements/tags.
      const realFetch = window.fetch;
      window.fetch = async () => ({ ok: true, json: async () => ({}) });
      const empty = await Overpass.fetchRouteList({ minLat: 51, minLng: 5, maxLat: 51.1, maxLng: 5.1 });
      window.fetch = async () => ({ ok: true, json: async () => ({ elements: [{ type: 'relation', id: 9 }] }) });
      const noTags = await Overpass.fetchRouteList({ minLat: 51, minLng: 5, maxLat: 51.1, maxLng: 5.1 });
      window.fetch = realFetch;
      ok('fetchRouteList: geen elements → lege lijst', Array.isArray(empty) && empty.length === 0);
      ok('fetchRouteList: relatie zonder tags → {} tags', noTags.length === 1 && noTags[0].id === 9
        && typeof noTags[0].tags === 'object');
    }

    // REGRESSIE (productie-bug): out geom(bbox) geeft null-punten voor geometrie
    // buiten het zoekgebied — de parser moet daar splitsen, niet crashen.
    const prNull = Overpass._test.parseRoutes({ elements: [{
      type: 'relation', id: 5, tags: { name: 'Geclipt' },
      members: [
        { type: 'way', geometry: [
          { lat: 51, lon: 5 }, { lat: 51.001, lon: 5 }, null,
          { lat: 51.003, lon: 5 }, { lat: 51.004, lon: 5 },
        ] },
        { type: 'way', geometry: [null, null] },   // volledig buiten beeld
        { type: 'node', ref: 42 },                  // node-member (courant) → overslaan
        { type: 'way' },                            // way zonder geometrie → overslaan
      ],
    }] });
    ok('REGRESSIE: null-punten → gesplitst, geen crash',
      prNull.length === 1 && prNull[0].segments.length === 2, JSON.stringify(prNull[0] && prNull[0].segments.length));
    ok('REGRESSIE: enkel-null-way overgeslagen', prNull[0].segments.every((sg) => sg.length === 2));
    const TD = Overpass._test.tagDistanceM;
    ok('distance-tag: km', TD('14') === 14000 && TD('22.3') === 22300);
    ok('distance-tag: Duitse komma', TD('9,5') === 9500);
    ok('distance-tag: meters-vergissing (≥1000)', TD('7700') === 7700);
    ok('distance-tag: rommel/leeg/nul → null', TD('abc') === null && TD(null) === null && TD('0') === null);
    const prDist = Overpass._test.parseRoutes({ elements: [{
      type: 'relation', id: 9, tags: { name: 'Rhein-Venn-Weg', distance: '144.2' },
      members: [{ type: 'way', geometry: [{ lat: 50.55, lon: 6.25 }, { lat: 50.551, lon: 6.25 }] }],
    }] });
    ok('parseRoutes: distance-tag wint van geclipte meting', prDist[0].distance === 144200, prDist[0].distance);
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

  // HET ECHTE ANTWOORD: bevroren Overpass-respons (tests/refresh-fixture.mjs
  // ververst hem). Handgemaakte fixtures bleken te schoon — dit is de wereld.
  const real = await page.evaluate(async () => {
    const d = await (await fetch('tests/fixtures/area-real.json')).json();
    const routes = Overpass._test.parseRoutes(d);
    const ov = Overpass._test.parse(d);
    return {
      r: routes.length, n: ov.nodes.length, h: ov.horeca.length,
      geenNulls: routes.every((rt) => rt.segments.every((sg) => sg.every((p) => p && p[0] != null))),
      distOk: routes.every((rt) => rt.distance > 100),
    };
  });
  t('ECHT antwoord: routes geparsed', real.r >= 10, String(real.r));
  t('ECHT antwoord: knooppunten + horeca', real.n >= 30 && real.h >= 5, `${real.n}/${real.h}`);
  t('ECHT antwoord: geen null-punten in segmenten', real.geenNulls);
  t('ECHT antwoord: zinnige afstanden', real.distOk);

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
  t('sectiekoppen aanwezig', secs.includes('Route inladen via link of bestand') && secs.includes('Opgeslagen wandelingen'), secs.join(','));
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
  t('duidelijke foutmelding', (await txt(page, '#load-status')).includes('directe GPX-link'));
});

/* ---------- S4: kaart, overlays, kaartlagen ---------- */
await scenario('S4 kaart & overlays & lagen', {}, async (page) => {
  await open(page);
  await markCached(page);
  await page.click('.route-card');
  await sleep(1200);
  t('routelijn getekend (canvas)', await page.evaluate(() =>
    !!MapView.line && !!document.querySelector('#map canvas')));
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
  // scherm-aan-optie aan/uit (wakeLock-paden) + terugkeer naar de app
  await page.check('#chk-awake'); await sleep(200);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(150);
  await page.uncheck('#chk-awake');
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

  // Auto-centreren tijdens tracking is zuinig: enkel bijsturen bij drift naar de
  // rand, zodat je punten kan aantikken zonder dat de kaart wegschuift.
  await page.evaluate(() => { MapView.map.setView([51.234514, 5.321518], 16, { animate: false }); MapView._followed = true; });
  t('tracking: fix in het centrum → kaart blijft staan (aantikbaar)', await page.evaluate(() => {
    const c0 = MapView.map.getCenter();
    MapView._followTo(51.234514, 5.321518);
    const c1 = MapView.map.getCenter();
    return Math.abs(c0.lat - c1.lat) < 1e-5 && Math.abs(c0.lng - c1.lng) < 1e-5;
  }));
  await page.evaluate(() => MapView._followTo(51.30, 5.42)); // ver buiten het scherm
  await page.waitForFunction(() => Math.abs(MapView.map.getCenter().lat - 51.30) < 0.03, null, { timeout: 5000 });
  t('tracking: drift naar de rand → kaart stuurt bij', true);
  t('tracking: volgen uit → geen hercentrering', await page.evaluate(() => {
    MapView._followed = false;
    MapView.map.setView([51.234514, 5.321518], 16, { animate: false });
    const c0 = MapView.map.getCenter();
    MapView._followTo(52, 6);
    const c1 = MapView.map.getCenter();
    return Math.abs(c0.lat - c1.lat) < 1e-5 && Math.abs(c0.lng - c1.lng) < 1e-5;
  }));
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
  const nLayers = await page.evaluate(() => Object.keys(MapView._exploreLayers).length);
  t('routes getekend (canvas)', nLayers > 3 && await page.evaluate(() => !!document.querySelector('#map canvas')), String(nLayers));

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

  // 'Zoek hier' herlaadt progressief; daarna staan de routes er weer.
  await page.click('#explore-search');
  await page.waitForFunction(() => /routes? — tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('Zoek hier herlaadt de routes', await page.evaluate(() => Object.keys(MapView._exploreLayers).length > 3));
  // herselecteer voor het vervolg (zoeken wist de keuze bewust)
  await page.evaluate(() => { MapView.selectExplore(Object.keys(MapView._exploreLayers)[0]); });
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
  const H = overpassHandler(LWN);
  await context.route((u) => u.host === 'overpass.kumi.systems', () => { /* hangt */ });
  await context.route((u) => /overpass-api\.de|overpass\.private\.coffee/.test(u.host), (r) => {
    const q = decodeURIComponent((r.request().postData() || '').replace(/^data=/, ''));
    if (/out tags/.test(q)) capturedBody = q; // de lijst-query bevat het zoekgebied
    H(r);
  });
  await open(page);
  const t0 = Date.now();
  await page.click('#btn-explore');
  await page.waitForFunction(() => /tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 25000 });
  t('hedged: resultaat < 9 s ondanks hangende mirror', Date.now() - t0 < 9000, `${Date.now() - t0} ms`);
  // uitzoomen → zoekgebied geklemd
  await page.evaluate(() => { MapView.map.setZoom(9); });
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
  t('offline: routelijn', await page.evaluate(() => !!MapView.line));
  const loaded = (await page.$$('#map .leaflet-tile-loaded')).length;
  t('offline: tegels uit cache', loaded > 3, String(loaded));
});

/* ---------- S9: statuslampjes-levenscyclus ---------- */
await scenario('S9 statuslampjes', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.41 }, permissions: ['geolocation'] },
  noOverpass: true,
}, async (page, context) => {
  await context.route(isOverpassHost, async (r) => {
    await sleep(1400);
    r.fulfill({ status: 200, contentType: 'application/json', body: LWN });
  });
  await open(page);
  t('idle: internet uit', (await txt(page, '#statusbar-list')).includes('internet uit'));
  await page.click('#btn-explore');
  await sleep(300);
  // lagen-sheet vóór het eerste resultaat: nog geen tellingen bekend
  await page.click('#btn-layers');
  t('lagen-sheet: gebiedstelling (0 vóór routes)', (await txt(page, '#ov-nodes-count')).includes('in dit gebied'));
  await page.click('#layers-close');
  await sleep(900);
  t('bezig: internet actief', (await txt(page, '#statusbar-map')).includes('internet actief'));
  await page.waitForFunction(() => /tik er één aan|geen/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  await page.waitForFunction(() => document.getElementById('statusbar-map').textContent.includes('internet uit'), null, { timeout: 60000 });
  t('klaar: internet weer uit', true);
  // visibilitychange-pad
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  t('visibilitychange verwerkt', true);
});

/* ---------- S10: branch-dekking (randgevallen & foutinjectie, unit-stijl) ---------- */
await scenario('S10 branch-dekking', { noOverpass: true, noKomoot: true }, async (page, context) => {
  // Overpass hangt (voor de time-outtest); Komoot per tour-id verschillend.
  await context.route(isOverpassHost, () => { /* hangt */ });
  const MINIMAL = JSON.stringify({ _embedded: { coordinates: { items: [
    { lat: 51.0, lng: 5.0, alt: 1, t: 0 }, { lat: 51.001, lng: 5.0, t: 9 },
  ] } } });
  await context.route((u) => u.host === 'api.komoot.de', (r) => {
    const url = r.request().url();
    if (url.includes('/555')) return r.fulfill({ status: 200, contentType: 'application/json', body: MINIMAL });
    if (url.includes('/777')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    return r.abort();
  });
  await context.route((u) => /corsproxy\.io|allorigins/.test(u.host), (r) => r.abort());
  await open(page);

  const results = await page.evaluate(async () => {
    const out = [];
    const ok = (n, c, x = '') => out.push([n, !!c, String(x)]);

    // fetch-wrapper met Request-object en zonder argument
    await fetch(new Request(location.origin + '/manifest.webmanifest'));
    await fetch().catch(() => {});
    ok('wrapFetch: Request-object + leeg argument', true);

    // DB: twee routes zonder importedAt → beide kanten van de sorteer-fallback
    await DB.put({ id: 'zonder-datum-a', name: 'A', coords: [[51, 5, 0]], distance: 1 });
    await DB.put({ id: 'zonder-datum-b', name: 'B', coords: [[51, 5, 0]], distance: 1 });
    const all = await DB.all();
    ok('DB: routes zonder importedAt sorteren mee', all.length >= 3);
    await DB.remove('zonder-datum-a');
    await DB.remove('zonder-datum-b');

    // DB: alle foutpaden via een kapotte transactie
    const failReq = () => { const r = {}; setTimeout(() => r.onerror && r.onerror({}), 0); return r; };
    const brokenStore = { getAll: failReq, get: failReq, put: failReq, delete: failReq, count: failReq };
    const origTx = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function () { return { objectStore: () => brokenStore }; };
    const rejects = [];
    for (const p of [DB.all(), DB.get('x'), DB.put({ id: 'x' }), DB.remove('x'), DB.count(),
                     DB.putRegion({ id: 'x' }), DB.allRegions()]) {
      rejects.push(await p.then(() => false, () => true));
    }
    IDBDatabase.prototype.transaction = origTx;
    ok('DB: alle 7 foutpaden verwerpen netjes', rejects.every(Boolean), rejects.join(','));

    // Tiles: string-basemap, onbekend detail, default-basemap, afgebroken download
    ok('tiles: estimate met string-basemap', Tiles.estimate([[51, 5, 0]], 'overview', 'satellite').count > 0);
    ok('tiles: onbekend detail → normal', Tiles.estimate([[51, 5, 0]], 'bestaat-niet').count > 0);
    ok('tiles: planTiles string-basemap', Tiles.planTiles([[51, 5, 0]], 'overview', 'topo').length > 0);
    ok('tiles: planBBox string + estimateBBox string',
      Tiles.planBBox({ minLat: 51, minLng: 5, maxLat: 51.01, maxLng: 5.01 }, 'overview', 'topo').length > 0 &&
      Tiles.estimateBBox({ minLat: 51, minLng: 5, maxLat: 51.01, maxLng: 5.01 }, 'overview', 'satellite').count > 0);
    ok('tiles: planBBox met onbekend detail → normal',
      Tiles.planBBox({ minLat: 51, minLng: 5, maxLat: 51.005, maxLng: 5.005 }, 'bestaat-niet').length > 0);
    const ac = new AbortController(); ac.abort();
    const dl = await Tiles.download([[51, 5, 0]], 'overview', undefined, null, ac.signal);
    ok('tiles: afgebroken download → cancelled', dl.cancelled === true);
    const dl2 = await Tiles.downloadBBox({ minLat: 51, minLng: 5, maxLat: 51.001, maxLng: 5.001 }, 'overview', undefined,
      () => {}, ac.signal);
    ok('tiles: afgebroken bbox-download (default kaartlaag)', dl2.cancelled === true);
    ok('tiles: corridor aan de wereldrand', Tiles.planTiles([[85.05, -179.99, 0]], 'overview').length > 0);
    // caches-API kapot → nette fallbacks
    const origOpen = caches.open.bind(caches), origDel = caches.delete.bind(caches);
    caches.open = () => { throw new Error('kapot'); };
    caches.delete = () => { throw new Error('kapot'); };
    ok('tiles: cacheSize bij kapotte cache → 0', (await Tiles.cacheSize()) === 0);
    await Tiles.clearAll(); ok('tiles: clearAll slikt fout', true);
    caches.open = origOpen; caches.delete = origDel;

    // Overpass: parse/parseRoutes-randgevallen
    const P = Overpass._test;
    ok('parse: leeg object', P.parse({}).nodes.length === 0);
    ok('parse: node zonder tags + horeca zonder naam',
      P.parse({ elements: [{ type: 'node', lat: 1, lon: 2 },
        { type: 'node', lat: 1, lon: 2, tags: { amenity: 'cafe' } }] }).horeca[0].n === '');
    ok('parseRoutes: leeg object', P.parseRoutes({}).length === 0);
    ok('parseRoutes: niet-relatie overgeslagen',
      P.parseRoutes({ elements: [{ type: 'node', lat: 1, lon: 2 }] }).length === 0);
    ok('parseRoutes: relatie zonder members overgeslagen',
      P.parseRoutes({ elements: [{ type: 'relation', id: 3, tags: {} }] }).length === 0);
    const prRef = P.parseRoutes({ elements: [{ type: 'relation', id: 1, tags: { ref: 'R1' },
      members: [{ type: 'way', geometry: [{ lat: 51, lon: 5 }, { lat: 51.001, lon: 5 }] }] }] });
    ok('parseRoutes: naam uit ref', prRef[0].name === 'R1');
    const prNone = P.parseRoutes({ elements: [{ type: 'relation', id: 2,
      members: [{ type: 'way', geometry: [{ lat: 51, lon: 5 }, { lat: 51.001, lon: 5 }] }] }] });
    ok('parseRoutes: zonder naam/ref → Wandelroute', prNone[0].name === 'Wandelroute');
    ok('boundsFromCoords: expliciete marge',
      Math.abs(Overpass.boundsFromCoords([[51, 5, 0]], 0.05).minLat - 50.95) < 1e-9);

    // GPX-parser: alle vormen en foutpaden
    const T = (x, n) => { try { return GPX.parse(x, n); } catch (e) { return { err: e.message }; } };
    const trk = T('<gpx><trk><name>Lus</name><trkseg><trkpt lat="51" lon="5"><ele>10</ele></trkpt><trkpt lat="51.001" lon="5"><ele>16</ele></trkpt></trkseg><trkseg><trkpt lat="51.002" lon="5"><ele>12</ele></trkpt></trkseg></trk></gpx>');
    ok('gpx: track over meerdere segmenten', trk.coords.length === 3 && trk.gpxVorm === 'track' && trk.name === 'Lus');
    ok('gpx: hoogtewinst en -verlies', trk.elevationUp === 6 && trk.elevationDown === 4, `${trk.elevationUp}/${trk.elevationDown}`);
    const rte = T('<gpx><rte><name>Plan</name><rtept lat="51" lon="5"/><rtept lat="51.001" lon="5"/></rte></gpx>');
    ok('gpx: rte-fallback', rte.gpxVorm === 'route' && rte.name === 'Plan');
    const wpt = T('<gpx><metadata><name>Bordjes</name></metadata><wpt lat="51" lon="5"/><wpt lat="51.001" lon="5"/></gpx>');
    ok('gpx: losse punten verbonden', wpt.gpxVorm === 'punten' && wpt.name === 'Bordjes' && wpt.distance > 100);
    ok('gpx: fallback-naam', T('<gpx><trk><trkseg><trkpt lat="51" lon="5"/><trkpt lat="51.1" lon="5"/></trkseg></trk></gpx>', 'bestand').name === 'bestand');
    ok('gpx: zonder naam → GPX-route', T('<gpx><wpt lat="51" lon="5"/><wpt lat="51.1" lon="5"/></gpx>').name === 'GPX-route');
    ok('gpx: kapotte XML → fout', /geen geldig/.test(T('<gpx><trk>').err || ''));
    ok('gpx: te weinig punten → fout', /Geen bruikbare/.test(T('<gpx><wpt lat="51" lon="5"/></gpx>').err || ''));
    ok('gpx: ongeldige coördinaat overgeslagen',
      T('<gpx><wpt lat="x" lon="5"/><wpt lat="51" lon="5"/><wpt lat="51.1" lon="5"/></gpx>').coords.length === 2);
    ok('gpx: id stabiel', T('<gpx><wpt lat="51" lon="5"/><wpt lat="51.1" lon="5"/></gpx>').id ===
      T('<gpx><wpt lat="51" lon="5"/><wpt lat="51.1" lon="5"/></gpx>').id);
    ok('gpx: isGpxUrl', GPX.isGpxUrl('https://x.be/pad/route.GPX?y=1') && !GPX.isGpxUrl('https://komoot.com/tour/1'));
    ok('gpx: naam uit URL', GPX._test.nameFromUrl('https://x.be/s/Nutteloze-gpx.gpx') === 'Nutteloze gpx');
    ok('gpx: naam uit leeg pad', GPX._test.nameFromUrl('/') === '');

    // KML-parser: routelijn + genummerde punten (bv. de bordjes)
    const K = (x, n) => { try { return KML.parse(x, n); } catch (e) { return { err: e.message }; } };
    const kLine = K('<kml><Document><name>Bordenroute</name>' +
      '<Placemark><LineString><coordinates>5.0,51.0,10 5.0,51.001,20 5.002,51.001,15</coordinates></LineString></Placemark>' +
      '<Placemark><name>1. Start</name><Point><coordinates>5.0,51.0,0</coordinates></Point></Placemark>' +
      '<Placemark><name>Los bord</name><Point><coordinates>5.001,51.001,0</coordinates></Point></Placemark>' +
      '</Document></kml>');
    ok('kml: lijn → coords + naam uit Document', kLine.coords.length === 3 && kLine.name === 'Bordenroute'
      && kLine.gpxVorm === 'track' && kLine.source === 'kml' && kLine.id.startsWith('kml-'));
    ok('kml: hoogtewinst/-verlies uit alt', kLine.elevationUp === 10 && kLine.elevationDown === 5,
      `${kLine.elevationUp}/${kLine.elevationDown}`);
    ok('kml: eigen punten → overlaysFetched (niet overschrijven)', kLine.overlaysFetched === true);
    ok('kml: geen Document-naam, geen fallback → KML-route',
      K('<kml><Placemark><LineString><coordinates>5,51,0 5,51.001,0</coordinates></LineString></Placemark></kml>').name === 'KML-route');
    ok('kml: punten → genummerde waypoints (ref uit naam, anders volgorde)',
      kLine.waypoints.length === 2 && kLine.waypoints[0].ref === '1' && kLine.waypoints[0].name === '1. Start'
      && kLine.waypoints[1].ref === '2', JSON.stringify(kLine.waypoints.map((n) => n.ref)));
    const kPts = K('<kml><Document><name>Enkel punten</name>' +
      '<Placemark><name>A</name><Point><coordinates>5.0,51.0</coordinates></Point></Placemark>' +
      '<Placemark><name>B</name><Point><coordinates>5.0,51.001</coordinates></Point></Placemark>' +
      '</Document></kml>');
    ok('kml: geen lijn → punten verbonden (punten-vorm)', kPts.gpxVorm === 'punten' && kPts.coords.length === 2);
    ok('kml: lege LineString → val terug op punten',
      K('<kml><Document><name>x</name><Placemark><LineString></LineString></Placemark>' +
        '<Placemark><name>1</name><Point><coordinates>5,51</coordinates></Point></Placemark>' +
        '<Placemark><name>2</name><Point><coordinates>5,51.001</coordinates></Point></Placemark></Document></kml>').gpxVorm === 'punten');
    ok('kml: kapotte XML → fout', /geen geldige KML/.test(K('<kml><Document>').err || ''));
    ok('kml: niets bruikbaars → fout', /Geen bruikbare/.test(K('<kml><Document><name>Leeg</name></Document></kml>').err || ''));
    ok('kml: fallback-naam bij naamloze Document',
      K('<kml><Document><Placemark><LineString><coordinates>5,51,0 5,51.001,0</coordinates></LineString></Placemark></Document></kml>', 'viavia').name === 'viavia');
    ok('kml: isKmlUrl (.kml én Google My Maps)',
      KML.isKmlUrl('https://x.be/r.kml') && KML.isKmlUrl('https://www.google.com/maps/d/viewer?mid=ABC123&ll=1,2')
      && !KML.isKmlUrl('https://komoot.com/tour/1'));
    ok('kml: My Maps-viewer → kml-export-URL',
      KML._test.mymapsKmlUrl('https://www.google.com/maps/d/u/0/viewer?mid=XYZ&ll=1%2C2&z=16')
        === 'https://www.google.com/maps/d/kml?mid=XYZ&forcekml=1');
    ok('kml: gewone URL is geen My Maps', KML._test.mymapsKmlUrl('https://x.be/r.kml') === null);
    ok('kml: naam uit URL', KML._test.nameFromUrl('https://x.be/s/Genk-route.kml') === 'Genk route');
    ok('kml: naam uit leeg pad', KML._test.nameFromUrl('/') === '');

    // Komoot: alternatieve tour_id-vorm
    ok('parseUrl: ?tour_id=', (Komoot.parseUrl('https://x.be/?tour_id=1234567') || {}).id === '1234567');

    // Geolocatie-varianten via een injecteerbare stub
    const setGeo = (impl) => Object.defineProperty(navigator, 'geolocation', { value: impl, configurable: true });
    const lastToast = () => document.getElementById('toast').textContent;
    setGeo({ getCurrentPosition: (okCb, err) => err({ code: 1 }) });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 60));
    ok('geo: code 1 → toegang geweigerd + denied', lastToast().includes('toegang geweigerd') && MapView.gpsState === 'denied');
    setGeo({ getCurrentPosition: (okCb, err) => err({ code: 2 }) });
    MapView.locateOnce(null, () => {});
    await new Promise((r) => setTimeout(r, 60));
    ok('geo: code 2 → positie onbeschikbaar', lastToast().includes('positie onbeschikbaar'));
    setGeo({ getCurrentPosition: (okCb, err) => err() });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 60));
    ok('geo: zonder fout-object → onbekende fout', lastToast().includes('onbekende fout'));
    setGeo({ getCurrentPosition: (okCb, err) => err({ code: 99, message: 'raar' }) });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 60));
    ok('geo: onbekende code → eigen boodschap', lastToast().includes('raar'));
    setGeo({ getCurrentPosition: (okCb, err) => err({ code: 99, message: '' }) });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 60));
    ok('geo: lege boodschap → fout', lastToast().includes('fout'));

    // Grove eerste fix (>60 m) → kort verfijnen naar de nauwkeurigste GPS-fix,
    // zodat de stip op de júiste plek staat i.p.v. op de netwerk-fix ernaast.
    MapView.map.setView([51.0, 5.0], 15, { animate: false });
    setGeo({ // (zonder _locateWaitMs → standaard wachttijd; de fijne fix komt eerder)
      getCurrentPosition: (okCb) => okCb({ coords: { latitude: 51.0, longitude: 5.0, accuracy: 300 } }), // grof
      watchPosition: (okCb) => {
        setTimeout(() => okCb({ coords: { latitude: 51.05, longitude: 5.05, accuracy: 8 } }), 20);  // fijn → klaar
        setTimeout(() => okCb({ coords: { latitude: 51.06, longitude: 5.06, accuracy: 5 } }), 45);  // 2e fix ná klaar → genegeerd
        return 1;
      },
      clearWatch: () => {},
    });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 90));
    ok('locatie: grove fix wordt verfijnd (stip juist)',
      Math.abs(MapView.locMarker.getLatLng().lat - 51.05) < 1e-4, MapView.locMarker.getLatLng().lat);
    ok('locatie: toont de nauwkeurigheid (±m)', lastToast().includes('±8 m'), lastToast());
    MapView.clearLocation();

    // Decente eerste fix (≤60 m, hier onbekende accuracy) → meteen gebruiken.
    setGeo({ getCurrentPosition: (okCb) => okCb({ coords: { latitude: 51.1, longitude: 5.1, accuracy: 0 } }) });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 30));
    ok('locatie: decente/onbekende fix → meteen gebruikt (geen cirkel/toast)',
      Math.abs(MapView.locMarker.getLatLng().lat - 51.1) < 1e-4 && !MapView.accCircle);
    MapView.clearLocation();

    // Verfijning levert enkel slechtere fixes → na korte time-out de eerste gebruiken.
    MapView._locateWaitMs = 60;
    setGeo({
      getCurrentPosition: (okCb) => okCb({ coords: { latitude: 52.0, longitude: 6.0, accuracy: 200 } }),
      watchPosition: (okCb) => { setTimeout(() => okCb({ coords: { latitude: 52.1, longitude: 6.1, accuracy: 500 } }), 15); return 1; }, // slechter
      clearWatch: () => {},
    });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 120));
    ok('locatie: slechtere verfijning genegeerd → eerste fix', Math.abs(MapView.locMarker.getLatLng().lat - 52.0) < 1e-4);
    MapView.clearLocation();

    // Fout tijdens verfijnen → val netjes terug op de eerste (grove) fix.
    setGeo({
      getCurrentPosition: (okCb) => okCb({ coords: { latitude: 53.0, longitude: 7.0, accuracy: 250 } }),
      watchPosition: (okCb, err) => { setTimeout(() => err({ code: 2 }), 15); return 1; },
      clearWatch: () => {},
    });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 60));
    ok('locatie: fout bij verfijnen → eerste fix gebruikt', !!MapView.locMarker && Math.abs(MapView.locMarker.getLatLng().lat - 53.0) < 1e-4);
    MapView.clearLocation();
    MapView._locateWaitMs = 0;

    // z-fallback: getZoom() → 0 (|| 0) in beide modi (route én verkennen)
    const origGetZoom = MapView.map.getZoom.bind(MapView.map);
    MapView.map.getZoom = () => 0;
    MapView.exploreMode = false;
    MapView._onLocated({ coords: { latitude: 51.2, longitude: 5.2, accuracy: 0 } }, null);
    MapView.exploreMode = true; MapView.exploreRoutes = [];
    MapView._onLocated({ coords: { latitude: 51.2, longitude: 5.2, accuracy: 0 } }, null);
    const zoomFallbackOk = !!MapView.locMarker;
    MapView.map.getZoom = origGetZoom;
    MapView.exploreMode = false; MapView.clearLocation();
    ok('locatie: zoom-fallback (|| 0) in route- én verken-modus', zoomFallbackOk);

    // Tracking: niet-fatale fout, dragstart en staleness
    let watchErr = null;
    setGeo({
      watchPosition: (okCb, err) => { watchErr = err; setTimeout(() => err({ code: 3 }), 10); return 7; },
      clearWatch: () => {},
      getCurrentPosition: () => {},
    });
    MapView.startTracking();
    MapView.startTracking(); // tweede start is een no-op (watch loopt al)
    await new Promise((r) => setTimeout(r, 60));
    ok('tracking: time-out houdt watch actief (zoekt…)', MapView.gpsState === 'searching');
    MapView._followed = true;
    MapView.map.fire('dragstart');
    ok('tracking: pannen stopt auto-centreren', MapView._followed === false);
    MapView.gpsState = 'fix'; MapView.lastFixAt = Date.now() - 60000;
    MapView._staleCheck();
    ok('tracking: >30 s geen fix → zoekt…', MapView.gpsState === 'searching');
    MapView.gpsState = 'fix'; MapView.lastFixAt = Date.now();
    MapView._staleCheck();
    ok('tracking: verse fix blijft fix', MapView.gpsState === 'fix');
    MapView.stopTracking();

    // WakeLock-paden met stub
    let released = false;
    Object.defineProperty(navigator, 'wakeLock', {
      value: { request: async () => ({ addEventListener() {}, release() { released = true; } }) },
      configurable: true,
    });
    await MapView.requestWake();
    MapView.releaseWake();
    ok('wakeLock: aanvragen + loslaten', released === true);

    // Statuslampjes: online/offline-events
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('online'));
    ok('status: online/offline events verwerkt', true);

    // Prefs met kapotte localStorage
    const origSet = Storage.prototype.setItem, origGet = Storage.prototype.getItem;
    Storage.prototype.setItem = () => { throw new Error('vol'); };
    Storage.prototype.getItem = () => { throw new Error('kapot'); };
    App._savePrefs();
    const prefs = App._loadPrefs();
    Storage.prototype.setItem = origSet; Storage.prototype.getItem = origGet;
    ok('prefs: kapotte opslag → defaults', prefs.basemap === 'voyager');

    // selectExplore/deselectExplore vóór er ooit gerenderd is + minDist zonder segmenten
    MapView._exploreLayers = undefined; MapView.exploreRoutes = [];
    MapView.selectExplore('bestaat-niet');
    MapView.deselectExplore();          // ook veilig zonder lagen; App-guard (niet in verkennen) dekt af
    ok('selectExplore/deselectExplore zonder lagen is veilig', true);
    ok('minDistToSegments zonder segmenten → Infinity', Geo.minDistToSegments([51, 5], undefined) === Infinity);

    // succesvolle fix vóór de kaart een zoomniveau heeft (getZoom() undefined)
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: {
      getCurrentPosition: (okCb) => okCb({ coords: { latitude: 51.2, longitude: 5.3 } }),
    } });
    MapView.locateOnce();
    await new Promise((r) => setTimeout(r, 60));
    ok('fix zonder zoomniveau werkt', !!MapView.locMarker);
    MapView.clearLocation();

    // downloadBBox met string-kaartlaag (afgebroken)
    const ac2 = new AbortController(); ac2.abort();
    const dl3 = await Tiles.downloadBBox({ minLat: 51, minLng: 5, maxLat: 51.001, maxLng: 5.001 }, 'overview', 'topo',
      null, ac2.signal);
    ok('downloadBBox met string-kaartlaag', dl3.cancelled === true);

    // Verken-randgevallen op MapView-niveau
    MapView.enterExplore();
    MapView.map.fire('click', { latlng: L.latLng(51, 5) });          // geen routes → return
    MapView.renderExplore();                                          // zonder argumenten
    MapView.renderExplore([{ id: 'leeg', name: 'Leeg', segments: [], coords: [] }]);
    MapView.renderExplore([{ id: 'leeg2', name: 'Leeg2', segments: [], coords: [] }]); // her-render-tak
    MapView.enterExplore();                                           // groep bestaat → opruim-tak
    // Progressief: eerste brokje tekenen, dan hetzelfde id opnieuw → dedup (continue).
    const seg = [[[51, 5], [51.001, 5.001]]];
    MapView.startExploreRender(() => {});
    MapView.addExploreRoutes([{ id: 'osm-1', name: 'A', segments: seg, coords: seg[0] }]);
    const naEerste = MapView.exploreRoutes.length;
    MapView.addExploreRoutes([{ id: 'osm-1', name: 'A', segments: seg, coords: seg[0] }]); // zelfde id → overslaan
    ok('addExploreRoutes: dubbel id wordt overgeslagen', naEerste === 1 && MapView.exploreRoutes.length === 1);
    MapView.map.fire('dragstart');                                    // gebruiker beweegt → _userMoved
    ok('verkennen: dragstart zet _userMoved', MapView._userMoved === true);
    MapView.clearExplore();
    ok('verkennen: lege segmenten en dubbele (re)render zonder fouten', true);

    // onExploreLocate-guards buiten verken-modus en met lege lijst
    App.onExploreLocate([{ name: 'X' }]);
    App._exploreActive = true; App.onExploreLocate([]); App._exploreActive = false;
    ok('onExploreLocate-guards', true);

    return out;
  });
  for (const [n, c, x] of results) t('S10: ' + n, c, x);

  // Komoot-imports met afwijkende payloads (via de UI)
  await page.fill('#url-input', 'https://www.komoot.com/tour/555');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Komoot-route/.test(document.getElementById('map-route-name').textContent || ''), null, { timeout: 15000 });
  t('S10: minimale tour → veldfallbacks (Komoot-route/hike)', true);
  await page.click('#btn-back');
  await page.fill('#url-input', 'https://www.komoot.com/tour/777');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Geen coördinaten/.test(document.getElementById('load-status').textContent), null, { timeout: 15000 });
  t('S10: tour zonder coördinaten → duidelijke fout', true);
  await page.fill('#url-input', 'https://www.komoot.com/tour/888');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Mislukt/.test(document.getElementById('load-status').textContent), null, { timeout: 15000 });
  t('S10: netwerkfout bij import → nette fout', true);
  // Enter-toets in de URL-balk
  await page.fill('#url-input', '');
  await page.press('#url-input', 'Enter');
  t('S10: Enter in URL-balk', (await txt(page, '#load-status')).includes('Plak eerst'));
  // Overlay sluiten via tik op de achtergrond
  await page.click('#btn-about');
  await page.click('#about-overlay', { position: { x: 8, y: 8 } });
  t('S10: overlay sluit via achtergrond-tik', await page.isHidden('#about-overlay'));
  // deleteMenu-randgevallen: zonder menu + annuleren in confirm; lege naam bij opslaan
  await page.evaluate(() => App.deleteMenu());
  await page.evaluate(() => App.saveMenu());
  page.once('dialog', (d) => d.dismiss());
  await page.click('.route-card .kebab');
  await page.click('#menu-delete');
  await sleep(300);
  t('S10: verwijderen geannuleerd → route blijft', (await page.$$('.route-card')).length >= 1);
  const nameBefore = await txt(page, '.route-card .name');
  await page.fill('#rename-input', '');
  await page.click('#menu-save');
  await sleep(300);
  t('S10: lege naam bij hernoemen → naam blijft', (await txt(page, '.route-card .name')) === nameBefore);
  // postQuery-time-out (alle mirrors hangen): moet netjes verwerpen
  const timedOut = await page.evaluate(async () => {
    try { await Overpass._test.postQuery('[out:json];', 250); return false; }
    catch (e) { return /niet bereikbaar/.test(e.message); }
  });
  t('S10: postQuery met hangende mirrors → nette fout', timedOut);
});

/* ---------- S11: mislukte tegels + accuracy-cirkel ---------- */
await scenario('S11 tegelfouten & accuracy', {
  ctx: { geolocation: { latitude: 51.234514, longitude: 5.321518, accuracy: 25 }, permissions: ['geolocation'] },
  noKomoot: true,
}, async (page, context) => {
  // De helft van de tegels geeft een serverfout → download slaat ze over
  let n = 0;
  await context.route((u) => /cartocdn\.com/.test(u.host), (r) =>
    (n++ % 2 === 0)
      ? r.fulfill({ status: 500, body: 'stuk' })
      : r.fulfill({ status: 200, contentType: 'image/png', body: TILE }));
  await open(page);
  const res = await page.evaluate(() =>
    Tiles.download([[51.23, 5.32, 0]], 'overview', 'voyager'));
  t('mislukte tegels overgeslagen, rest opgeslagen', res.ok > 0 && res.ok < res.total, JSON.stringify(res));
  // Kapotte Cache-opslag → download vangt de fout per tegel op
  const res2 = await page.evaluate(async () => {
    const orig = Cache.prototype.put;
    Cache.prototype.put = () => { throw new Error('cache vol'); };
    const r = await Tiles.download([[52.5, 4.4, 0]], 'overview', 'voyager');
    Cache.prototype.put = orig;
    return r;
  });
  t('kapotte cache-opslag → tegels netjes overgeslagen', res2.ok === 0 && res2.total > 0, JSON.stringify(res2));

  // accuracy-cirkel: aanmaken en daarna verplaatsen
  await markCached(page);
  await page.click('.route-card');
  await sleep(700);
  await page.click('#btn-locate');
  await page.waitForSelector('.loc-dot', { timeout: 10000 });
  t('accuracy-cirkel getekend', await page.evaluate(() => !!MapView.accCircle));
  await context.setGeolocation({ latitude: 51.2355, longitude: 5.3220, accuracy: 40 });
  await page.click('#btn-locate');
  await sleep(900);
  t('accuracy-cirkel verplaatst', await page.evaluate(() => MapView.accCircle.getRadius() === 40));
});

/* ---------- S12: verken-randgevallen ---------- */
const ONE_ROUTE = JSON.stringify({ elements: [{
  type: 'relation', id: 42, tags: { name: 'Bos & Hei', ref: 'BH', colour: 'red' },
  members: [{ type: 'way', geometry: [
    { lat: 51.311, lon: 5.405 }, { lat: 51.313, lon: 5.405 }, { lat: 51.313, lon: 5.407 },
  ] }],
}] });
await scenario('S12 verken-randgevallen', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.405, accuracy: 5 }, permissions: ['geolocation'] },
  overpassData: ONE_ROUTE,
}, async (page, context) => {
  await open(page);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /1 route — tik/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('enkelvoud in hint (1 route)', true);
  await page.waitForFunction(() => /Gebied offline/.test(document.getElementById('toast').textContent), null, { timeout: 60000 });

  // kiezen via een échte muisklik op de routelijn (canvas-hit-detectie)
  const clickPt = await page.evaluate(() => {
    const pt = MapView.map.latLngToContainerPoint([51.312, 5.405]);
    const rect = document.getElementById('map').getBoundingClientRect();
    return { x: rect.left + pt.x, y: rect.top + pt.y };
  });
  await page.mouse.click(clickPt.x, clickPt.y);
  await sleep(250);
  const info = await txt(page, '#explore-info');
  t('DOM-klik op lijn kiest route; naam met & + ref netjes', info.includes('Bos & Hei') && info.includes('BH'), info);

  // tik op leeg stuk kaart → deselecteren (enkelvoud-hint), verder zoeken kan
  await page.evaluate(() => { MapView.map.fire('click', { latlng: L.latLng(51.35, 5.45) }); });
  await sleep(200);
  t('lege-kaart-tik deselecteert', await page.evaluate(() => MapView.selectedExploreId === null));
  t('info terug naar zoekstand', (await txt(page, '#explore-info')).includes('Routes in de buurt'));
  t('hint enkelvoud na deselect', (await txt(page, '#explore-hint')).includes('1 route — tik'));
  t('Volg weer uit', await page.$eval('#explore-follow', (el) => el.disabled));

  // ◎ op een route → "Je staat op:" (tweede route erbij → sorteer-comparator draait)
  await page.evaluate(() => {
    MapView.exploreRoutes.push({ id: 'osm-43', name: 'Zijpad', distance: 200,
      segments: [[[51.3115, 5.405], [51.3125, 5.405]]], coords: [] });
  });
  await page.click('#btn-locate');
  await page.waitForFunction(() => /Je staat op/.test(document.getElementById('toast').textContent), null, { timeout: 10000 });
  t('locatie op route → "Je staat op: …" met sortering', (await txt(page, '#toast')).includes('Bos & Hei'));

  // kaartlagen-sheet in verken-modus (tellingen leeg)
  await page.click('#btn-layers');
  t('lagen-sheet in verkennen telt gebied', (await txt(page, '#ov-nodes-count')).includes('in dit gebied'));
  await page.click('#layers-close');

  // verouderde zoekactie: tweede zoek annuleert de eerste (succes- én foutpad)
  const slowH = overpassHandler(ONE_ROUTE);
  await context.route(isOverpassHost, async (r) => { await sleep(500); slowH(r); });
  await page.evaluate(() => { App._selectedExplore = null; App._exploreFetch(true); App._exploreFetch(true); });
  await sleep(1600);
  t('dubbele zoekactie: oudste antwoord genegeerd', true);
  await page.evaluate(async () => {
    const orig = Overpass.fetchRouteList;
    Overpass.fetchRouteList = async () => { await new Promise((r) => setTimeout(r, 250)); throw new Error('stuk'); };
    App._exploreFetch(true); App._exploreFetch(true); // eerste faalt als verouderd → guard in het foutpad
    await new Promise((r) => setTimeout(r, 900));
    Overpass.fetchRouteList = orig;
  });
  t('dubbele zoekactie met fout: oudste genegeerd', true);

  // opslag-fouten tijdens verkennen: putRegion en downloadBBox falen stil
  await context.route(isOverpassHost, overpassHandler(ONE_ROUTE));
  await page.evaluate(() => {
    window.__origPut = DB.putRegion; window.__origDl = Tiles.downloadBBox;
    DB.putRegion = () => Promise.reject(new Error('vol'));
    Tiles.downloadBBox = () => Promise.reject(new Error('vol'));
    MapView.map.setView([51.5, 5.8], 14); // nieuw gebied → nieuwe regio-id
  });
  await page.click('#explore-search');
  await page.waitForFunction(() => !document.getElementById('explore-search').disabled, null, { timeout: 20000 });
  await sleep(400);
  await page.evaluate(() => { DB.putRegion = window.__origPut; Tiles.downloadBBox = window.__origDl; });
  t('opslagfouten tijdens verkennen zijn stil', true);

  // online maar netwerk stuk → fallback op opgeslagen regio's ('offline cache')
  await page.evaluate(() => { MapView.map.setView([51.312, 5.405], 14); });
  await context.route(isOverpassHost, (r) => r.abort());
  await page.click('#explore-search');
  await page.waitForFunction(() => /offline cache/.test(document.getElementById('explore-hint').textContent), null, { timeout: 30000 });
  t('netwerk stuk → routes uit offline cache', true);
  await page.evaluate(() => { MapView.selectExplore(MapView.exploreRoutes[0].id); });
  await sleep(200);
  t('kiezen uit offline-fallback werkt', await page.$eval('#explore-follow', (el) => !el.disabled));
  // Volg-guard: zonder keuze doet Volg niets
  await page.evaluate(() => { App._selectedExplore = null; return App.followSelected(); });
  t('Volg zonder keuze is een no-op', true);

  // guards van _autoCacheRegion + oude explore-cache
  const guards = await page.evaluate(async () => {
    const b = { minLat: 51.30, minLng: 5.39, maxLat: 51.32, maxLng: 5.42 };
    await App._autoCacheRegion(b, []);                       // geen routes → return
    App._regionJob = 'bezig';
    await App._autoCacheRegion(b, [{ id: 'x', segments: [], coords: [] }]); // bezig → return
    App._regionJob = null;
    await App._autoCacheRegion(b, [{ id: 'x', name: 'X', segments: [[[51.31, 5.40], [51.311, 5.40]]], coords: [] }]); // vers → skip
    // oude explore-cache telt niet meer mee; ook zonder savedAt
    await DB.putRegion({ id: 'explore-cache', bounds: b, routes: [{ id: 'y' }], savedAt: '2020-01-01T00:00:00Z' });
    App._regions = await DB.allRegions();
    const oud = App._exploreCache() === null;
    await DB.putRegion({ id: 'explore-cache', bounds: b, routes: [{ id: 'y' }] });
    App._regions = await DB.allRegions();
    const zonderDatum = App._exploreCache() === null;
    // regio zonder savedAt is niet vers → wordt opnieuw binnengehaald
    const tiny = { minLat: 51.30, minLng: 5.39, maxLat: 51.301, maxLng: 5.391 };
    const cxT = (tiny.minLat + tiny.maxLat) / 2, cyT = (tiny.minLng + tiny.maxLng) / 2;
    await DB.putRegion({ id: 'region-' + Math.round(cxT * 200) + '_' + Math.round(cyT * 200), bounds: tiny, routes: [{ id: 'z' }] });
    App._regions = await DB.allRegions();
    await App._autoCacheRegion(tiny, [{ id: 'z', name: 'Z', segments: [[[51.3, 5.39], [51.301, 5.39]]], coords: [] }]);
    // regio zonder routes-lijst deert niet
    await DB.putRegion({ id: 'region-kaal', bounds: { minLat: 51.30, minLng: 5.39, maxLat: 51.32, maxLng: 5.42 }, savedAt: new Date().toISOString() });
    App._regions = await DB.allRegions();
    const kaal = Array.isArray(App._routesFromRegions(b));
    await DB.putRegion({ id: 'region-oud', bounds: { minLat: 40, minLng: 4, maxLat: 40.1, maxLng: 4.1 },
      routes: [{ id: 'o' }], savedAt: '2020-01-01T00:00:00Z' });
    App._regions = await DB.allRegions();
    const oudGeenVerseBron = App._routesFromRegions({ minLat: 40, minLng: 4, maxLat: 40.1, maxLng: 4.1 }, true).length === 0;
    return { oud, zonderDatum, kaal, oudGeenVerseBron };
  });
  t('autoCacheRegion-guards + oude cache + kale regio', guards.oud && guards.zonderDatum && guards.kaal && guards.oudGeenVerseBron, JSON.stringify(guards));

  // terug en opnieuw verkennen: cache-render + kiezen daaruit
  await page.click('#btn-back');
  await sleep(200);
  await page.evaluate(async () => { // herstel een verse explore-cache
    await DB.putRegion({ id: 'explore-cache', bounds: { minLat: 51.30, minLng: 5.39, maxLat: 51.32, maxLng: 5.42 },
      routes: [{ id: 'osm-42', name: 'Bos & Hei', ref: 'BH', colour: '#dc2626', distance: 400,
        segments: [[[51.311, 5.405], [51.313, 5.405]]], coords: [[51.311, 5.405], [51.313, 5.405]] }],
      savedAt: new Date().toISOString() });
    App._regions = await DB.allRegions();
  });
  await context.route(isOverpassHost, async (r) => { await sleep(800); r.abort(); });
  await page.click('#btn-explore');
  await sleep(400); // cache is meteen zichtbaar, netwerk hangt nog
  await page.evaluate(() => { MapView.selectExplore('osm-42'); });
  await sleep(200);
  t('kiezen uit cache-weergave werkt direct', (await txt(page, '#explore-info')).includes('Bos & Hei'));
});

/* ---------- S12c: progressief laden — alle takken (Overpass gestubt) ---------- */
await scenario('S12c progressief laden — takken', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.405, accuracy: 5 }, permissions: ['geolocation'] },
  noOverpass: true,
}, async (page, context) => {
  await context.route(isOverpassHost, (r) => r.abort());
  await open(page);
  const results = await page.evaluate(async () => {
    const out = [];
    const ok = (n, c) => out.push([n, !!c]);
    MapView.map.setView([51.312, 5.405], 14); // kaart moet een beeld hebben voor getBounds()
    const origList = Overpass.fetchRouteList;
    const origGeom = Overpass.fetchRoutesByIds;
    const origOv = Overpass.fetchOverlaysArea;
    const seg = [[[51.311, 5.405], [51.313, 5.405]]];
    const oneRoute = { id: 'osm-42', name: 'R', ref: 'R', colour: '#dc2626', distance: 400, segments: seg, coords: seg[0] };
    const prep = () => {
      App._selectedExplore = null;
      App._exploreActive = true;
      MapView.enterExplore();
      Overpass.fetchOverlaysArea = async () => ({ nodes: [], horeca: [] });
    };

    // 1) Gebruiker verliet verkennen tijdens de lijst-query → stop na fase 1.
    prep();
    Overpass.fetchRouteList = async () => { App._exploreActive = false; return [{ id: 42, tags: {} }]; };
    Overpass.fetchRoutesByIds = origGeom;
    await App._exploreFetch(true);
    ok('stale na lijst-query → netjes stoppen', true);

    // 2) Elk brokje mislukt → geen geometrie → foutpad/terugval.
    prep();
    Overpass.fetchRouteList = async () => [{ id: 42, tags: {} }];
    Overpass.fetchRoutesByIds = async () => { throw new Error('stuk'); };
    await App._exploreFetch(true);
    ok('alle brokjes stuk → geen geometrie → terugval', true);

    // 3) Verkennen verlaten tijdens een brokje → stop binnen brokje én na de pool.
    prep();
    Overpass.fetchRouteList = async () => [{ id: 42, tags: {} }];
    Overpass.fetchRoutesByIds = async () => { App._exploreActive = false; return [oneRoute]; };
    await App._exploreFetch(true);
    ok('stale binnen brokje + na pool → stoppen', true);

    // 4) Al een route gekozen tijdens het laden → hint blijft ongemoeid.
    prep();
    App._selectedExplore = oneRoute;
    Overpass.fetchRouteList = async () => [{ id: 42, tags: {} }];
    Overpass.fetchRoutesByIds = async () => [oneRoute];
    await App._exploreFetch(true);
    ok('gekozen route: hint blijft op "laden", niet op "tik er één aan"',
      !document.getElementById('explore-hint').textContent.includes('tik er één aan'));
    App._selectedExplore = null;

    // 5) Routes ok maar overlays-query faalt → overlays uit lokale opslag.
    prep();
    Overpass.fetchRouteList = async () => [{ id: 42, tags: {} }];
    Overpass.fetchRoutesByIds = async () => [oneRoute];
    Overpass.fetchOverlaysArea = async () => { throw new Error('geen overlays'); };
    await App._exploreFetch(true);
    ok('overlays-query faalt → terugval op opslag', App._exploreRoutes.length === 1);

    Overpass.fetchRouteList = origList;
    Overpass.fetchRoutesByIds = origGeom;
    Overpass.fetchOverlaysArea = origOv;

    // 6) Lagen-sheet met nog lege tellingen (nc/hc null) → geen "(… )".
    MapView._nodeCount = null; MapView._horecaCount = null;
    App.openLayers();
    ok('lagen-sheet zonder tellingen toont niets tussen haakjes',
      document.getElementById('ov-nodes-count').textContent === '' &&
      document.getElementById('ov-horeca-count').textContent === '');

    return out;
  });
  for (const [n, c] of results) t('S12c: ' + n, c);
});

/* ---------- S12b: verkennen zonder GPS en zonder offline data ---------- */
await scenario('S12b verkennen zonder GPS/data', {
  overpassBody: '{"elements":[]}',
  init: `navigator.geolocation.getCurrentPosition = (ok, err) => setTimeout(() => err({ code: 2 }), 30);`,
}, async (page, context) => {
  await open(page);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /geen bewegwijzerde/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('GPS faalt: verkennen valt terug op kaartbeeld', true);
  // offline zonder opgeslagen regio's → "geen offline routes"
  await context.setOffline(true);
  await page.click('#explore-search');
  await page.waitForFunction(() => /geen offline routes/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('offline zonder regio-data: nette hint', true);

  // offline mét precies één opgeslagen route → enkelvoud in de hint
  await page.evaluate(async () => {
    await DB.putRegion({ id: 'region-offline1', bounds: { minLat: 40, minLng: 4, maxLat: 42, maxLng: 6 },
      routes: [{ id: 'osm-1', name: 'Enige', distance: 300, segments: [[[41, 5], [41.001, 5]]], coords: [] }],
      nodes: [], horeca: [], savedAt: new Date().toISOString() });
    App._regions = await DB.allRegions();
    MapView.map.setView([41, 5], 13);
  });
  await page.click('#explore-search');
  await page.waitForFunction(() => /1 route \(offline\)/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('offline met 1 route → enkelvoud in hint', true);
});

/* ---------- S13: geen geolocation-API + kapotte SW-registratie ---------- */
await scenario('S13 geen GPS-API & SW-fout', {
  init: `delete Navigator.prototype.geolocation;
         const origReg = ServiceWorkerContainer.prototype.register;
         ServiceWorkerContainer.prototype.register = () => Promise.reject(new Error('sw kapot'));`,
}, async (page) => {
  await open(page);
  await markCached(page);
  await page.click('.route-card');
  await sleep(600);
  await page.click('#btn-locate');
  t('◎ zonder GPS-API → melding', (await txt(page, '#toast')).includes('Geen GPS'));
  await page.click('#btn-track');
  t('➤ zonder GPS-API → melding + geen HUD', await page.isHidden('#track-hud'));
  // verkennen zonder GPS-API: onErr-pad zonder fout-object
  await page.click('#btn-back');
  await page.click('#btn-explore');
  await page.waitForFunction(() => /geen GPS|tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('verkennen zonder GPS-API → nette hint', true);
  // succesvolle fix zonder accuracy-veld (geen cirkel)
  await page.evaluate(() => {
    navigator.geolocation = {
      getCurrentPosition: (ok) => ok({ coords: { latitude: 51.24, longitude: 5.33 } }),
    };
  });
  await page.click('#btn-back');
  await markCached(page);
  await page.click('.route-card');
  await sleep(500);
  await page.click('#btn-locate');
  await sleep(500);
  t('fix zonder accuracy → stip zonder cirkel',
    await page.evaluate(() => !!MapView.locMarker && !MapView.accCircle));
});

/* ---------- S13b: overlays niet geladen + offline-melding in lagen-sheet ---------- */
await scenario('S13b overlays offline-melding', { noOverpass: true }, async (page, context) => {
  await context.route(isOverpassHost, (r) => r.abort());
  await open(page);
  await markCached(page);
  await page.evaluate(async () => {
    // de meegeleverde route heeft de overlays al ingebakken — wis dat voor deze test
    const r = await DB.get('komoot-3096182502');
    delete r.overlaysFetched; delete r.nodes; delete r.horeca;
    await DB.put(r);
  });
  await page.click('.route-card');           // fetchOverlays faalt → overlaysFetched blijft false
  await sleep(900);
  await page.click('#btn-back');
  await context.setOffline(true);
  await page.click('.route-card');           // offline: maybeFetchOverlays slaat over
  await sleep(600);
  await page.click('#btn-layers');
  t('lagen-sheet meldt: overlays nog niet geladen',
    (await txt(page, '#overlays-note')).includes('verbind één keer'));
  await page.click('#layers-close');
});

/* ---------- S14: kapotte opslag ---------- */
await scenario('S14a regio-opslag kapot', {
  init: `const origTx = IDBDatabase.prototype.transaction;
         IDBDatabase.prototype.transaction = function (store, mode) {
           if (String(store) === 'regions') {
             return { objectStore: () => ({ getAll() { const r = {}; setTimeout(() => r.onerror && r.onerror({}), 0); return r; } }) };
           }
           return origTx.call(this, store, mode);
         };`,
}, async (page) => {
  await open(page);
  t('app werkt met kapotte regio-opslag', (await page.$$('.route-card')).length === 1);
  t('regions veilig leeg', await page.evaluate(() => Array.isArray(App._regions) && App._regions.length === 0));
});

await scenario('S14b indexedDB volledig kapot', {
  allowErrors: true,
  init: `indexedDB.open = () => { const r = {}; setTimeout(() => r.onerror && r.onerror({ target: r }), 0); return r; };`,
}, async (page) => {
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await sleep(800);
  t('pagina rendert ondanks kapotte opslag', await page.isVisible('#screen-list'));
  t('statuslampjes werken nog', (await txt(page, '#statusbar-list')).includes('internet'));
});

/* ---------- S15: deselecteren & opslag-eerst verkennen ---------- */
const NODES_BODY = JSON.stringify({ elements: [
  { type: 'node', lat: 51.313, lon: 5.406, tags: { rwn_ref: '71' } },
  { type: 'node', lat: 51.309, lon: 5.403, tags: { rwn_ref: '72' } },
  { type: 'node', lat: 51.311, lon: 5.404, tags: { amenity: 'cafe', name: 'De Pit' } },
] });
await scenario('S15 deselecteren & opslag-eerst', {
  ctx: { geolocation: { latitude: 51.312, longitude: 5.41 }, permissions: ['geolocation'] },
  noOverpass: true,
}, async (page, context) => {
  // Routes (LWN) + knooppunten/horeca (NODES) in één dataset; de query-bewuste
  // mock geeft elk querytype het juiste stuk terug.
  const COMBINED = JSON.stringify({ elements: [
    ...JSON.parse(LWN.toString()).elements,
    ...JSON.parse(NODES_BODY).elements,
  ] });
  const combinedH = overpassHandler(COMBINED);
  let netCalls = 0;
  await context.route(isOverpassHost, (r) => { netCalls++; combinedH(r); });
  await open(page);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('eerste verkenning gebruikt internet', netCalls >= 1, String(netCalls));
  t('knooppunten zichtbaar tijdens verkennen', (await page.$$('.kp-badge')).length === 2);
  t('horeca (koffie) zichtbaar tijdens verkennen', (await page.$$('.horeca-pin')).length === 1);
  await page.waitForFunction(() => /Gebied offline/.test(document.getElementById('toast').textContent), null, { timeout: 60000 });
  const regNodes = await page.evaluate(async () =>
    (await DB.allRegions()).some((r) => r.id.startsWith('region-') && (r.nodes || []).length === 2));
  t('knooppunten opgeslagen in de regio', regNodes);

  // selecteren en weer deselecteren via een lege plek (meervoud-tak)
  await page.evaluate(() => MapView.selectExplore(Object.keys(MapView._exploreLayers)[0]));
  await sleep(200);
  t('keuze actief', await page.$eval('#explore-follow', (el) => !el.disabled));
  t('⤢ zichtbaar bij keuze', await page.$eval('#btn-recenter', (el) => !el.hidden));
  await page.click('#btn-recenter');   // zoomt naar de gekozen route
  await sleep(400);
  t('⤢ zoomt naar gekozen route', await page.evaluate(() => {
    const grp = MapView._exploreLayers[MapView.selectedExploreId];
    return MapView.map.getBounds().contains(grp.getBounds());
  }));
  await page.evaluate(() => { MapView.map.fire('click', { latlng: L.latLng(52.0, 6.5) }); });
  await sleep(200);
  t('deselect: keuze weg + stijl hersteld', await page.evaluate(() =>
    MapView.selectedExploreId === null &&
    (() => { let w = 0; MapView._exploreLayers[Object.keys(MapView._exploreLayers)[0]]
      .eachLayer((l) => { if (!l.options._hit) w = l.options.weight; }); return w === 4; })()));
  t('⤢ verborgen zonder keuze', await page.$eval('#btn-recenter', (el) => el.hidden));
  await page.evaluate(() => { MapView.recenter(); }); // no-op zonder keuze, geen fout
  t('⤢-logica zonder keuze is no-op', true);
  t('hint terug naar meervoud', (await txt(page, '#explore-hint')).includes('routes — tik er één aan'));
  // nogmaals op leeg tikken zonder keuze: niets kapot
  await page.evaluate(() => { MapView.map.fire('click', { latlng: L.latLng(52.0, 6.5) }); });
  t('lege tik zonder keuze is no-op', await page.evaluate(() => MapView.selectedExploreId === null));

  // opslag-eerst: opnieuw verkennen gebruikt GEEN internet meer.
  // Verouder de explore-cache zodat de routes écht uit de regio-opslag
  // gerenderd worden (en niet al op de kaart voorgetekend staan).
  await page.click('#btn-back');
  await sleep(200);
  await page.evaluate(async () => {
    const regs = await DB.allRegions();
    const ec = regs.find((r) => r.id === 'explore-cache');
    ec.savedAt = '2020-01-01T00:00:00Z';
    await DB.putRegion(ec);
    App._regions = await DB.allRegions();
  });
  const before = netCalls;
  await page.click('#btn-explore');
  await page.waitForFunction(() => /opgeslagen/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('tweede verkenning komt uit opslag (hint)', true);
  t('tweede verkenning gebruikt geen internet', netCalls === before, `${before} → ${netCalls}`);
  t('routes zichtbaar uit opslag', await page.evaluate(() => Object.keys(MapView._exploreLayers).length > 3));
  t('knooppunten ook uit opslag zichtbaar', (await page.$$('.kp-badge')).length === 2);
  await page.evaluate(() => { MapView.selectExplore(MapView.exploreRoutes[0].id); });
  await sleep(200);
  t('kiezen uit opslag-weergave werkt', await page.$eval('#explore-follow', (el) => !el.disabled));

  // “Zoek hier” forceert wél een verse netwerk-zoekactie
  await page.click('#explore-search');
  await page.waitForFunction(() => /route.*tik er één aan/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('Zoek hier forceert netwerk', netCalls > before, `${before} → ${netCalls}`);

  // offline + force → routes uit opslag met (offline)-label
  await context.setOffline(true);
  await page.click('#explore-search');
  await page.waitForFunction(() => /\(offline\)/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  t('offline geforceerd zoeken → opgeslagen routes (offline)', true);
  t('offline: knooppunten uit opslag', (await page.$$('.kp-badge')).length === 2);
});

/* ---------- S17: knooppunten & horeca van heel België ---------- */
await scenario('S17 heel België offline', {
  ctx: { geolocation: { latitude: 51.2333, longitude: 5.3134 }, permissions: ['geolocation'] }, // Lommel
  overpassBody: '{"elements":[]}',   // Overpass levert NIETS — alles moet uit de landdata komen
  realCountry: true,
}, async (page, context) => {
  await open(page);
  await page.click('#btn-explore');
  await page.waitForFunction(() => /heel België offline/.test(document.getElementById('toast').textContent), null, { timeout: 30000 });
  t('landdata eenmalig binnengehaald (toast)', true);
  const reg = await page.evaluate(async () => {
    const r = (await DB.allRegions()).find((x) => x.id === 'be-overlays');
    return r ? { n: r.nodes.length, h: r.horeca.length } : null;
  });
  t('12k knooppunten + 34k horeca opgeslagen', reg && reg.n > 12000 && reg.h > 34000, JSON.stringify(reg));
  await sleep(400);
  t('knooppunten rond Lommel zichtbaar zonder Overpass', (await page.$$('.kp-badge')).length > 0);
  t('horeca rond Lommel zichtbaar zonder Overpass', (await page.$$('.horeca-pin')).length > 0);
  // cap: een stadscentrum (Antwerpen) levert duizenden horeca → maximaal 400 getekend
  const capped = await page.evaluate(() => {
    const b = { minLat: 51.17, minLng: 4.32, maxLat: 51.26, maxLng: 4.48 };
    const ov = App._overlaysFromRegions(b);
    App._renderAreaOverlays(ov, b);
    return { raw: ov.horeca.length, drawn: MapView._horecaCount };
  });
  t('stadscentrum: markers op ~400 gecapt', capped.raw > 400 && capped.drawn === 400, JSON.stringify(capped));
  // dubbel aanroepen tijdens lopende job is veilig; daarna bestaat de regio al
  await page.evaluate(() => Promise.all([App._ensureCountryOverlays(), App._ensureCountryOverlays()]));
  t('landdata wordt niet dubbel binnengehaald', true);
  // volledig offline: elders in België verkennen → knooppunten uit opslag
  await context.setOffline(true);
  await page.evaluate(() => { MapView.map.setView([51.05, 3.72], 13); }); // Gent
  await page.click('#explore-search');
  await page.waitForFunction(() => /geen offline routes|routes/.test(document.getElementById('explore-hint').textContent), null, { timeout: 20000 });
  await sleep(300);
  t('offline in Gent: horeca uit landdata', (await page.$$('.horeca-pin')).length > 0);
});

/* ---------- S17b: landdata-bootstrap faalt netjes ---------- */
await scenario('S17b landdata onbereikbaar', {
  ctx: { geolocation: { latitude: 51.2333, longitude: 5.3134 }, permissions: ['geolocation'] },
  overpassBody: '{"elements":[]}',
  realCountry: true,
}, async (page, context) => {
  let calls = 0;
  await context.route((u) => u.pathname.endsWith('/data/be-overlays.json'), (r) => {
    calls++;
    // Eerst de 404 (die cachet de service worker niet), daarna kapotte JSON
    // voor het catch-pad. Netwerkfouten zelf worden door de SW 503's.
    if (calls === 1) return r.fulfill({ status: 404, body: 'weg' });
    r.fulfill({ status: 200, contentType: 'application/json', body: 'kapot{' });
  });
  await open(page);
  await page.click('#btn-explore');
  await sleep(1200);
  t('bootstrap-404 is stil', true);
  await page.click('#btn-back');
  await page.click('#btn-explore');
  await sleep(1200);
  t('bootstrap met kapotte JSON is stil', true);
});

/* ---------- S18: GPX-import (bestand + URL + proxy-fallback) ---------- */
await scenario('S18 GPX-import', { noKomoot: true, noOverpass: true }, async (page, context) => {
  // GPX-import heeft geen OSM-overlays nodig; Overpass afknippen houdt elke
  // route-opening licht (geen extra fetch/rendering) én voorkomt dat de
  // "Knooppunten geladen"-toast de import-melding overschrijft.
  await context.route(isOverpassHost, (r) => r.abort());
  const GPX_XML = readFileSync(path.join(ROOT, 'tests/fixtures/test-route.gpx'), 'utf8');
  // Unieke coördinaten per bron → verschillende id's (id = hash van coords).
  const gpxAt = (lat, name) => `<gpx><trk><name>${name}</name><trkseg>` +
    `<trkpt lat="${lat}" lon="5.31"/><trkpt lat="${lat + 0.002}" lon="5.312"/><trkpt lat="${lat + 0.004}" lon="5.314"/>` +
    `</trkseg></trk></gpx>`;
  await open(page);

  // via bestand (volledig offline pad)
  await page.setInputFiles('#gpx-file', path.join(ROOT, 'tests/fixtures/test-route.gpx'));
  await page.waitForFunction(() => /Testlus Lommel/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('GPX-bestand → route geopend', true);
  t('afstand berekend', (await txt(page, '#map-route-meta')).includes('km'));
  await page.click('#btn-back');
  await sleep(300);
  t('GPX-route in de lijst', (await page.$$eval('.route-card .name', (els) => els.map((e) => e.textContent))).includes('Testlus Lommel'));

  // her-import behoudt eigen naam
  await page.evaluate(async () => {
    const routes = await DB.all();
    const g = routes.find((r) => r.source === 'gpx');
    g.name = 'Mijn bordjeslus';
    await DB.put(g);
  });
  await page.setInputFiles('#gpx-file', path.join(ROOT, 'tests/fixtures/test-route.gpx'));
  await page.waitForFunction(() => /Mijn bordjeslus/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('her-import behoudt eigen naam', true);
  await page.click('#btn-back');

  // via URL (direct)
  await context.route((u) => u.host === 'voorbeeld.be', (r) =>
    r.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxAt(50.10, 'URL-lus') }));
  await page.fill('#url-input', 'https://voorbeeld.be/tochten/mooie-lus.gpx');
  await page.click('#btn-load');
  await page.waitForFunction(() => /URL-lus/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('GPX-URL → route geopend', true);
  await page.click('#btn-back');

  // via URL met CORS-blokkade → proxy-fallback (zoals nuttelozeborden.be)
  await context.route((u) => u.host === 'geblokkeerd.be', (r) => r.abort());
  await context.route((u) => /corsproxy\.io/.test(u.host), (r) =>
    r.fulfill({ status: 200, contentType: 'application/gpx+xml', body: gpxAt(50.20, 'Proxy-lus') }));
  await page.fill('#url-input', 'https://geblokkeerd.be/w.gpx');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Proxy-lus/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('CORS-geblokkeerde GPX via proxy-fallback', true);
  await page.click('#btn-back');

  // losse-punten-GPX: nette melding + toch bruikbaar
  const WPT = '<gpx><metadata><name>Bordjes Perk</name></metadata><wpt lat="51.23" lon="5.31"/><wpt lat="51.232" lon="5.312"/><wpt lat="51.234" lon="5.314"/></gpx>';
  await context.route((u) => u.host === 'bordjes.be', (r) =>
    r.fulfill({ status: 200, contentType: 'application/gpx+xml', body: WPT }));
  await page.fill('#url-input', 'https://bordjes.be/locaties.gpx');
  await page.click('#btn-load');
  await page.waitForFunction(() => /losse punten verbonden/.test(document.getElementById('toast').textContent), null, { timeout: 25000 });
  t('waypoint-GPX: eerlijke melding + route', (await txt(page, '#map-route-name')).includes('Bordjes Perk'));
  await page.click('#btn-back');

  // alle bronnen falen → nette fout; kapot bestand → nette fout
  await context.route((u) => /allorigins/.test(u.host), (r) => r.fulfill({ status: 500, body: 'nee' }));
  await context.route((u) => /corsproxy\.io/.test(u.host), (r) => r.fulfill({ status: 500, body: 'nee' }));
  await context.route((u) => u.host === 'stuk.be', (r) => r.abort());
  await page.fill('#url-input', 'https://stuk.be/w.gpx');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Mislukt/.test(document.getElementById('load-status').textContent), null, { timeout: 25000 });
  t('onbereikbare GPX-URL → nette fout', true);
  const bad = path.join(ROOT, 'tests/fixtures/tour.json'); // geen XML
  await page.setInputFiles('#gpx-file', bad);
  await page.waitForFunction(() => /geen geldig GPX/.test(document.getElementById('load-status').textContent), null, { timeout: 25000 });
  t('kapot bestand → nette fout', true);

  // naam uit <metadata> als trk/rte naamloos is (we staan nog op de lijst)
  await context.route((u) => u.host === 'meta.be', (r) =>
    r.fulfill({ status: 200, contentType: 'application/gpx+xml',
      body: '<gpx><metadata><name>Enkel-metadata</name></metadata><trk><trkseg><trkpt lat="50.40" lon="5.31"/><trkpt lat="50.402" lon="5.312"/></trkseg></trk></gpx>' }));
  await page.fill('#url-input', 'https://meta.be/w.gpx');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Enkel-metadata/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('gpx: naam uit metadata bij naamloze trk', true);
  await page.click('#btn-back');

  // 📂-knop opent de bestandskiezer én laadt het gekozen bestand
  page.once('filechooser', (fc) => fc.setFiles(path.join(ROOT, 'tests/fixtures/test-route.gpx')));
  await page.click('#btn-gpx');
  await page.waitForFunction(() => /Lommel|bordjeslus/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('📂 opent bestandskiezer en laadt', true);
});

/* ---------- S19: KML / Google My Maps-import (Nutteloze Borden Genk) ---------- */
await scenario('S19 KML-import', { noKomoot: true }, async (page, context) => {
  const GENK_KML = readFileSync(path.join(ROOT, 'tests/fixtures/genk-mymaps.kml'), 'utf8');
  await open(page);

  // Google My Maps-viewerlink → app haalt de KML-export op (host www.google.com)
  await context.route((u) => u.host === 'www.google.com', (r) => {
    const ok = /\/maps\/d\/kml\?mid=107C_ri1EnHn3t/.test(r.request().url());
    r.fulfill(ok
      ? { status: 200, contentType: 'application/xml', body: GENK_KML }
      : { status: 404, body: 'nee' });
  });
  await page.fill('#url-input', 'https://www.google.com/maps/d/u/0/viewer?mid=107C_ri1EnHn3t-esIZOroBucXEbBbOc&ll=50.96%2C5.50&z=16');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Nuttelozebordenroute Genk/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('My Maps-link → route geopend', true);
  t('afstand ± 3,9 km', (await txt(page, '#map-route-meta')).includes('km'));
  // de 69 genummerde bordjes staan als waypoints op de kaart, met hun naam als tooltip
  await page.waitForSelector('.kp-badge', { timeout: 10000 });
  const badges = await page.$$eval('.kp-badge', (els) => els.map((e) => e.textContent));
  t('genummerde bord-badges getekend', badges.length > 20 && badges.includes('1'), `${badges.length} badges`);
  t('bordjes zitten in waypoints, niet in knooppunten', await page.evaluate(() =>
    (MapView.route.waypoints || []).length === 69 && (MapView.route.nodes || []).length === 0));
  const tip = await page.evaluate(() => {
    const m = MapView.waypointLayer.getLayers()[0];
    return m ? m.getTooltip().getContent() : '';
  });
  t('tooltip toont bordnaam i.p.v. "Wandelknooppunt"', !/Wandelknooppunt/.test(tip) && tip.length > 2, tip);
  // Bordje is aantikbaar → popup met de naam (tooltips tonen niet bij een tik).
  const pop = await page.evaluate(() => {
    const m = MapView.waypointLayer.getLayers()[0];
    m.openPopup();
    const open = !!document.querySelector('.leaflet-popup .wp-popup');
    return { content: m.getPopup() ? m.getPopup().getContent() : '', open };
  });
  t('bordje aantikbaar → popup met naam opent', pop.open && /\w/.test(pop.content), JSON.stringify(pop));
  // Touch-tolerant: een tik NAAST een badge opent toch het dichtstbijzijnde punt.
  t('tik naast een badge → dichtstbijzijnde punt opent', await page.evaluate(() => {
    MapView.map.closePopup();
    const m = MapView.waypointLayer.getLayers()[0];
    const p = MapView.map.latLngToContainerPoint(m.getLatLng());
    const q = L.point(p.x + 25, p.y + 25);
    MapView.map.fire('click', { containerPoint: q, latlng: MapView.map.containerPointToLatLng(q) });
    return !!document.querySelector('.leaflet-popup');
  }));
  // Ver van alle bordjes → geen popup (drempel ~34 px).
  t('tik ver van alle bordjes → geen popup', await page.evaluate(() => {
    MapView.map.closePopup();
    MapView.map.setView([50.99, 5.62], 15, { animate: false });
    const q = L.point(120, 120);
    MapView.map.fire('click', { containerPoint: q, latlng: MapView.map.containerPointToLatLng(q) });
    return !document.querySelector('.leaflet-popup');
  }));
  // REGRESSIE: bordjes horen bij de route → blijven zichtbaar ook als de
  // knooppunten-schakelaar UIT staat (ze zijn géén knooppunten).
  await page.evaluate(() => { App.setOverlay('nodes', false); });
  t('bordjes blijven zichtbaar met knooppunten UIT',
    (await page.$$('.kp-badge')).length > 20 &&
    await page.evaluate(() => MapView.map.hasLayer(MapView.waypointLayer)));
  await page.evaluate(() => { App.setOverlay('nodes', true); });
  // Naar "Nieuwe wandeling" (enterExplore) ruimt de route-visual incl. waypoints op.
  t('waypoints opgeruimd bij verlaten route', await page.evaluate(() => {
    const had = !!MapView.waypointLayer;
    MapView.enterExplore();
    return had && !MapView.waypointLayer;
  }));
  t('waypoint-tap zonder laag → veilige no-op', await page.evaluate(() => {
    MapView._waypointNearestTap({ containerPoint: L.point(10, 10) }); // geen laag → return
    return true;
  }));
  await page.click('#btn-back');
  await sleep(200);
  t('KML-route in de lijst', (await page.$$eval('.route-card .name', (els) => els.map((e) => e.textContent))).some((n) => /Genk/.test(n)));

  // directe .kml-URL met CORS-blokkade → proxy-fallback (zoals GPX)
  const SIMPLE = '<kml><Document><name>Proxy-KML</name><Placemark><LineString><coordinates>5.0,51.0,0 5.0,51.002,0 5.002,51.002,0</coordinates></LineString></Placemark></Document></kml>';
  await context.route((u) => u.host === 'geblokkeerd.be', (r) => r.abort());
  await context.route((u) => /corsproxy\.io/.test(u.host), (r) =>
    r.fulfill({ status: 200, contentType: 'application/xml', body: SIMPLE }));
  await page.fill('#url-input', 'https://geblokkeerd.be/route.kml');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Proxy-KML/.test(document.getElementById('map-route-name').textContent), null, { timeout: 25000 });
  t('CORS-geblokkeerde KML via proxy-fallback', true);
  await page.click('#btn-back');

  // alle bronnen falen → nette fout (HTTP-fout-tak + throw lastErr)
  await context.route((u) => u.host === 'stuk.be', (r) => r.fulfill({ status: 500, body: 'nee' }));
  await context.route((u) => /corsproxy\.io|allorigins/.test(u.host), (r) => r.fulfill({ status: 500, body: 'nee' }));
  await page.fill('#url-input', 'https://stuk.be/w.kml');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Mislukt/.test(document.getElementById('load-status').textContent), null, { timeout: 25000 });
  t('onbereikbare KML → nette fout', true);

  // onbekende link (geen gpx/kml/komoot) → duidelijke melding
  await page.fill('#url-input', 'https://ergens.be/pagina');
  await page.click('#btn-load');
  await page.waitForFunction(() => /Google My Maps/.test(document.getElementById('load-status').textContent), null, { timeout: 25000 });
  t('onbekende link → noemt Komoot/GPX/KML', true);
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

// UNCOVERED=1 npm test → toon de ongedekte stukken bron per bestand.
if (process.env.UNCOVERED) {
  console.log('\n──────── ONGEDEKT ────────');
  for (const [url, { len, bytes }] of rows) {
    const rel = url.replace(BASE + '/', '');
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    console.log(`\n### ${rel}`);
    let i = 0;
    while (i < len) {
      if (!bytes[i]) {
        let j = i;
        while (j < len && !bytes[j]) j++;
        if (j - i > 1) {
          const line = src.slice(0, i).split('\n').length;
          console.log(`  [r${line}] ${JSON.stringify(src.slice(i, Math.min(j, i + 200)))}`);
        }
        i = j;
      } else i++;
    }
  }
}

console.log(`\n──────── RESULTAAT: ${pass} geslaagd, ${fail} gefaald ────────`);
if (failures.length) { console.log('Gefaald:'); for (const f of failures) console.log('  ✗ ' + f); }
process.exit(fail ? 1 : 0);
