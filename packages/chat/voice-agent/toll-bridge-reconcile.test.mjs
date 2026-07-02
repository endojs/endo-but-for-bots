// toll-bridge-reconcile.test.mjs — ARCH-5 regression.
//
// hosting-ledger.json (rent bookkeeping) lives BESIDE purses.json (the money). A crash between the two
// files' writes must never desync balances. The fix makes the ledger metadata-only and treats the purse as
// the single source of truth, with two guarantees:
//   (1) MONEY-SAFE ORDERING — accrue()/chargeSave() persist the advanced accrual CLOCK before debiting the
//       purse, so a torn cross-file write can only UNDER-charge (forgive a window), never double-charge; and
//   (2) RECONCILE-ON-LOAD — corrupt/future/garbage ledger entries are dropped or clamped so they can't
//       synthesize a phantom rent debit on the next accrue.
import '@endo/init'; // SES: toll-bridge/purse harden their exports at load
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { costOf } from './costModel.mjs';
import { makePurse } from './purse.mjs';
import { makePurseStore } from './purse-store.mjs';
import { makeTollBridge } from './toll-bridge.mjs';

const DAY = 86_400_000;
const mkdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'toll-arch5-'));

// Build a bridge over real, file-backed stores in `dir`. hostRate fixed for deterministic rent.
const mkBridge = (dir, hostRate = 667) => {
  const purseStore = makePurseStore({ file: path.join(dir, 'purses.json'), debounceMs: 1 });
  const bridge = makeTollBridge({ purseStore, makePurse, costOf, ledgerFile: path.join(dir, 'hosting-ledger.json'), hostRate });
  return { purseStore, bridge };
};

