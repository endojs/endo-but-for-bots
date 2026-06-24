// self-heal.test.mjs — promise-preserving error recovery (designs/self-healing-errors.md), proven with an
// INJECTED (deterministic) fixer — no model in the loop. Covers the generic healer + the custom-tools
// end-to-end adoption, with the mandatory negatives (bounded exhaustion, fixer-gives-up, no-fixer, no-source).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { makeSelfHealer, makeReviewedFixer } from './self-heal.mjs';

// ─────────── the generic healer ───────────
test('heal: a throwing attempt is repaired in place → the promise RESOLVES with the fixed value', async () => {
  let live = 'broken';
  const healer = makeSelfHealer({ fix: async ({ error }) => ({ source: 'fixed', summary: `was: ${error}` }), max: 2 });
  const r = await healer.heal({
    label: 't', source: live,
    attempt: async () => { if (live !== 'fixed') throw new Error('boom'); return 42; },
    apply: async s => { live = s; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.value, 42, 'the caller gets the repaired value, never the error');
  assert.equal(r.healed, true);
  assert.equal(r.patches.length, 1);
  assert.equal(live, 'fixed', 'the runtime-mutable source was swapped live');
});

test('heal: bounded — an unfixable attempt exhausts tries and returns GRACEFULLY (never throws)', async () => {
  let n = 0, calls = 0;
  const healer = makeSelfHealer({ fix: async () => ({ source: `try-${(n += 1)}` }), max: 2 });
  const r = await healer.heal({ label: 't', source: 's', attempt: async () => { calls += 1; throw new Error('still broken'); }, apply: async () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'still broken', 'surfaces the last error, gracefully (no throw)');
  assert.equal(calls, 3, 'bounded: 1 initial + max(2) retries');
});

test('heal: a fixer that gives up (null) stops immediately; no fixer behaves like a plain try', async () => {
  let c1 = 0; const giveUp = await makeSelfHealer({ fix: async () => null, max: 3 }).heal({ source: 's', attempt: async () => { c1 += 1; throw new Error('x'); }, apply: async () => {} });
  assert.equal(giveUp.ok, false); assert.equal(c1, 1, 'no retry once the fixer returns null');
  let c2 = 0; const none = await makeSelfHealer({}).heal({ source: 's', attempt: async () => { c2 += 1; throw new Error('x'); }, apply: async () => {} });
  assert.equal(none.ok, false); assert.equal(c2, 1, 'no fixer wired → one attempt, graceful');
});

// ─────────── reviewed fixer: a patch faces the same adversarial panel ───────────
test('makeReviewedFixer: a patch undergoes review — CRITICAL is refused, non-critical passes with the verdict attached', async () => {
  const fix = async () => ({ source: 'return async () => 1;', summary: 'patched' });
  const crit = makeReviewedFixer({ fix, review: async () => ({ worst: 'critical', findings: [] }) });
  assert.equal(await crit({ source: 'x', error: 'e' }), null, 'a critically-flawed patch is refused (never auto-applied)');
  const okFixer = makeReviewedFixer({ fix, review: async () => ({ worst: 'low', findings: [] }) });
  const r = await okFixer({ source: 'x', error: 'e' });
  assert.equal(r.source, 'return async () => 1;', 'a non-critical patch is applied');
  assert.equal(r.review.worst, 'low', 'the panel verdict is attached');
  assert.match(r.summary, /review: low/, 'verdict folded into the audit summary');
  const bare = makeReviewedFixer({ fix }); // no panel wired → behaves as the raw fixer
  assert.ok((await bare({ source: 'x', error: 'e' })).source, 'no review fn → raw patch passes through');
  const strict = makeReviewedFixer({ fix, review: async () => ({ worst: 'high', findings: [] }), reject: ['high', 'critical'] });
  assert.equal(await strict({ source: 'x', error: 'e' }), null, 'the reject set is configurable (e.g. also refuse high)');
});

// ─────────── custom-tools end-to-end ───────────
let _v = 0;
const mkTools = async fix => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-heal-'));
  process.env.CUSTOM_TOOLS_STORE = path.join(dir, 'tools.json');
  process.env.CUSTOM_TOOLS_STATE = path.join(dir, 'state');
  const { makeCustomTools } = await import(`./custom-tools.mjs?v=${(_v += 1)}`); // ?v= → fresh module eval re-reads the STORE env
  return makeCustomTools({ fix });
};
const admit = (tools, code) => { const p = tools.propose({ name: 'inc', code, proposedBy: 'test', now: new Date().toISOString() }); tools.admit(p.id); return p.id; };

test('custom tool that THROWS in its method self-heals: the call resolves with the fixed value + persists + logs', async () => {
  const fix = async ({ error }) => (/needs doubling/.test(error) ? { source: 'return async ({ x }) => x * 2;', summary: 'implement x*2' } : null);
  const tools = await mkTools(fix);
  const id = admit(tools, "return async ({ x }) => { throw new Error('needs doubling'); };");
  const r = await tools.call(id, { args: { x: 3 } });
  assert.equal(r.ok, true, 'the broken call is repaired + RESOLVES — no error reaches the caller');
  assert.equal(r.value, 6, 'returns the fixed result');
  assert.equal(r.healed, 1, 'reports one repair');
  assert.match(tools.get(id).code, /x \* 2/, 'the patched source is persisted (setSource)');
  assert.equal((tools.listAll().find(t => t.id === id).healLog || []).length, 1, 'the repair is audited on the tool');
  const r2 = await tools.call(id, { args: { x: 5 } }); // already fixed → no heal needed
  assert.equal(r2.ok, true); assert.equal(r2.value, 10); assert.ok(!r2.healed, 'a now-working tool heals zero times');
});

test("custom-tools hands the fixer the agent's DOCUMENTS: the authoring guide + the tool's review history", async () => {
  let seen = null;
  const fix = async input => { seen = input; return { source: 'return async () => 1;' }; };
  const tools = await mkTools(fix);
  const id = admit(tools, "return async () => { throw new Error('boom'); };");
  tools.setReview(id, { worst: 'medium', findings: [{ severity: 'medium', discipline: 'ocapReviewer', report: 'watch the cap' }] });
  await tools.call(id, { args: {} });
  assert.ok(seen && seen.ctx, 'the fixer was invoked with ctx');
  assert.match(seen.ctx.guide || '', /make\(powers\)/, 'ctx carries the canonical authoring guide the agent has');
  assert.equal(seen.ctx.review && seen.ctx.review.worst, 'medium', "ctx carries THIS tool's admission review");
  assert.match(seen.error, /boom/, 'and the actual runtime error');
});

test('custom tool that THROWS at instantiation self-heals too', async () => {
  const fix = async ({ error }) => (/init fail/.test(error) ? { source: 'return async () => 7;', summary: 'drop the throw' } : null);
  const tools = await mkTools(fix);
  const id = admit(tools, "throw new Error('init fail');\nreturn async () => 1;"); // make(powers) throws
  const r = await tools.call(id, { args: {} });
  assert.equal(r.ok, true); assert.equal(r.value, 7, 'instantiation error repaired → resolves');
});

test('no fixer wired → a broken tool returns a plain error (today\'s behaviour, unchanged)', async () => {
  const tools = await mkTools(undefined);
  const id = admit(tools, "return async ({ x }) => { throw new Error('boom'); };");
  const r = await tools.call(id, { args: { x: 1 } });
  assert.equal(r.ok, false); assert.match(r.error, /boom/);
});

test('unfixable tool → bounded heal, then a GRACEFUL error (never throws, no infinite repair)', async () => {
  let tries = 0;
  const fix = async () => ({ source: `return async () => { throw new Error('still-${(tries += 1)}'); };` }); // every patch still throws
  const tools = await mkTools(fix);
  const id = admit(tools, "return async () => { throw new Error('orig'); };");
  const r = await tools.call(id, { args: {} });
  assert.equal(r.ok, false, 'gives up gracefully');
  assert.match(r.error, /still-/, 'surfaces the last attempted error');
  assert.equal(tries, 2, 'bounded number of repair attempts (max)');
});
