// Golden tests pinning the scenario-derivation contract the gauntlet panel found
// broken in the initial mirror: the shared per-agent accessors (includes / mode
// / raw) and the front-matter flag promotion that feeds the only/no filters.
// Pure logic only — no xst/node child spawn, no prelude build — so it runs
// anywhere `node --test` does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  scenarioIncludes,
  scenarioIsModule,
  scenarioIsRaw,
  scenarioIsLockdown,
  scenarioIsAsync,
  scenarioOk,
} from './agents/scenario.js';
import {
  generateScenariosForTests,
  filterOnlyRules,
  filterNoRules,
  scenariosForTests,
  agentRunsScenario,
  makeResultReport,
  diffResultReports,
  readResultBaseline,
  writeResultBaseline,
} from './test.js';
import {
  decodeIronhorseOutcome,
  makeIronhorseSource,
} from './agents/ironhorse.js';

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

// --- scenarioIsLockdown: the node agent's single source of truth -------------

test('scenarioIsLockdown reads the scenario lockdown axis, not the name', () => {
  assert.equal(scenarioIsLockdown({ lockdown: true }), true);
  assert.equal(scenarioIsLockdown({ lockdown: false }), false);
  assert.equal(scenarioIsLockdown({}), false);
});

// --- scenariosForTests: a fully-excluded file surfaces as zero-coverage -------

test('a file whose no* flags exclude every wired agent yields one zero-coverage skip', async () => {
  // engine-realist/spec-keeper/corner-prober: noXs+noSesXs+noSesNode together
  // makes filterNoRules drop every (agent,mode,lockdown,compartment) combination,
  // so without a synthetic record the file vanishes from both --list and the run.
  const scenarios = await collect(
    scenariosForTests(
      asyncIterable([
        fakeCase({ flags: ['onlyStrict', 'noXs', 'noSesXs', 'noSesNode'] }),
      ]),
      ['xs', 'sesXs', 'sesNode'],
      {},
    ),
  );
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].zeroCoverage, true);
  assert.equal(scenarios[0].skipped, true);
  assert.equal(scenarios[0].file, 'test/x.js');
});

test('a raw+module case yields one zero-coverage skip, never silently nothing', async () => {
  // corner-prober: `module`->onlyModule wants the module scenario, but `raw`
  // suppresses every strict/module axis, so filterOnlyRules rejects the surviving
  // sloppy scenarios. The gap is now deliberate and visible, not a silent drop.
  const scenarios = await collect(
    scenariosForTests(
      asyncIterable([fakeCase({ flags: ['raw', 'module'] })]),
      ['sesNode'],
      {},
    ),
  );
  assert.equal(scenarios.length, 1);
  assert.equal(scenarios[0].zeroCoverage, true);
  assert.equal(scenarios[0].skipped, true);
});

test('scenariosForTests emits no zero-coverage record for a normally-covered file', async () => {
  const scenarios = await collect(
    scenariosForTests(
      asyncIterable([fakeCase({ flags: [] })]),
      ['sesNode'],
      {},
    ),
  );
  assert.ok(scenarios.length > 1);
  for (const scenario of scenarios) {
    assert.notEqual(scenario.zeroCoverage, true);
  }
});

// --- agentRunsScenario: the child-spawn boundary classifier ------------------

test('agentRunsScenario preserves the module matrix for JavaScript agents', () => {
  assert.equal(agentRunsScenario('xs', 'module'), true);
  assert.equal(agentRunsScenario('sesNode', 'lockdownModule'), true);
  // The remaining modes are not yet wired to these module-only agents.
  // Ironhorse's script coverage is asserted separately below.
  assert.equal(agentRunsScenario('xs', 'sloppy'), false);
  assert.equal(agentRunsScenario('sesXs', 'strict'), false);
  assert.equal(agentRunsScenario('sesNode', 'lockdownStrict'), false);
  assert.equal(agentRunsScenario('xs', 'compartmentModule'), false);
  assert.equal(agentRunsScenario('sesXs', 'lockdownCompartmentModule'), false);
});

test('agentRunsScenario exposes script modes for both Ironhorse deliveries', () => {
  for (const agent of ['ironhorse', 'sesIronhorse']) {
    assert.equal(agentRunsScenario(agent, 'sloppy'), true);
    assert.equal(agentRunsScenario(agent, 'strict'), true);
    assert.equal(agentRunsScenario(agent, 'lockdownSloppy'), true);
    assert.equal(agentRunsScenario(agent, 'lockdownStrict'), true);
    assert.equal(agentRunsScenario(agent, 'module'), false);
    assert.equal(agentRunsScenario(agent, 'compartmentStrict'), false);
  }
});

