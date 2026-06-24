// sweep-smoke.mjs — the LOAD-BEARING "kill the SSH" proof for the JS port: run the SAME Google Places calls
// the persona's sweep.py made, but IN-PROCESS, with the key read from OUR secret registry — no ssh, no
// persona, no key on screen. Does a single text search, a geocode, and a full live scan('oakland').
//
//   node smoke/sweep-smoke.mjs            (uses google-places-api-key from the registry / env)
import { makePipeline } from '../core.mjs';
import * as places from '../providers/places.mjs';
import { SEED_CITIES } from '../cities.mjs';
import { makeMemStore } from '../test/mem-store.mjs';

const line = (label, v) => console.log(`  ${label}: ${v}`);

(async () => {
  console.log('dietician-app sweep smoke (key from registry, NO ssh):');
  line('Places key available', places.hasKey() ? 'yes' : 'NO — onboard google-places-api-key first');

  // 1. one text search (the sweep's per-query call)
  const oak = SEED_CITIES.oakland;
  const s = await places.searchText('steakhouse', { center: oak.center, radius: oak.radius });
  line('searchText("steakhouse"@oakland)', s.ok ? `${s.places.length} results — e.g. ${(s.places[0] || {}).name || '(none)'}` : `ERROR ${s.error}`);

  // 2. geocode a NOT-yet-configured city (powers addCity)
  const g = await places.geocode('Portland, Oregon');
  line('geocode("Portland, Oregon")', g.ok ? `${g.name} ${Number(g.lat).toFixed(4)},${Number(g.lng).toFixed(4)} [${(g.types || [])[0]}]` : `ERROR ${g.error}`);

  // 3. a FULL live sweep of one city (sweep.py + rank.py, in-process, fresh in-memory store)
  const pipe = makePipeline({ places, store: makeMemStore(), person: 'alexa' });
  const r = await pipe.scan('oakland');
  if (!r.ok) { line('scan("oakland")', `ERROR ${r.error}`); process.exit(1); }
  line('scan("oakland") counts', JSON.stringify(r.counts));
  line('top candidates', r.candidates.slice(0, 6).map(c => `${c.name} [${c.primary_type}]`).join(' | ') || '(none)');
  line('sample a-priori skips', r.skips.slice(0, 4).map(s => `${s.name} (${s.by})`).join(' | ') || '(none)');

  const okAll = places.hasKey() && s.ok && g.ok && r.ok && r.counts.found > 0;
  console.log(okAll ? '\n✓ live Places sweep works in pure JS — the SSH-to-persona dependency is removed for the sweep stage.' : '\n✗ smoke incomplete (see errors above).');
  process.exit(okAll ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
