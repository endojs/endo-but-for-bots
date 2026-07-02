// purse-unit.test.mjs — T-TEST-3 · unit coverage for the µUSD ledger primitives
// (purse.mjs makePurse/makeBoundedSubPurse + purse-store.mjs makePurseStore/hashKey).
//
// Load-bearing invariants asserted here:
//   • credit/set are the ONLY balance-increasers; debit only ever decreases.
//   • `granted` (allowance) tracks total-ever-granted and never shrinks on a debit.
//   • a bounded sub-purse cannot spend past its cap NOR past its parent (assert-then-charge).
//   • onChange fires after every mutation with (balance, granted) — the persistence hook.
//   • makePurseStore hashes the (swiss-num) key on disk, round-trips through get/set,
//     debounces writes (nothing on disk until the timer / flushNow), and reloads durably.
// Hermetic: store files live under mkdtemp and every store is flushed+swept in teardown
// (T-TEST-1: never touch a live purses.json; a leaked debounce timer holds the event loop open).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makePurse, makeBoundedSubPurse } from './purse.mjs';
import { makePurseStore, hashKey } from './purse-store.mjs';

// ---- makePurse -----------------------------------------------------------

test('makePurse: initial clamps negatives, rounds, and seeds granted = balance', () => {
  assert.equal(makePurse(-5).balance(), 0);
  assert.equal(makePurse(3.7).balance(), 4);
  const p = makePurse(100);
  assert.equal(p.granted(), 100);
});

test('makePurse: credit raises BOTH balance and granted; debit lowers ONLY balance', () => {
  const seen = [];
  const p = makePurse(100, { onChange: (b, g) => seen.push([b, g]) });
  assert.equal(p.credit(50), 150);
  assert.equal(p.balance(), 150);
  assert.equal(p.granted(), 150); // allowance grew with the top-up
  assert.equal(p.debit(30), 120);
  assert.equal(p.balance(), 120);
  assert.equal(p.granted(), 150); // debit did NOT shrink the allowance ("120 of 150 left")
  // onChange fired once per mutation, carrying (balance, granted)
  assert.deepEqual(seen, [[150, 150], [120, 150]]);
});

test('makePurse: debit past zero goes negative and the NEXT call is refused by canAfford', () => {
  const p = makePurse(40);
  p.debit(100); // check-before/charge-after can drive balance below zero by at most one call
  assert.equal(p.balance(), -60);
  assert.equal(p.canAfford(1), false);
  assert.equal(p.canAfford(0), false); // -60 >= 0 is false
});

test('makePurse: set() resets balance AND granted to the same value', () => {
  const p = makePurse(100);
  p.debit(40);
  assert.equal(p.set(10), 10);
  assert.equal(p.balance(), 10);
  assert.equal(p.granted(), 10);
});

test('makePurse: rehydrate restores granted (can exceed balance after spending)', () => {
  const p = makePurse(20, { granted: 200 }); // 20 of 200 left
  assert.equal(p.balance(), 20);
  assert.equal(p.granted(), 200);
  // granted floors at balance: a granted BELOW the balance is bumped up to it
  const q = makePurse(50, { granted: 10 });
  assert.equal(q.granted(), 50);
});

// ---- makeBoundedSubPurse -------------------------------------------------

test('sub-purse: refuses over-cap AND over-parent spends without mutating either ledger', () => {
  const parent = makePurse(100);
  const sub = makeBoundedSubPurse({ parent, cap: 40 });
  assert.equal(sub.cap(), 40);
  assert.equal(sub.balance(), 40); // remaining cap
  // over its own cap → throws, both ledgers untouched
  assert.throws(() => sub.debit(41), /over cap/);
  assert.equal(sub.spent(), 0);
  assert.equal(parent.balance(), 100);
  // within cap but the parent is drained → throws on the parent-affordance assertion
  parent.debit(90); // parent now holds 10
  assert.equal(sub.canAfford(20), false);
  assert.throws(() => sub.debit(20), /parent cannot afford/);
  assert.equal(sub.spent(), 0);
  assert.equal(parent.balance(), 10); // refusal left the parent untouched
});

