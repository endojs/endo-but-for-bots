// codemode-hygiene.test.mjs — ANSWER-CHANNEL HYGIENE + EMPTY-TURN-ENDER honesty (audit P1-3 & P1-7, imp-29fb7c16).
//
// The user-visible reply must be HONEST DATA. This suite proves the codemode-side guards:
//  (P1-3) an EMPTY explicit turn-ender — answer("")/answer()/whitespace — with no other captured content is NOT
//         delivered as a silent empty bubble; it becomes a `blocked` stall with a clear message. A turn that
//         legitimately answers with an OBJECT and empty text is NOT clobbered (the object channel carries it).
//  (P1-7a) a generated PROGRAM that fails to PARSE (SyntaxError) AUTO-RETRIES ONCE with the parse error fed back,
//         then returns a clean `blocked` stall — never the raw SyntaxError text as the turn result.
//  (P1-7b) an answer that IS a raw ```js fenced program, a raw provider-error JSON blob, or a stray unfenced
//         program is REPLACED with a clean message, not shown raw. Ordinary prose replies are untouched.
import '@endo/init';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgentCode } from './codemode.mjs';

// a scripted LLM: returns the next canned reply each call, counting invocations. Records the messages it saw.
const scriptedLLM = replies => {
  let i = 0; const seen = [];
  const fn = async messages => { seen.push(messages); const text = replies[i] || ''; i += 1; return { text, usage: null }; };
  fn.calls = () => i; fn.seen = seen; return fn;
};
const run = (code, opts = {}) => runAgentCode({ toolbox: {}, manifest: [], userText: 'go', llm: scriptedLLM(['```js\n' + code + '\n```']), ...opts });
const fenced = program => '```js\n' + program + '\n```';

// ── P1-3: empty turn-ender → honest blocked stall, not a silent empty bubble ────────────────────────────────
test('(P1-3 a) answer("") with no other content → a blocked stall, NOT { answer:"" }', async () => {
  const r = await run('answer("");');
  assert.notEqual(r.answer, '', 'the reply is NOT an empty string');
  assert.ok(r.answer.trim().length > 0, 'a non-empty, legible message is delivered');
  assert.equal(r.blocked, true, 'the empty turn-ender is flagged blocked so the server treats it as a stall');
});

test('(P1-3 a2) answer() with NO argument → a blocked stall', async () => {
  const r = await run('answer();');
  assert.ok(r.answer.trim().length > 0, 'non-empty message');
  assert.equal(r.blocked, true);
});

test('(P1-3 a3) answer("   ") whitespace-only → a blocked stall', async () => {
  const r = await run('answer("   \\n\\t ");');
  assert.ok(r.answer.trim().length > 0);
  assert.equal(r.blocked, true);
});

test('(P1-3 b) answer(OBJECT) with empty text is NOT clobbered — the object channel still carries it', async () => {
  const r = await run('answer({ city: "Paris", temp: 21 });');
  assert.ok(Array.isArray(r.objects) && r.objects.length === 1, 'the object descriptor is carried');
  assert.ok(/Paris/.test(r.objects[0].sample), 'the real data survives');
  assert.notEqual(r.blocked, true, 'an object answer is NOT reclassified as blocked');
  assert.ok(/🌱/.test(r.answer), 'the 🌱 placeholder is the reply text (not the empty-stall message)');
});

test('(P1-3) a NORMAL non-empty answer keeps kind=answer (no false blocked)', async () => {
  const r = await run('answer("all set — the door is closed");');
  assert.equal(r.answer, 'all set — the door is closed');
  assert.equal(r.blocked, undefined);
});

// ── P1-7(a): SyntaxError in the generated program → retry once, then clean blocked ──────────────────────────
test('(P1-7 a) a program with a SyntaxError RETRIES once (parse error fed back), then answers', async () => {
  // round 1: a program that does NOT parse (unbalanced brace). round 2: a valid answer.
  const llm = scriptedLLM(['```js\nconst x = {\n```', '```js\nanswer("recovered after the parse retry");\n```']);
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'go', llm });
  assert.equal(r.answer, 'recovered after the parse retry', 'the retry succeeded and produced the reply');
  assert.equal(llm.calls(), 2, 'exactly one retry (two model calls total)');
  // the parse error was fed back into the retry context.
  const retryMessages = llm.seen[1];
  const lastUser = [...retryMessages].reverse().find(m => m.role === 'user');
  assert.match(lastUser.content, /did not PARSE|SyntaxError/i, 'the parse error was fed back to the model');
});

