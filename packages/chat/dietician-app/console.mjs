// console.mjs — the Endo CAP LAYER over the pure pipeline. makeDietician wraps the injected pipeline+store in
// hardened Remotables behind swissnums (the rover-app/gpu-lease pattern): a root DietConsole holds the owner's
// full authority + the share() minting power; share(kind,label) MINTS a narrower, swissnum-bound, independently
// revocable facet — 'guide' (read-only published verdicts/site; the link you hand a friend), 'scanner'
// (scan+evaluate, optionally city-locked + rate/TTL-bounded; cannot publish or read the diet), 'editor' (edit
// the diet spec + re-evaluate; no publish). The Google key + judge live in the injected pipeline, NEVER in a
// facet — a 'guide' holder has no scan() method, so confinement is lexical, not a runtime check. revoke =
// forget the swissnum (root-side only). This module runs AFTER @endo/init (grunt.mjs / the cap test).
import { Far } from '@endo/far';
import crypto from 'node:crypto';

export const newSwiss = () => crypto.randomBytes(16).toString('hex');

// sliding-window + TTL rate gate (gpu-lease makeRateGate). clock injected so it's testable.
const makeRateGate = ({ maxCalls = 40, windowMs = 3600000, ttlMs = 0, clock = Date.now } = {}) => {
  const created = clock();
  const hits = [];
  const prune = now => { while (hits.length && now - hits[0] > windowMs) hits.shift(); };
  return {
    check() {
      const now = clock();
      if (ttlMs && now - created > ttlMs) throw new Error('this link has expired');
      prune(now);
      if (hits.length >= maxCalls) throw new Error(`rate limit reached (${maxCalls} per ${Math.round(windowMs / 60000)} min)`);
      hits.push(now);
    },
    remaining() { const now = clock(); prune(now); return Math.max(0, maxCalls - hits.length); },
  };
};

export const makeDietician = ({ pipeline, store, baseUrl = 'http://127.0.0.1:8782', person = 'alexa', clock = Date.now, rootSwiss } = {}) => {
  const locator = new Map();
  const register = (swiss, cap, kind, label) => { locator.set(swiss, { cap, kind, label }); return swiss; };
  const urlFor = swiss => `${baseUrl}/#cap=${swiss}`;
  const siteRel = which => `site/${which === 'disney' ? 'disney' : 'eats'}/index.html`;

  // ---- attenuated facets — each its own Far object → own swissnum → independently revocable ----
  const makeGuideFacet = label => Far('DietGuide', {
    describe: async () => ({ kind: 'guide', label, person, counts: await store.counts(), can: ['readGuide', 'listCities', 'status'] }),
    status: async () => ({ counts: await store.counts() }),
    listCities: () => pipeline.listCities().map(c => ({ slug: c.slug, name: c.name })),
    readGuide: async (which = 'eats') => (await store.readArtifact(siteRel(which))) || '',
    help: () => 'Read-only safe-eats guide. readGuide("eats"|"disney") → published HTML; status() → verdict counts; listCities(). No scan / evaluate / publish / diet access.',
  });

  const makeScannerFacet = (label, { city, ttlMs = 0, maxCalls = 40 } = {}) => {
    const gate = makeRateGate({ maxCalls, windowMs: 3600000, ttlMs, clock });
    const locked = city ? String(city) : null;
    const resolveCity = c => {
      const want = String(c || locked || '');
      if (locked && want && want !== locked) throw new Error(`this scanner is scoped to "${locked}"`);
      if (!want) throw new Error('a city is required');
      return locked || want;
    };
    return Far('DietScanner', {
      describe: () => ({ kind: 'scanner', label, person, city: locked, remaining: gate.remaining(), can: ['scan', 'evaluate'] }),
      scan: async c => { const city = resolveCity(c); gate.check(); return pipeline.scan(city); },
      evaluate: async ({ city, limit } = {}) => { const c = resolveCity(city); gate.check(); return pipeline.evaluate({ city: c, limit }); },
      help: () => `Scoped scanner${locked ? ` for ${locked}` : ''}. scan(city) + evaluate({city,limit}); rate/TTL-bounded; cannot publish or read the diet spec.`,
    });
  };

  const makeEditorFacet = label => Far('DietEditor', {
    describe: () => ({ kind: 'editor', label, person, can: ['readSpec', 'writeSpec', 'evaluate'] }),
    readSpec: () => store.readSpec(),
    writeSpec: async text => { await store.writeSpec(String(text || '')); return { ok: true, bytes: String(text || '').length }; },
    evaluate: async ({ city, limit } = {}) => pipeline.evaluate({ city, limit }),
    help: () => 'Diet editor. readSpec() / writeSpec(text) edit the binding diet; evaluate({city,limit}) re-judges against it. No publish.',
  });

  const mintFacet = (kind, label, opts = {}) => {
    const swiss = newSwiss();
    const cap = kind === 'guide' ? makeGuideFacet(label)
      : kind === 'scanner' ? makeScannerFacet(label, opts)
        : kind === 'editor' ? makeEditorFacet(label)
          : null;
    if (!cap) throw new Error(`unknown facet kind "${kind}" — use guide | scanner | editor`);
    register(swiss, cap, kind, label);
    return { swiss, cap };
  };

  const shares = new Map();

  const root = Far('DietConsole', {
    describe: async () => ({ kind: 'root', person, label: `Dietician — ${person}`, cities: pipeline.listCities().length, counts: await store.counts() }),
    status: async () => ({ person, counts: await store.counts(), cities: pipeline.listCities().length }),
    listCities: () => pipeline.listCities(),
    scan: c => pipeline.scan(c),
    evaluate: o => pipeline.evaluate(o || {}),
    buildMap: o => pipeline.buildMap(o || {}),
    generateGuide: (which, o) => pipeline.generateGuide(which, o || {}),
    readGuide: async (which = 'eats') => (await store.readArtifact(siteRel(which))) || '',
    readSpec: () => store.readSpec(),
    writeSpec: async t => { await store.writeSpec(String(t || '')); return { ok: true }; },
    // mint a NAMED, narrower, independently-revocable facet link. label required (to recognize at revoke time).
    share: (kind, label, opts) => {
      const clean = String(label || '').trim().slice(0, 80);
      if (!clean) throw new Error('a name is required for a share link (so you can recognize it to revoke later)');
      const { swiss } = mintFacet(String(kind || ''), clean, opts || {});
      shares.set(swiss, { kind, label: clean, opts: opts || {}, createdAt: new Date(clock()).toISOString() });
      return { kind, label: clean, swiss, url: urlFor(swiss) };
    },
    listShares: () => [...shares.entries()].filter(([s]) => locator.has(s)).map(([swiss, s]) => ({ swiss, kind: s.kind, label: s.label, createdAt: s.createdAt })),
    revoke: swiss => { const k = String(swiss); const had = locator.delete(k); shares.delete(k); return { revoked: had }; },
    help: () => 'Dietician console (owner). describe/status; scan(city); evaluate({city,limit}); buildMap(); generateGuide("eats"|"disney"); readSpec/writeSpec; share(kind,label,opts) → guide|scanner|editor link; listShares; revoke(swiss).',
  });

  const rs = rootSwiss && /^[0-9a-f]{32}$/.test(rootSwiss) ? rootSwiss : newSwiss();
  register(rs, root, 'root', `Dietician (${person})`);
  return { root, rootSwiss: rs, locator, register, urlFor, newSwiss };
};
