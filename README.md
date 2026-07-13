# Wandelen — offline PWA voor wandelroutes

Een volledig offline **Progressive Web App** om wandelroutes te bekijken en onderweg
te valideren of je nog juist zit — met **minimaal batterijverbruik**. Routes komen
van **Komoot**: plak een gedeelde tour-URL en de route wordt automatisch ingeladen
en lokaal bewaard.

De app is voorgeladen met de route **“from Lommel to Grote Heide”** (18,8 km).

## Wat de app doet

- **Startscherm** met een URL-balk + **Laden**-knop en een lijst van je opgeslagen routes.
- **Komoot-import**: plak een URL zoals
  `https://www.komoot.com/nl-nl/tour/3096182502?share_token=…` en de route laadt automatisch in.
  Meerdere routes inladen kan; ze blijven bewaard.
- **Openen & hernoemen**: tik een route open op de kaart, of gebruik het `⋯`-menu
  (of lang indrukken) om te **hernoemen** of te **verwijderen**.
- **Kaart** met de volledige route om te valideren dat je nog op het juiste pad zit.
- **Locatie in drie standen** — bewust gescheiden om batterij te sparen:
  1. **Kaart** (standaard): enkel de route, **GPS uit**.
  2. **◎ Toon mijn locatie**: één verse GPS-meting, zet een stip op de kaart. GPS gaat daarna weer uit.
  3. **➤ Volg mijn locatie** (tracking): aparte, expliciete stand met live positie. Stopt zodra je op **Stop** tikt.
- **Hoe ver nog?** Zodra je locatie bekend is, toont de balk bovenaan je **voortgang
  langs de route**: bv. *km 8,4 van 18,8 · nog 10,4 km · 45%*. Ben je van het pad af,
  dan zie je hoever (en bij welk punt je het dichtst zit).
- **Scherpe kaart + kaartlagen** (🗺-knop): kies tussen **Kaart — scherp** (@2x-tegels,
  haarscherp op retina, ook uitgezoomd), **Satelliet** (luchtfoto) en **Topografisch**
  (hoogtelijnen). Je keuze blijft bewaard.
- **Wandelknooppunten**: de genummerde knooppunten worden als badges getoond (bv. **71**)
  — bij een geopende route de knooppunten die je route volgt, en tijdens **Nieuwe
  wandeling** álle knooppunten van het gebied, zodat je op de bordjes-nummers kan
  zoeken. Aan/uit via 🗺.
- **Horeca (☕)**: cafés, restaurants, snackbars en bakkers staan als koffie-icoontjes op
  de kaart — langs je route én in het verkende gebied. Standaard aan; aan/uit via 🗺.
- **Nieuwe wandeling — routes in de buurt** (🧭, geen Komoot nodig): opent een kaart met
  álle bewegwijzerde wandelroutes rond je, elk in **de kleur van de pijltjes** en met de
  **afstand** — ook in **Duitsland** (lokale lussen én regionale Wanderwege; bij lange
  trajecten wordt de officiële afstand getoond). Tik ◎ om te zien op welke routes je staat, kies er één en tik **Volg** —
  dan wordt die route ingeladen zoals gewoonlijk en vanaf dan volledig offline.
  Tik je op een **leeg stuk kaart**, dan wordt de keuze weer losgelaten en kan je
  verder zoeken. Het verkende gebied (kaart + routes) wordt **automatisch** offline
  opgeslagen; kom je er later terug, dan komen de routes **uit die opslag** — zonder
  internet. **🔄 Zoek hier** haalt ze desgewenst opnieuw vers op.
- **Alles automatisch offline**: opent je een route met internet, dan downloadt de app
  de kaarttegels er meteen bij (hoogste resolutie, voortgang in de statusbalk). Route,
  knooppunten en horeca worden sowieso lokaal opgeslagen — geen aparte knop meer nodig.
- **Status-indicators**: de lampjes bovenaan tonen **gebruik**, geen beschikbaarheid —
  grijs als de app niets doet, **internet actief** alleen tijdens echt verkeer, en de
  GPS-stand (uit / zoekt… / volgt / geweigerd). Tracking claimt pas "volgt" als er
  echt een GPS-fix is.

