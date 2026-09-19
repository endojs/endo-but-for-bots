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

test('exec explains missing returns without inviting effect replay', async t => {
  const tool = makeExecTool(powers);
  for (const code of [
    '21 * 2;',
    'await (async () => 42)();',
    'return undefined;',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const result = await tool.execute({ code });
    t.regex(result, /top-level return/);
    t.regex(result, /console output goes to daemon logs/);
    t.regex(result, /do not repeat/);
  }
  t.is(await tool.execute({ code: 'return await (async () => 42)();' }), '42');
});

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

test('a parse failure is explained by its cause, not by a stock phrase', async t => {
  const tool = makeExecTool(powers);
  const failure = async code =>
    (await t.throwsAsync(tool.execute({ code }))).message;

  // What the three.js session hit twice: a GLSL shader's backticks inside
  // the template literal that was building the page. It was told "no
  // markdown fences" and resent the same code.
  const nested = await failure(
    'const html = `<script>const s = `varying vec3 v;`;</script>`;\nreturn html;',
  );
  t.regex(nested, /inner backtick ends the literal/);
  t.notRegex(nested, /markdown fences/);

  // And what the next session tried.
  const imported = await failure("const fs = await import('fs'); return 1;");
  t.regex(imported, /no import, import\(\) or require/);
  t.notRegex(imported, /markdown fences/);
  t.notRegex(imported, /template literals/);

  // Fences are mentioned when the code had one that could not be stripped.
  const fenced = await failure('```js\nreturn 1 +;\n');
  t.regex(fenced, /without markdown fences/);
  t.notRegex(fenced, /template literals/);
  const prose = await failure('Here is the code:\n```js\nreturn 1;\n```');
  t.regex(prose, /without markdown fences or any prose/);
  t.notRegex(prose, /template literals/);
  // A fence that was stripped is not what is wrong with the code inside it.
  const stripped = await failure('```js\nreturn 1 +;\n```');
  t.notRegex(stripped, /markdown fences/);

  const staticImport = await failure('import fs from "fs"; return 1;');
  t.regex(staticImport, /no import, import\(\) or require/);

  // The evaluator refuses the characters wherever they are, so the advice
  // has to cover a page whose own script imports something.
  const quoted = await failure(
    'const page = "<script>import(\\"three\\")</script>"; return page;',
  );
  t.regex(quoted, /even inside a string or a comment/);
  t.regex(quoted, /"imp" \+ "ort\("/);

  // Anything else gets the plain advice, and always the engine's message.
  const plain = await failure('return 1 +;');
  t.regex(
    plain,
    /^Could not parse the code \(.+\)\. Check the code for syntax errors/,
  );

  const nestedAwait = await failure(
    'const f = () => { await sleep(1); }; return 1;',
  );
  t.regex(
    nestedAwait,
    /not inside a nested function unless that function is async/,
  );
});

test('the description says what is not there, since nothing else will', t => {
  const { description } = makeExecTool(powers).schema().function;
  // An undeclared name reads as undefined here instead of throwing, so the
  // error a model sees never names it.
  t.regex(description, /A petname is NOT a variable/);
  t.regex(description, /E\(powers\)\.lookup\("workspace"\)/);
  t.regex(description, /typeof target is "undefined"/);
  t.regex(description, /No import, import\(\) or require/);
  t.regex(description, /inner backtick\s+ends the literal/);
});
