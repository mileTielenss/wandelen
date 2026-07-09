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
- **Wandelknooppunten**: de genummerde knooppunten die je route volgt worden als badges
  getoond (bv. **71**), zodat je onderweg de bordjes kan volgen. Aan/uit via 🗺.
- **Horeca**: cafés, restaurants, snackbars en bakkers langs de route staan als icoontjes
  op de kaart. Standaard aan; aan/uit via 🗺.
- **Volledig offline**: de app-code, de route, de knooppunten en horeca worden lokaal
  opgeslagen. Sla ook de **kaarttegels** rond een route op via **⬇ Offline** (doe dit één
  keer met wifi), zodat ook de onderkaart zonder internet werkt.

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
2. Plak de URL in de balk op het startscherm en tik **Laden**.
3. Open de route en tik **⬇ Offline** om de kaart lokaal te bewaren.

> Je kan de app ook openen met `?url=<komoot-url>` om meteen te importeren.

## Techniek

| Onderdeel | Keuze |
|---|---|
| Kaart | [Leaflet](https://leafletjs.com/) 1.9.4 (lokaal meegeleverd) |
| Tegels | OpenStreetMap, corridor-gewijs gecachet in de Cache Storage |
| Opslag routes | IndexedDB |
| Offline | Service worker (app-shell + tegels) |
| Routebron | Komoot publieke tour-API (`api.komoot.de/v007/tours/…`) |

Kaartdata © OpenStreetMap-bijdragers. Enkel voor persoonlijk gebruik — respecteer de
[tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
