// skiplists.test.mjs — the a-priori filter tables ported from sweep.py must behave identically: the
// primaryType dict, the name regexes (incl. their word-boundary subtleties), and the priority ranking.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_SKIP, NAME_AUTO_SKIP, PRIORITY, priorityOf } from '../skiplists.mjs';

test('AUTO_SKIP carries the full primaryType skip set (≈70 cuisines)', () => {
  assert.ok(Object.keys(AUTO_SKIP).length >= 65, `got ${Object.keys(AUTO_SKIP).length}`);
  for (const t of ['sushi_restaurant', 'thai_restaurant', 'deli', 'cafe', 'vegan_restaurant', 'bar', 'bakery']) {
    assert.ok(AUTO_SKIP[t], `expected ${t} in AUTO_SKIP`);
  }
  assert.ok(!AUTO_SKIP.steak_house, 'steak_house must NOT be auto-skipped (it is high-priority)');
});

test('NAME_AUTO_SKIP regexes match by word boundary (first match wins), as in sweep.py', () => {
  const reason = name => { for (const [re, r] of NAME_AUTO_SKIP) if (re.test(name)) return r; return null; };
  assert.match(reason('Hana Sushi Bar') || '', /Sushi/, 'sushi matches');
  assert.match(reason('Joe\'s Ramen House') || '', /Ramen/, 'ramen matches');
  assert.match(reason('Taqueria Tacos El Rey') || '', /Tacos/, 'tacos matches');
  assert.match(reason('Blue Bottle Coffee') || '', /Coffee/, 'coffee matches');
  // word boundary: "Sushil's Kitchen" must NOT match \bsushi\b (followed by a word char)
  assert.equal(reason('Sushil\'s Kitchen'), null, 'word-boundary: Sushil is not sushi');
  // a clean steakhouse name hits none of the name skips
  assert.equal(reason('House of Prime Rib'), null, 'a steakhouse name is not name-skipped');
});

test('PRIORITY ranks survivors; priorityOf defaults to 1', () => {
  assert.equal(priorityOf('steak_house'), 10);
  assert.equal(priorityOf('mediterranean_restaurant'), 9);
  assert.equal(priorityOf('restaurant'), 2);
  assert.equal(priorityOf('something_unknown'), 1, 'unknown type → default priority 1');
  assert.ok(PRIORITY.steak_house > PRIORITY.restaurant);
});