test('sub-purse: a debit draws down the shared parent; the parent is the conserved quantity', () => {
  const parent = makePurse(100);
  const a = makeBoundedSubPurse({ parent, cap: 80 });
  const b = makeBoundedSubPurse({ parent, cap: 80 });
  a.debit(60);
  b.debit(30);
  assert.equal(parent.balance(), 10);
  assert.ok(a.spent() + b.spent() <= 100); // sum of children can never exceed what the parent held
});

test('makeBoundedSubPurse rejects a missing/invalid parent', () => {
  assert.throws(() => makeBoundedSubPurse({ cap: 10 }), /requires a parent/);
  assert.throws(() => makeBoundedSubPurse({ parent: {}, cap: 10 }), /requires a parent/);
});

// ---- hashKey + makePurseStore -------------------------------------------

test('hashKey: stable, 64-hex, and collision-distinct for different keys', () => {
  const h1 = hashKey('cap-swissnum:sid-1');
  assert.equal(h1, hashKey('cap-swissnum:sid-1')); // deterministic
  assert.match(h1, /^[0-9a-f]{64}$/); // sha-256 hex
  assert.notEqual(h1, hashKey('cap-swissnum:sid-2'));
});

const stores = [];
const mkStore = (opts = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purse-store-test-'));
  const file = path.join(dir, 'sub', 'purses.json'); // nested → also proves mkdirSync recursion
  const store = makePurseStore({ file, ...opts });
  stores.push({ store, dir });
  return { store, file, dir };
};
test.afterEach(() => {
  for (const { store, dir } of stores.splice(0)) {
    try { store.flushNow(); } catch { /* */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
});

test('purseStore: set/get round-trips by the HASHED key, never the raw swissnum', () => {
  const { store, file } = mkStore();
  const rawKey = 'SECRET-cap-swissnum:sid';
  store.set(rawKey, 500, 500);
  assert.deepEqual(store.get(rawKey), { balance: 500, granted: 500 });
  store.flushNow();
  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('SECRET-cap-swissnum'), 'raw key must never hit disk (cap-hygiene)');
  assert.ok(onDisk.includes(hashKey(rawKey)), 'disk is keyed by the sha-256 hash');
});

test('purseStore: writes are DEBOUNCED — nothing on disk until the timer/flushNow', async () => {
  const { store, file } = mkStore({ debounceMs: 50 });
  store.set('k', 10, 10);
  assert.ok(!fs.existsSync(file), 'debounced: no write yet');
  await new Promise(r => setTimeout(r, 90)); // let the debounce timer fire
  assert.ok(fs.existsSync(file), 'debounce timer flushed the write');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[hashKey('k')], { balance: 10, granted: 10 });
});

test('purseStore: flushNow writes immediately (the shutdown path)', () => {
  const { store, file } = mkStore({ debounceMs: 100000 }); // effectively never auto-flushes
  store.set('k', 42, 99);
  assert.ok(!fs.existsSync(file));
  store.flushNow();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[hashKey('k')], { balance: 42, granted: 99 });
});

test('purseStore: creditByHash adds to an existing (already-hashed) balance — the INT-6 boot-replay path', () => {
  const { store } = mkStore();
  const h = hashKey('some-cap:sid');
  store.set('some-cap:sid', 100, 100);
  const after = store.creditByHash(h, 250);
  assert.equal(after, 350);
  assert.equal(store.get('some-cap:sid').balance, 350);
  // crediting a never-seen hash starts from base 0
  assert.equal(store.creditByHash(hashKey('fresh'), 80), 80);
});

test('purseStore: remove deletes an entry; reload from disk is durable', () => {
  const { store, file } = mkStore();
  store.set('keep', 5, 5);
  store.set('drop', 9, 9);
  store.remove('drop');
  store.flushNow();
  // a fresh store over the same file rehydrates only the surviving entry
  const store2 = makePurseStore({ file });
  stores.push({ store: store2, dir: path.dirname(path.dirname(file)) });
  assert.deepEqual(store2.get('keep'), { balance: 5, granted: 5 });
  assert.equal(store2.get('drop'), undefined);
});
