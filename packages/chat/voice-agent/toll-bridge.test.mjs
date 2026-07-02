// toll-bridge.test.mjs — T-TEST-3 · unit coverage for the metering rail (toll-bridge.mjs).
//
// The silent-mis-billing risk: edit-spend must be REFUSED before the model call when an account
// is empty; hosting rent must accrue as bytes × elapsed; and fund() must be the ONLY op that ever
// raises a balance (charge/accrue only ever lower it — so a leaked account can be griefed but never
// used to steal). These tests assert that math against a fake in-memory purseStore + a controllable
// costOf, using the REAL makePurse (its debit/credit semantics are load-bearing here) and a hermetic
// mkdtemp ledger file (T-TEST-1: never touch a live store).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeTollBridge } from './toll-bridge.mjs';
import { makePurse } from './purse.mjs';

const HOST_RATE = 667; // µUSD per MB per day (the module default)

// A fake purseStore backed by a plain Map — mirrors the {balance,granted} shape the real one persists.
const makeFakePurseStore = () => {
  const m = new Map();
  return {
    get: k => m.get(k),
    set: (k, balance, granted) => { m.set(k, { balance, granted }); },
    _map: m,
  };
};

// Spin up a toll-bridge over a throwaway ledger file. `cost` is the µUSD chargeEdit will bill.
// (dirs are swept by an afterEach hook below, so no per-test `t` plumbing needed.)
const dirs = [];
const setup = ({ cost = 0 } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toll-bridge-test-'));
  dirs.push(dir);
  const ledgerFile = path.join(dir, 'hosting-ledger.json');
  const purseStore = makeFakePurseStore();
  let costVal = cost;
  const costOf = () => costVal;
  const tb = makeTollBridge({ purseStore, makePurse, costOf, ledgerFile, hostRate: HOST_RATE });
  return { tb, purseStore, ledgerFile, dir, setCost: v => { costVal = v; } };
};

test.afterEach(() => { for (const d of dirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } });

test('chargeEdit debits the exact cost and leaves the remainder', () => {
  const s = setup({ cost: 120 });
  s.tb.fund({ account: 'acct', uusd: 500 });
  const res = s.tb.chargeEdit({ account: 'acct', model: 'anthropic:x', usage: {} });
  assert.equal(res.ok, true);
  assert.equal(res.cost, 120);
  assert.equal(res.remaining, 380); // 500 − 120, exact
});

test('insufficient funds is REFUSED before the model call and does NOT debit', () => {
  const s = setup({ cost: 200 });
  s.tb.fund({ account: 'acct', uusd: 50 });
  const res = s.tb.chargeEdit({ account: 'acct', model: 'anthropic:x', usage: {} });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'insufficient');
  assert.equal(res.cost, 200);
  // refusal left the balance untouched — no partial debit (the "never route exhaustion through the model" rule)
  assert.equal(res.remaining, 50);
  assert.equal(s.tb.check('acct').remaining, 50);
});

test('a free (cost 0) edit is allowed even on an empty account and debits nothing', () => {
  const s = setup({ cost: 0 });
  // never funded → balance 0
  const res = s.tb.chargeEdit({ account: 'broke', model: 'default', usage: {} });
  assert.equal(res.ok, true);
  assert.equal(res.cost, 0);
  assert.equal(res.remaining, 0);
});

test('chargeSave charges one day of upfront rent and records the artifact in the ledger', () => {
  const s = setup({});
  s.tb.fund({ account: 'acct', uusd: 10_000 });
  // 1 MB app → one day's rent = 1 MB × 667 µUSD/MB/day = 667 µUSD upfront
  const res = s.tb.chargeSave({ account: 'acct', key: 'app-1', bytes: 1_000_000, appName: 'demo' }, 1_000);
  assert.equal(res.ok, true);
  assert.equal(res.charged, 667);
  assert.equal(res.remaining, 10_000 - 667);
  // ledger entry persisted to disk
  const led = JSON.parse(fs.readFileSync(s.ledgerFile, 'utf8'));
  assert.equal(led['app-1'].account, 'acct');
  assert.equal(led['app-1'].bytes, 1_000_000);
  assert.equal(led['app-1'].accrued, 667);
  assert.equal(led['app-1'].delinquent, false);
});

test('chargeSave refuses a size the account cannot afford — no debit, no ledger entry', () => {
  const s = setup({});
  s.tb.fund({ account: 'acct', uusd: 100 }); // can pay the canAfford(1) gate but not the 667 upfront
  const res = s.tb.chargeSave({ account: 'acct', key: 'big', bytes: 1_000_000, appName: 'big' }, 1_000);
  assert.equal(res.ok, false);
  assert.equal(res.need, 667);
  assert.equal(res.remaining, 100); // untouched
  assert.ok(!fs.existsSync(s.ledgerFile) || !JSON.parse(fs.readFileSync(s.ledgerFile, 'utf8')).big);
});

