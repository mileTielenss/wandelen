# CLAUDE.md — overdracht & werkafspraken

Dit bestand is de gids voor iedereen (mens of Claude-sessie) die aan deze repo
verder werkt. Lees het vóór je code wijzigt. De README is voor gebruikers;
dit document is voor ontwikkelaars.

## Wat dit project is

Een volledig offline **PWA voor wandelroutes** (Nederlandstalige UI, gebruiker in
Lommel, België). Kern: Komoot-routes importeren, bewegwijzerde routes in de buurt
verkennen, onderweg valideren dat je juist zit — alles met **minimaal
batterijverbruik** en **alles automatisch offline**.

- Live: **https://miletielenss.github.io/wandelen/** (GitHub Pages, branch `main`, root)
- Deploy = gewoon pushen naar `main`. Geen build, geen CI.
- Eén branch (`main`). Historiek is beschrijvend; lees `git log` voor de "waarom" per feature.

## Snel starten

```bash
python3 -m http.server 8080     # app lokaal op http://localhost:8080
npm install && npm test         # testsuite (332 asserts) + coverage-rapport
UNCOVERED=1 npm test            # toont ongedekte regels (hoort leeg te zijn)
```

## Architectuur

**Bewust géén framework, géén build-stap, géén modules-bundler.** Plain JS in
IIFE's die globals registreren. `index.html` laadt de scripts in deze volgorde
(volgorde is betekenisvol — latere scripts gebruiken de globals van eerdere):

| Bestand | Global | Verantwoordelijkheid |
|---|---|---|
| `js/db.js` | `DB` | IndexedDB-opslag: routes + regio's |
| `js/komoot.js` | `Komoot` | Komoot-URL parsen, tour ophalen, naar routeformaat |
| `js/gpx.js` | `GPX` | GPX (URL of bestand) parsen: trk → rte → wpt, naar routeformaat |
| `js/kml.js` | `KML` | KML / Google My Maps parsen: LineString → route, Point → genummerde punten (bv. bordjes). Bron voor routes die enkel als "digitaal routeplan" bestaan |
| `js/overpass.js` | `Overpass` | OSM/Overpass: knooppunten, horeca, wandellussen (lwn/rwn-relaties). Progressief laden: lijst (`fetchRouteList`) → geometrie per brokje (`fetchRoutesByIds`) → overlays (`fetchOverlaysArea`); hedged mirrors + extern abort-`signal` |
| `js/tiles.js` | `Tiles` | Kaartlagen-catalogus, tegelplanning (corridor/bbox), downloads naar Cache Storage |
| `js/map.js` | `MapView`, `Geo` | Leaflet-kaart, route/overlays tekenen, locatie (1×/tracking), verken-laag, geometrie |
| `js/app.js` | `App` | Schermen, flows, statuslampjes, auto-caching, voorkeuren, event-bedrading |
| `sw.js` | — | Service worker: app-shell (stale-while-revalidate) + tegels (cache-first) |

`vendor/leaflet/` is Leaflet 1.9.4, **lokaal meegeleverd** (offline-eis: geen CDN).
`data/default-route.json` is de vooraf ingebakken route incl. `nodes`/`horeca`.
`data/be-overlays.json` (±2,7 MB) = álle knooppunten + horeca van België; wordt bij
eerste verkenning lazy opgehaald en als regio `be-overlays` in IndexedDB gezet
(`App._ensureCountryOverlays`). Renderen is gecapt op de ~400 dichtstbijzijnde per
soort (`_renderAreaOverlays`) — anders sterft de DOM in een stadscentrum. Herbouwen:
zelfde Overpass-queries als `tests/refresh-fixture.mjs` maar met `area(3600052411)`.
Iconen in `icons/` zijn statisch gegenereerd (pure-Python PNG-writer; eenmalig).

### Dataformaten

Route (IndexedDB store `routes`, keyPath `id`):
```js
{ id: 'komoot-<tourId>' | 'osm-<relId>',   // bron bepaalt prefix
  source: 'komoot' | 'osm' | 'gpx' | 'kml',   // gpx/kml: id = '<bron>-'+hash(coords); gpxVorm 'track'|'route'|'punten'
  name, sport, distance /*m*/, elevationUp, elevationDown, duration,
  coords: [[lat, lng, alt], …],            // volledige polyline
  nodes:  [{ ref, lat, lng }, …],          // wandelknooppunten (Overpass), via 🗺-schakelaar
  waypoints: [{ ref, name, lat, lng }, …], // route-EIGEN punten (KML/bordjes): ALTIJD zichtbaar
  horeca: [{ n /*naam*/, t /*type*/, lat, lng }, …],
  overlaysFetched: bool,                   // nodes/horeca al opgehaald?
  tilesCached: bool, tileDetail, tileMaps: ['voyager', …],  // per kaartlaag gecachet
  importedAt: ISO-string }
```

