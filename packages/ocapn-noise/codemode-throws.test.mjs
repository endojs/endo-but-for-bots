// codemode-throws.test.mjs — REL-3: the CodeMode loop must turn EVERY throw into a structured terminal
// turn result, never let one escape as a rejection (which is what opened the /chat REL-1 window and, pre-fix,
// hit the plaintext outer catch / left the run stuck 'running'). Proves:
//   (1) a thrown provider error (invoke() rejects, not { error }) → { llmError } terminal turn, no rejection;
//   (2) a thrown INFERENCE_BUDGET_EXHAUSTED from a metered sub-call (delegateTask) → { exhausted } terminal
//       turn with resumeFrom (the top-up path), NOT swallowed as an ordinary tool error the program runs past;
//   (3) an ordinary tool throw is still swallowed to { ok:false, error } and the loop keeps going (unchanged).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentCode } from './codemode.mjs';

test('a thrown provider error becomes a terminal { llmError } turn (never an escaped rejection)', async () => {
  const llm = async () => { throw new Error('anthropic fetch: ECONNRESET'); };
  let r;
  await assert.doesNotReject(async () => { r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'hi', llm }); });
  assert.match(String(r.llmError), /ECONNRESET/, 'the throw surfaced as llmError');
  assert.equal(r.answer, '', 'no answer persisted for a provider error');
});

test('INFERENCE_BUDGET_EXHAUSTED thrown from a metered sub-call → terminal { exhausted } turn with resumeFrom', async () => {
  // delegateTask is exposed as a normal tool; its metered wrapper throws the coded error before any paid call.
  const boom = () => { const e = new Error('INFERENCE_BUDGET_EXHAUSTED: needs 100 µUSD but purse has 5'); e.code = 'INFERENCE_BUDGET_EXHAUSTED'; throw e; };
  const toolbox = { delegateTask: { run: async () => boom() } };
  const manifest = [{ name: 'delegateTask', description: 'delegate', args: { prompt: 'string' } }];
  const llm = (() => { let i = 0; return async () => { i += 1; return { text: '```js\nawait delegateTask({ prompt: "do a big thing" });\nanswer("done");\n```', usage: null }; }; })();
  let r;
  await assert.doesNotReject(async () => { r = await runAgentCode({ toolbox, manifest, userText: 'delegate this', llm }); });
  assert.equal(r.exhausted, true, 'routed to the exhausted / top-up path, not a swallowed tool error');
  assert.ok(Array.isArray(r.resumeFrom), 'hands back an in-flight transcript so a top-up can resume');
});

test('an ORDINARY tool throw is still swallowed to { ok:false, error } and the loop continues', async () => {
  const toolbox = { flaky: { run: async () => { throw new Error('kaboom'); } } };
  const manifest = [{ name: 'flaky', description: 'flaky', args: {} }];
  // round 1: call flaky (throws → error result); round 2: answer using the fact it failed.
  const llm = (() => { const replies = ['```js\nconst x = await flaky();\nconsole.log(JSON.stringify(x));\n```', '```js\nanswer("handled the failure");\n```']; let i = 0; return async () => { const text = replies[i] || ''; i += 1; return { text, usage: null }; }; })();
  const r = await runAgentCode({ toolbox, manifest, userText: 'go', llm });
  assert.equal(r.answer, 'handled the failure', 'the loop continued past a swallowed tool error');
  assert.equal(r.exhausted, undefined, 'an ordinary throw is NOT treated as exhaustion');
  assert.equal(r.llmError, undefined, 'an ordinary tool throw is NOT an llmError');
});
