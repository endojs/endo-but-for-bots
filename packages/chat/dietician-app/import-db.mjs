// import-db.mjs — one-shot migration of the persona's ~/eating-out DB into a portable instance store.
// Resolves the "mixed DB state" gotcha: the persona has 947 migrated places (metadata only, with a twin in
// evaluations/<person>/) PLUS 130 a-priori-SKIP places that still carry an INLINE verdict (written by
// sweep.py after migrate.py ran). This importer normalizes BOTH into the clean split:
//   places/<slug>.json       ← PLACE_FIELDS only (no verdict)
//   evaluations/<slug>.json  ← EVAL_FIELDS (for an inline-verdict place, the verdict is split out here)
// so the instance store has NO mixed state. COPY semantics: reads the source, never mutates the persona DB.
import fs from 'node:fs';
import path from 'node:path';

const PLACE_FIELDS = ['name', 'address', 'place_id', 'lat', 'lng', 'cuisine', 'menu_url', 'menu_pdf_url', 'primary_type', 'outdoor_seating', 'food_types', 'cached_menu', 'cached_menu_date', 'cached_menu_sources'];
const EVAL_FIELDS = ['place_id', 'name', 'verdict', 'evaluated_for', 'evaluated_date', 'summary', 'promising_dishes', 'avoid_outright', 'kitchen_flexibility'];
const pick = (o, keys) => { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; };
const readdir = d => { try { return fs.readdirSync(d); } catch { return []; } };
const readJson = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// srcDir = a local copy of the persona ~/eating-out (with places/ + evaluations/<person>/) + the diet spec.
export const importPersonaDb = async ({ srcDir, dietSpecPath, store, person = 'alexa' }) => {
  const stats = { places: 0, verdicts: 0, normalizedSkips: 0, specBytes: 0, errors: [] };

  // 1. diet spec → diet.md
  try { const md = fs.readFileSync(dietSpecPath || path.join(srcDir, '..', 'family-diets', `${person}.md`), 'utf8'); await store.writeSpec(md); stats.specBytes = Buffer.byteLength(md); }
  catch (e) { stats.errors.push(`diet spec: ${e.message}`); }

  // 2. places/<slug>.json → place metadata (+ split out any inline verdict)
  const placesDir = path.join(srcDir, 'places');
  for (const f of readdir(placesDir)) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace(/\.json$/, '');
    const rec = readJson(path.join(placesDir, f));
    if (!rec) { stats.errors.push(`unreadable place ${f}`); continue; }
    const meta = pick(rec, PLACE_FIELDS);
    if (!('cached_menu' in meta)) { meta.cached_menu = null; meta.cached_menu_date = null; meta.cached_menu_sources = []; }
    await store.putPlace(slug, meta);
    stats.places += 1;
    if (rec.verdict) { // the 130 inline a-priori SKIPs — normalize into evaluations/
      const ev = pick(rec, EVAL_FIELDS); ev.place_id = rec.place_id || ''; ev.name = rec.name || '';
      await store.putVerdict(slug, ev);
      stats.normalizedSkips += 1;
    }
  }

  // 3. evaluations/<person>/<slug>.json → evaluations/<slug>.json (the per-instance flat layout)
  const evalDir = path.join(srcDir, 'evaluations', person);
  for (const f of readdir(evalDir)) {
    if (!f.endsWith('.json')) continue;
    const slug = f.replace(/\.json$/, '');
    const rec = readJson(path.join(evalDir, f));
    if (!rec) { stats.errors.push(`unreadable eval ${f}`); continue; }
    await store.putVerdict(slug, pick(rec, EVAL_FIELDS));
    stats.verdicts += 1;
  }

  return stats;
};

// compute verdict counts straight off the persona source (for the parity comparison).
export const sourceCounts = ({ srcDir, person = 'alexa' }) => {
  const c = { VIABLE: 0, BORDERLINE: 0, SKIP: 0, UNKNOWN: 0, OTHER: 0, inlineSkipPlaces: 0 };
  for (const f of readdir(path.join(srcDir, 'evaluations', person))) {
    if (!f.endsWith('.json')) continue;
    const v = readJson(path.join(srcDir, 'evaluations', person, f));
    const k = v && v.verdict; if (k in c) c[k] += 1; else c.OTHER += 1;
  }
  for (const f of readdir(path.join(srcDir, 'places'))) {
    if (!f.endsWith('.json')) continue;
    const p = readJson(path.join(srcDir, 'places', f));
    if (p && p.verdict) c.inlineSkipPlaces += 1;
  }
  return c;
};