Regio (store `regions`): `{ id: 'region-<lat*200>_<lng*200>' | 'explore-cache',
bounds: {minLat,minLng,maxLat,maxLng}, routes: […], nodes: […], horeca: […], savedAt }`.
Knooppunten + horeca + routes worden in verken-modus als vaste overlays getoond
(`MapView.renderExploreOverlays`), ook offline via `_overlaysFromRegions`.

**Progressief laden** (i.p.v. één trage gecombineerde aanvraag): `_exploreFetch`
haalt routes in fasen op zodat er meteen iets zichtbaar is en de kaart bruikbaar blijft:
1. **Fase 1 — lijst** (`Overpass.fetchRouteList` → `listQuery`, `out tags qt`):
   piepklein, enkel route-ids + tags, zodat we direct het aantal weten.
2. **Fase 2 — geometrie** (`Overpass.fetchRoutesByIds` → `geomQuery`, `rel(id:…);out geom qt`):
   de ids in brokjes van 6, met een concurrency-pool van 3 (`_runPool`); élk brokje
   verschijnt meteen op de kaart via `MapView.addExploreRoutes` (niet-destructief —
   een reeds gekozen route en tikken blijven behouden).
3. **Overlays** (`Overpass.fetchOverlaysArea` → `out center qt`): parallel gestart,
   blokkeert het tekenen van routes niet.

Een nieuwe zoekactie breekt de vorige stroom af via een `AbortController`
(`this._exploreAbort`); `postQuery` neemt een extern `signal`. `_exploreFetch` bewaakt
verouderde antwoorden met een `stale()`-check (`mySeq` vs `_exploreSeq`, plus
`_exploreActive`). Bij een netwerkfout valt hij terug op opgeslagen regio's.
(`areaQuery`/`out geom(bbox)` bestaan alleen nog voor `tests/refresh-fixture.mjs` en
de fixture; de app gebruikt ze niet meer.)

`explore-cache` = laatste verkenresultaat (max 7 dagen); `region-*` = automatisch
offline opgeslagen verkende gebieden (30 dagen vers). Verkennen is **opslag-eerst**:
`_exploreFetch()` zonder `force` gebruikt verse `region-*`-routes zonder netwerk;
“Zoek hier” roept `_exploreFetch(true)` aan en gaat wél naar Overpass.

Overig: `localStorage['wandelen-prefs']` = `{ basemap, showNodes, showHoreca }`.
Cache Storage: `wandelen-app-v4` (shell), `wandelen-tiles-v1` (alle kaartlagen door elkaar,
sleutel = volledige tegel-URL).

## Externe diensten (en hun beperkingen)

| Dienst | Gebruik | Let op |
|---|---|---|
| `api.komoot.de/v007/tours/<id>?…` | route-import | CORS open; `share_token` verplicht voor privétours; fallback via corsproxy.io / allorigins |
| GPX-URL of -bestand (`GPX.importFromUrl` / `GPX.parse`) | route-import | Veel sites (natuurpunt, nuttelozeborden.be) sturen geen CORS-headers → zelfde proxy-fallback als Komoot. `wpt`-only bestanden = losse punten, verbonden in bestandsvolgorde (`gpxVorm:'punten'`) |
| KML-URL of Google My Maps-link (`KML.importFromUrl` / `KML.parse`) | route-import | Google My Maps-viewerlink → publieke KML-export (`/maps/d/kml?mid=…&forcekml=1`); zelfde proxy-fallback (Google stuurt geen CORS). `LineString` → route, `Point`-placemarks → `waypoints` met `ref`=bordnummer + `name`. Waypoints zijn route-eigen en worden **altijd** getekend (`MapView._setWaypoints`, los van de knooppunten-schakelaar — het zijn géén knooppunten). Zet `overlaysFetched:true` als er eigen punten zijn (geen OSM-overlays ophalen). Zo werkt de **Nutteloze Borden**-route van Genk (69 bordjes, geen GPX) toch |
| Overpass (kumi.systems → overpass-api.de → private.coffee) | knooppunten, horeca, wandelroutes (lwn + rwn zonder `network:type=node_network`, plus routes zonder network-tag — dekt ook Duitse Wanderwege; geometrie VOLLEDIG met `out geom` — bewuste keuze: wie een route volgt wil heel het
traject, en de bbox-klem begrenst het aantal relaties; afstand bij voorkeur uit de
`distance`-tag). **Progressief**: eerst een lichte lijst-query (`out tags`), dan de geometrie per brokje (`rel(id:…);out geom`) | **Hedged**: alle mirrors parallel gestart met 3,5 s tussenstart, eerste antwoord wint. Query-timeout 20–25 s, client-timeout 12–16 s. Extern `signal` breekt alle pogingen af. Zoekgebied altijd klemmen (±0.16°) |
| Carto Voyager `@2x` (standaard), Esri World Imagery, OpenTopoMap | kaarttegels | Vaste subdomeinen (geen `{s}`) zodat cache-URL's deterministisch zijn. **Fair use**: nooit bulk (heel België ≈ 20 GB — bewust niet ondersteund; corridor/regio volstaat) |

