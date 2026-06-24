// kml.test.mjs — the build_kml.py port must preserve the load-bearing details exactly: lng,lat,0 order, the
// ABGR green tint, VIABLE+BORDERLINE only, CDATA + escaping, dish bullets, sort-by-name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKml } from '../kml.mjs';
import { makePipeline } from '../core.mjs';
import { makeMemStore } from './mem-store.mjs';

const items = [
  { verdict: 'VIABLE', name: 'Zeta Grill & Co', cuisine: 'steakhouse', address: '9 Z St, Oakland', summary: 'Clean ribeye', promising_dishes: [{ name: 'Ribeye', modifications: 'no butter', residual_risk: 'none' }], menu_url: 'https://z.test/m?a=1&b=2', evaluated_date: '2026-06-01', evaluated_for: 'Alexa', lat: 37.8044, lng: -122.2712 },
  { verdict: 'BORDERLINE', name: 'Alpha Diner', cuisine: 'diner', address: '1 A St, Oakland', summary: 'call ahead', promising_dishes: [], evaluated_date: '2026-06-01', evaluated_for: 'Alexa', lat: 37.80, lng: -122.27 },
  { verdict: 'SKIP', name: 'Sushi Bar', address: 'x', lat: 1, lng: 2 }, // must NOT appear
  { verdict: 'VIABLE', name: 'No Coords', lat: null, lng: null },       // must NOT appear (no lat/lng)
];

test('buildKml: VIABLE+BORDERLINE only, lng,lat,0 order, ABGR green, CDATA + escaping, sorted by name', () => {
  const { kml, total, viable, borderline } = buildKml(items, { person: 'alexa' });
  assert.equal(total, 2);
  assert.equal(viable, 1);
  assert.equal(borderline, 1);
  assert.equal((kml.match(/<Placemark>/g) || []).length, 2, 'SKIP + no-coords excluded');

  // lng,lat,0 (NOT lat,lng): Zeta is lng=-122.2712, lat=37.8044
  assert.match(kml, /<coordinates>-122\.2712,37\.8044,0<\/coordinates>/);
  // ABGR opaque-green tint on the VIABLE style
  assert.match(kml, /<Style id="VIABLE">[\s\S]*<color>ff00aa00<\/color>/);
  assert.ok(!/<color>/.test(kml.split('id="BORDERLINE"')[1] || ''), 'BORDERLINE style has no color line');
  // CDATA description + dish bullet entity + <small> risk
  assert.match(kml, /<!\[CDATA\[/);
  assert.match(kml, /&#8226; <i>Ribeye<\/i> — no butter <small>\(risk: none\)<\/small>/);
  // menu_url ampersand escaped to &amp; (saxutils.escape escapes & < >)
  assert.match(kml, /href="https:\/\/z\.test\/m\?a=1&amp;b=2"/);
  // folders + doc title carry the person name
  assert.match(kml, /<name>Safe Eats \(Alexa\)<\/name>/);
  assert.match(kml, /🟢 Very Safe \(VIABLE\)/);
  assert.match(kml, /🟡 Questionable \(BORDERLINE\)/);
});

test('buildKml escapes XML metacharacters in a place name', () => {
  const { kml } = buildKml([{ verdict: 'VIABLE', name: 'Tom & Jerry <Grill>', lat: 1, lng: 2 }], { person: 'bob' });
  assert.match(kml, /<name>🟢 Tom &amp; Jerry &lt;Grill&gt;<\/name>/);
  assert.match(kml, /<name>Safe Eats \(Bob\)<\/name>/, 'person generalizes beyond Alexa');
});

test('core.buildMap writes the KML artifact to the store from its verdicts', async () => {
  const store = makeMemStore({
    places: { z: { name: 'Z', lat: 37.8, lng: -122.2, place_id: 'p' }, a: { name: 'A', lat: 37.7, lng: -122.1, place_id: 'q' }, s: { name: 'S', lat: 1, lng: 2, place_id: 'r' } },
    evaluations: { z: { verdict: 'VIABLE', name: 'Z' }, a: { verdict: 'BORDERLINE', name: 'A' }, s: { verdict: 'SKIP', name: 'S' } },
  });
  // mem-store needs writeArtifact for buildMap
  store.writeArtifact = async (rel, content) => { store._artifacts = store._artifacts || {}; store._artifacts[rel] = content; };
  const pipe = makePipeline({ store, person: 'alexa' });
  const r = await pipe.buildMap();
  assert.ok(r.ok);
  assert.equal(r.total, 2, 'VIABLE + BORDERLINE only');
  assert.match(store._artifacts['safe-eats.kml'], /<Placemark>/);
});
