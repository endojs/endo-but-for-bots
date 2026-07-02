// component-shares-double-spend.test.mjs — P1-8 regression.
//
// Before the fix, makeComponentShares built a FRESH makePurse per open (reading the stored balance each
// time). Two opens that each read balance X before either persisted would both debit X→X−perOpen, losing
// one debit (a double-spend of the shared component-allowance). The fix routes allowance purses through the
// server's ONE cached `purseAt(key, seed)` accessor, so every open of a share reads and debits the SAME
// in-memory purse instance — debits can't be lost.
//
// This test builds a purseAt exactly like server.mjs (a chatPurses cache + makePurse + a purse-store-shaped
// backing map), then (a) reproduces the OLD lost-debit with two fresh purses over the raw store to show the
// hazard is real, and (b) proves the cached-purseAt path conserves under many interleaved opens.
import '@endo/init'; // SES: makeComponentShares/makePurse harden their exports at load
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { makeComponentShares } from './component-shares.mjs';
import { makePurse } from './purse.mjs';

// A minimal purse-store-shaped backing map (get returns the live {balance,granted}; set writes synchronously).
const makeBackingStore = () => {
  const data = new Map();
  return {
    data,
    get: k => data.get(k),
    set: (k, balance, granted) => { data.set(k, { balance: Math.round(balance) || 0, granted: Math.round(granted) || 0 }); },
  };
};

// A faithful copy of server.mjs's purseAt: cache-per-key, rehydrate from the backing store, persist on change.
const makePurseAt = store => {
  const cache = new Map();
  const purseAt = (k, seed) => {
    let p = cache.get(k);
    if (!p) {
      const saved = store.get(k);
      p = makePurse(saved ? saved.balance : seed, { granted: saved ? saved.granted : undefined, onChange: (b, g) => store.set(k, b, g) });
      if (!saved) store.set(k, p.balance(), p.granted());
      cache.set(k, p);
    }
    return p;
  };
  return { purseAt, cache };
};

test('P1-8: the lost-debit hazard is real for fresh-per-open purses', () => {
  // Demonstrate WHAT the fix prevents: two purses built from the same store snapshot, interleaved.
  const store = makeBackingStore();
  const KEY = 'cshare:demo';
  store.set(KEY, 100, 100);
  const fresh = () => { const s = store.get(KEY); return makePurse(s.balance, { granted: s.granted, onChange: (b, g) => store.set(KEY, b, g) }); };
  const a = fresh(); // reads 100
  const b = fresh(); // reads 100 (a hasn't persisted yet)
  a.debit(10); // store → 90
  b.debit(10); // b's in-memory was 100 → 90, store → 90  (should be 80: ONE debit was lost)
  assert.equal(store.get(KEY).balance, 90, 'fresh-per-open loses a debit (this is the bug the fix removes)');
});

test('P1-8: concurrent opens over the cached purseAt debit correctly (no lost debit)', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cshare-p18-'));
  const file = path.join(tmp, 'component-shares.json');
  const store = makeBackingStore();
  const { purseAt, cache } = makePurseAt(store);
  const shares = makeComponentShares({ file, purseAt });

  const perOpen = 10_000;
  const total = 50_000; // affords exactly 5 opens
  const token = shares.create({ componentId: 'cmp-1', cells: [{ id: 'c1', handle: 'h' }], charge: { scheme: 'allowance', total, perOpen } });

  // Fire many opens "concurrently" — each open interleaves a microtask between reading and charging, the
  // shape a real async route takes. With a single cached purse these serialize; a fresh purse per open
  // would double-spend.
  const open = async () => { await Promise.resolve(); return shares.chargeOpen(token); };
  const results = await Promise.all(Array.from({ length: 12 }, open));

  const okCount = results.filter(r => r.ok).length;
  const denied = results.filter(r => !r.ok).length;
  assert.equal(okCount, 5, 'exactly total/perOpen opens succeed');
  assert.equal(denied, 7, 'the rest are refused (allowance used up)');

  // Exactly ONE purse instance ever existed for this share's key — the crux of the fix.
  const keys = [...cache.keys()].filter(k => k.startsWith('cshare:'));
  assert.equal(keys.length, 1, 'a single cached purse serves every open (no fresh-per-open purse)');
  const purse = purseAt(keys[0]);
  assert.equal(purse.balance(), 0, 'the allowance drained to exactly zero — no lost debit, no over-spend');
  assert.equal(store.get(keys[0]).balance, 0, 'and the persisted balance agrees');

  // A further open is deterministically refused.
  const after = await open();
  assert.equal(after.ok, false, 'a drained share refuses further opens');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('P1-8: two opens resolve to the SAME purse instance (identity)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cshare-id-'));
  const store = makeBackingStore();
  const { purseAt } = makePurseAt(store);
  const shares = makeComponentShares({ file: path.join(tmp, 's.json'), purseAt });
  const token = shares.create({ componentId: 'c', cells: [], charge: { scheme: 'allowance', total: 30_000, perOpen: 10_000 } });
  const rec = shares.get(token);
  const p1 = purseAt(rec.purseKey);
  const p2 = purseAt(rec.purseKey);
  assert.equal(p1, p2, 'purseAt returns the one cached instance for the share key');
  p1.debit(10_000); p2.debit(10_000);
  assert.equal(p1.balance(), 10_000, 'both handles are the same purse — two debits both land');
  fs.rmSync(tmp, { recursive: true, force: true });
});
