// meter-delegate-wiring.test.mjs — PROVES the Opus delegate path is WIRED into the purse.
//
// The seam under test is delegate.mjs's makeMeteredOpusDelegate, which wraps the bare
// runOpusDelegate with meter.mjs's makeMeteredDelegate so a DELEGATED (Opus) turn is
// metered against the chat purse EXACTLY like callLLM is via makeMeteredLLM:
//   1. FUNDED → runs the (paid) Opus turn and DEBITS the actual usage-priced cost,
//      accumulating per-provider spend (cost > 0, remaining = balance − cost).
//   2. UNFUNDED → THROWS INFERENCE_BUDGET_EXHAUSTED *before* any paid Opus call (the
//      network is never touched — exhaustion never routes through the model).
// Deterministic: global fetch is stubbed to a fixed Messages-API response (no network).
//
//   node --test packages/chat/voice-agent/meter-delegate-wiring.test.mjs
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeMeteredOpusDelegate } from './delegate.mjs';
import { makePurse } from './purse.mjs';
import { costOf } from './costModel.mjs';

const MODEL = process.env.DELEGATE_MODEL || 'claude-opus-4-8';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// A fixed cumulative usage so the priced cost is deterministic.
const USAGE = { input_tokens: 800, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

// Install a fake Messages-API fetch: counts calls and returns a single end_turn answer
// carrying USAGE (so runOpusDelegate finishes in one step with that cumulative usage).
const installFakeFetch = () => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          stop_reason: 'end_turn',
          usage: USAGE,
          content: [{ type: 'text', text: 'delegated answer' }],
        };
      },
      async text() { return ''; },
    };
  };
  return {
    calls: () => calls,
    restore: () => { globalThis.fetch = realFetch; if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = realKey; },
  };
};

test('FUNDED — a delegated (Opus) turn debits the purse the actual usage-priced cost', async () => {
  const f = installFakeFetch();
  try {
    const actual = costOf(MODEL, USAGE);
    assert.ok(actual > 0, 'the fixture usage prices > 0');
    const start = actual + 5000;
    const perProvider = {};
    const purse = makePurse(start);
    const delegate = makeMeteredOpusDelegate({ purse, perProvider, model: MODEL });

    const r = await delegate({ prompt: 'do a delegated thing', manifest: [], grantedPowers: [] });

    assert.ok(f.calls() >= 1, 'the paid Opus turn actually ran (network touched)');
    assert.equal(r.answer, 'delegated answer', 'the delegate result passes through');
    assert.equal(r.cost, actual, 'reported cost = actual usage-priced delta');
    assert.equal(r.remaining, start - actual, 'remaining = balance − actual cost');
    assert.equal(purse.balance(), start - actual, 'the purse was actually debited');
    assert.ok(perProvider[`anthropic:${MODEL}`] === actual, 'per-provider spend accumulated');
  } finally { f.restore(); }
});

test('UNFUNDED — a delegated turn THROWS INFERENCE_BUDGET_EXHAUSTED before any paid call', async () => {
  const f = installFakeFetch();
  try {
    const purse = makePurse(0); // empty: cannot afford even the floor
    const delegate = makeMeteredOpusDelegate({ purse, perProvider: {}, model: MODEL });

    await assert.rejects(
      () => delegate({ prompt: 'do a delegated thing', manifest: [], grantedPowers: [] }),
      (e) => {
        assert.equal(e.code, 'INFERENCE_BUDGET_EXHAUSTED', 'carries the stable code');
        assert.match(String(e.message), /INFERENCE_BUDGET_EXHAUSTED/);
        return true;
      },
    );
    assert.equal(f.calls(), 0, 'the network/model was NEVER touched (refused before any paid call)');
    assert.equal(purse.balance(), 0, 'nothing was debited');
  } finally { f.restore(); }
});

test('NO PURSE — makeMeteredOpusDelegate is an unmetered pass-through (free contexts)', async () => {
  const f = installFakeFetch();
  try {
    const delegate = makeMeteredOpusDelegate({}); // no purse
    const r = await delegate({ prompt: 'free turn', manifest: [], grantedPowers: [] });
    assert.equal(r.answer, 'delegated answer', 'still runs the delegate, just unmetered');
    assert.equal(r.cost, undefined, 'no cost field when unmetered');
  } finally { f.restore(); }
});

test('WIRED AT THE CALL SITE — server threads the purse into ctx and the delegate path uses the metered seam', () => {
  const server = fs.readFileSync(path.join(HERE, 'server.mjs'), 'utf8');
  const caps = fs.readFileSync(path.join(HERE, 'agent-caps.mjs'), 'utf8');
  // server.mjs hands the turn's purse + a shared perProvider ledger into the toolbox ctx.
  assert.match(server, /runNode\.toolbox\(\{[^}]*purse[^}]*perProvider[^}]*\}\)/, 'server passes purse + perProvider into the toolbox ctx');
  // agent-caps.mjs's delegateTask wraps runOpusDelegate via the metered seam fed from ctx.
  assert.match(caps, /makeMeteredOpusDelegate\(\{\s*purse:\s*ctx\.purse/, 'delegateTask builds the metered delegate from ctx.purse');
});