test('decodeIronhorseOutcome maps every non-covered result to failure', () => {
  const scenario = { file: 'test/x.js' };
  assert.equal(
    decodeIronhorseOutcome(
      scenario,
      0,
      null,
      JSON.stringify({ cases: [{ outcome: 'covered' }] }),
    ).ok,
    true,
  );
  assert.deepEqual(
    decodeIronhorseOutcome(
      scenario,
      0,
      null,
      JSON.stringify({
        cases: [{ outcome: 'run-skip', reason: 'unsupported-opcode:eval' }],
      }),
    ),
    {
      ok: false,
      code: 1,
      signal: null,
      failureReason: 'unsupported-opcode:eval',
      ...scenario,
    },
  );
  assert.equal(
    decodeIronhorseOutcome(
      scenario,
      1,
      null,
      JSON.stringify({
        cases: [{ outcome: 'fail', reason: 'result divergence' }],
      }),
    ).ok,
    false,
  );
  assert.equal(
    decodeIronhorseOutcome(scenario, 2, null, 'not-json').failureReason,
    'invalid endot-ih report',
  );
});

test('makeIronhorseSource reuses the stream harness and inserts setup at its boundary', () => {
  const harness = `function Test262Error(message) {
  this.message = message || '';
}
Object.defineProperty(Test262Error.prototype, 'toString', {
  value: function () {
    return 'Test262Error: ' + this.message;
  },
  writable: true,
  enumerable: false,
  configurable: true,
});
`;
  const subject = 'assert.sameValue(1, 1);\n';
  const source = makeIronhorseSource(
    {
      contents: `${harness}${subject}`,
      insertionIndex: harness.length,
      lockdown: false,
    },
    { sesShim: false },
  );
  assert.equal(source.match(/function Test262Error/g)?.length, 1);
  assert.match(source, /flags: \[raw\]/);
  assert.doesNotMatch(source, /Object\.defineProperty/);
  assert.match(source, /Test262Error\.prototype\.toString = function/);
  assert.ok(source.endsWith(subject));
});

test('makeIronhorseSource delegates async handling to endot-ih', () => {
  const source = makeIronhorseSource(
    {
      contents: '$DONE();\n',
      insertionIndex: 0,
      attrs: { flags: { async: true } },
      lockdown: false,
    },
    { sesShim: false },
  );
  assert.match(source, /flags: \[raw, async\]/);
});

// --- result report: lossless baseline indexed by agent/scenario --------------

test('makeResultReport lists skipped, failed, and passed files by scenario', async () => {
  const report = await makeResultReport(
    asyncIterable([
      { file: 'test/pass.js', agent: 'xs', scenario: 'module', ok: true },
      { file: 'test/pass.js', agent: 'xs', scenario: 'module', ok: true },
      { file: 'test/fail.js', agent: 'xs', scenario: 'module', ok: false },
      { file: 'test/skip.js', agent: 'xs', scenario: 'strict', skipped: true },
      { file: 'test/none.js', zeroCoverage: true, skipped: true },
    ]),
  );
  assert.deepEqual(report, {
    version: 1,
    scenarios: {
      'xs/module': {
        skipped: [],
        failed: ['test/fail.js'],
        passed: ['test/pass.js'],
      },
      'xs/strict': {
        skipped: ['test/skip.js'],
        failed: [],
        passed: [],
      },
      zeroCoverage: {
        skipped: ['test/none.js'],
        failed: [],
        passed: [],
      },
    },
  });
});

test('diffResultReports identifies both sides of a changed outcome', () => {
  const expected = {
    scenarios: {
      'xs/module': { skipped: [], failed: ['test/x.js'], passed: [] },
    },
  };
  const actual = {
    scenarios: {
      'xs/module': { skipped: [], failed: [], passed: ['test/x.js'] },
    },
  };
  assert.deepEqual(diffResultReports(expected, actual), [
    '- xs/module failed test/x.js',
    '+ xs/module passed test/x.js',
  ]);
});

test('result baseline uses directories of flat textual lists', () => {
  const baselineDirectory = mkdtempSync(join(tmpdir(), 'hardened262-'));
  const report = {
    version: 1,
    scenarios: {
      'xs/module': {
        skipped: [],
        failed: ['test/fail.js'],
        passed: ['test/pass.js'],
      },
      zeroCoverage: {
        skipped: ['test/none.js'],
        failed: [],
        passed: [],
      },
    },
  };
  try {
    writeResultBaseline(baselineDirectory, report);
    assert.equal(
      readFileSync(join(baselineDirectory, 'xs/module/failed.txt'), 'utf-8'),
      'test/fail.js\n',
    );
    assert.equal(
      readFileSync(join(baselineDirectory, 'xs/module/skipped.txt'), 'utf-8'),
      '',
    );
    assert.deepEqual(readResultBaseline(baselineDirectory), report);
  } finally {
    rmSync(baselineDirectory, { recursive: true, force: true });
  }
});
