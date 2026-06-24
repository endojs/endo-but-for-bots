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
  evaluatedFor = 'Alexa (MCAS+histamine+fructan)', // the per-person "evaluated_for" label stamped on verdicts
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
      place_id: p.place_id || '', name: p.name, verdict: 'SKIP', evaluated_for: evaluatedFor,
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

    // persist the capped candidates as place metadata (no verdict yet) so evaluate() picks them up and a
    // re-scan dedups against them (idempotent). a-priori SKIPs were already written above.
    for (const c of top) {
      await store.putPlace(c.slug, {
        name: c.name, address: c.address, place_id: c.place_id, lat: c.lat, lng: c.lng,
        cuisine: String(c.primary_type || '').replace(/_/g, ' '), menu_url: null, primary_type: c.primary_type,
        outdoor_seating: c.outdoor_seating ?? null, cached_menu: null, cached_menu_date: null, cached_menu_sources: [], city: c.city,
      });
    }

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

  // gather a live menu via the injected web cap (discovery path; the reevaluate path uses cached_menu only).
  // Mirrors the live bridge's menu lookup: webSearch → top 3 urls → browse/fetchUrl → concatenated text.
  const gatherMenu = async place => {
    const out = { menu: '', menuUrl: '', sources: [] };
    if (!web || typeof web.webSearch !== 'function') return out;
    try {
      const sr = await web.webSearch(`${place.name} ${place.address || ''} menu`);
      const urls = (sr && sr.ok && Array.isArray(sr.results) ? sr.results : []).slice(0, 3).map(h => h.url).filter(Boolean);
      for (const u of urls) {
        let text = '';
        try { const p = web.browse ? await web.browse(u) : null; text = p && (p.text || p.summary || p.content || ''); } catch { /* try plain fetch */ }
        if (!text && web.fetchUrl) { try { const p = await web.fetchUrl(u); text = p && (p.text || p.summary || p.content || ''); } catch { /* skip */ } }
        if (text) { out.menu += `\n\n[${u}]\n${String(text).slice(0, 3500)}`; out.sources.push(u); if (!out.menuUrl) out.menuUrl = u; }
        if (out.menu.length > 4500) break;
      }
    } catch { /* menu unreachable → UNKNOWN (the safe verdict) */ }
    return out;
  };

  // STAGE 2b/4 — judge not-yet-evaluated places against the diet spec. cached_menu PREFERRED; else web lookup
  // (only if a `web` cap was injected). Idempotent: skips places that already carry a verdict. Writes the
  // verdict (+ any freshly-fetched cached_menu) to the store. A batch can take a minute or two (one LLM/place).
  const evaluate = async ({ city, slugs, limit = 3, onStep = () => {}, signal } = {}) => {
    if (!judge || typeof judge.evaluate !== 'function') return { ok: false, error: 'no judge injected (need an LLM evaluator)' };
    const lim = Math.max(1, Math.min(8, Number(limit) || 3));
    const spec = await store.readSpec();
    const cityName = city ? ((cityRecord(cities, city) || {}).name || city) : null;

    let todo = [];
    if (Array.isArray(slugs)) todo = slugs.slice();
    else {
      for (const slug of await store.listPlaces()) {
        if (await store.getVerdict(slug)) continue; // already judged → idempotent
        const place = await store.getPlace(slug);
        if (!place) continue;
        if (cityName && String(place.city || '') !== cityName) continue;
        todo.push(slug);
      }
    }
    const batch = todo.slice(0, lim);
    const results = [];
    for (const slug of batch) {
      if (signal && signal.aborted) break;
      const place = await store.getPlace(slug);
      if (!place) continue;
      let menu = place.cached_menu || '';
      if (menu) onStep({ kind: 'tool', name: 'cachedMenu', detail: place.name });
      else {
        onStep({ kind: 'tool', name: 'menuLookup', detail: place.name });
        const got = await gatherMenu(place);
        menu = got.menu;
        if (menu) { place.cached_menu = menu.slice(0, 8000); place.cached_menu_date = today(); place.menu_url = got.menuUrl || place.menu_url; place.cached_menu_sources = got.sources; await store.putPlace(slug, place); }
      }
      onStep({ kind: 'tool', name: 'judge', detail: place.name });
      const v = await judge.evaluate({ spec, person, place, menu, signal });
      await store.putVerdict(slug, {
        place_id: place.place_id || '', name: place.name, verdict: v.verdict, evaluated_for: evaluatedFor,
        evaluated_date: today(), summary: v.summary, promising_dishes: v.promising_dishes, avoid_outright: v.avoid_outright, kitchen_flexibility: v.kitchen_flexibility,
      });
      if (v.cuisine && !place.cuisine) { place.cuisine = v.cuisine; await store.putPlace(slug, place); }
      results.push({ slug, name: place.name, verdict: v.verdict, summary: v.summary });
      onStep({ kind: 'tool', name: `verdict:${v.verdict}`, detail: place.name });
    }
    const tally = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
    return { ok: true, city: cityName || undefined, evaluated: results.length, remaining: Math.max(0, todo.length - batch.length), tally, results };
  };

  const listCities = () => cityList(cities);

  return { scan, evaluate, listCities, slugify };
};