> Kaarttegels voor een héél land (bv. heel België) zijn bewust niet mogelijk: dat zijn
> tientallen GB en de tegel-providers staan bulk-downloads niet toe. De streek waar je
> wandelt of verkent wordt automatisch gecachet; dat is ruim voldoende.

## Batterijzuinig ontwerp

- GPS staat **standaard uit**. “Toon locatie” doet **één** meting i.p.v. continu volgen.
- Tracking is een **aparte stand** die je expliciet start en stopt.
- Auto-centreren tijdens tracking stopt zodra je zelf de kaart verschuift.
- Geen kaart-animaties die onnodig hertekenen; “scherm aan houden” is optioneel en standaard uit.
- Geen frameworks — lichte, vanilla JS.

## Hosten op GitHub Pages

De app staat op de `main`-branch en is statische HTML/JS/CSS. GitHub Pages aanzetten
is een eenmalige klik:

1. Ga naar **Settings → Pages**.
2. Bij **Build and deployment → Source** kies **Deploy from a branch**.
3. Kies **Branch: `main`** en map **`/ (root)`**, en klik **Save**.

Na ~1 minuut staat de app live op:

> **https://miletielenss.github.io/wandelen/**

Elke push naar `main` werkt de site automatisch bij. Open de link op je telefoon en
kies **“Toevoegen aan startscherm”** om de PWA te installeren (over HTTPS werken de
service worker, GPS en offline-opslag).

### Lokaal testen

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Een nieuwe route toevoegen

1. Open de tour in Komoot en deel ze (**Delen → Link kopiëren**) zodat de URL een
   `share_token` bevat.
2. Plak de URL in de balk op het startscherm en tik **Laden** — de route opent meteen
   en de kaart wordt automatisch offline opgeslagen (met internet).

> Je kan de app ook openen met `?url=<komoot-url>` om meteen te importeren.

## Testen

```bash
npm install   # eenmalig (playwright-core)
npm test      # unit- + E2E-suite met coverage-rapport
```

De suite (`tests/run.mjs`) draait 243 asserts in een headless Chromium: unit-tests van
alle pure logica en E2E-scenario's voor elk scherm, elke flow én elk foutpad — import
(incl. proxy-fallback, kapotte payloads en netwerkfouten), kaartlagen, overlays, locatie,
tracking (incl. regressietest op de rode-stip-bug, geweigerde/uitgevallen GPS),
verkennen (hedged mirrors, bbox-klem, cache, offline fallback), automatische
offline-opslag, offline herstart via de service worker, statuslampjes, en
foutinjectie (kapotte IndexedDB, kapotte Cache-opslag, falende service-worker-registratie,
ontbrekende GPS-API). Externe services worden gemockt.

**Coverage over `js/*.js`: 100,0%** — elke byte van elke module wordt uitgevoerd
(rapport onderaan `npm test`; `UNCOVERED=1 npm test` toont eventueel ongedekte regels).
`sw.js` draait in een worker en valt buiten page-coverage; het offline-gedrag ervan
wordt functioneel getest via de offline-herstart-scenario's.

## Techniek

| Onderdeel | Keuze |
|---|---|
| Kaart | [Leaflet](https://leafletjs.com/) 1.9.4 (lokaal meegeleverd) |
| Tegels | Carto Voyager @2x (standaard), Esri World Imagery, OpenTopoMap — corridor-/regiogewijs in de Cache Storage |
| Opslag | IndexedDB (routes + regio's), Cache Storage (app-shell + tegels), localStorage (voorkeuren) |
| Offline | Service worker: app-shell stale-while-revalidate, tegels cache-first |
| Routebronnen | Komoot publieke tour-API (`api.komoot.de/v007/tours/…`) en OSM/Overpass (wandelroutes lwn/rwn, knooppunten, horeca) |

Voor architectuur, werkafspraken en uitbreiden: zie **[CLAUDE.md](CLAUDE.md)**.

Kaartdata © OpenStreetMap-bijdragers © CARTO, luchtfoto's Esri. Enkel voor persoonlijk
gebruik — respecteer de fair-use-voorwaarden van de tegel-providers.
