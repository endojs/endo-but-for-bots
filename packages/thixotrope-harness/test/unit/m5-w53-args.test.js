// @ts-check
// W5.3 (designs/m5-interfaces.md 2.4.2): `parseClosedArgs` reads an M5
// built-in tool's JSON arguments without building a record from them: an
// unknown key at any depth answers the R3-26 text before anything is kept,
// a key flood stops at its first key, odd JSON is refused with M1a's
// `argumentsNotJson` text, raw spans are kept as the exact source text,
// and decoded strings equal `JSON.parse`'s.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { textOf } from '../../guest/lib/interfaces.js';
import { m5ToolArgumentNames } from '../../guest/lib/interfaces-m5.js';
import {
  argSpecs,
  maxArgDepth,
  parseClosedArgs,
} from '../../guest/lib/tool-args.js';
/* eslint-enable import/no-relative-packages */

/**
 * @param {string} text
 * @param {any} spec
 */
const values = (text, spec) => {
  const r = parseClosedArgs(text, spec);
  if (!r.ok) throw Error(`refused: ${r.text}`);
  return Object.fromEntries(r.values);
};

/**
 * @param {string} text
 * @param {any} spec
 */
const refusal = (text, spec) => {
  const r = parseClosedArgs(text, spec);
  if (r.ok) throw Error(`accepted: ${text}`);
  return r.text;
};

test('the specs follow the contract names, in order', t => {
  for (const [tool, spec] of Object.entries(argSpecs)) {
    t.is(spec.tool, tool);
    t.deepEqual(
      spec.fields.map(f => f.name),
      [.../** @type {any} */ (m5ToolArgumentNames)[tool]],
    );
  }
});

test('well-formed arguments: strings decoded, raw spans exact, integers', t => {
  t.deepEqual(values('{"petName":"notes"}', argSpecs.lookup), {
    petName: 'notes',
  });
  t.deepEqual(
    values(
      ' { "value" : { "a" : [1, 2.5e3, true, null, "x"] } , "petName":"k" } ',
      argSpecs.store,
    ),
    { value: '{ "a" : [1, 2.5e3, true, null, "x"] }', petName: 'k' },
  );
  t.deepEqual(values('{"petName":"k","value":"he\\"llo"}', argSpecs.store), {
    petName: 'k',
    value: '"he\\"llo"',
  });
  t.deepEqual(
    values(
      '{"messageNumber":3,"edgeName":"notes","petName":"n"}',
      argSpecs.adopt,
    ),
    { messageNumber: 3, edgeName: 'notes', petName: 'n' },
  );
  t.deepEqual(values('{"petName":"k"}', argSpecs.describeCapability), {
    petName: 'k',
  });
  // Blank arguments read as {} for a tool with no required argument.
  t.deepEqual(values('', argSpecs.list), {});
  t.deepEqual(values('  {}  ', argSpecs.list), {});
  // A later duplicate key wins, as JSON.parse.
  t.deepEqual(values('{"petName":"a","petName":"b"}', argSpecs.lookup), {
    petName: 'b',
  });
});

test('decoded strings equal JSON.parse on escapes, unicode and surrogates', t => {
  const samples = [
    'plain',
    'tab\there',
    'quote " and backslash \\',
    'line\nbreak\r\n',
    'slash / and \u0001 control',
    'café 中文',
    'emoji 😀',
    '',
  ];
  for (const sample of samples) {
    const text = `{"petName":${JSON.stringify(sample)}}`;
    t.is(values(text, argSpecs.lookup).petName, JSON.parse(text).petName);
  }
  // Escapes written out by hand.
  const escaped = '{"petName":"\\u0041\\ud83d\\ude00\\/\\b\\f"}';
  t.is(values(escaped, argSpecs.lookup).petName, JSON.parse(escaped).petName);
  // A key spelled with an escape is the same key.
  t.deepEqual(values('{"pet\\u004eame":"x"}', argSpecs.lookup), {
    petName: 'x',
  });
});

