// cap-layer.test.mjs — the SES cap layer (console.mjs). Proves the confinement that makes the dietician a real
// sharable capability: a 'guide' link has NO scan/evaluate/diet access; a 'scanner' is city-locked + rate/TTL
// bounded; an 'editor' can edit the diet but not scan; revoke drops the swissnum from the /rpc locator.
// Runs under SES. Run: node cap-layer.test.mjs
import '@endo/init';
import assert from 'node:assert/strict';
import { E } from '@endo/far';
import { makeDietician } from './console.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok -', m); } else { fail++; console.error('  FAIL -', m); } };
const denied = async fn => { try { await fn(); return false; } catch { return true; } };

const fakePipeline = {
  listCities: () => [{ slug: 'oakland', name: 'Oakland' }, { slug: 'berkeley', name: 'Berkeley' }],
  scan: async c => ({ ok: true, city: c, candidates: [] }),
  evaluate: async o => ({ ok: true, evaluated: 0, city: o.city }),
  buildMap: async () => ({ ok: true, total: 0 }),
  generateGuide: async which => ({ ok: true, which }),
};
const fakeStore = {
  counts: async () => ({ VIABLE: 5, BORDERLINE: 3, SKIP: 10, UNKNOWN: 1, total: 19 }),
  readArtifact: async rel => `<html>GUIDE ${rel}</html>`,
  readSpec: async () => 'BINDING DIET SPEC',
  writeSpec: async () => {},
};

(async () => {
  let now = 1000;
  const clock = () => now;
  const { root, locator, rootSwiss } = makeDietician({ pipeline: fakePipeline, store: fakeStore, person: 'alexa', baseUrl: 'http://t', clock });

  ok(locator.get(rootSwiss) && locator.get(rootSwiss).cap === root, 'root registered under a stable swissnum');
  const d = await E(root).describe();
  ok(d.kind === 'root' && d.person === 'alexa' && d.counts.total === 19, 'root.describe → counts + person');

  // ---- guide facet: read-only, NO scan/evaluate/diet ----
  const g = await E(root).share('guide', 'a friend');
  ok(/^[0-9a-f]{32}$/.test(g.swiss) && g.url === `http://t/#cap=${g.swiss}`, 'guide share minted with a #cap= url');
  const guide = locator.get(g.swiss).cap;
  ok(/GUIDE/.test(await E(guide).readGuide('eats')), 'guide.readGuide returns the published HTML');
  ok((await E(guide).status()).counts.total === 19, 'guide.status → counts');
  ok(await denied(() => E(guide).scan('oakland')), 'guide has NO scan (confinement)');
  ok(await denied(() => E(guide).evaluate({ city: 'oakland' })), 'guide has NO evaluate');
  ok(await denied(() => E(guide).readSpec()), 'guide has NO diet-spec access');
  ok(await denied(() => E(guide).share('guide', 'x')), 'guide cannot re-share / mint');

  // ---- scanner facet: city-locked + rate-bounded, cannot publish/read diet ----
  const s = await E(root).share('scanner', 'oakland only', { city: 'oakland', maxCalls: 2 });
  const scanner = locator.get(s.swiss).cap;
  ok((await E(scanner).scan()).city === 'oakland', 'scanner.scan (city-locked) works'); // 1 of 2
  ok(await denied(() => E(scanner).scan('berkeley')), 'scanner refuses a city outside its scope');
  ok((await E(scanner).scan()).ok, 'second scan ok'); // 2 of 2
  ok(await denied(() => E(scanner).scan()), 'scanner rate gate stops after maxCalls'); // 3 → throws
  ok(await denied(() => E(scanner).writeSpec('x')), 'scanner cannot edit the diet');
  ok(await denied(() => E(scanner).buildMap()), 'scanner cannot build/publish');

  // ---- scanner TTL ----
  const st = await E(root).share('scanner', 'expiring', { ttlMs: 100 });
  const scTtl = locator.get(st.swiss).cap;
  ok((await E(scTtl).scan('oakland')).ok, 'fresh TTL scanner works');
  now += 200; // advance past the TTL
  ok(await denied(() => E(scTtl).scan('oakland')), 'expired TTL scanner is refused');

  // ---- editor facet: edits diet + re-evaluates, no scan/publish ----
  const e = await E(root).share('editor', 'diet editor');
  const ed = locator.get(e.swiss).cap;
  ok((await E(ed).readSpec()) === 'BINDING DIET SPEC', 'editor reads the diet spec');
  ok((await E(ed).writeSpec('NEW SPEC')).ok, 'editor writes the diet spec');
  ok((await E(ed).evaluate({ city: 'oakland' })).ok, 'editor can re-evaluate');
  ok(await denied(() => E(ed).scan('oakland')), 'editor has NO scan');
  ok(await denied(() => E(ed).buildMap()), 'editor cannot publish');

  // ---- listShares + revoke ----
  ok((await E(root).listShares()).length === 4, 'four named shares listed');
  const rev = await E(root).revoke(g.swiss);
  ok(rev.revoked && !locator.has(g.swiss), 'revoke drops the swissnum from the /rpc locator');
  ok((await E(root).listShares()).length === 3, 'revoked share dropped from listShares');

  // ---- unknown facet kind refused ----
  ok(await denied(() => E(root).share('superuser', 'x')), 'an unknown facet kind is refused');
  ok(await denied(() => E(root).share('guide', '')), 'an unnamed share is refused');

  console.log(`\n${fail ? '✗' : '✓'} cap-layer: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
