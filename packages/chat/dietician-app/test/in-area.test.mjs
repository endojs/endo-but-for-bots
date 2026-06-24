// in-area.test.mjs — the in-city filter must not drop every place when the city's LOCAL address name differs
// from the geocoded name (Copenhagen ↔ København): with zero name matches it falls back to distance-from-centre.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePipeline } from '../core.mjs';
import { makeMemStore } from './mem-store.mjs';

const fakePlaces = fixture => ({ searchText: async () => ({ ok: true, places: fixture }), geocode: async () => ({ ok: false }) });
// Copenhagen centre; restaurants whose addresses say "København" (not "Copenhagen") but are within the radius.
const CPH = { latitude: 55.6761, longitude: 12.5683 };
const near = (dLat, dLng) => ({ latitude: CPH.latitude + dLat, longitude: CPH.longitude + dLng });

test('a city whose local address name differs (Copenhagen↔København) keeps in-radius places via distance fallback', async () => {
  const fixture = [
    { place_id: 'a', name: 'Kødbyens Grill', address: 'Flæsketorvet 1, 1711 København, Denmark', primary_type: 'steak_house', lat: near(0.002, 0).latitude, lng: CPH.longitude },
    { place_id: 'b', name: 'Havnegade Seafood', address: 'Havnegade 5, 1058 København, Denmark', primary_type: 'seafood_restaurant', lat: CPH.latitude, lng: near(0, 0.003).longitude },
    { place_id: 'c', name: 'Faraway Roskilde Diner', address: 'Algade 2, 4000 Roskilde, Denmark', primary_type: 'diner', lat: 55.6415, lng: 12.0803 }, // ~35km away → out of area
  ];
  const store = makeMemStore();
  const pipe = makePipeline({ places: fakePlaces(fixture), store, person: 'alexa' });
  const r = await pipe.scan({ slug: 'copenhagen', name: 'Copenhagen', center: CPH, radius: 7000, cap: 20 });
  assert.ok(r.ok, r.error);
  assert.equal(r.counts.matchMode, 'distance', 'fell back to distance because "Copenhagen" matched zero addresses');
  const names = r.candidates.map(c => c.name);
  assert.ok(names.includes('Kødbyens Grill') && names.includes('Havnegade Seafood'), 'in-radius København restaurants are kept (not dropped as out-of-city)');
  assert.ok(!names.includes('Faraway Roskilde Diner'), 'a restaurant ~35km away is still dropped as out of area');
});

test('a city whose name DOES appear in addresses still uses the precise name match (no regression)', async () => {
  const fixture = [
    { place_id: 'x', name: 'Oakland Grill', address: '1 Broadway, Oakland, CA 94607, USA', primary_type: 'steak_house', lat: 37.804, lng: -122.271 },
    { place_id: 'y', name: 'SF Spot (near Oakland centre)', address: '1 Market St, San Francisco, CA 94105, USA', primary_type: 'restaurant', lat: 37.806, lng: -122.272 }, // close by, but addressed SF
  ];
  const store = makeMemStore();
  const pipe = makePipeline({ places: fakePlaces(fixture), store, person: 'alexa' });
  const r = await pipe.scan({ slug: 'oakland', name: 'Oakland', center: { latitude: 37.8044, longitude: -122.2712 }, radius: 5000, cap: 20 });
  assert.equal(r.counts.matchMode, 'name', 'uses the name match (Oakland appears in an address)');
  const names = r.candidates.map(c => c.name);
  assert.ok(names.includes('Oakland Grill'), 'the Oakland-addressed place is a candidate');
  assert.ok(!names.includes('SF Spot (near Oakland centre)'), 'an SF-addressed place is still dropped by the precise name match');
});
