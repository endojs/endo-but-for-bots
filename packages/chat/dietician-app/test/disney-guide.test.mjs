// disney-guide.test.mjs — the Disney generator structure: park grouping, the two inline-SVG maps (resort +
// hotel), the hotel section + distance cards, the CSS-only zone/safe/breakfast filter controls, person +
// trip parameterization, and core.generateGuide('disney') gathering park + hotel rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateDisneyGuide, haversineMi, DEFAULT_TRIP } from '../guides/disney-guide.mjs';
import { makePipeline } from '../core.mjs';
import { makeMemStore } from './mem-store.mjs';

const parkRows = [
  { slug: 'disneyland-a', verdict: 'VIABLE', name: 'Carnation Cafe', address: 'Main Street, U.S.A., Disneyland Park, Anaheim, CA', lat: 33.812, lng: -117.919 },
  { slug: 'disneyland-b', verdict: 'BORDERLINE', name: 'Smokejumpers Grill', address: 'Grizzly Peak, Disney California Adventure, Anaheim, CA', lat: 33.806, lng: -117.920 },
  { slug: 'disneyland-c', verdict: 'VIABLE', name: 'Ballast Point', address: 'Downtown Disney District, Anaheim, CA', lat: 33.808, lng: -117.923 },
];
const hotelRows = [
  { slug: 'oc-grill', verdict: 'VIABLE', name: 'OC Grill', address: '1 St, Anaheim, CA 92802, USA', lat: 33.81, lng: -117.914, dist_mi: 0.4, cuisine: 'steakhouse' },
];

test('haversineMi is correct (Disneyland → its hotel ≈ 0.8 mi)', () => {
  const d = haversineMi(33.8121, -117.919, DEFAULT_TRIP.hotel.lat, DEFAULT_TRIP.hotel.lng);
  assert.ok(d > 0.3 && d < 1.5, `got ${d}`);
});

test('generateDisneyGuide: park sections, both SVG maps, hotel section, CSS-only filters', () => {
  const html = generateDisneyGuide(parkRows, hotelRows, { person: 'alexa', today: '2026-06-23' });
  // park grouping in PARK_ORDER with the right data-zone
  assert.match(html, /data-zone="dlr"[\s\S]*Disneyland Park/);
  assert.match(html, /data-zone="dca"[\s\S]*California Adventure/);
  assert.match(html, /data-zone="ddd"[\s\S]*Downtown Disney/);
  // the resort map (dl-map) + the hotel map (hotel-map), both inline SVG
  assert.match(html, /<svg viewBox="0 0 860 560" class="dl-map"/);
  assert.match(html, /class="dl-map hotel-map"/);
  // hotel rings + marker + a distance pill on the hotel card
  assert.match(html, /class="ring"/);
  assert.match(html, /class="hotel-marker"/);
  assert.match(html, /0\.4 mi from hotel/);
  // map dots are anchors to the cards
  assert.match(html, /<a href="#card-disneyland-a"><circle/);
  // CSS-only zone filter inputs + the breakfast + safe-only controls
  assert.match(html, /<input type="radio" id="z-hotel"/);
  assert.match(html, /id="ft-breakfast"/);
  assert.match(html, /for="safe-only"/);
  // person generalization
  assert.match(html, /Disneyland Food Guide — for Alexa/);
});

test('trip is parameterizable (retarget hotel name + park tints)', () => {
  const trip = { ...DEFAULT_TRIP, hotel: { ...DEFAULT_TRIP.hotel, name: 'My Other Hotel' } };
  const html = generateDisneyGuide(parkRows, hotelRows, { person: 'bob', trip, companionUrl: 'https://example.test/g' });
  assert.match(html, /My Other Hotel/);
  assert.match(html, /Disneyland Food Guide — for Bob/);
  assert.match(html, /Feeding Bob/);
});

test('core.generateGuide("disney") gathers Disney park rows + nearby non-Disney hotel rows', async () => {
  const store = makeMemStore({
    places: {
      'disneyland-grill': { name: 'DL Grill', address: 'Main Street, Disneyland Park, Anaheim, CA', lat: 33.812, lng: -117.919, place_id: 'd1' },
      'anaheim-near': { name: 'Near Spot', address: '1 St, Anaheim, CA 92802', lat: 33.814, lng: -117.913, place_id: 'p1' },
      'far-away': { name: 'Far Spot', address: '1 St, Oakland, CA 94607', lat: 37.8, lng: -122.27, place_id: 'p2' },
    },
    evaluations: {
      'disneyland-grill': { verdict: 'VIABLE', name: 'DL Grill' },
      'anaheim-near': { verdict: 'VIABLE', name: 'Near Spot' },
      'far-away': { verdict: 'VIABLE', name: 'Far Spot' },
    },
  });
  const arts = {};
  store.writeArtifact = async (rel, content) => { arts[rel] = content; };
  const pipe = makePipeline({ store, person: 'alexa' });
  const r = await pipe.generateGuide('disney');
  assert.ok(r.ok);
  assert.equal(r.cards, 1, 'one Disney park card');
  assert.equal(r.hotel, 1, 'one nearby non-Disney hotel row (Anaheim in radius; Oakland excluded)');
  assert.ok(arts['site/disney/index.html'].includes('Near Spot'), 'nearby spot in the hotel section');
  assert.ok(!arts['site/disney/index.html'].includes('Far Spot'), 'far spot excluded by radius');
  assert.match(arts['site/disney/sort.js'], /navigator\.geolocation/);
});