test('(P1-7 a2) a program that STILL fails to parse after the retry → a clean blocked stall (no raw SyntaxError)', async () => {
  // both rounds fail to parse. After ONE retry it must give up with a clean blocked message.
  const llm = scriptedLLM(['```js\nconst x = {\n```', '```js\nfunction (\n```', '```js\nanswer("should never reach here");\n```']);
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'go', llm });
  assert.equal(r.blocked, true, 'gives up as blocked');
  assert.equal(r.stalled, true, 'flagged stalled');
  assert.ok(!/SyntaxError|Unexpected|token/i.test(r.answer), `no raw parse-error text in the reply: ${JSON.stringify(r.answer)}`);
  assert.equal(llm.calls(), 2, 'stops after exactly one retry — does not keep burning the allowance');
});

test('(P1-7 a3) a RUNTIME error (not a SyntaxError) is NOT treated as a parse-retry — normal failStreak path', async () => {
  // a program that PARSES but throws at runtime should NOT hit the syntax retry; it feeds back as OUTPUT and the
  // loop continues normally (proving the syntax flag distinguishes compile failures from runtime throws).
  const llm = scriptedLLM(['```js\nthrow new Error("runtime boom");\n```', '```js\nanswer("handled the runtime error");\n```']);
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'go', llm });
  assert.equal(r.answer, 'handled the runtime error', 'the loop continued past a runtime throw (not a parse retry)');
  assert.equal(r.stalled, undefined, 'a single runtime throw is not a stall');
});

// ── P1-7(b): answer-channel lint — no raw program / provider-error blob as the reply ────────────────────────
test('(P1-7 b) answer() of a whole ```js fenced program is REPLACED, not shown raw', async () => {
  // the model mistakenly calls answer() with a fenced program as the string.
  const r = await run('answer("```js\\nconst x = await getX();\\nreturn x;\\n```");');
  assert.ok(!/```/.test(r.answer), `the fenced program is not shown raw: ${JSON.stringify(r.answer)}`);
  assert.ok(!/getX/.test(r.answer), 'the program body is not surfaced');
  assert.ok(r.answer.trim().length > 0, 'a clean recovery message is delivered');
});

test('(P1-7 b2) answer() of a raw provider-error JSON blob is REPLACED', async () => {
  const blob = '{"error":{"type":"rate_limit_error","message":"429 too many requests"}}';
  const r = await run(`answer(${JSON.stringify(blob)});`);
  assert.ok(!/rate_limit_error|429/.test(r.answer), `raw provider error not surfaced: ${JSON.stringify(r.answer)}`);
  assert.ok(r.answer.trim().length > 0, 'a clean message is delivered');
});

test('(P1-7 b3) a raw provider-error blob delivered as PROSE (no program) is also replaced', async () => {
  const blob = '{"type":"overloaded_error","message":"anthropic fetch: 529 overloaded"}';
  const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'go', llm: scriptedLLM([blob]) });
  assert.ok(!/overloaded_error|529/.test(r.answer), `raw prose provider error not surfaced: ${JSON.stringify(r.answer)}`);
});

test('(P1-7 b4) an ordinary prose answer that MENTIONS "error"/code but is not an artefact is NOT mangled', async () => {
  // legitimate prose replies must survive the lint untouched (no false positives): one mentions an error, one
  // starts with a word that overlaps a JS keyword ("if you…"), one describes code. None is a raw artefact.
  const cases = [
    'Your build failed because of a type error on line 12; fix the missing return.',
    'if you want, I can schedule it for tomorrow — just say the word.',
    'The function returns a promise, so await it before you read the value.',
  ];
  for (const prose of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runAgentCode({ toolbox: {}, manifest: [], userText: 'go', llm: scriptedLLM([prose]) });
    assert.equal(r.answer, prose, `prose preserved verbatim: ${JSON.stringify(prose)}`);
  }
});

test('(P1-7 b5) answer("") of a normal plain string is untouched by the lint', async () => {
  const r = await run('answer("The meeting is at 3pm on Tuesday.");');
  assert.equal(r.answer, 'The meeting is at 3pm on Tuesday.');
  assert.equal(r.objects, undefined);
});
