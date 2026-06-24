// meter-delegate.test.mjs — the prepaid toll on a DELEGATED (Opus) turn, deterministic
// (no model / no network): a FAKE delegate + a small purse prove the two seam claims.
//   node --test packages/chat/voice-agent/meter-delegate.test.mjs
//
// Claims under test:
//   1. EXHAUSTION THROWS — an unfunded purse makes the metered delegate throw
//      INFERENCE_BUDGET_EXHAUSTED *before* the (paid) delegate is ever called.
//   2. FUNDED DEBITS — a funded purse runs the delegate and debits the ACTUAL delta
//      cost computed from the returned cumulative `usage`, accumulating per-provider.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMeteredDelegate } from './meter.mjs';
import { makePurse } from './purse.mjs';
import { costOf } from './costModel.mjs';

const MODEL = 'claude-opus-4-8';

// A FAKE delegate mimicking runOpusDelegate: records whether it ran, returns a fixed
// usage so the cost is deterministic. (Real signature: ({prompt,...}) -> {answer,usage}.)
const makeFakeDelegate = (usage) => {
  let called = 0;
  const fn = async (args) => { called += 1; return { answer: 'done', toolsUsed: [], model: MODEL, usage }; };
  fn.calls = () => called;
  return fn;
};

test('EXHAUSTION THROWS — an unfunded purse throws INFERENCE_BUDGET_EXHAUSTED before any paid call', async () => {
  const purse = makePurse(0); // empty: cannot afford even the floor
  const fake = makeFakeDelegate({ input_tokens: 500, output_tokens: 300 });
  const metered = makeMeteredDelegate({ delegate: fake, purse, model: MODEL });

  await assert.rejects(
    () => metered({ prompt: 'do a thing' }),
    (e) => {
      assert.equal(e.code, 'INFERENCE_BUDGET_EXHAUSTED', 'carries the stable code');
      assert.match(String(e.message), /INFERENCE_BUDGET_EXHAUSTED/);
      return true;
    },
  );
  assert.equal(fake.calls(), 0, 'the paid delegate was NEVER called');
  assert.equal(purse.balance(), 0, 'nothing was debited');
});

test('FUNDED DEBITS — a funded purse runs the delegate and debits the actual delta cost', async () => {
  const usage = { input_tokens: 500, output_tokens: 300 };
  const actual = costOf(MODEL, usage); // the µUSD the turn really cost
  assert.ok(actual > 0, 'the fixture usage prices > 0');

  const start = actual + 1000; // funded comfortably above the actual cost
  const perProvider = {};
  const purse = makePurse(start);
  const fake = makeFakeDelegate(usage);
  const metered = makeMeteredDelegate({ delegate: fake, purse, perProvider, model: MODEL });

  const out = await metered({ prompt: 'do a thing' });

  assert.equal(fake.calls(), 1, 'the delegate ran exactly once');
  assert.equal(out.answer, 'done', 'the delegate result is passed through');
  assert.equal(out.cost, actual, 'reported cost is the actual usage-priced delta');
  assert.equal(out.remaining, start - actual, 'remaining = balance - actual cost');
  assert.equal(purse.balance(), start - actual, 'the purse was debited the actual delta');
  assert.equal(perProvider['anthropic:claude-opus-4-8'], actual, 'per-provider spend accumulated');
});

test('a small purse that covers the FLOOR but not the full turn still runs (check-before / charge-after)', async () => {
  // The floor is small; a purse that can afford the floor passes the gate, then the
  // actual (larger) debit may drive the balance to/below zero — the NEXT turn is refused.
  const usage = { input_tokens: 5000, output_tokens: 4000 }; // a big, expensive turn
  const actual = costOf(MODEL, usage);
  const floorCost = costOf(MODEL, { input_tokens: 200, output_tokens: 100 });
  assert.ok(actual > floorCost, 'the real turn costs more than the floor');

  const purse = makePurse(floorCost); // exactly affords the floor, NOT the real turn
  const fake = makeFakeDelegate(usage);
  const metered = makeMeteredDelegate({ delegate: fake, purse, model: MODEL });

  const out = await metered({ prompt: 'expensive' });
  assert.equal(fake.calls(), 1, 'it ran (floor was affordable)');
  assert.equal(out.cost, actual, 'charged the full actual cost');
  assert.ok(purse.balance() <= 0, 'balance driven to/below zero by the overspend');

  // and now exhausted: the NEXT delegated turn throws.
  await assert.rejects(() => metered({ prompt: 'again' }), (e) => e.code === 'INFERENCE_BUDGET_EXHAUSTED');
});

test('a provider error is surfaced WITHOUT charging', async () => {
  const purse = makePurse(5000);
  const errDelegate = async () => ({ error: 'anthropic 500: boom' });
  const metered = makeMeteredDelegate({ delegate: errDelegate, purse, model: MODEL });
  const out = await metered({ prompt: 'x' });
  assert.equal(out.error, 'anthropic 500: boom', 'the error is surfaced');
  assert.equal(out.cost, 0, 'no charge on error');
  assert.equal(purse.balance(), 5000, 'purse untouched');
});
