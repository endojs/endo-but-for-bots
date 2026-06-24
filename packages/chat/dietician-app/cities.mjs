// cities.mjs — the ONE unified city table. The persona hardcoded the same cities in THREE divergent places
// (sweep.py CITIES = 14, rank.py CAPS = 9, gen_prompts.py discovery loop = 5); this collapses them into a
// single source: slug → { name, center{latitude,longitude}, radius (m), cap (max candidates to evaluate) }.
// A portable instance seeds from this and grows via addCity (which geocodes a new city on demand).
//
// QUERIES = the fixed cuisine text-searches the sweep runs per city (sweep.py QUERIES, verbatim order).

export const QUERIES = [
  'Japanese restaurant',
  'Hawaiian plate lunch',
  'Mediterranean grilled',
  'Greek restaurant',
  'steakhouse',
  'poke bowl',
  'salad bowl',
  'grain bowl',
  'rotisserie chicken',
  'farm to table',
  'fresh seafood grilled',
  'breakfast brunch',
  'diner',
  'rice bowl healthy',
];

// per-city candidate caps (rank.py CAPS); cities without an explicit cap use DEFAULT_CAP.
const CAPS = {
  oakland: 20,
  alameda: 18,
  'san-leandro': 18,
  berkeley: 22,
  'san-francisco': 28,
  'castro-valley': 15,
  hayward: 18,
  'santa-cruz': 22,
  berlin: 25,
};
export const DEFAULT_CAP = 20;
export const DEFAULT_RADIUS = 5000;

// sweep.py CITIES (name + center + radius), verbatim.
const RAW = {
  oakland: { name: 'Oakland', center: { latitude: 37.8044, longitude: -122.2712 }, radius: 5000 },
  alameda: { name: 'Alameda', center: { latitude: 37.7652, longitude: -122.2416 }, radius: 5000 },
  'san-leandro': { name: 'San Leandro', center: { latitude: 37.7249, longitude: -122.1561 }, radius: 5000 },
  berkeley: { name: 'Berkeley', center: { latitude: 37.8716, longitude: -122.2727 }, radius: 5000 },
  'san-francisco': { name: 'San Francisco', center: { latitude: 37.7749, longitude: -122.4194 }, radius: 8000 },
  'castro-valley': { name: 'Castro Valley', center: { latitude: 37.6941, longitude: -122.0863 }, radius: 4000 },
  hayward: { name: 'Hayward', center: { latitude: 37.6688, longitude: -122.0808 }, radius: 5000 },
  'santa-cruz': { name: 'Santa Cruz', center: { latitude: 36.9741, longitude: -122.0308 }, radius: 5000 },
  berlin: { name: 'Berlin', center: { latitude: 52.52, longitude: 13.405 }, radius: 7000 },
  'palo-alto': { name: 'Palo Alto', center: { latitude: 37.4419, longitude: -122.143 }, radius: 4000 },
  'menlo-park': { name: 'Menlo Park', center: { latitude: 37.453, longitude: -122.1817 }, radius: 3000 },
  'mountain-view': { name: 'Mountain View', center: { latitude: 37.3861, longitude: -122.0839 }, radius: 4000 },
  'redwood-city': { name: 'Redwood City', center: { latitude: 37.4852, longitude: -122.2364 }, radius: 4000 },
  'los-altos': { name: 'Los Altos', center: { latitude: 37.3688, longitude: -122.1132 }, radius: 3000 },
};

// the seeded, cap-merged table.
export const SEED_CITIES = Object.fromEntries(
  Object.entries(RAW).map(([slug, c]) => [slug, { ...c, cap: CAPS[slug] ?? DEFAULT_CAP }]),
);

// a city slug → its full record (with cap), or null.
export const cityRecord = (table, slug) => {
  const c = (table || SEED_CITIES)[slug];
  return c ? { slug, ...c } : null;
};

export const cityList = (table = SEED_CITIES) => Object.entries(table).map(([slug, c]) => ({ slug, ...c }));
