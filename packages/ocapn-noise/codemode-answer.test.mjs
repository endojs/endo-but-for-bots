// codemode-answer.test.mjs — the FINAL ANSWER is delivered by calling answer(text) in the program scope (a
// first-class function), not by an `ANSWER:` text marker parsed out of prose. Proves: (1) answer() in a program
// becomes the turn's reply; (2) it works after a tool call; (3) answer() ENDS the turn — the model isn't called
// again and code after answer() does NOT run; (4) non-string args coerce; (5) the `ANSWER:` marker is RETIRED
// (a no-program reply is delivered verbatim, not stripped) — the last in-band control marker is gone.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentCode } from './codemode.mjs';

// a scripted LLM: returns the next canned reply each call, counting invocations.
const scriptedLLM = replies => { let i = 0; const fn = async () => { const text = replies[i] || ''; i += 1; return { text, usage: null }; }; fn.calls = () => i; return fn; };

test('answer() in a program is the final reply, and ends the turn', async () => {
  const llm = scriptedLLM(['```js\nanswer("hello from the answer function");\n```']);
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'hi', llm });
  assert.equal(r.answer, 'hello from the answer function');
  assert.equal(llm.calls(), 1, 'answer() ended the turn — exactly one model call (no extra round-trip)');
});

test('answer() works after a real tool call (tool runs, then the reply is delivered)', async () => {
  let ran = 0;
  const toolbox = { getX: { run: async () => { ran += 1; return { value: 42 }; } } };
  const manifest = [{ name: 'getX', description: 'get x', args: {} }];
  const steps = [];
  const llm = scriptedLLM(['```js\nconst x = await getX();\nanswer("x is " + x.value);\n```']);
  const r = await runAgentCode({ toolbox, manifest, userText: 'get x', llm, onStep: s => steps.push(s) });
  assert.equal(ran, 1, 'the tool ran');
  assert.equal(r.answer, 'x is 42', 'the answer composed the tool result');
  assert.ok(steps.some(s => s.kind === 'tool' && s.name === 'getX'), 'the tool call is in the trace');
  assert.ok(r.toolsUsed.some(u => u.name === 'getX'), 'the tool is recorded in toolsUsed');
});

test('answer() ENDS the turn immediately — code after it does not run', async () => {
  let ranAfter = 0;
  const toolbox = { sideEffect: { run: async () => { ranAfter += 1; return { ok: true }; } } };
  const manifest = [{ name: 'sideEffect', description: 'a side effect', args: {} }];
  const llm = scriptedLLM(['```js\nanswer("done");\nawait sideEffect();\n```']);
  const r = await runAgentCode({ toolbox, manifest, userText: 'go', llm });
  assert.equal(r.answer, 'done');
  assert.equal(ranAfter, 0, 'the tool AFTER answer() never ran — answer() unwound the program');
  assert.equal(llm.calls(), 1, 'no further model calls after answer()');
});

test('answer() coerces a non-string argument to a string', async () => {
  const llm = scriptedLLM(['```js\nanswer(42);\n```']);
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'n', llm });
  assert.equal(r.answer, '42');
});

test('ask(question) ends the turn with the asking flag (no answer/blocked flags)', async () => {
  const llm = scriptedLLM(['```js\nask("which city did you mean?");\n```']);
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'weather?', llm });
  assert.equal(r.answer, 'which city did you mean?', 'the question is delivered as the reply text');
  assert.equal(r.asking, true, 'asking flag is set');
  assert.equal(r.blocked, undefined, 'blocked flag is NOT set');
  assert.equal(llm.calls(), 1, 'ask() ended the turn');
});

test('blocked(reason) ends the turn with the blocked flag', async () => {
  const llm = scriptedLLM(['```js\nblocked("I need the home power, which I have requested.");\n```']);
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'turn on the lights', llm });
  assert.equal(r.answer, 'I need the home power, which I have requested.');
  assert.equal(r.blocked, true, 'blocked flag is set');
  assert.equal(r.asking, undefined, 'asking flag is NOT set');
  assert.equal(llm.calls(), 1, 'blocked() ended the turn');
});

test('ask()/blocked() end the turn immediately — code after them does not run, and they work after a tool', async () => {
  let after = 0;
  const toolbox = { peek: { run: async () => ({ value: 7 }) }, sideEffect: { run: async () => { after += 1; } } };
  const manifest = [{ name: 'peek', description: 'peek', args: {} }, { name: 'sideEffect', description: 'fx', args: {} }];
  const r = await runAgentCode({ toolbox, manifest, userText: 'go',
    llm: scriptedLLM(['```js\nconst x = await peek();\nblocked("stuck at " + x.value);\nawait sideEffect();\n```']) });
  assert.equal(r.answer, 'stuck at 7', 'blocked() composed the tool result');
  assert.equal(r.blocked, true);
  assert.equal(after, 0, 'code after blocked() never ran');
});

test('the ANSWER: marker is RETIRED — a no-program reply is delivered VERBATIM (not stripped)', async () => {
  // The last in-band marker is gone: the loop no longer recognizes or strips a leading "ANSWER:".
  const r1 = await runAgentCode({ toolbox: {}, manifest: [], userText: 'q', llm: scriptedLLM(['ANSWER: legacy text']) });
  assert.equal(r1.answer, 'ANSWER: legacy text', 'the ANSWER: prefix is NOT stripped — the marker is retired');
  // a plain natural-language reply (no program) is still delivered as the answer — that is content, not a marker.
  const r2 = await runAgentCode({ toolbox: {}, manifest: [], userText: 'q', llm: scriptedLLM(['just some plain prose']) });
  assert.equal(r2.answer, 'just some plain prose', 'a prose reply is delivered as the answer');
});

test('safety net: a bare answer/ask/blocked("…") call WITHOUT a code fence is unwrapped AND keeps its flag', async () => {
  const cases = [
    { q: 'answer("unfenced reply")', asking: undefined, blocked: undefined },
    { q: "ask('unfenced reply');", asking: true, blocked: undefined },
    { q: 'blocked(`unfenced reply`)', asking: undefined, blocked: true },
  ];
  for (const { q, asking, blocked } of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'q', llm: scriptedLLM([q]) });
    assert.equal(r.answer, 'unfenced reply', `unwrapped ${q}`);
    assert.equal(r.asking, asking, `asking flag for ${q}`);
    assert.equal(r.blocked, blocked, `blocked flag for ${q}`);
  }
});