## Ontwerpprincipes (niet breken)

1. **Offline-first.** Elke feature moet werken zonder internet nadat hij één keer
   online gebruikt is. Nieuwe data → IndexedDB of Cache Storage, en de
   service worker moet ze serveren.
2. **Batterij.** GPS staat standaard uit; ◎ = één verse meting, ➤ = expliciete
   tracking-stand met Stop. Auto-centreren stopt zodra de gebruiker pant.
3. **Eerlijke statuslampjes.** De internet/GPS-indicators tonen **gebruik**, geen
   beschikbaarheid: grijs in rust, alleen actief tijdens echt verkeer/echte metingen,
   "volgt" pas bij een echte GPS-fix. (`App._wrapFetch` telt externe requests.)
4. **Alles automatisch.** Geen handmatige download-knoppen: route openen of gebied
   verkennen met internet = tegels + data op de achtergrond cachen (voortgang in statusbalk).
5. **Zuinig renderen.** Kaartvectoren via canvas (één element i.p.v. honderden
   SVG-nodes); statusbalk-DOM alleen herschrijven als de inhoud echt wijzigt.
6. **Touch-tolerant.** Routes kiezen mag niet pixel-precies hoeven: brede onzichtbare
   raaklijnen (26 px, `_hit: true`) + kaart-brede dichtstbijzijnde-route-fallback (~28 px).
   Tik op een leeg stuk kaart = **deselecteren** (`MapView.deselectExplore` →
   `App.onExploreDeselect`). Hertekenen van de verkende laag alleen als het resultaat
   écht verschilt (anders verdwijnt de laag onder de vinger van de gebruiker).
7. **Nederlandstalige UI**, komma als decimaalteken ("18,8 km").

## Tests — 100% coverage is de norm

`tests/run.mjs` = eigen runner (Playwright-core + headless Chromium, geen testframework).
Scenario's S1–S19: unit-tests in-page, alle UI-flows, alle foutpaden via foutinjectie.
`tests/fixtures/area-real.json` = **bevroren écht Overpass-antwoord** (Hageven, incl.
null-punten en alle rariteiten) waar de parsers elke run tegen draaien; ververs hem
met `node tests/refresh-fixture.mjs` na elke wijziging aan `areaQuery` of de parsers.

**Snelheid (hou de run < ~90 s).** De volledige suite draait sequentieel; elk
scenario print zijn eigen tijd (`⏱ …`) zodat een uitschieter meteen zichtbaar is.
De grootste valkuil is de **hedged-mirror stagger** (`HEDGE_MS`, prod 3,5 s): een
foutpad-test zou anders bij élke query seconden op die staggers wachten. `open()`
zet daarom `Overpass._test.setHedgeMs(120)` — de hedge-**logica** blijft getest
(mirror 2 start ná mirror 1), enkel véél sneller. Gebruik **geen vaste `sleep()`
op iets waar je op een conditie kan wachten** (`waitForFunction`/`waitForSelector`);
kunstmatige mock-vertragingen kort houden. Time-outs in traag-ladende scenario's (S18)
staan bewust ruim (25 s) — die kosten niets als het snel gaat en voorkomen flakes
onder belasting. Draai altijd **één** run tegelijk (kill eerst node-strays); twee
parallelle runs botsen op poort 8199 → exit 1 met lege output.

Coverage over `js/*.js` staat op **100,0% (byte-niveau)**; hou dat zo:

- Nieuwe code → tests in hetzelfde commit. Draai `UNCOVERED=1 npm test` en dek
  wat verschijnt. **Onbereikbare defensieve code verwijder je** in plaats van hem
  te laten staan (dat is hier de stijl: geen dode `try/catch`- of `||`-fallbacks).
- `sw.js` valt buiten page-coverage (worker); het gedrag ervan wordt functioneel
  getest in S8 (offline herstart). Wijzig je `sw.js`, breid S8 uit.

