/* Ververs tests/fixtures/area-real.json met een écht Overpass-antwoord voor het
   Hageven-gebied. Draai dit na elke wijziging aan areaQuery of de parsers:
   de suite test tegen dit bevroren echte antwoord (handgemaakte fixtures
   bleken te schoon — zie CLAUDE.md).  Gebruik: node tests/refresh-fixture.mjs */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
global.window = {};
eval(readFileSync(path.join(ROOT, 'js/overpass.js'), 'utf8'));
const q = global.window.Overpass._test.areaQuery({ minLat: 51.28, minLng: 5.38, maxLat: 51.33, maxLng: 5.46 });

const res = await fetch('https://overpass-api.de/api/interpreter', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: 'data=' + encodeURIComponent(q),
});
if (!res.ok) throw new Error('Overpass HTTP ' + res.status);
const data = await res.json();
const rels = data.elements.filter((e) => e.type === 'relation').length;
if (rels < 5) throw new Error('Verdacht weinig relaties (' + rels + ') — niet opgeslagen');
writeFileSync(path.join(ROOT, 'tests/fixtures/area-real.json'), JSON.stringify(data));
console.log('area-real.json ververst:', data.elements.length, 'elementen,', rels, 'relaties');
