// codemode-objects.test.mjs — the OBJECT CHANNEL (increment 1a): when a program hands answer()/ask()/blocked()
// a NON-STRING value (a plain object, a live Endo Remotable with methods, a circular graph, a promise, or a bare
// cap/swissnum), codemode must NOT coerce it to the useless "[object Object]" and lose the live data. It CAPTURES
// a cap-safe structured descriptor on `r.objects` (the CONTRACT documented in codemode.mjs) and puts a clean,
// legible 🌱 placeholder in the reply text. Proves: (a) plain object, (b) Far/Remotable-like with methods,
// (c) circular object, (d) bare cap string → no "[object Object]" in the text; descriptors carry kind/methods/
// scrubbed-sample; the cap case is redacted; and a JSON.stringify-throwing value does not crash the turn.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentCode } from './codemode.mjs';

const scriptedLLM = replies => { let i = 0; const fn = async () => { const text = replies[i] || ''; i += 1; return { text, usage: null }; }; fn.calls = () => i; return fn; };
const run = code => runAgentCode({ toolbox: {}, manifest: [], userText: 'go', llm: scriptedLLM(['```js\n' + code + '\n```']) });
const noSmell = s => { assert.ok(!/\[object \w+\]/.test(String(s)), `no raw "[object …]" smell in: ${JSON.stringify(s)}`); };

test('(a) a PLAIN OBJECT handed to answer() is captured, not destroyed to [object Object]', async () => {
  const r = await run('answer({ city: "Paris", temp: 21, ok: true });');
  noSmell(r.answer);
  assert.ok(Array.isArray(r.objects) && r.objects.length === 1, 'one descriptor on the objects channel');
  const d = r.objects[0];
  assert.equal(d.kind, 'object');
  assert.ok(/Paris/.test(d.sample) && /21/.test(d.sample), 'the sample preserves the real data');
  assert.ok(/🌱/.test(r.answer), 'the text is a legible placeholder that references the object');
});

test('(b) a Far/Remotable-like object with METHODS captures its method names + kind=remotable', async () => {
  // shape a __getMethodNames__-bearing object INSIDE the program (host cap wrappers arrive the same way).
  const code = [
    'const obj = harden({',
    '  __getMethodNames__: () => ["send", "inbox", "help"],',
    '  send: () => {}, inbox: () => {}, help: () => "a peer",',
    '});',
    'answer(obj);',
  ].join('\n');
  const r = await run(code);
  noSmell(r.answer);
  const d = r.objects[0];
  assert.equal(d.kind, 'remotable');
  assert.deepEqual(d.methods, ['help', 'inbox', 'send'], 'methods are captured, sorted');
  assert.ok(/help|inbox|send/.test(r.answer), 'the placeholder summarizes the methods');
});

test('(c) a CIRCULAR object does not crash the turn and is captured with a «circular» sample', async () => {
  const code = 'const a = { name: "root" }; a.self = a; answer(a);';
  const r = await run(code);
  noSmell(r.answer);
  assert.equal(r.objects.length, 1);
  assert.ok(/root/.test(r.objects[0].sample), 'the reachable data is preserved');
  assert.ok(/circular/i.test(r.objects[0].sample), 'the cycle is marked, not thrown on');
});

test('(d) a bare CAP/swissnum string is REDACTED — the secret never reaches the text or the sample', async () => {
  const swiss = '0123456789abcdef0123456789abcdef';
  const r = await run(`answer(${JSON.stringify(swiss)});`);
  assert.ok(!r.answer.includes(swiss), 'the raw swissnum is NOT in the reply text');
  assert.equal(r.objects[0].redacted, true, 'the descriptor is flagged redacted');
  assert.ok(!JSON.stringify(r.objects[0]).includes(swiss), 'the raw swissnum is NOT in the descriptor');
});

test('(d2) a #cap= URL embedded in an otherwise-normal string answer is scrubbed', async () => {
  const cap = '#cap=deadbeefdeadbeefdeadbeef';
  const r = await run(`answer("here is your link " + ${JSON.stringify(cap)});`);
  assert.ok(!r.answer.includes('deadbeef'), 'the swissnum is scrubbed from the text');
  assert.ok(/here is your link/.test(r.answer), 'the surrounding prose survives');
});

test('an ARRAY is captured as kind=array with a length label', async () => {
  const r = await run('answer([1, 2, { x: 3 }]);');
  noSmell(r.answer);
  assert.equal(r.objects[0].kind, 'array');
  assert.ok(/Array\(3\)/.test(r.objects[0].name));
});

test('a value whose getters THROW during JSON.stringify does not crash — descriptor still emitted', async () => {
  const code = [
    'const bomb = harden({ get boom() { throw new Error("nope"); }, safe: 7 });',
    'answer(bomb);',
  ].join('\n');
  const r = await run(code);
  noSmell(r.answer);
  assert.equal(r.objects.length, 1, 'a descriptor is still produced');
  assert.ok(r.answer.length > 0, 'the turn produced a non-empty reply (did not crash)');
});

test('a PROMISE handed to answer() is captured as kind=promise (the [object Promise] smell)', async () => {
  const r = await run('answer(Promise.resolve(42));');
  noSmell(r.answer);
  assert.equal(r.objects[0].kind, 'promise');
});

test('a plain STRING answer is unchanged (no objects channel) and a NUMBER still coerces', async () => {
  const r1 = await run('answer("just a normal reply");');
  assert.equal(r1.answer, 'just a normal reply');
  assert.equal(r1.objects, undefined, 'ordinary string reply carries no objects channel');
  const r2 = await run('answer(42);');
  assert.equal(r2.answer, '42', 'a number still coerces to its string (back-compat)');
  assert.equal(r2.objects, undefined);
});

test('ask()/blocked() also carry the object channel + keep their kind flags', async () => {
  const rAsk = await run('ask({ options: ["a", "b"] });');
  assert.equal(rAsk.asking, true);
  assert.ok(rAsk.objects && rAsk.objects.length === 1, 'ask() captured the object');
  noSmell(rAsk.answer);
  const rBlk = await run('blocked({ reason: "missing power", need: "home" });');
  assert.equal(rBlk.blocked, true);
  assert.ok(rBlk.objects && rBlk.objects.length === 1);
  noSmell(rBlk.answer);
});