test('ARCH-5: reconcile-on-load drops malformed entries and clamps future/garbage ticks (no phantom debit)', () => {
  const dir = mkdir();
  const ledgerFile = path.join(dir, 'hosting-ledger.json');
  // A hand-written ledger with: a valid entry with a FUTURE lastTick, a garbage-tick entry, and a malformed
  // entry (no account). Simulates a torn/corrupt-but-parseable file.
  const future = new Date(Date.now() + 5 * DAY).toISOString();
  fs.writeFileSync(ledgerFile, JSON.stringify({
    good: { account: 'acct-1', bytes: 1_000_000, appName: 'a', since: new Date(Date.now() - DAY).toISOString(), lastTick: future, accrued: 500, delinquent: false },
    garbage: { account: 'acct-1', bytes: 1_000_000, since: 'not-a-date', lastTick: 'xyz', accrued: 0 },
    malformed: { bytes: 5, appName: 'no-account' },
  }));
  const { purseStore, bridge } = mkBridge(dir);
  bridge.fund({ account: 'acct-1', uusd: 1_000_000 });
  const before = bridge.check('acct-1').remaining;
  // reconcile ran at load; a future/garbage tick must not produce a negative-elapsed → giant rent.
  const { total } = bridge.accrue(Date.now()); // now < the clamped ticks' window ⇒ ~0 due
  assert.equal(total, 0, 'clamped ticks yield no rent this instant (no phantom debit)');
  assert.equal(bridge.check('acct-1').remaining, before, 'purse untouched by the corrupt ledger');
  // malformed entry was dropped from the persisted ledger.
  const reloaded = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.ok(!('malformed' in reloaded), 'malformed (accountless) entry dropped on reconcile');
  assert.ok('good' in reloaded && 'garbage' in reloaded, 'valid entries survive');
  purseStore.flushNow?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ARCH-5: accrue persists the ledger BEFORE debiting the purse (save-then-charge ordering)', () => {
  const dir = mkdir();
  const ledgerFile = path.join(dir, 'hosting-ledger.json');
  const purseStore = makePurseStore({ file: path.join(dir, 'purses.json'), debounceMs: 1 });
  // A makePurse whose debit inspects the on-disk ledger to prove the clock was already persisted.
  let observedTickAtDebit = null;
  const spyMakePurse = (initial, opts) => {
    const p = makePurse(initial, opts);
    return harden({ ...p, debit: amt => { try { observedTickAtDebit = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')).site1?.lastTick; } catch { observedTickAtDebit = 'unreadable'; } return p.debit(amt); } });
  };
  const bridge = makeTollBridge({ purseStore, makePurse: spyMakePurse, costOf, ledgerFile, hostRate: 667 });
  bridge.fund({ account: 'acct', uusd: 10_000_000 });
  const t0 = Date.now();
  bridge.chargeSave({ account: 'acct', key: 'site1', bytes: 1_000_000, appName: 'app' }, t0);
  observedTickAtDebit = null;
  const t1 = t0 + DAY; // a full day of rent accrues
  const { total } = bridge.accrue(t1);
  assert.ok(total > 0, 'a day of rent was charged');
  assert.equal(observedTickAtDebit, new Date(t1).toISOString(), 'at debit-time the ledger on disk already showed the advanced tick (save-before-charge)');
  purseStore.flushNow?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ARCH-5: a restart replaying accrue after a lost purse-debit does NOT double-charge', () => {
  const dir = mkdir();
  const ledgerFile = path.join(dir, 'hosting-ledger.json');
  const pursesFile = path.join(dir, 'purses.json');
  // Bridge 1: register an artifact and accrue a day of rent (ledger advances, purse debited).
  const ps1 = makePurseStore({ file: pursesFile, debounceMs: 1 });
  const b1 = makeTollBridge({ purseStore: ps1, makePurse, costOf, ledgerFile, hostRate: 667 });
  b1.fund({ account: 'acct', uusd: 10_000_000 });
  // Use PAST-relative times so the persisted tick is never in the future relative to the reload's real
  // Date.now() (reconcile-on-load legitimately clamps future ticks — in production `now` is always
  // Date.now(), so a persisted tick is never future; the test must respect that invariant).
  const now = Date.now();
  const t0 = now - 3 * DAY;
  b1.chargeSave({ account: 'acct', key: 'site1', bytes: 2_000_000, appName: 'app' }, t0);
  const t1 = now - 2 * DAY;
  const paid = b1.accrue(t1).total;
  assert.ok(paid > 0, 'day-1 rent charged');
  ps1.flushNow(); // ledger already durable (atomic); ensure the purse debit is durable too
  const balAfter = b1.check('acct').remaining;

  // Simulate the money-SAFE torn variant: the ledger persisted (tick=t1) but the purse debit was LOST — roll
  // the purses file back to its pre-accrue balance. (Reverse ordering makes THIS the only possible torn
  // case; the double-charge case — old ledger + debited purse — cannot occur because the ledger is written
  // first and durably.) A restart must then NOT re-charge the already-advanced window.
  const purseData = JSON.parse(fs.readFileSync(pursesFile, 'utf8'));
  for (const k of Object.keys(purseData)) purseData[k].balance += paid; // "un-apply" the lost debit
  fs.writeFileSync(pursesFile, JSON.stringify(purseData));

  // Bridge 2: fresh process over the SAME files. Re-accrue at t1.
  const ps2 = makePurseStore({ file: pursesFile, debounceMs: 1 });
  const b2 = makeTollBridge({ purseStore: ps2, makePurse, costOf, ledgerFile, hostRate: 667 });
  const replay = b2.accrue(t1).total;
  assert.equal(replay, 0, 'the already-advanced window is NOT re-charged on restart (no double-charge)');
  // And going forward, rent still accrues from t1 normally.
  const forward = b2.accrue(t1 + DAY).total;
  assert.ok(forward > 0, 'rent still accrues for the next window (clock is live, not frozen)');
  ps2.flushNow();
  assert.equal(b1 && b2 && balAfter >= 0, true);
  fs.rmSync(dir, { recursive: true, force: true });
});
