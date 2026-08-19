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
} from './agents/scenario.js';
import { generateScenariosForTests, filterOnlyRules } from './test.js';

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

test('filterOnlyRules keeps an onlyStrict case only in the strict mode', async () => {
  const generated = generateScenariosForTests(
    asyncIterable([fakeCase({ flags: ['onlyStrict'] })]),
    ['sesNode'],
    {},
  );
  const kept = await collect(filterOnlyRules(generated));
  assert.ok(kept.length > 0);
  for (const scenario of kept) {
    assert.equal(scenario.mode, 'strict');
  }
});
