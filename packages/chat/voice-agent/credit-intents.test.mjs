// credit-intents.test.mjs — INT-6: payment credit is crash-safe + idempotent. Proves:
//   (1) a normal credit applies once and is marked 'applied';
//   (2) a CRASH between the durable redeem-record and the purse credit (doLiveCredit throws / process dies
//       before mark-applied) leaves a PENDING intent → boot replay applies it EXACTLY ONCE (money not lost);
//   (3) replay does NOT double-credit an already-applied intent, and apply() is a no-op for a known id;
//   (4) a corrupt-but-present journal is NOT silently reset (guarded — owed credits can't vanish).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeCreditIntents } from './credit-intents.mjs';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'credit-intents-')), 'journal.json');

// a fake purse store: hash -> balance, with a flushable "durable" mirror to model the crash window.
const makeFakePurse = () => { const bal = new Map(); return { bal, creditByHash: (h, u) => { bal.set(h, (bal.get(h) || 0) + u); return bal.get(h); } }; };

test('a normal credit applies once and is marked applied', () => {
  const file = tmpFile(); const purse = makeFakePurse();
  const ci = makeCreditIntents({ file, creditByHash: purse.creditByHash });
  let credited = 0;
  const r = ci.apply('stripe:pay1', { hashedKey: 'HASH_A', uusd: 1000, kind: 'stripe' }, () => { credited += 1; purse.bal.set('HASH_A', 1000); });
  assert.deepEqual(r, { applied: true, already: false });
  assert.equal(credited, 1);
  assert.equal(ci.status('stripe:pay1'), 'applied');
  assert.equal(ci.apply('stripe:pay1', { hashedKey: 'HASH_A', uusd: 1000 }, () => { credited += 1; }).already, true, 'a second apply for the same id is a no-op');
  assert.equal(credited, 1, 'idempotent — not credited twice');
});

test('a CRASH before mark-applied → boot replay applies the lost credit exactly once', () => {
  const file = tmpFile(); const purse = makeFakePurse();
  // Simulate the crash: doLiveCredit throws AFTER the pending intent is journaled but the purse never got it.
  const ci1 = makeCreditIntents({ file, creditByHash: purse.creditByHash });
  assert.throws(() => ci1.apply('deleg:tx7', { hashedKey: 'HASH_B', uusd: 5000, kind: 'delegation' }, () => { throw new Error('process died mid-credit'); }));
  assert.equal(purse.bal.get('HASH_B'), undefined, 'purse got nothing (the money-loss window)');
  assert.equal(ci1.status('deleg:tx7'), 'pending', 'the owed credit is durably recorded as pending');

  // BOOT: a fresh instance loads the journal from disk and replays.
  const ci2 = makeCreditIntents({ file, creditByHash: purse.creditByHash });
  const n = ci2.replayPending();
  assert.equal(n, 1, 'one credit replayed');
  assert.equal(purse.bal.get('HASH_B'), 5000, 'the user got their paid credit after boot');
  assert.equal(ci2.status('deleg:tx7'), 'applied');

  // A SECOND boot must NOT re-apply it (idempotent).
  const ci3 = makeCreditIntents({ file, creditByHash: purse.creditByHash });
  assert.equal(ci3.replayPending(), 0, 'nothing pending on the next boot');
  assert.equal(purse.bal.get('HASH_B'), 5000, 'not double-credited across boots');
});

test('replay does not touch an already-applied intent', () => {
  const file = tmpFile(); const purse = makeFakePurse();
  const ci = makeCreditIntents({ file, creditByHash: purse.creditByHash });
  ci.apply('stripe:payX', { hashedKey: 'HASH_C', uusd: 2000 }, () => purse.bal.set('HASH_C', 2000));
  assert.equal(ci.replayPending(), 0, 'no pending intents');
  assert.equal(purse.bal.get('HASH_C'), 2000, 'balance unchanged by a no-op replay');
});

test('a corrupt-but-present journal is NOT silently reset (guarded)', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ "intents": { CORRUPT');
  assert.throws(() => makeCreditIntents({ file, creditByHash: () => {} }), e => e && e.code === 'STORE_CORRUPT', 'refuses to lose owed credits on corruption');
});
