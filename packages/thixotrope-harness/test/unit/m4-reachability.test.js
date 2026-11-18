// @ts-check
// M4 acceptance 5, part (a) of the CC-060 workaround (W4.8;
// designs/m4-interfaces.md 11, 19): the interface closure a session vat can
// reach from what it is made with (`MakeArgs`: its config, its
// `SessionServices` (Backend, host facet, exec handle) and its row
// reporter), following every method's return guard of every interface in
// `interfaces.js` and `interfaces-m4.js` (the M2 and M4 versions of an
// interface name both count). None of the forbidden interfaces may be in it.
// The exec vat holds a subset of what its session gives it, so the
// session's closure bounds the exec vat's too.
//
// Guards are read through their payload (`guard.payload.methodGuards`, the
// technique M5's CC-072 asks the prelude to support; W4.1's test pins it).
// Part (b), the holdings by origin in a running daemon, is
// `test/integration/m4-reachability.test.js`.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { interfaces, shapes } from '../../guest/lib/interfaces.js';
import { m4Interfaces } from '../../guest/lib/interfaces-m4.js';
/* eslint-enable import/no-relative-packages */

/** Interfaces no session or exec vat may reach (acceptance 5, section 11). */
const FORBIDDEN = harden([
  'AgentHostAdmin',
  'SecretsAdmin',
  'SubscriptionsAdmin',
  'Secret',
  'SecretWriter',
  'PoolMember',
  'Accounts',
  'AccountsSubscription',
  'AuditReader',
  'CredentialOps',
  'AgentHostSink',
  'Operator',
  'HarnessRoot',
  'SessionFactory',
]);

/**
 * Every remotable label a pattern names, anywhere inside it.
 * @param {any} pattern
 * @param {Set<string>} [into]
 */
const labelsIn = (pattern, into = new Set()) => {
  if (pattern === null || typeof pattern !== 'object') return into;
  const tag = pattern[Symbol.toStringTag];
  if (tag === 'match:remotable') {
    into.add(pattern.payload.label);
    return into;
  }
  if (typeof tag === 'string' && 'payload' in pattern) {
    labelsIn(pattern.payload, into);
    return into;
  }
  for (const value of Object.values(pattern)) labelsIn(value, into);
  return into;
};

/** Interface guards by interface name (several versions per name). */
const guardsByName = () => {
  /** @type {Map<string, any[]>} */
  const byName = new Map();
  for (const table of [interfaces, interfaces, m4Interfaces]) {
    for (const guard of Object.values(table)) {
      const name = guard.payload.interfaceName;
      byName.set(name, [...(byName.get(name) ?? []), guard]);
    }
  }
  return byName;
};

/**
 * The closure of interfaces reachable through return guards.
 * @param {Iterable<string>} start
 */
const closureFrom = start => {
  const byName = guardsByName();
  const reached = new Set(start);
  /** @type {string[]} */
  const unknown = [];
  const todo = [...reached];
  while (todo.length > 0) {
    const name = /** @type {string} */ (todo.pop());
    const guards = byName.get(name);
    if (guards === undefined) unknown.push(name);
    for (const guard of guards ?? []) {
      for (const method of Object.values(guard.payload.methodGuards)) {
        for (const label of labelsIn(
          /** @type {any} */ (method).payload.returnGuard,
        )) {
          if (!reached.has(label)) {
            reached.add(label);
            todo.push(label);
          }
        }
      }
    }
  }
  return { reached, unknown };
};

test('acceptance 5 (a): no forbidden interface in the closure from a session vat', t => {
  const start = labelsIn(shapes.MakeArgs);
  t.true(start.has('Backend'));
  t.true(start.has('SessionHostFacet'));
  t.true(start.has('ExecHandle'));
  const { reached, unknown } = closureFrom(start);
  t.log(`reachable: ${[...reached].sort().join(', ')}`);
  if (unknown.length > 0) t.log(`no guard here: ${unknown.sort().join(', ')}`);
  // The pool Backend (M4 version of `Backend`) is walked too.
  t.true(reached.has('TurnPorts') || reached.has('Endpoint'));
  t.deepEqual(
    FORBIDDEN.filter(name => reached.has(name)),
    [],
    'no forbidden interface is reachable',
  );
});

test('the walk sees the forbidden interfaces from the operator side (the check can fail)', t => {
  const { reached } = closureFrom(['SecretsAdmin']);
  for (const name of [
    'SubscriptionsAdmin',
    'PoolMember',
    'Accounts',
    'AuditReader',
    'Secret',
    'SecretWriter',
  ])
    t.true(reached.has(name), name);
});
