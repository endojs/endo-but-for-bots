// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import {
  pruneAndPinCatalog,
  deriveAllowList,
  isDispatchable,
  isAdmissibleToolName,
  isAdmissibleServerName,
  catalogToolNames,
} from '../src/tool-permissions.js';

const descriptors = names => names.map(name => ({ name }));

test('pruneAndPinCatalog keeps well-formed names', t => {
  const pinned = pruneAndPinCatalog(
    descriptors(['writeText', 'readText', 'list', 'remove']),
  );
  t.deepEqual(catalogToolNames(pinned), [
    'list',
    'readText',
    'remove',
    'writeText',
  ]);
});

test('pruneAndPinCatalog prunes code-eval, dunder, __-bearing, and charset-violating names', t => {
  const pinned = pruneAndPinCatalog(
    descriptors([
      'writeText',
      'evaluate', // code-eval
      'eval',
      'define',
      '__proto__', // dunder
      'constructor',
      'foo__bar', // __ sequence
      'ReadText', // adapter grammar: lower camelCase only
      'read_text',
      'read-text',
      `a${'b'.repeat(64)}`, // adapter grammar: at most 64 characters
      'a,b', // charset (comma)
      'a b', // charset (space)
      '*', // wildcard
      'read*', // anchored-glob escalation
    ]),
  );
  t.deepEqual(catalogToolNames(pinned), ['writeText']);
});

test('the pinned catalog is a frozen null-prototype record (not a Map)', t => {
  const pinned = pruneAndPinCatalog(descriptors(['a']));
  t.is(Object.getPrototypeOf(pinned), null);
  t.true(Object.isFrozen(pinned));
  t.false(pinned instanceof Map);
});

test('pruneAndPinCatalog rejects duplicate names (no order-dependent shadowing)', t => {
  t.throws(() => pruneAndPinCatalog(descriptors(['a', 'a'])), {
    message: /duplicate tool name/,
  });
});

test('deriveAllowList emits one mcp__server__tool per surviving name', t => {
  const pinned = pruneAndPinCatalog(descriptors(['writeText', 'list']));
  t.deepEqual(deriveAllowList(pinned, 'endo'), [
    'mcp__endo__list',
    'mcp__endo__writeText',
  ]);
});

test('deriveAllowList throws on an empty post-prune catalog (zero-tool boundary)', t => {
  const pinned = pruneAndPinCatalog(descriptors(['evaluate', '__proto__']));
  t.throws(() => deriveAllowList(pinned, 'endo'), {
    message: /empty post-prune tool catalog/,
  });
});

test('deriveAllowList rejects a malformed server name', t => {
  const pinned = pruneAndPinCatalog(descriptors(['a']));
  t.throws(() => deriveAllowList(pinned, 'endo__x'), {
    message: /invalid MCP server name/,
  });
  t.throws(() => deriveAllowList(pinned, 'has space'), {
    message: /invalid MCP server name/,
  });
});

test('isDispatchable is server-side membership against the pinned snapshot', t => {
  const pinned = pruneAndPinCatalog(descriptors(['writeText', 'evaluate']));
  t.true(isDispatchable(pinned, 'writeText'));
  t.false(isDispatchable(pinned, 'evaluate')); // pruned
  t.false(isDispatchable(pinned, '__proto__')); // never resolves through proto
  t.false(isDispatchable(pinned, 'toString'));
  t.false(isDispatchable(pinned, 42));
});

// --- property: allow-list round-trip -------------------------------------

const admissibleName = fc
  .stringMatching(/^[a-z][A-Za-z0-9]{0,23}$/)
  .filter(isAdmissibleToolName);

test('property: admissible names round-trip to exactly their mcp entries', t => {
  fc.assert(
    fc.property(
      fc.uniqueArray(admissibleName, { minLength: 1, maxLength: 12 }),
      names => {
        const pinned = pruneAndPinCatalog(descriptors(names));
        const allow = deriveAllowList(pinned, 'endo');
        const expected = [...names].sort().map(n => `mcp__endo__${n}`);
        t.deepEqual([...allow], expected);
        // No entry ever contains a comma-splittable or wildcard artefact.
        for (const entry of allow) {
          t.regex(entry, /^mcp__endo__[a-z][A-Za-z0-9]{0,63}$/);
          t.false(entry.slice('mcp__endo__'.length).includes('__'));
        }
      },
    ),
    { numRuns: 200 },
  );
});

test('property: inadmissible names are always pruned / fail closed', t => {
  const hostile = fc.oneof(
    fc.constantFrom('evaluate', 'eval', 'define'),
    fc.constantFrom('__proto__', 'constructor', 'prototype', 'toString'),
    fc.constantFrom(
      'a,b',
      'a b',
      '*',
      'read*',
      'foo__bar',
      'x__',
      'ReadText',
      'read_text',
      'read-text',
    ),
    fc.string().filter(s => !isAdmissibleToolName(s)),
  );
  fc.assert(
    fc.property(hostile, name => {
      const pinned = pruneAndPinCatalog([{ name }]);
      t.false(isDispatchable(pinned, name));
      t.false(catalogToolNames(pinned).includes(name));
    }),
    { numRuns: 300 },
  );
});

test('server-name admissibility preserves the MCP segment grammar', t => {
  t.true(isAdmissibleServerName('endo'));
  t.false(isAdmissibleServerName('endo__x'));
  t.false(isAdmissibleServerName(''));
  t.false(isAdmissibleServerName('a b'));
});
