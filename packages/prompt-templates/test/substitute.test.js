/* eslint-disable no-template-curly-in-string -- Pi placeholders are literal template text */
import '@endo/init/debug.js';

import test from 'ava';

import {
  analyzePlaceholders,
  parseArgumentHint,
  parseCommandArguments,
  substituteArguments,
} from '../src/substitute.js';

test('analyzePlaceholders finds the highest position and rest forms', t => {
  t.deepEqual(analyzePlaceholders('no placeholders $PATH $0 $'), {
    maxPosition: 0,
    usesRest: false,
  });
  t.deepEqual(analyzePlaceholders('$2 then $1 and ${3:-x}'), {
    maxPosition: 3,
    usesRest: false,
  });
  for (const rest of ['$@', '$ARGUMENTS', '${@:2}', '${@:1:2}', '${@:-x}']) {
    t.deepEqual(analyzePlaceholders(`$1 ${rest}`), {
      maxPosition: 1,
      usesRest: true,
    });
  }
});

test('substituteArguments expands each placeholder form', t => {
  const args = ['a', 'b', 'c', 'd'];
  const cases = [
    ['$1-$2-$4', 'a-b-d'],
    ['[$5]', '[]'],
    ['$@', 'a b c d'],
    ['$ARGUMENTS', 'a b c d'],
    ['${1:-z}', 'a'],
    ['${6:-z}', 'z'],
    ['${@:-z}', 'a b c d'],
    ['${@:2}', 'b c d'],
    ['${@:2:2}', 'b c'],
    ['${@:3:9}', 'c d'],
    ['[${@:9}]', '[]'],
    ['[${@:9:1}]', '[]'],
  ];
  for (const [body, expected] of cases) {
    t.is(substituteArguments(body, args), expected, body);
  }
});

test('substituteArguments applies defaults for absent or empty arguments', t => {
  t.is(substituteArguments('${1:-staged}', []), 'staged');
  t.is(substituteArguments('${1:-staged}', ['']), 'staged');
  t.is(substituteArguments('${@:-all}', []), 'all');
  t.is(substituteArguments('${1:-}', []), '');
});

test('substituteArguments keeps text outside the grammar', t => {
  t.is(
    substituteArguments('$PATH $0 $ $$ ${x} ${1} $a', ['v']),
    '$PATH $0 $ $$ ${x} ${1} $a',
  );
});

test('substituteArguments is a single pass', t => {
  t.is(
    substituteArguments('$1 $2', ['$2', "${1:-x} $& $@ $ARGUMENTS $` $'"]),
    "$2 ${1:-x} $& $@ $ARGUMENTS $` $'",
  );
});

test('substituteArguments expands the design example', t => {
  const body =
    'Review the ${2:-staged} changes for bugs, focusing on $1.\nExtra notes from the user: ${@:3}';
  t.is(
    substituteArguments(body, ['security']),
    'Review the staged changes for bugs, focusing on security.\nExtra notes from the user: ',
  );
  t.is(
    substituteArguments(body, ['security', 'unstaged', 'be', 'brief']),
    'Review the unstaged changes for bugs, focusing on security.\nExtra notes from the user: be brief',
  );
});

test('parseArgumentHint reads required and optional tokens', t => {
  t.deepEqual(parseArgumentHint(''), []);
  t.deepEqual(parseArgumentHint('<focus> [scope] extra'), [
    { label: 'focus', required: true },
    { label: 'scope', required: false },
    { label: 'extra', required: false },
  ]);
  t.deepEqual(parseArgumentHint('<file name> [ line ]'), [
    { label: 'file name', required: true },
    { label: 'line', required: false },
  ]);
});

test('parseCommandArguments separates on whitespace', t => {
  t.deepEqual(parseCommandArguments(''), []);
  t.deepEqual(parseCommandArguments('   '), []);
  t.deepEqual(parseCommandArguments(' a\tb\n c '), ['a', 'b', 'c']);
});

test('parseCommandArguments opens quotes only at the start of an argument', t => {
  t.deepEqual(parseCommandArguments(`"a b" 'c d'`), ['a b', 'c d']);
  t.deepEqual(parseCommandArguments(`don't stop`), ["don't", 'stop']);
  t.deepEqual(parseCommandArguments(`pre"a b"`), ['pre"a', 'b"']);
  t.deepEqual(parseCommandArguments(`'say "hi"'`), ['say "hi"']);
});

test('parseCommandArguments removes quotes and keeps empty arguments', t => {
  t.deepEqual(parseCommandArguments(`"" x ''`), ['', 'x', '']);
  t.deepEqual(parseCommandArguments(`"a"b`), ['a', 'b']);
});

test('parseCommandArguments keeps an unterminated quote as text', t => {
  t.deepEqual(parseCommandArguments(`"open quote`), ['"open', 'quote']);
  t.deepEqual(parseCommandArguments(`x 'y`), ['x', "'y"]);
});

test('parseCommandArguments does not treat backslashes as escapes', t => {
  t.deepEqual(parseCommandArguments(`"a\\"b"`), ['a\\', 'b"']);
  t.deepEqual(parseCommandArguments(`a\\ b`), ['a\\', 'b']);
});
