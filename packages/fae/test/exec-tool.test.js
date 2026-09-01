// @ts-check
/**
 * Unit tests for the exec tool maker's handling of model-authored code:
 *   - multiline snippets run (top-level await, multiple statements),
 *   - a markdown-fenced snippet (```` ```js … ``` ````) has its fence
 *     stripped rather than being rejected as a SyntaxError,
 *   - genuinely malformed code surfaces a corrective error.
 */

import '@endo/init/debug.js';

import test from 'ava';

import { makeExecTool } from '../src/tool-makers.js';

// Minimal powers handle: the exec code under test doesn't call through it, but
// the tool still endows it, so a bare object is enough.
const powers = {};

test('exec runs a plain multiline snippet', async t => {
  const tool = makeExecTool(powers);
  const result = await tool.execute({
    code: 'const a = 2;\nconst b = 3;\nreturn a * b;',
  });
  t.is(result, '6');
});

test('exec strips a markdown code fence before evaluating', async t => {
  const tool = makeExecTool(powers);
  const fenced = [
    '```js',
    'const xs = [1, 2, 3];',
    'return xs.length;',
    '```',
  ].join('\n');
  const result = await tool.execute({ code: fenced });
  t.is(result, '3');
});

test('exec strips an untagged fence too', async t => {
  const tool = makeExecTool(powers);
  const fenced = ['```', 'return 40 + 2;', '```'].join('\n');
  const result = await tool.execute({ code: fenced });
  t.is(result, '42');
});

test('exec leaves inline backticks in real code untouched', async t => {
  const tool = makeExecTool(powers);
  // A template literal is not a wrapping fence; it must survive verbatim.
  const result = await tool.execute({
    // eslint-disable-next-line no-template-curly-in-string -- code-as-data
    code: 'const name = "floot";\nreturn `hello ${name}`;',
  });
  t.is(result, '"hello floot"');
});

test('exec reports a corrective error for malformed code', async t => {
  const tool = makeExecTool(powers);
  await t.throwsAsync(() => tool.execute({ code: 'return (' }), {
    message: /Could not parse the code/,
  });
});

// A capability that answers with BigInts is the common case, not an exotic one:
// stat() sizes and times and a workflow's status()/journal() all do. Before the
// replacer, returning one threw "Do not know how to serialize a BigInt" and the
// caller lost the whole result.
test('exec renders a BigInt result as a decimal string', async t => {
  const tool = makeExecTool(powers);
  const result = await tool.execute({ code: 'return 7n;' });
  t.is(result, '"7"');
});

test('exec renders BigInts nested in a result', async t => {
  const tool = makeExecTool(powers);
  const result = await tool.execute({
    code: 'return { size: 408n, times: [1n, 2n], name: "secrets.env" };',
  });
  t.deepEqual(JSON.parse(result), {
    size: '408',
    times: ['1', '2'],
    name: 'secrets.env',
  });
});

// The compartment has no timers, so before `sleep` an agent could not wait
// between polls inside one call — it spun, or burned a turn per check.
test('exec can wait with the sleep endowment', async t => {
  const tool = makeExecTool(powers);
  const result = await tool.execute({
    code: 'await sleep(5);\nreturn "waited";',
  });
  t.is(result, '"waited"');
});

test('exec still has no ambient timers', async t => {
  const tool = makeExecTool(powers);
  await t.throwsAsync(() =>
    tool.execute({
      code: 'return typeof setTimeout === "function" ? setTimeout(() => {}, 1) : (() => { throw new Error("no setTimeout") })();',
    }),
  );
});
