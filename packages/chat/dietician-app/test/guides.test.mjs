// guides.test.mjs — the eats-guide generator structure: city grouping, VIABLE-first sort, cards, tabs,
// the safe-only/search/proximity controls, person generalization, and the shared helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateEatsGuide } from '../guides/eats-guide.mjs';
import { cityOf, mapsUrl, citySlug, esc } from '../guides/shared.mjs';
import { makePipeline } from '../core.mjs';
import { makeMemStore } from './mem-store.mjs';

test('shared helpers: cityOf / mapsUrl(real vs synthetic) / esc', () => {
  assert.equal(cityOf('123 Main St, Oakland, CA 94607, USA'), 'Oakland');
  assert.equal(cityOf('no city here'), 'Other');
  assert.equal(citySlug('San Francisco'), 'san-francisco');
  assert.match(mapsUrl({ place_id: 'ChIJabc' }), /place_id:ChIJabc/);
  assert.match(mapsUrl({ place_id: 'disney-x', name: 'A', address: 'B' }), /maps\/search\/\?api=1&query=AB/);
  assert.equal(esc('a & b <c> "d" \'e\''), 'a &amp; b &lt;c&gt; &quot;d&quot; &#x27;e&#x27;');
});

test('generateEatsGuide: groups by city, VIABLE before BORDERLINE, renders cards + controls', () => {
  const rows = [
    { slug: 'z', verdict: 'BORDERLINE', name: 'Z Spot', city: 'Oakland', address: 'x, Oakland, CA 94607', lat: 1, lng: 2 },
    { slug: 'a', verdict: 'VIABLE', name: 'A Grill', city: 'Oakland', address: 'y, Oakland, CA 94607', lat: 1, lng: 2, promising_dishes: [{ name: 'Ribeye', modifications: 'no butter' }] },
    { slug: 'b', verdict: 'VIABLE', name: 'B Cafe', city: 'Berkeley', address: 'z, Berkeley, CA 94704', lat: 1, lng: 2 },
  ];
  const html = generateEatsGuide(rows, { person: 'alexa', today: '2026-06-23' });
  // two city sections; Oakland (2) before Berkeley (1)
  assert.ok(html.indexOf('data-zone="oakland"') < html.indexOf('data-zone="berkeley"'), 'cities ordered by count desc');
  // within Oakland, VIABLE (A Grill) before BORDERLINE (Z Spot)
  assert.ok(html.indexOf('A Grill') < html.indexOf('Z Spot'), 'VIABLE sorts before BORDERLINE');
  assert.equal((html.match(/<article /g) || []).length, 3, 'three cards');
  // controls present
  assert.match(html, /id="safe-only-btn"/);
  assert.match(html, /id="text-filter"/);
  assert.match(html, /id="sort-proximity"/);
  assert.match(html, /class="tab city-tab active" data-zone="all"/);
  // person generalization + counts
  assert.match(html, /Eats Guide — for Alexa/);
  assert.match(html, /2 safe bets and 1 workable/);
  // a dish rendered
  assert.match(html, /<span class="dish-name">Ribeye<\/span>/);
});

test('core.generateGuide writes site/index.html + site/sort.js, excludes Disney + SKIP', async () => {
  const store = makeMemStore({
    places: {
      'oak-grill': { name: 'Oak Grill', address: '1 St, Oakland, CA 94607', lat: 1, lng: 2, place_id: 'p1' },
      'sf-cafe': { name: 'SF Cafe', address: '2 St, San Francisco, CA 94110', lat: 1, lng: 2, place_id: 'p2' },
      'disneyland-lounge': { name: 'Disney Lounge', address: 'Anaheim', lat: 1, lng: 2, place_id: 'disney-x' },
      'skip-spot': { name: 'Skip', address: '3 St, Oakland, CA 94607', lat: 1, lng: 2, place_id: 'p3' },
    },
    evaluations: {
      'oak-grill': { verdict: 'VIABLE', name: 'Oak Grill' },
      'sf-cafe': { verdict: 'BORDERLINE', name: 'SF Cafe' },
      'disneyland-lounge': { verdict: 'VIABLE', name: 'Disney Lounge' },
      'skip-spot': { verdict: 'SKIP', name: 'Skip' },
    },
  });
  const arts = {};
  store.writeArtifact = async (rel, content) => { arts[rel] = content; };
  const pipe = makePipeline({ store, person: 'alexa' });
  const r = await pipe.generateGuide('eats');
  assert.ok(r.ok);
  assert.equal(r.cards, 2, 'Disney excluded; SKIP excluded → 2 cards');
  assert.ok(arts['site/index.html'] && arts['site/sort.js'], 'both artifacts written');
  assert.ok(!arts['site/index.html'].includes('Disney Lounge'), 'Disney slug excluded from the eats guide');
  assert.ok(!arts['site/index.html'].includes('>Skip<'), 'SKIP excluded');
  assert.match(arts['site/sort.js'], /navigator\.geolocation/);
});
