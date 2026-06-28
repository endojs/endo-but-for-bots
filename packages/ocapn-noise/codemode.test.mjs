// codemode.test.mjs — a tool call that fails with a RECOVERABLE network error is RETRIED EXACTLY ONCE.
//
// The CodeMode loop wraps every toolbox verb so the model-authored program can `await name(args)`.
// Transient transport faults (ECONNRESET, fetch failed, 503, …) often succeed on an immediate second
// attempt, so wrapCall retries the underlying call ONE time when isRecoverableNetworkError(e) is true.
// A deterministic error (bad args, application `ok:false`) must NOT be retried. These tests pin both
// the classifier and the end-to-end retry behavior through runAgentCode.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentCode, isRecoverableNetworkError } from './codemode.mjs';

// a scripted LLM: returns the next canned reply each call, counting invocations.
const scriptedLLM = replies => { let i = 0; const fn = async () => { const text = replies[i] || ''; i += 1; return { text, usage: null }; }; fn.calls = () => i; return fn; };

const netError = (code, message) => { const e = new Error(message || code); e.code = code; return e; };

test('isRecoverableNetworkError: transient transport faults are recoverable', () => {
  assert.equal(isRecoverableNetworkError(netError('ECONNRESET')), true);
  assert.equal(isRecoverableNetworkError(netError('ETIMEDOUT')), true);
  assert.equal(isRecoverableNetworkError(netError('EAI_AGAIN')), true);
  assert.equal(isRecoverableNetworkError(new Error('fetch failed')), true);
  assert.equal(isRecoverableNetworkError(new Error('socket hang up')), true);
  const e503 = new Error('Service Unavailable'); e503.status = 503;
  assert.equal(isRecoverableNetworkError(e503), true);
  const e429 = new Error('Too Many Requests'); e429.statusCode = 429;
  assert.equal(isRecoverableNetworkError(e429), true);
  // a wrapped cause is inspected too
  assert.equal(isRecoverableNetworkError(new Error('failed', { cause: netError('ECONNREFUSED') })), true);
});

test('isRecoverableNetworkError: deterministic / application faults are NOT recoverable', () => {
  assert.equal(isRecoverableNetworkError(undefined), false);
  assert.equal(isRecoverableNetworkError(new Error('bad arguments')), false);
  assert.equal(isRecoverableNetworkError(new Error('validation failed')), false);
  const e400 = new Error('Bad Request'); e400.status = 400;
  assert.equal(isRecoverableNetworkError(e400), false);
  const e404 = new Error('Not Found'); e404.status = 404;
  assert.equal(isRecoverableNetworkError(e404), false);
});

test('a recoverable network error is retried ONCE and then succeeds', async () => {
  let attempts = 0;
  const toolbox = {
    fetchThing: {
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw netError('ECONNRESET', 'connection reset by peer');
        return { value: 'recovered' };
      },
    },
  };
  const manifest = [{ name: 'fetchThing', description: 'fetch a thing', args: {} }];
  const steps = [];
  const llm = scriptedLLM(['```js\nconst r = await fetchThing();\nanswer("got " + r.value);\n```']);
  const r = await runAgentCode({ toolbox, manifest, userText: 'go', llm, onStep: s => steps.push(s) });
  assert.equal(attempts, 2, 'the tool was attempted twice (one retry)');
  assert.equal(r.answer, 'got recovered', 'the retry succeeded and its result was used');
  assert.ok(steps.some(s => s.kind === 'tool-retry' && s.name === 'fetchThing'), 'a tool-retry step was traced');
  assert.ok(steps.some(s => s.kind === 'tool' && s.name === 'fetchThing'), 'the eventual success is in the trace');
});

test('the retry is SINGLE — a tool that always fails the network is attempted exactly twice', async () => {
  let attempts = 0;
  const toolbox = {
    fetchThing: { run: async () => { attempts += 1; throw netError('ETIMEDOUT', 'request timed out'); } },
  };
  const manifest = [{ name: 'fetchThing', description: 'fetch a thing', args: {} }];
  const steps = [];
  // the program inspects the wrapped {ok:false} result the loop returns after both attempts fail
  const llm = scriptedLLM(['```js\nconst r = await fetchThing();\nanswer(r.ok === false ? "failed" : "ok");\n```']);
  const r = await runAgentCode({ toolbox, manifest, userText: 'go', llm, onStep: s => steps.push(s) });
  assert.equal(attempts, 2, 'exactly two attempts: original + one retry (no infinite/extra retries)');
  assert.equal(r.answer, 'failed', 'after both attempts failed, the tool surfaced ok:false');
  assert.ok(steps.some(s => s.kind === 'tool-retry' && s.name === 'fetchThing'), 'one retry was traced');
  assert.ok(steps.some(s => s.kind === 'tool-error' && s.name === 'fetchThing'), 'final failure traced as tool-error');
});

test('a NON-recoverable error is NOT retried — attempted exactly once', async () => {
  let attempts = 0;
  const toolbox = {
    doThing: { run: async () => { attempts += 1; throw new Error('invalid argument: bad input'); } },
  };
  const manifest = [{ name: 'doThing', description: 'do a thing', args: {} }];
  const steps = [];
  const llm = scriptedLLM(['```js\nconst r = await doThing();\nanswer(r.ok === false ? "failed" : "ok");\n```']);
  const r = await runAgentCode({ toolbox, manifest, userText: 'go', llm, onStep: s => steps.push(s) });
  assert.equal(attempts, 1, 'a deterministic error is not retried — one attempt only');
  assert.equal(r.answer, 'failed');
  assert.ok(!steps.some(s => s.kind === 'tool-retry'), 'no tool-retry step for a non-recoverable error');
});
