// Golden tests pinning the scenario-derivation contract the gauntlet panel found
// broken in the initial mirror: the shared per-agent accessors (includes / mode
// / raw) and the front-matter flag promotion that feeds the only/no filters.
// Pure logic only — no xst/node child spawn, no prelude build — so it runs
// anywhere `node --test` does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scenarioIncludes,
  scenarioIsModule,
  scenarioIsRaw,
  scenarioIsAsync,
  scenarioOk,
} from './agents/scenario.js';
import {
  generateScenariosForTests,
  filterOnlyRules,
  filterNoRules,
  agentRunsScenario,
} from './test.js';

/**
 * Build a test262-stream-shaped case. `test262-stream` normalizes `flags` to a
 * `{ name: true }` map and `includes` to an array (never undefined).
 *
 * @param {object} [options]
 * @param {string} [options.file]
 * @param {string[]} [options.flags]
 * @param {string[]} [options.includes]
 */
const fakeCase = ({ file = 'test/x.js', flags = [], includes = [] } = {}) => ({
  file,
  contents: '// body\n',
  insertionIndex: 0,
  attrs: {
    flags: Object.fromEntries(flags.map(flag => [flag, true])),
    includes,
  },
});

const asyncIterable = items =>
  (async function* stream() {
    for (const item of items) yield item;
  })();

const collect = async iterable => {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
};

// --- Item 3: includes are additive, not a replacement ------------------------

test('scenarioIncludes prepends the defaults to a declared include', () => {
  assert.deepEqual(
    scenarioIncludes({ attrs: { includes: ['propertyHelper.js'] } }),
    ['assert.js', 'sta.js', 'propertyHelper.js'],
  );
});

test('scenarioIncludes returns just the defaults when none are declared', () => {
  // test262-stream normalizes an absent `includes:` to [], not undefined.
  assert.deepEqual(scenarioIncludes({ attrs: { includes: [] } }), [
    'assert.js',
    'sta.js',
  ]);
});

test('scenarioIncludes deduplicates a redundantly declared default', () => {
  assert.deepEqual(
    scenarioIncludes({ attrs: { includes: ['assert.js', 'compareArray.js'] } }),
    ['assert.js', 'sta.js', 'compareArray.js'],
  );
});

// --- Item 1: mode / raw derive from the shared scenario object ---------------

test('scenarioIsModule is true only for the module mode', () => {
  assert.equal(scenarioIsModule({ mode: 'module' }), true);
  assert.equal(scenarioIsModule({ mode: 'sloppy' }), false);
  assert.equal(scenarioIsModule({ mode: 'strict' }), false);
  assert.equal(scenarioIsModule({}), false);
});

test('scenarioIsRaw reads the canonical raw flag', () => {
  assert.equal(scenarioIsRaw({ attrs: { flags: { raw: true } } }), true);
  assert.equal(scenarioIsRaw({ attrs: { flags: {} } }), false);
  assert.equal(scenarioIsRaw({}), false);
});

// --- Item 2: onlyStrict from front-matter survives; module promotes to only --

test('generateScenariosForTests preserves a front-matter onlyStrict flag', async () => {
  const scenarios = await collect(
    generateScenariosForTests(
      asyncIterable([fakeCase({ flags: ['onlyStrict'] })]),
      ['sesNode'],
      {},
    ),
  );
  assert.ok(scenarios.length > 0);
  for (const scenario of scenarios) {
    assert.equal(
      scenario.attrs.flags.onlyStrict,
      true,
      'onlyStrict must not be clobbered to undefined',
    );
  }
});

test('a module-flagged case is promoted to onlyModule', async () => {
  const [scenario] = await collect(
    generateScenariosForTests(
      asyncIterable([fakeCase({ flags: ['module'] })]),
      ['sesNode'],
      {},
    ),
  );
  assert.equal(scenario.attrs.flags.onlyModule, true);
});

test('filterOnlyRules keeps an onlyStrict case in the strict and module modes only', async () => {
  // An ES-module body is strict, so `module` satisfies `onlyStrict`; without
  // that alias every onlyStrict case (55 of the 89 ported, incl. the harden
  // cases) would be generated only into scenario names no agent runs and be
  // reported `skip` indistinguishably from the deliberate backlog.
  const generated = generateScenariosForTests(
    asyncIterable([fakeCase({ flags: ['onlyStrict'] })]),
    ['sesNode'],
    {},
  );
  const kept = await collect(filterOnlyRules(generated));
  assert.ok(kept.length > 0);
  const modes = new Set(kept.map(scenario => scenario.mode));
  assert.deepEqual([...modes].sort(), ['module', 'strict']);
  for (const scenario of kept) {
    assert.notEqual(scenario.mode, 'sloppy');
  }
});

