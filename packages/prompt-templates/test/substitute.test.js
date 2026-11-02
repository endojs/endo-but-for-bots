import '@endo/init/debug.js';

import test from 'ava';

import {
  bindArguments,
  extractVariables,
  parseCommandArguments,
  substituteVariables,
} from '../src/substitute.js';

test('extractVariables lists distinct names in first-appearance order', t => {
  t.deepEqual(extractVariables('{{b}} {{a}} {{ b }} {{a-1}} {{c_d}}'), [
    'b',
    'a',
    'a-1',
    'c_d',
  ]);
});

test('extractVariables ignores text that is not a variable name', t => {
  t.deepEqual(
    extractVariables('{{}} {{not a name}} {{1x}} {{__proto__}} {x} {{x}'),
    [],
  );
});

test('substituteVariables replaces every occurrence, spaced or not', t => {
  t.is(
    substituteVariables('{{a}}, {{ a }}: {{b}}', { a: '1', b: '2' }),
    '1, 1: 2',
  );
});

test('substituteVariables leaves a placeholder without a value', t => {
  t.is(substituteVariables('{{a}} {{b}}', { a: '1' }), '1 {{b}}');
});

test('substituteVariables does not reinterpret a value', t => {
  t.is(
    substituteVariables('{{a}} {{b}}', { a: '{{b}}', b: "$& $1 $` $'" }),
    "{{b}} $& $1 $` $'",
  );
});

test('substituteVariables ignores inherited properties of the values', t => {
  t.is(substituteVariables('{{constructor}}', {}), '{{constructor}}');
  t.is(substituteVariables('{{constructor}}', { constructor: 'kept' }), 'kept');
});

test('parseCommandArguments splits like a shell', t => {
  t.deepEqual(parseCommandArguments(''), []);
  t.deepEqual(parseCommandArguments('   '), []);
  t.deepEqual(parseCommandArguments(' a\tb\n c '), ['a', 'b', 'c']);
  t.deepEqual(parseCommandArguments(`"a b" 'c d'`), ['a b', 'c d']);
  t.deepEqual(parseCommandArguments(`"it's" 'say "hi"'`), ["it's", 'say "hi"']);
  t.deepEqual(parseCommandArguments(`pre"a b"post`), ['prea bpost']);
  t.deepEqual(parseCommandArguments(`"" x ''`), ['', 'x', '']);
});

test('parseCommandArguments runs an unterminated quote to the end', t => {
  t.deepEqual(parseCommandArguments('x "a b'), ['x', 'a b']);
});

test('bindArguments assigns positionally and reports the remainder', t => {
  t.deepEqual(bindArguments(['a', 'b'], ['1']), {
    values: { a: '1' },
    missing: ['b'],
    excess: 0,
  });
  t.deepEqual(bindArguments(['a', 'b'], ['1', '2']), {
    values: { a: '1', b: '2' },
    missing: [],
    excess: 0,
  });
  t.deepEqual(bindArguments(['a'], ['1', '2', '3']), {
    values: { a: '1' },
    missing: [],
    excess: 2,
  });
  t.deepEqual(bindArguments([], []), { values: {}, missing: [], excess: 0 });
});
