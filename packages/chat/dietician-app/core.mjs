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
import { buildKml } from './kml.mjs';
import { cityOf } from './guides/shared.mjs';
import { generateEatsGuide } from './guides/eats-guide.mjs';
import { generateDisneyGuide, haversineMi, DEFAULT_TRIP } from './guides/disney-guide.mjs';
import { SORT_JS } from './guides/sort-js.mjs';

// slugify — sweep.py slugify(): lowercase, non-alnum → '-', strip, cap 60, fallback 'place'.
export const slugify = name => (String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || 'place';

// the persona's "city name appears in the formatted address" in-city test (the only geo-filter the sweep has).
const inCityOf = (cityName, address) => String(address || '').toLowerCase().includes(String(cityName || '').toLowerCase());
// haversine distance in METRES — the language-agnostic in-area fallback (see scan()).
const haversineM = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

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

    // In-area test. NORMALLY the city NAME must appear in the address (precise). But some cities' LOCAL
    // address name differs from the geocoded English name (e.g. Copenhagen ↔ København) — Google returns the
    // English name for the city but the LOCAL name in restaurant addresses, so a name-substring match drops
    // EVERY place as "out of city". Detect that (the name appears in ZERO found addresses) and fall back to a
    // distance-from-centre test — language-agnostic, and a no-op for cities whose name does match.
    const nameHits = [...all.values()].filter(p => inCityOf(city.name, p.address)).length;
    // If the city NAME barely appears in the found addresses, its LOCAL address name differs (Copenhagen ↔
    // København) → fall back to distance. Use a RATIO, not ==0, so ONE coincidental "Copenhagen Street" match
    // doesn't defeat it (the live bug: 1 of 215 matched → name mode → all 214 dropped).
    const useDistance = !!city.center && all.size > 0 && (nameHits / all.size) < 0.12;
    const inArea = p => (useDistance
      ? (p.lat != null && p.lng != null && haversineM(city.center.latitude, city.center.longitude, p.lat, p.lng) <= (city.radius || 5000) * 1.3)
      : inCityOf(city.name, p.address));

    for (const [pid, p] of all) {
      if (existing.has(pid)) { already.push(p.name); continue; }
      const inCity = inArea(p);
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
      counts: { found: all.size, already: already.length, skipped: skipped.length, droppedOutOfCity, candidates: candidates.length, returned: top.length, matchMode: useDistance ? 'distance' : 'name' },
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
        // plain fetch FIRST (fast) — only fall back to the headless browser (slow) if it yields nothing.
        try { const p = web.fetchUrl ? await web.fetchUrl(u) : null; text = p && (p.text || p.summary || p.content || ''); } catch { /* try the browser */ }
        if (!text && web.browse) { try { const p = await web.browse(u); text = p && (p.text || p.summary || p.content || ''); } catch { /* skip */ } }
        if (text) { out.menu += `\n\n[${u}]\n${String(text).slice(0, 3500)}`; out.sources.push(u); if (!out.menuUrl) out.menuUrl = u; }
        if (out.menu.length > 3500) break; // enough menu to judge — stop fetching
      }
    } catch { /* menu unreachable → UNKNOWN (the safe verdict) */ }
    return out;
  };

  // STAGE 2b/4 — judge not-yet-evaluated places against the diet spec. cached_menu PREFERRED; else web lookup
  // (only if a `web` cap was injected). Idempotent: skips places that already carry a verdict. Writes the
  // verdict (+ any freshly-fetched cached_menu) to the store. A batch can take a minute or two (one LLM/place).
  const evaluate = async ({ city, slugs, limit = 3, onStep = () => {}, signal } = {}) => {
    if (!judge || typeof judge.evaluate !== 'function') return { ok: false, error: 'no judge injected (need an LLM evaluator)' };
    // each verdict is written as it's produced (idempotent), so a big batch interrupted by the turn limit
    // still saves its progress — the next call picks up the remaining. Cap is generous (was 8).
    const lim = Math.max(1, Math.min(60, Number(limit) || 3));
    const spec = await store.readSpec();
    const cityName = city ? ((cityRecord(cities, city) || {}).name || city) : null;
    // Match the city by SLUG, not exact string: scan persists place.city as the geocoded DISPLAY name
    // ("Copenhagen") while evaluate may be called with the slug ("copenhagen") for a city that isn't
    // pre-configured — an exact compare drops every candidate. slugify both sides so they agree.
    const wantSlug = city ? slugify(city) : null;

    let todo = [];
    if (Array.isArray(slugs)) todo = slugs.slice();
    else {
      for (const slug of await store.listPlaces()) {
        if (await store.getVerdict(slug)) continue; // already judged → idempotent
        const place = await store.getPlace(slug);
        if (!place) continue;
        if (wantSlug && slugify(place.city || '') !== wantSlug) continue;
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

  // STAGE 5a — rebuild the safe-eats KML from the store's VIABLE+BORDERLINE verdicts (build_kml.py port).
  // Writes the artifact to the store and returns counts. SKIP/UNKNOWN stay in the DB but off the map.
  const buildMap = async ({ rel = 'safe-eats.kml', title } = {}) => {
    const items = [];
    for (const slug of await store.listVerdicts()) {
      const ev = await store.getVerdict(slug);
      if (!ev || !/^(VIABLE|BORDERLINE)$/.test(ev.verdict)) continue;
      const place = await store.getPlace(slug);
      if (!place) continue;
      const merged = { ...place, ...ev, slug };
      if (merged.lat == null || merged.lng == null) continue;
      items.push(merged);
    }
    const { kml, total, viable, borderline } = buildKml(items, { person, title });
    await store.writeArtifact(rel, kml);
    return { ok: true, path: rel, total, viable, borderline, bytes: Buffer.byteLength(kml) };
  };

  // gather merged VIABLE+BORDERLINE rows for a guide. eats = non-Disney; disney = slug contains 'disneyland'.
  // city is derived from the address (matching the persona's gen_guide city_of), like the live guides.
  const gatherGuideRows = async ({ disney = false } = {}) => {
    const rows = [];
    for (const slug of await store.listVerdicts()) {
      const isDisney = slug.includes('disneyland');
      if (disney ? !isDisney : isDisney) continue;
      const ev = await store.getVerdict(slug);
      if (!ev || !/^(VIABLE|BORDERLINE)$/.test(ev.verdict)) continue;
      const place = await store.getPlace(slug);
      const merged = { slug, ...(place || {}), ...ev };
      merged.city = cityOf(merged.address || '');
      rows.push(merged);
    }
    return rows;
  };

  // STAGE 5b — regenerate a browsing guide from the store + write it (site/index.html + site/sort.js).
  // Returns counts; the outward PUBLISH (serving it) is a separate confirm-gated step (grunt, Slice 8/10).
  const generateGuide = async (which = 'eats', { date, trip } = {}) => {
    const day = date || today();
    if (which === 'eats') {
      const rows = await gatherGuideRows({ disney: false });
      const html = generateEatsGuide(rows, { person, today: day });
      await store.writeArtifact('site/eats/index.html', html);
      await store.writeArtifact('site/eats/sort.js', SORT_JS);
      const viable = rows.filter(r => r.verdict === 'VIABLE').length;
      return { ok: true, which: 'eats', cards: rows.length, viable, borderline: rows.length - viable, bytes: Buffer.byteLength(html), path: 'site/eats/index.html' };
    }
    if (which === 'disney') {
      const t = trip || DEFAULT_TRIP;
      const parkRows = await gatherGuideRows({ disney: true });
      const hotelRows = [];
      for (const slug of await store.listVerdicts()) {
        if (slug.includes('disneyland')) continue;
        const ev = await store.getVerdict(slug);
        if (!ev || !/^(VIABLE|BORDERLINE)$/.test(ev.verdict)) continue;
        const place = await store.getPlace(slug);
        if (!place || place.lat == null || place.lng == null) continue;
        const d = haversineMi(t.hotel.lat, t.hotel.lng, place.lat, place.lng);
        if (d > t.hotel.radiusMi) continue;
        hotelRows.push({ slug, ...place, ...ev, dist_mi: Math.round(d * 100) / 100 });
      }
      const ord = { VIABLE: 0, BORDERLINE: 1 };
      hotelRows.sort((a, b) => (ord[a.verdict] ?? 9) - (ord[b.verdict] ?? 9) || a.dist_mi - b.dist_mi);
      const html = generateDisneyGuide(parkRows, hotelRows, { person, today: day, trip: t });
      await store.writeArtifact('site/disney/index.html', html);
      await store.writeArtifact('site/disney/sort.js', SORT_JS);
      const viable = parkRows.filter(r => r.verdict === 'VIABLE').length;
      return { ok: true, which: 'disney', cards: parkRows.length, viable, borderline: parkRows.length - viable, hotel: hotelRows.length, bytes: Buffer.byteLength(html), path: 'site/disney/index.html' };
    }
    return { ok: false, error: `unknown guide "${which}" (use 'eats' or 'disney')` };
  };

  const listCities = () => cityList(cities);

  return { scan, evaluate, buildMap, generateGuide, gatherGuideRows, listCities, slugify };
};