// --- filterNoRules: the parallel-but-differently-cased twin of filterOnlyRules

test('filterNoRules drops a noStrict case from the strict and module modes', async () => {
  // Symmetric to onlyStrict: because `module` is strict, a `noStrict` case must
  // be excluded from BOTH the strict and module scenarios and retained only in
  // sloppy — the exact asymmetry class the fixed onlyStrict drift came from.
  const generated = generateScenariosForTests(
    asyncIterable([fakeCase({ flags: ['noStrict'] })]),
    ['sesNode'],
    {},
  );
  const kept = await collect(filterNoRules(generated));
  assert.ok(kept.length > 0);
  for (const scenario of kept) {
    assert.equal(scenario.mode, 'sloppy');
  }
});

test('filterNoRules retains a case that trips no `no*` rule', async () => {
  // The sesNode agent never trips a `noSesXs` rule, so every generated scenario
  // survives the filter unchanged.
  const generated = await collect(
    generateScenariosForTests(
      asyncIterable([fakeCase({ flags: ['noSesXs'] })]),
      ['sesNode'],
      {},
    ),
  );
  const kept = await collect(filterNoRules(asyncIterable(generated)));
  assert.equal(kept.length, generated.length);
  assert.ok(kept.length > 0);
});

// --- raw + strict/module: a raw case has no wrapper for a strict pragma -------

test('a raw case yields neither a strict- nor a module-mode scenario', async () => {
  // A raw test262 case carries no harness wrapper into which to inject the
  // `"use strict";` pragma, so `generateScenariosForTests` skips its strict
  // scenarios entirely; the module axis is skipped for the same reason, since an
  // ES module body is inherently strict and would silently impose strict
  // semantics on a sloppy-only raw case (test.js). Pin that documented contract.
  const scenarios = await collect(
    generateScenariosForTests(
      asyncIterable([fakeCase({ flags: ['raw'] })]),
      ['sesNode'],
      {},
    ),
  );
  assert.ok(scenarios.length > 0);
  for (const scenario of scenarios) {
    assert.notEqual(scenario.mode, 'strict');
    assert.notEqual(scenario.mode, 'module');
  }
});

// --- scenarioOk: the async protocol is signaled by print(), not exit code ----

test('scenarioIsAsync reads the canonical async flag', () => {
  assert.equal(scenarioIsAsync({ attrs: { flags: { async: true } } }), true);
  assert.equal(scenarioIsAsync({ attrs: { flags: {} } }), false);
  assert.equal(scenarioIsAsync({}), false);
});

test('scenarioOk fails on a nonzero exit regardless of stdout', () => {
  assert.equal(scenarioOk(fakeCase(), 1, ''), false);
  assert.equal(
    scenarioOk(fakeCase(), null, 'Test262:AsyncTestComplete'),
    false,
  );
});

test('scenarioOk passes a clean synchronous case', () => {
  assert.equal(scenarioOk(fakeCase(), 0, '# some TAP output\n'), true);
});

test('scenarioOk fails a clean exit that printed the async-failure marker', () => {
  // The regression the breaker seat found: $DONE(error) prints the marker but
  // never sets a nonzero exit, so exit-code-only logic laundered it into a pass.
  const asyncCase = fakeCase({ flags: ['async'] });
  assert.equal(
    scenarioOk(asyncCase, 0, 'Test262:AsyncTestFailure:Test262Error: boom'),
    false,
  );
});

test('scenarioOk requires a declared-async case to signal completion', () => {
  const asyncCase = fakeCase({ flags: ['async'] });
  // Clean exit but no completion marker: $DONE never fired.
  assert.equal(scenarioOk(asyncCase, 0, 'partial output, no marker'), false);
  // Completion marker present: a real async pass.
  assert.equal(scenarioOk(asyncCase, 0, 'Test262:AsyncTestComplete'), true);
});

// --- agentRunsScenario: the child-spawn boundary classifier ------------------

test('agentRunsScenario wires exactly module and lockdownModule today', () => {
  assert.equal(agentRunsScenario('module'), true);
  assert.equal(agentRunsScenario('lockdownModule'), true);
  // Everything else — the sloppy/strict modes and the whole compartment axis —
  // is generated and enumerated by `--list` but not yet wired to an agent; pin
  // that so an accidental future widening of the wired set is caught.
  assert.equal(agentRunsScenario('sloppy'), false);
  assert.equal(agentRunsScenario('strict'), false);
  assert.equal(agentRunsScenario('lockdownStrict'), false);
  assert.equal(agentRunsScenario('compartmentModule'), false);
  assert.equal(agentRunsScenario('lockdownCompartmentModule'), false);
});
