// scan.test.mjs — the ported sweep.py + rank.py filter pipeline, exercised deterministically over a FAKE
// places provider so every branch is covered without hitting Google: already-in-DB, auto-skip-by-type
// (in-city vs out-of-city), name-skip, out-of-city drop, candidate, ranking, and slug collision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makePipeline, slugify } from '../core.mjs';
import { makeMemStore } from './mem-store.mjs';

// a fake provider that returns the SAME fixture for every query (dedup by place_id → the unique set).
const fakePlaces = fixture => ({ searchText: async () => ({ ok: true, places: fixture }), geocode: async () => ({ ok: false, error: 'n/a' }) });

const P = (over) => ({ place_id: 'id-' + over.name.replace(/\W+/g, ''), name: over.name, address: over.address, lat: 37.8, lng: -122.27, primary_type: over.primary_type || '', outdoor_seating: null, ...over });

test('scan partitions places exactly like the persona sweep, and ranks candidates by priority', async () => {
  const OAK = ', Oakland, CA 94607, USA';
  const fixture = [
    P({ name: 'Already Known Grill', address: 'X' + OAK, place_id: 'pid-known', primary_type: 'restaurant' }), // A: already in DB
    P({ name: 'Hana Sushi', address: '1 A St' + OAK, primary_type: 'sushi_restaurant' }),                       // B: auto-skip by type, in-city → SKIP
    P({ name: 'Bangkok Thai', address: '2 B St, Berkeley, CA 94704, USA', primary_type: 'thai_restaurant' }),  // C: auto-skip by type, out-of-city → drop
    P({ name: 'Joe Ramen House', address: '3 C St' + OAK, primary_type: 'restaurant' }),                        // D: name-skip (ramen), in-city → SKIP
    P({ name: 'Prime Steakhouse', address: '4 D St' + OAK, primary_type: 'steak_house' }),                      // E: candidate, priority 10
    P({ name: 'Green Bowl', address: '5 E St' + OAK, primary_type: 'restaurant' }),                             // F: candidate, priority 2
    P({ name: 'Faraway Diner', address: '6 F St, San Jose, CA 95112, USA', primary_type: 'diner' }),            // G: clean but out-of-city → drop
  ];
  const store = makeMemStore({ places: { 'already-known-grill': { place_id: 'pid-known', name: 'Already Known Grill' } } });
  const pipe = makePipeline({ places: fakePlaces(fixture), store, person: 'alexa' });

  const r = await pipe.scan('oakland');
  assert.ok(r.ok, r.error);
  assert.equal(r.counts.found, 7, 'all 7 unique places gathered');
  assert.equal(r.counts.already, 1, 'the seeded place_id is recognised as already-known');
  assert.equal(r.counts.skipped, 2, 'two in-city a-priori skips (sushi type + ramen name)');
  assert.equal(r.counts.droppedOutOfCity, 2, 'two out-of-city drops (Berkeley thai + San Jose diner)');
  assert.equal(r.counts.candidates, 2, 'two real candidates (steakhouse + bowl)');

  const names = r.candidates.map(c => c.name);
  assert.deepEqual(names, ['Prime Steakhouse', 'Green Bowl'], 'ranked: steak_house (10) before restaurant (2)');
  assert.ok(r.candidates.every(c => c.city === 'Oakland' && c.slug), 'candidates carry city + slug');

  // the two a-priori skips were written to the store as PLACE metadata + a SKIP verdict (clean split)
  const skipSlugs = [...store._evals.keys()];
  assert.equal(skipSlugs.length, 2, 'two SKIP verdicts written');
  for (const s of skipSlugs) {
    assert.equal((await store.getVerdict(s)).verdict, 'SKIP');
    assert.equal((await store.getPlace(s)).cached_menu, null, 'a-priori skip place has no cached menu');
    assert.ok(!('verdict' in (await store.getPlace(s))), 'place metadata carries NO verdict (clean split)');
  }
  // skip reasons surfaced
  assert.match(r.skips.map(s => s.reason).join(' '), /Sushi/);
  assert.match(r.skips.map(s => s.reason).join(' '), /Ramen/);
});

test('slug collision: a DIFFERENT place with the same name gets a city-disambiguated slug', async () => {
  const OAK = ', Oakland, CA 94607, USA';
  const store = makeMemStore({ places: { souvla: { place_id: 'pid-OTHER', name: 'Souvla' } } });
  const fixture = [P({ name: 'Souvla', address: '1 St' + OAK, place_id: 'pid-NEW', primary_type: 'greek_restaurant' })];
  const pipe = makePipeline({ places: fakePlaces(fixture), store, person: 'alexa' });
  const r = await pipe.scan('oakland');
  assert.equal(r.candidates.length, 1);
  assert.notEqual(r.candidates[0].slug, 'souvla', 'a different place_id must not reuse the existing slug');
  assert.match(r.candidates[0].slug, /^souvla-oakland/, 'disambiguated with the city short slug');
});

test('slugify matches the persona (lowercase, non-alnum→-, strip, cap 60)', () => {
  assert.equal(slugify("Joe's Café & Grill!"), 'joe-s-caf-grill');
  assert.equal(slugify('  ---weird---  '), 'weird');
  assert.equal(slugify(''), 'place');
});