test('an unknown key at any depth answers the R3-26 text', t => {
  t.is(
    refusal('{"petName":"a","method":"x"}', argSpecs.lookup),
    textOf.unexpectedArgument('method', 'lookup', ['petName']),
  );
  t.is(
    refusal('{"zz":1}', argSpecs.list),
    textOf.unexpectedArgument('zz', 'list', []),
  );
  const nested = harden({
    tool: 'nested',
    fields: harden([
      harden({
        name: 'outer',
        kind: harden({
          fields: harden([harden({ name: 'inner', kind: 'string' })]),
        }),
        required: true,
      }),
    ]),
  });
  t.deepEqual(
    values('{"outer":{"inner":"x"}}', nested).outer.get('inner'),
    'x',
  );
  t.is(
    refusal('{"outer":{"inner":"x","__proto__":1}}', nested),
    textOf.unexpectedArgument('__proto__', 'nested', ['inner']),
  );
  // Keys inside a raw value are the model's data, kept as text.
  t.deepEqual(
    values('{"value":{"__proto__":1},"petName":"k"}', argSpecs.store),
    {
      value: '{"__proto__":1}',
      petName: 'k',
    },
  );
});

test('a key flood stops at its first unknown key and keeps nothing', t => {
  const keys = Array.from({ length: 20_000 }, (_, i) => `"k${i}":${i}`);
  const text = `{${keys.join(',')}}`;
  const t0 = performance.now();
  t.is(
    refusal(text, argSpecs.lookup),
    textOf.unexpectedArgument('k0', 'lookup', ['petName']),
  );
  t.true(performance.now() - t0 < 50, 'refused at the first key');
});

test('odd JSON is refused with the R4-45 text', t => {
  const notJson = (/** @type {string} */ text, /** @type {any} */ spec) => {
    const answer = refusal(text, spec);
    t.true(
      answer.startsWith('could not parse tool arguments as JSON ('),
      `${text}: ${answer}`,
    );
  };
  for (const text of [
    '[]',
    '"petName"',
    '{"petName":"a",}',
    '{"petName":"a"',
    '{"petName" "a"}',
    "{'petName':'a'}",
    '{"petName":"a"} x',
    '{"petName":"a\u0001"}',
    '{"petName":"\\x41"}',
    '{"petName":"\\u12G4"}',
    '{"petName":"unterminated}',
    '{petName:"a"}',
  ]) {
    notJson(text, argSpecs.lookup);
  }
  for (const value of ['01', '1.', '.5', '+1', 'NaN', 'Infinity', 'tru', '-']) {
    notJson(`{"value":${value},"petName":"k"}`, argSpecs.store);
  }
  // Missing and mistyped arguments.
  notJson('{}', argSpecs.lookup);
  notJson('', argSpecs.lookup);
  notJson('{"petName":1}', argSpecs.lookup);
  notJson('{"petName":null}', argSpecs.lookup);
  notJson('{"messageNumber":1.5,"edgeName":"a","petName":"b"}', argSpecs.adopt);
  notJson('{"messageNumber":"1","edgeName":"a","petName":"b"}', argSpecs.adopt);
  notJson(
    '{"messageNumber":1e400,"edgeName":"a","petName":"b"}',
    argSpecs.adopt,
  );
  notJson('{"petName":"k"}', argSpecs.store);
  t.false(parseClosedArgs(/** @type {any} */ (undefined), argSpecs.list).ok);
});

test('nesting is bounded in raw spans', t => {
  const deep = (/** @type {number} */ n) => `${'['.repeat(n)}${']'.repeat(n)}`;
  t.true(
    parseClosedArgs(
      `{"value":${deep(maxArgDepth - 2)},"petName":"k"}`,
      argSpecs.store,
    ).ok,
  );
  t.regex(
    refusal(`{"value":${deep(5000)},"petName":"k"}`, argSpecs.store),
    /nested deeper than 64/,
  );
});