test('host-rent accrues as bytes × elapsed and debits the owner account', () => {
  const s = setup({});
  s.tb.fund({ account: 'acct', uusd: 10_000 });
  const t0 = 1_000_000; // arbitrary fixed epoch (ms)
  // publish 1 MB at t0 (charges 667 upfront)
  s.tb.chargeSave({ account: 'acct', key: 'app', bytes: 1_000_000, appName: 'a' }, t0);
  const afterSave = s.tb.check('acct').remaining;
  assert.equal(afterSave, 10_000 - 667);
  // accrue at t0 + exactly one day → 1 MB × 667 × 1 day = 667 more
  const oneDay = t0 + 86_400_000;
  const { total } = s.tb.accrue(oneDay);
  assert.equal(total, 667, 'one MB-day of rent');
  assert.equal(s.tb.check('acct').remaining, afterSave - 667);
  // accruing again at the SAME instant charges nothing (elapsed 0) — rent is not double-billed
  const again = s.tb.accrue(oneDay);
  assert.equal(again.total, 0);
});

test('accrue flags an artifact delinquent and only pays what the account can cover', () => {
  const s = setup({});
  s.tb.fund({ account: 'acct', uusd: 667 }); // exactly one day of upfront rent, nothing left over
  const t0 = 2_000_000;
  s.tb.chargeSave({ account: 'acct', key: 'app', bytes: 1_000_000, appName: 'a' }, t0);
  assert.equal(s.tb.check('acct').remaining, 0);
  // a day later 667 is due but the account is empty → partial (0) pay, marked delinquent
  const { total, delinquent } = s.tb.accrue(t0 + 86_400_000);
  assert.equal(total, 0);
  assert.deepEqual(delinquent, ['app']);
  const led = JSON.parse(fs.readFileSync(s.ledgerFile, 'utf8'));
  assert.equal(led.app.delinquent, true);
});

test('fund() is the ONLY balance-increaser; charge/accrue only decrease', () => {
  const s = setup({ cost: 100 });
  // fund raises balance AND allowance (granted)
  const f1 = s.tb.fund({ account: 'acct', uusd: 1_000 });
  assert.equal(f1.remaining, 1_000);
  assert.equal(f1.allowance, 1_000);
  // an edit lowers the balance
  s.tb.chargeEdit({ account: 'acct', model: 'x', usage: {} });
  assert.equal(s.tb.check('acct').remaining, 900);
  // a save lowers it further
  s.tb.chargeSave({ account: 'acct', key: 'k', bytes: 1_000_000, appName: 'a' }, 5_000);
  assert.equal(s.tb.check('acct').remaining, 900 - 667);
  // nothing but fund ever went up — top up again and confirm allowance keeps climbing while balance is additive
  const f2 = s.tb.fund({ account: 'acct', uusd: 500 });
  assert.equal(f2.remaining, 900 - 667 + 500);
  assert.equal(f2.allowance, 1_500); // granted only ever grows with fund
});

test('unregister only removes an artifact owned by the calling account', () => {
  const s = setup({});
  s.tb.fund({ account: 'owner', uusd: 10_000 });
  s.tb.chargeSave({ account: 'owner', key: 'k', bytes: 100_000, appName: 'a' }, 1_000);
  // a different account cannot unregister it
  const bad = s.tb.unregister('intruder', 'k');
  assert.equal(bad.ok, false);
  assert.ok(JSON.parse(fs.readFileSync(s.ledgerFile, 'utf8')).k);
  // the owner can
  const good = s.tb.unregister('owner', 'k');
  assert.equal(good.ok, true);
  assert.ok(!JSON.parse(fs.readFileSync(s.ledgerFile, 'utf8')).k);
});

test('the ledger survives a reload (durable across restart)', () => {
  const s = setup({});
  s.tb.fund({ account: 'acct', uusd: 10_000 });
  s.tb.chargeSave({ account: 'acct', key: 'persisted', bytes: 500_000, appName: 'p' }, 1_000);
  // build a fresh toll-bridge over the SAME ledger file — the artifact must still be there
  const tb2 = makeTollBridge({ purseStore: makeFakePurseStore(), makePurse, costOf: () => 0, ledgerFile: s.ledgerFile, hostRate: HOST_RATE });
  const status = tb2.accountStatus('acct', 1_000); // same instant → no new rent
  assert.equal(status.hosting.length, 1);
  assert.equal(status.hosting[0].key, 'persisted');
});
