// core.mjs — the dietician pipeline as PURE node (no Endo, no harden) over INJECTED I/O. This is where the
// persona's Python logic ports verbatim; grunt.mjs wraps it in the cap layer. Injected dependencies make it
// portable + headless-testable: swap places/judge/store/diet and you have a different person's dietician.
//
//   makePipeline({ places, store, judge, web, clock, person, ... }) → { scan, listCities, ... }
//
//   places — providers/places.mjs: { searchText(q,{center,radius}), geocode(name) }. Holds the Google key.
//   store  — the per-instance data store (Slice 3): { placeIds(), hasPlace(slug), getPlace(slug),
//            putPlace(slug,meta), putVerdict(slug,evalRec), ... }. The ONLY fs authority.
//   judge  — the LLM evaluator (Slice 4). web — discovery menu-lookup caps (Slice 4).
//
// SLICE 2 lands `scan` (the sweep.py + rank.py stages, in-memory, no /tmp round-trip). Later slices add
// evaluate / buildMap / generateGuide on the same injected store.
import { AUTO_SKIP, NAME_AUTO_SKIP, priorityOf } from './skiplists.mjs';
import { QUERIES, SEED_CITIES, cityRecord, cityList } from './cities.mjs';

// slugify — sweep.py slugify(): lowercase, non-alnum → '-', strip, cap 60, fallback 'place'.
export const slugify = name => (String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || 'place';

// the persona's "city name appears in the formatted address" in-city test (the only geo-filter the sweep has).
const inCityOf = (cityName, address) => String(address || '').toLowerCase().includes(String(cityName || '').toLowerCase());

export const makePipeline = ({
  places,
  store,
  judge,                 // Slice 4
  web,                   // Slice 4
  clock = Date.now,      // injected for testable dates
  cities = SEED_CITIES,  // the instance's city table (Slice 3 reads it from the store)
  person = 'alexa',
  aprioriEvaluatedFor = 'Alexa (MCAS+histamine+fructan)', // the label on a-priori SKIP verdicts (per-person)
} = {}) => {
  const today = () => new Date(clock()).toISOString().slice(0, 10);

  // write an a-priori SKIP — a categorical pre-filter result. Unlike the persona (which wrote one mixed file),
  // we keep the clean split the design specifies: PLACE metadata (no verdict) + an evaluations SKIP verdict.
  const writeSkip = async (p, reason, used) => {
    const base = slugify(p.name);
    let s = base;
    let i = 1;
    while (used.has(s) || (await store.hasPlace(s))) { // sweep.py write_skip() disambiguation
      s = `${base}-${String(p.place_id || '').slice(-6).toLowerCase()}`;
      i += 1;
      if (i > 3) { s = `${base}-${String(p.place_id || '').slice(-10).toLowerCase()}`; break; }
    }
    used.add(s);
    await store.putPlace(s, {
      name: p.name, address: p.address || '', place_id: p.place_id || '', lat: p.lat, lng: p.lng,
      cuisine: String(p.primary_type || '').replace(/_/g, ' '), menu_url: null, primary_type: p.primary_type || '',
      outdoor_seating: p.outdoor_seating ?? null, cached_menu: null, cached_menu_date: null, cached_menu_sources: [],
    });
    await store.putVerdict(s, {
      place_id: p.place_id || '', name: p.name, verdict: 'SKIP', evaluated_for: aprioriEvaluatedFor,
      evaluated_date: today(), summary: `A-priori SKIP — ${reason}`, promising_dishes: [], avoid_outright: [],
      kitchen_flexibility: 'N/A (cuisine type incompatible)',
    });
    return s;
  };

  // the candidate-path slug + collision/idempotency routine (sweep.py main()).
  const candidateSlug = async (p, used, cityShort) => {
    const pid = String(p.place_id || '');
    const base = slugify(p.name);
    let s = base;
    if (used.has(s) || (await store.hasPlace(s))) {
      let samePlace = false;
      if (await store.hasPlace(s)) { const ex = await store.getPlace(s); samePlace = !!(ex && ex.place_id === pid); }
      if (!samePlace) {
        s = `${base}-${cityShort}`;
        if (used.has(s) || (await store.hasPlace(s))) { // the persona's single-iteration "while"
          const p2 = await store.getPlace(s);
          const sameInner = !!(p2 && p2.place_id === pid);
          if (!sameInner) s = `${base}-${cityShort}-${pid.slice(-6).toLowerCase()}`;
        }
      }
    }
    return s;
  };

  // STAGE 1+2a — sweep a city's restaurants, dedupe vs the store, write a-priori SKIPs, rank + cap.
  const scan = async cityArg => {
    const city = typeof cityArg === 'string' ? cityRecord(cities, cityArg) : cityArg;
    if (!city) return { ok: false, error: `unknown city "${cityArg}". Known: ${Object.keys(cities).join(', ')}. (addCity geocodes a new one.)` };

    // union all query results by place_id (first wins, per setdefault)
    const all = new Map();
    const queryStats = [];
    for (const q of QUERIES) {
      const r = await places.searchText(q, { center: city.center, radius: city.radius });
      if (!r || !r.ok) { queryStats.push({ q, error: (r && r.error) || 'failed' }); continue; }
      for (const p of r.places) if (p.place_id && !all.has(p.place_id)) all.set(p.place_id, p);
      queryStats.push({ q, results: r.places.length });
    }

    const existing = await store.placeIds(); // Map place_id → slug
    const used = new Set();
    const skipped = [];
    const candidates = [];
    const already = [];
    let droppedOutOfCity = 0;
    const cityShort = String(city.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    for (const [pid, p] of all) {
      if (existing.has(pid)) { already.push(p.name); continue; }
      const inCity = inCityOf(city.name, p.address);
      const ptype = p.primary_type || '';
      const name = p.name || '';

      if (AUTO_SKIP[ptype]) {
        if (inCity) { await writeSkip(p, AUTO_SKIP[ptype], used); skipped.push({ name, reason: AUTO_SKIP[ptype], by: `type:${ptype}` }); }
        else droppedOutOfCity += 1;
        continue;
      }
      let nameReason = null;
      for (const [pat, reason] of NAME_AUTO_SKIP) { if (pat.test(name)) { nameReason = reason; break; } }
      if (nameReason) {
        if (inCity) { await writeSkip(p, nameReason, used); skipped.push({ name, reason: nameReason, by: 'name' }); }
        else droppedOutOfCity += 1;
        continue;
      }
      if (!inCity) { droppedOutOfCity += 1; continue; }

      const slug = await candidateSlug(p, used, cityShort);
      used.add(slug);
      candidates.push({
        name: p.name, address: p.address || '', place_id: pid, lat: p.lat, lng: p.lng,
        primary_type: ptype || 'restaurant', outdoor_seating: p.outdoor_seating ?? null, city: city.name, slug,
      });
    }

    // STAGE 2a — rank by primaryType PRIORITY (stable desc), cap to the city's cap (rank.py, in-memory).
    const ranked = candidates
      .map((c, i) => [c, i])
      .sort((a, b) => (priorityOf(b[0].primary_type) - priorityOf(a[0].primary_type)) || (a[1] - b[1]))
      .map(x => x[0]);
    const top = ranked.slice(0, city.cap || 20);

    return {
      ok: true,
      city: city.name,
      slug: city.slug || (typeof cityArg === 'string' ? cityArg : undefined),
      counts: { found: all.size, already: already.length, skipped: skipped.length, droppedOutOfCity, candidates: candidates.length, returned: top.length },
      candidates: top,
      skips: skipped,
      queryStats,
    };
  };

  const listCities = () => cityList(cities);

  return { scan, listCities, slugify };
};
