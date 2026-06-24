// mem-store.mjs — an in-memory implementation of the store interface core.mjs depends on. Used by the unit
// tests now; also the reference shape the real home-folder-backed store.mjs (Slice 3) must satisfy.
//
//   placeIds()        → Map(place_id → slug)   (dedup the sweep against what's known)
//   hasPlace(slug)    → bool
//   getPlace(slug)    → place metadata | null
//   putPlace(slug,m)  → write place metadata (PLACE_FIELDS, no verdict)
//   putVerdict(slug,v)→ write this person's verdict (EVAL_FIELDS)
//   getVerdict(slug)  → verdict | null
export const makeMemStore = (seed = {}) => {
  const places = new Map(Object.entries(seed.places || {}));
  const evals = new Map(Object.entries(seed.evaluations || {}));
  return {
    placeIds: async () => {
      const m = new Map();
      for (const [slug, rec] of places) if (rec && rec.place_id) m.set(rec.place_id, slug);
      return m;
    },
    hasPlace: async slug => places.has(slug),
    getPlace: async slug => places.get(slug) || null,
    putPlace: async (slug, rec) => { places.set(slug, rec); },
    listPlaces: async () => [...places.keys()],
    putVerdict: async (slug, rec) => { evals.set(slug, rec); },
    getVerdict: async slug => evals.get(slug) || null,
    listVerdicts: async () => [...evals.keys()],
    readSpec: async () => seed.spec || '',
    // test introspection
    _places: places,
    _evals: evals,
  };
};
