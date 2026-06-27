// codemode.test.mjs — SINGLE-RETRY on recoverable network errors for tool execution.
//
// The CodeMode loop wraps each granted capability (`wrapCall`) so the model's program can `await` it.
// A network-touching tool can fail TRANSIENTLY — a reset socket, a timeout, a dropped connection. Those
// recoverable blips deserve ONE immediate retry before the failure is surfaced to the program. A NON-
// recoverable error (a logic/validation error) must NOT be retried — it is the answer.
//
// These tests drive runAgentCode with a stub LLM whose program calls a stub tool, and assert:
//   1) a tool that throws a recoverable network error ONCE then succeeds → the program sees the SUCCESS
//      (the call was retried exactly once), and a `tool-retry` step was emitted.
//   2) a tool that throws a NON-recoverable error is NOT retried (called exactly once), and the program
//      sees the {ok:false,error} envelope.
//   3) a tool that fails with a recoverable error on BOTH the original attempt and the retry → the
//      program sees the {ok:false,error}, and the tool was called exactly twice (single retry, no storm).
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert';
import { runAgentCode } from './codemode.mjs';

// A manifest entry + toolbox cap for a single tool named `netCall`. `runs` is a queue of behaviours
// (functions) applied to successive cap.run() invocations; `calls` counts invocations.
const makeNetTool = behaviours => {
  const state = { calls: 0 };
  const manifest = [{ name: 'netCall', description: 'a network-touching tool', args: {} }];
  const toolbox = {
    netCall: {
      run: async () => {
        const i = state.calls;
        state.calls += 1;
        const b = behaviours[i] || behaviours[behaviours.length - 1];
        return b();
      },
    },
  };
  return { manifest, toolbox, state };
};

// A stub LLM that, on its FIRST turn, emits a program calling netCall() and returning its result;
// on any later turn (the loop fed an OUTPUT back) it just answers, so the loop terminates.
const llmCallsNetCallOnce = () => {
  let turn = 0;
  return async () => {
    turn += 1;
    if (turn === 1) {
      return { text: '```js\nconst r = await netCall();\nreturn r;\n```' };
    }
    return { text: 'ANSWER: done' };
  };
};

test('recoverable network error is retried ONCE and then succeeds', async () => {
  const recoverable = () => { const e = new Error('socket hang up'); e.code = 'ECONNRESET'; throw e; };
  const succeed = () => ({ ok: true, payload: 'fresh data' });
  const { manifest, toolbox, state } = makeNetTool([recoverable, succeed]);

  const steps = [];
  const result = await runAgentCode({
    toolbox,
    manifest,
    userText: 'fetch it',
    llm: llmCallsNetCallOnce(),
    onStep: s => steps.push(s),
  });

  assert.ok(result, 'returns a result');
  assert.strictEqual(state.calls, 2, 'tool should be called twice: original + one retry');
  // The program returned the tool result; the SUCCESSFUL value must be the one the program saw.
  const toolStep = steps.find(s => s.kind === 'tool' && s.name === 'netCall');
  assert.ok(toolStep, 'a successful tool step should be recorded');
  assert.deepStrictEqual(toolStep.result, { ok: true, payload: 'fresh data' }, 'program saw the retried SUCCESS');
  // A retry trace was emitted for the first (recoverable) failure.
  const retryStep = steps.find(s => s.kind === 'tool-retry' && s.name === 'netCall');
  assert.ok(retryStep, 'a tool-retry step should be emitted for the recoverable failure');
});

test('a NON-recoverable error is NOT retried — surfaced immediately', async () => {
  const nonRecoverable = () => { const e = new Error('invalid argument: missing id'); e.code = 'EINVAL'; throw e; };
  const { manifest, toolbox, state } = makeNetTool([nonRecoverable]);

  const steps = [];
  await runAgentCode({
    toolbox,
    manifest,
    userText: 'do it',
    llm: llmCallsNetCallOnce(),
    onStep: s => steps.push(s),
  });

  assert.strictEqual(state.calls, 1, 'non-recoverable error must NOT be retried');
  const retryStep = steps.find(s => s.kind === 'tool-retry' && s.name === 'netCall');
  assert.ok(!retryStep, 'no tool-retry step for a non-recoverable error');
  const errStep = steps.find(s => s.kind === 'tool-error' && s.name === 'netCall');
  assert.ok(errStep, 'the error is surfaced as a tool-error step');
});

test('a recoverable error that persists is retried exactly ONCE (no retry storm)', async () => {
  const recoverable = () => { throw new Error('fetch failed: connection reset'); };
  const { manifest, toolbox, state } = makeNetTool([recoverable]);

  const steps = [];
  await runAgentCode({
    toolbox,
    manifest,
    userText: 'do it',
    llm: llmCallsNetCallOnce(),
    onStep: s => steps.push(s),
  });

  assert.strictEqual(state.calls, 2, 'a persistent recoverable error is retried exactly once: 2 calls total');
  const retryStep = steps.find(s => s.kind === 'tool-retry' && s.name === 'netCall');
  assert.ok(retryStep, 'a tool-retry step is emitted');
  const errStep = steps.find(s => s.kind === 'tool-error' && s.name === 'netCall');
  assert.ok(errStep, 'after the failed retry the error is surfaced');
});
