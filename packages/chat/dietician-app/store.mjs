// store.mjs — the per-instance data store: the typed wrapper core.mjs depends on, over a folder cap (the
// makeFsFolder shim in tests/import, or the SES home-folder cap in grunt.mjs — same { list, read, write,
// mkdir } interface). This is the per-person restaurant DB + diet spec. Layout inside the instance root:
//
//   diet.md                      ← the binding diet spec (sensitive PHI; only the 'editor' facet reads it)
//   cities.json                  ← the unified city table (seeded; addCity appends)        [Slice 3+]
//   places/<slug>.json           ← PLACE metadata + reusable cached_menu (no verdict)
//   evaluations/<slug>.json      ← THIS person's verdict (source of truth for the guides)
//   site/ , safe-eats.kml        ← generated artifacts                                       [Slices 5-7]
//
// The persona kept evaluations/<person>/ subdirs in ONE shared DB; here the per-person split IS the
// per-instance boundary, so evaluations/ is flat. Plain node (no Endo/harden).
const parse = s => { try { return JSON.parse(s); } catch { return null; } };

export const makeDietStore = (folder, { person = 'alexa' } = {}) => {
  const readJson = async rel => { const r = await folder.read(rel); return r && r.ok ? parse(r.content) : null; };
  const writeJson = (rel, obj) => folder.write(rel, JSON.stringify(obj, null, 2));
  const slugsIn = async dir => {
    const r = await folder.list(dir);
    if (!r || !r.ok) return [];
    return r.entries.filter(e => !e.dir && e.name.endsWith('.json')).map(e => e.name.replace(/\.json$/, ''));
  };

  return {
    person,
    folder,

    // diet spec
    readSpec: async () => { const r = await folder.read('diet.md'); return r && r.ok ? r.content : ''; },
    writeSpec: t => folder.write('diet.md', String(t ?? '')),

    // places (metadata + cached_menu) — the core's dedup + collision path uses these
    listPlaces: () => slugsIn('places'),
    hasPlace: async slug => { const r = await folder.read(`places/${slug}.json`); return !!(r && r.ok); },
    getPlace: slug => readJson(`places/${slug}.json`),
    putPlace: (slug, rec) => writeJson(`places/${slug}.json`, rec),
    placeIds: async () => {
      const m = new Map();
      for (const slug of await slugsIn('places')) { const rec = await readJson(`places/${slug}.json`); if (rec && rec.place_id) m.set(rec.place_id, slug); }
      return m;
    },

    // evaluations (this person's verdicts) — the source of truth the guides + KML read
    listVerdicts: () => slugsIn('evaluations'),
    getVerdict: slug => readJson(`evaluations/${slug}.json`),
    putVerdict: (slug, rec) => writeJson(`evaluations/${slug}.json`, rec),

    // verdict tally (status + the import parity proof)
    counts: async () => {
      const c = { VIABLE: 0, BORDERLINE: 0, SKIP: 0, UNKNOWN: 0, OTHER: 0, total: 0 };
      for (const slug of await slugsIn('evaluations')) {
        const v = await readJson(`evaluations/${slug}.json`);
        const k = v && v.verdict;
        if (k in c && k !== 'total' && k !== 'OTHER') c[k] += 1; else c.OTHER += 1;
        c.total += 1;
      }
      return c;
    },

    // merged view a guide/KML consumes: place metadata + this person's verdict (verdict fields win).
    merged: async slug => {
      const place = await readJson(`places/${slug}.json`);
      const verdict = await readJson(`evaluations/${slug}.json`);
      if (!place && !verdict) return null;
      return { ...(place || {}), ...(verdict || {}), slug };
    },
  };
};
