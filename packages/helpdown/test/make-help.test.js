// @ts-check

import test from 'ava';

import { makeHelp, parseHelpdown } from '../index.js';

test('makeHelp returns the overview for no argument', t => {
  const help = makeHelp({ '': 'Foo - a thing.', bar: 'bar() -> void' });
  t.is(help(), 'Foo - a thing.');
  t.is(help(''), 'Foo - a thing.');
});

test('makeHelp returns the entry for a named method', t => {
  const help = makeHelp({ '': 'Foo - a thing.', bar: 'bar() -> void' });
  t.is(help('bar'), 'bar() -> void');
});

test('makeHelp searches fallbacks in order', t => {
  const help = makeHelp({ '': 'Foo - a thing.' }, [
    { bar: 'first bar' },
    { bar: 'second bar', baz: 'only baz' },
  ]);
  t.is(help('bar'), 'first bar');
  t.is(help('baz'), 'only baz');
});

test('makeHelp prefers its own entry over a fallback', t => {
  const help = makeHelp({ bar: 'own bar' }, [{ bar: 'fallback bar' }]);
  t.is(help('bar'), 'own bar');
});

// The fallback wording is the one string every capability shows when it has no
// documentation for what was asked. It is pinned here because it is now
// defined in exactly one place, and drifting it would silently change what
// every `help()` caller in the workspace sees.
test('makeHelp falls back to the interface wording', t => {
  const help = makeHelp({});
  t.is(help(), 'No documentation available for this interface.');
  t.is(help(''), 'No documentation available for this interface.');
});

test('makeHelp falls back to the method wording, quoting the name', t => {
  const help = makeHelp({ '': 'Foo - a thing.' });
  t.is(help('bar'), 'No documentation available for method "bar".');
  t.is(help('nope'), 'No documentation available for method "nope".');
});

test('makeHelp falls back when no fallback record has the method', t => {
  const help = makeHelp({ '': 'Foo - a thing.' }, [{ baz: 'only baz' }]);
  t.is(help('bar'), 'No documentation available for method "bar".');
});

test('makeHelp serves a parsed helpdown document', t => {
  const entries = parseHelpdown(
    [
      '# Foo - a thing.',
      '',
      '## bar(x) -> number',
      '',
      'Returns x doubled.',
    ].join('\n'),
  );
  const helpMap = new Map(entries);
  const fooHelp = helpMap.get('Foo');
  if (fooHelp === undefined) {
    t.fail('expected a Foo entry');
    return;
  }
  const help = makeHelp(fooHelp);
  t.is(help(), 'Foo - a thing.');
  t.is(help('bar'), 'bar(x) -> number\nReturns x doubled.');
  t.is(help('nope'), 'No documentation available for method "nope".');
});