Valkuilen die al eens gekost hebben (niet opnieuw ontdekken):
- **Mock op host, niet op URL**: een route-regex als `/overpass/` onderschept ook
  het eigen `js/overpass.js` en vervangt het door JSON → "Unexpected token ':'".
  Gebruik de bestaande predicates (`isOverpassHost`, host-checks).
- `page.waitForFunction(fn, ARG, {timeout})` — opties zijn het **derde** argument.
- De **service worker maskeert tegelfouten** (geeft een placeholder terug): wil je
  het foutpad van `Tiles.download` testen, gebruik 5xx-antwoorden of injecteer een
  kapotte `Cache.prototype.put`, geen `abort()`.
- Headless geolocation zonder permissie **hangt** (geen timeout) — stub
  `navigator.geolocation` via `addInitScript`/`defineProperty` voor foutpaden.
- De **default route heeft `overlaysFetched: true` ingebakken** — wis die vlag als
  een test het "nog niet geladen"-pad nodig heeft.
- Playwright-`geolocation` geeft standaard `accuracy: 0` → geef expliciet
  `accuracy` mee om de nauwkeurigheidscirkel te testen.
- De kaart rendert met **canvas** (`preferCanvas: true`) — er zijn géén SVG-paths
  om op te asserten of te klikken; controleer laag-objecten via `evaluate` en klik
  met `page.mouse.click` op containerpunt-coördinaten.
- `page.evaluate(() => MapView.map.fire(...))` e.d. geven het **map-object** terug →
  "Cannot serialize result". Wikkel Leaflet-aanroepen in `{ }` zodat er niets terugkeert.
- **`out geom(bbox)` levert `null`-punten** voor way-geometrie buiten het
  zoekgebied (heeft in productie de verkenfunctie gebroken — fixtures waren te
  schoon). `parseRoutes` splitst ways op die gaten; test nieuwe parsers altijd
  óók tegen een echt Overpass-antwoord, niet enkel tegen handgemaakte fixtures.
- **`setView` met animatie + meteen `getBounds()` = oude grenzen** — de zoekactie
  na een GPS-fix zocht daardoor naast je locatie. Locatie-sprongen doen we met
  `animate: false`.
- De **service worker cachet 200-antwoorden** van eigen bestanden (SWR): een test
  die per aanroep ander gedrag wil, moet met het niet-gecachete geval (bv. 404)
  beginnen.

## Service worker & updates

App-shell = **stale-while-revalidate**: gebruikers krijgen updates automatisch bij
het volgende bezoek (één herstart van de app na deploy). Tegels = cache-first.
`APP_CACHE`-versie (`wandelen-app-v4`) hoef je door SWR meestal niet te bumpen;
doe het wél als je bestanden **verwijdert/hernoemt** of `APP_ASSETS` wijzigt.
Voeg je een nieuw statisch bestand toe → zet het in `APP_ASSETS` in `sw.js`
én laad het in `index.html`.

## Hernieuwbare assets

- `data/default-route.json`: Komoot-tour 3096182502 + Overpass-overlays, samengevoegd.
  Herbouwen: haal de tour op via de API (zie Externe diensten), map naar het
  routeformaat hierboven, voeg `nodes`/`horeca` uit Overpass toe (bbox = route + ~0.012°).
- `icons/*.png`: eenmalig gegenereerd (groene gradient, witte routelijn, rode stip);
  bij een redesign gewoon vervangen, zelfde bestandsnamen/maten (192/512/maskable/180/64).

## Uitbreidingsideeën (eerder besproken, nog niet gebouwd)

- **GR-routes** (Grote Routepaden / Grande Randonnée) in "Nieuwe wandeling". Nu filtert
  `ROUTE_FILTER` (js/overpass.js) enkel `lwn|rwn` (lokaal/regionaal); GR's zitten als
  `network=nwn|iwn` in OSM. Idee: die netwerken erbij (evt. als aparte laag/kleur, want
  het zijn lange lijnen i.p.v. lussen). Gevraagd door de gebruiker — "voor later".
- **Hoogteprofiel** onder de kaart (alt zit al in `coords[i][2]`).
- **Kilometermarkeringen** langs de route (cumulatieve afstand zit in `MapView._cum`).
- Meerdere Overpass-gebieden slimmer samenvoegen (nu: losse `region-*`-records).
- Routebeschrijving/bochtaanwijzingen uit de Komoot-`path`-data.

Werkwijze bij uitbreidingen: klein houden, in het bestaande patroon (IIFE + global,
Nederlandstalige UI-strings, offline-pad meteen meebouwen), tests + 100% coverage
in hetzelfde commit, en `README.md` bijwerken als het gebruikersgedrag verandert.
