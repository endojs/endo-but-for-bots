import { parseArgs } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';
import { readFileSync, writeFileSync } from 'fs';

import TestStream from 'test262-stream';

// agents:
import { testSesNode } from './agents/node.js';
import { testXs } from './agents/xs.js';

// This harness reuses its own package root as the test262 corpus directory, so
// test262-stream reads THIS package's version as the "corpus version" and, by
// default, rejects any version outside its supported major range (1-5). Read
// our own version so we can accept it explicitly and stay free to follow the
// 0.1.0 initial-release convention.
const { version: corpusVersion } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
);

const options = /** @type {const} */ ({
  list: {
    type: 'boolean',
    multiple: false,
  },
  flag: {
    type: 'string',
    short: 'f',
    multiple: true,
  },
  agent: {
    type: 'string',
    short: 'a',
    multiple: true,
  },
  compact: {
    type: 'boolean',
    multiple: false,
  },
  baseline: {
    type: 'string',
    multiple: false,
  },
  report: {
    type: 'string',
    multiple: false,
  },
  'update-baseline': {
    type: 'string',
    multiple: false,
  },
});

const strictPragma = '"use strict";\n';

const strictTest = test => {
  const { contents, insertionIndex } = test;
  return {
    ...test,
    contents: `${strictPragma}${contents}`,
    insertionIndex: insertionIndex + strictPragma.length,
  };
};

export async function* generateScenariosForTests(tests, agents, extraFlags) {
  for await (const test of tests) {
    const { attrs } = test;
    const { flags } = attrs;
    // Promote the ad-hoc `module` convention to the `only` filter so a
    // module-flagged case is restricted to the module scenario. `onlyStrict` is
    // already a canonical test262 flag `test262-stream` parses directly from the
    // front-matter (there is no `flags.strict`), so it is left untouched — the
    // earlier `flags.onlyStrict = flags.strict` clobbered the real value with
    // `undefined` and silently defeated the strict-only filter on every case
    // that declared it.
    flags.onlyModule = flags.module;
    for (const agent of agents) {
      for (const mode of ['Sloppy', 'Strict', 'Module']) {
        for (const lockdown of [false, true]) {
          for (const compartment of [false, true]) {
            const scenario = [];
            if (lockdown) {
              scenario.push('Lockdown');
            }
            if (compartment) {
              scenario.push('Compartment');
            }
            scenario.push(mode);
            scenario[0] = scenario[0].toLowerCase();
            if (
              test.attrs.flags.raw &&
              (mode === 'Strict' || mode === 'Module')
            ) {
              // A raw test has no harness wrapper into which to inject the
              // strict pragma, so it has no distinct strict scenario. The module
              // axis is skipped for the same reason: an ES module body is
              // inherently strict, so running a raw case there would silently
              // impose strict semantics on a case that only exists in its sloppy
              // form rather than reporting the strict/module scenario as skip.
              // eslint-disable-next-line no-continue
              continue;
            }
            yield {
              ...(mode === 'Strict' ? strictTest(test) : test),
              attrs: {
                ...attrs,
                flags: {
                  ...flags,
                  ...extraFlags,
                },
              },
              agent,
              scenario: scenario.join(''),
              mode: mode.toLowerCase(),
              lockdown,
              compartment,
              qualifiers: {
                [agent]: true,
                [mode.toLowerCase()]: true,
                // An ES-module body is strict regardless of a pragma, so the
                // `module` mode SATISFIES `onlyStrict` (and, symmetrically, a
                // `noStrict` case must not run there). Without this alias an
                // `onlyStrict` case is generated only into `strict`/`lockdownStrict`
                // scenario names no agent runs today, so it is reported `skip`
                // indistinguishably from the deliberate backlog — stranding 55 of
                // the 89 ported cases (including the harden vs. native cases this
                // package most exists to pin) as structurally inert.
                strict: mode === 'Strict' || mode === 'Module',
                compartment,
                lockdown,
                lockdownCompartment: lockdown && compartment,
              },
              temporaryPath: [
                agent,
                mode.toLowerCase(),
                ...(compartment ? ['compartment'] : []),
                ...(lockdown ? ['lockdown'] : []),
                test.file,
              ].join('/'),
            };
          }
        }
      }
    }
  }
}

export async function* filterNoRules(tests) {
  for await (const test of tests) {
    const { attrs, qualifiers } = test;
    const { flags } = attrs;
    const noFlags = Object.keys(flags).filter(
      flag => flags[flag] && flag.match(/^no[A-Z]/),
    );
    if (
      !noFlags.some(noFlag => {
        const condition = noFlag.replace(/^no([A-Z])/, (_, $1) =>
          $1.toLowerCase(),
        );
        return qualifiers[condition];
      })
    ) {
      yield test;
    }
  }
}

export async function* filterOnlyRules(tests) {
  for await (const test of tests) {
    const { attrs, qualifiers } = test;
    const { flags } = attrs;
    const onlyFlags = Object.keys(flags).filter(
      flag => flags[flag] && flag.match(/^only[A-Z]/),
    );
    if (
      onlyFlags.every(onlyFlag => {
        const condition = onlyFlag.replace(/^only([A-Z])/, (_, $1) =>
          $1.toLowerCase(),
        );
        return qualifiers[condition];
      })
    ) {
      yield test;
    }
  }
}

/**
 * Wrap a single value as a one-shot async iterable for the per-file pipeline.
 *
 * @template T
 * @param {T} item
 */
async function* asyncOnce(item) {
  yield item;
}

/**
 * A synthetic record for a source file whose EVERY generated scenario was
 * filtered out — so that a file which the `no*`/`only*` rules leave with zero
 * runnable-or-skippable scenarios still surfaces, rather than vanishing from both
 * `--list` and the run report. Two distinct front-matter shapes reach here:
 *   - every wired agent excluded, e.g. `noXs`+`noSesXs`+`noSesNode` together, so
 *     `filterNoRules` drops all combinations (engine-realist/spec-keeper/corner-prober);
 *   - a `raw`+`module` contradiction, where the `module`->`onlyModule` promotion
 *     wants the module scenario but `raw` suppresses every strict/module axis, so
 *     `filterOnlyRules` rejects the surviving sloppy scenarios (corner-prober).
 * Emitting a `skipped` zero-coverage record upholds the same visibility invariant
 * `runTests` enforces for the unwired scenarios (README.md; scripts/test.js).
 *
 * @param {{ file: string, attrs?: object }} test
 */
export const zeroCoverageScenario = test => ({
  file: test.file,
  attrs: test.attrs,
  agent: '',
  mode: '',
  scenario: '',
  lockdown: false,
  compartment: false,
  skipped: true,
  zeroCoverage: true,
});

export async function* scenariosForTests(tests, agents, conditions) {
  for await (const test of tests) {
    // Filter each file's scenarios in isolation so we can tell a file that
    // yielded zero survivors from one that merely interleaves with its
    // neighbours; the filters are per-scenario and stateless, so per-file and
    // whole-stream filtering produce the identical surviving set and order.
    let survived = false;
    const generated = generateScenariosForTests(
      asyncOnce(test),
      agents,
      conditions,
    );
    for await (const scenario of filterOnlyRules(filterNoRules(generated))) {
      survived = true;
      yield scenario;
    }
    if (!survived) {
      yield zeroCoverageScenario(test);
    }
  }
}

const verboseBegin = test => {
  if (test.zeroCoverage) {
    console.error(
      `## (zero coverage: every wired agent excluded) ${test.file}`,
    );
    return;
  }
  console.error(
    `## ${test.agent} ${test.mode}${test.lockdown ? ' lockdown' : ''}${test.compartment ? ' compartment' : ''}${test.description ? `${test.description}` : ''} ${test.file}`,
  );
};

const terseEnd = test => {
  if (test.zeroCoverage) {
    console.error('# skip (zero coverage: every wired agent excluded)');
    return;
  }
  if (test.skipped) {
    console.error('# skip (no agent runs this scenario yet)');
    return;
  }
  console.error(
    `# ${test.ok ? 'ok' : `not ok code=${test.code} signal=${test.signal}`}`,
  );
};

const compactEnd = test => {
  if (test.zeroCoverage) {
    console.error(['skip', test.file, 'zero-coverage', '', '', ''].join(':'));
    return;
  }
  console.error(
    [
      test.skipped ? 'skip' : test.ok ? 'pass' : 'fail',
      test.file,
      test.agent,
      test.mode,
      test.lockdown ? 'lockdown' : '',
      test.compartment ? 'compartment' : '',
    ].join(':'),
  );
};

// Which (agent, scenario) pairs an agent actually executes today. Every agent
// currently drives only the `module` and `lockdownModule` scenarios; the
// remaining sloppy/strict modes and the whole compartment axis are generated
// (and enumerated by `--list`) but not yet wired to any agent.
export const agentRunsScenario = scenario =>
  scenario === 'module' || scenario === 'lockdownModule';

export async function* runTests({ quiet, begin }, tests) {
  for await (const test of tests) {
    const { agent, scenario } = test;
    begin(test);
    if (!agentRunsScenario(scenario)) {
      // Report the scenario as an explicit skip rather than silently dropping
      // it, so a run and `--list` enumerate the same scenarios and un-covered
      // cases stay visible.
      yield { ...test, skipped: true };
    } else if (agent === 'xs') {
      yield await testXs(test, { sesShim: false, quiet });
    } else if (agent === 'sesXs') {
      yield await testXs(test, { sesShim: true, quiet });
    } else if (agent === 'sesNode') {
      yield await testSesNode(test, { quiet });
    } else {
      yield { ...test, skipped: true };
    }
  }
}

const resultStatus = test =>
  test.skipped ? 'skipped' : test.ok ? 'passed' : 'failed';

const resultScenario = test =>
  test.zeroCoverage ? 'zeroCoverage' : `${test.agent}/${test.scenario}`;

/**
 * Build a stable, reviewable inventory of every outcome, indexed first by the
 * scenario that produced it and then by status. This is deliberately lossless:
 * a baseline diff names the tests that moved, not just changed totals.
 *
 * @param {AsyncIterable<object>} results
 */
export const makeResultReport = async results => {
  /** @type {Record<string, { skipped: string[], failed: string[], passed: string[] }>} */
  const scenarios = {};
  for await (const result of results) {
    const scenario = resultScenario(result);
    scenarios[scenario] ??= { skipped: [], failed: [], passed: [] };
    const files = scenarios[scenario][resultStatus(result)];
    if (!files.includes(result.file)) {
      files.push(result.file);
    }
  }

  return {
    version: 1,
    scenarios: Object.fromEntries(
      Object.entries(scenarios)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([scenario, outcomes]) => [
          scenario,
          Object.fromEntries(
            Object.entries(outcomes).map(([status, files]) => [
              status,
              files.sort(),
            ]),
          ),
        ]),
    ),
  };
};

const reportText = report => `${JSON.stringify(report, null, 2)}\n`;

/**
 * Name every changed baseline entry. A leading minus is an expected outcome
 * that disappeared; a leading plus is a newly observed outcome.
 *
 * @param {object} expected
 * @param {object} actual
 */
export const diffResultReports = (expected, actual) => {
  const flatten = report =>
    new Set(
      Object.entries(report.scenarios ?? {}).flatMap(([scenario, outcomes]) =>
        Object.entries(outcomes).flatMap(([status, files]) =>
          files.map(file => `${scenario} ${status} ${file}`),
        ),
      ),
    );
  const expectedEntries = flatten(expected);
  const actualEntries = flatten(actual);
  return [
    ...[...expectedEntries]
      .filter(entry => !actualEntries.has(entry))
      .sort()
      .map(entry => `- ${entry}`),
    ...[...actualEntries]
      .filter(entry => !expectedEntries.has(entry))
      .sort()
      .map(entry => `+ ${entry}`),
  ];
};

const main = async () => {
  await null;
  const {
    values: {
      flag: flagArguments,
      agent: agentArguments,
      list: showList,
      compact: compactReport,
      baseline: baselinePath,
      report: reportPath,
      'update-baseline': updateBaselinePath,
    },
    positionals,
  } = parseArgs({
    args: process.argv.slice(2),
    options,
    allowPositionals: true,
  });

  // These agent names leave a open space for bare XS and node agents to check
  // for progress toward obviating the shim.
  const stream = new TestStream(fileURLToPath(new URL('..', import.meta.url)), {
    paths: positionals.length ? positionals : undefined,
    acceptVersion: corpusVersion,
  });
  const conditions = Object.fromEntries(
    (flagArguments ?? []).map(flag => [flag, true]),
  );
  const agents = agentArguments ?? ['xs', 'sesXs', 'sesNode'];
  const tests = scenariosForTests(stream, agents, conditions);

  const resultArtifactRequested =
    baselinePath !== undefined ||
    reportPath !== undefined ||
    updateBaselinePath !== undefined;

  if (showList) {
    if (compactReport) {
      let prev;
      for await (const test of tests) {
        if (test.file !== prev) {
          console.log(test.file);
          prev = test.file;
        }
      }
    } else {
      for await (const test of tests) {
        if (test.zeroCoverage) {
          // A file every rule excluded still gets one enumerated line, so the
          // list and a run agree and no ported case silently disappears.
          console.log(`${test.file}:zero-coverage:::`);
          // eslint-disable-next-line no-continue
          continue;
        }
        const { file, agent, mode, lockdown, compartment } = test;
        console.log(
          `${file}:${agent}:${mode}:${lockdown ? 'lockdown' : ''}:${compartment ? 'compartment' : ''}`,
        );
      }
    }
  } else if (resultArtifactRequested) {
    const results = runTests({ quiet: true, begin: Function.prototype }, tests);
    const report = await makeResultReport(results);
    if (reportPath !== undefined) {
      writeFileSync(reportPath, reportText(report));
    }
    if (updateBaselinePath !== undefined) {
      writeFileSync(updateBaselinePath, reportText(report));
    }
    if (baselinePath !== undefined) {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8'));
      const differences = diffResultReports(baseline, report);
      if (differences.length > 0) {
        console.error(
          `Result baseline changed (${differences.length} entries):`,
        );
        for (const difference of differences) {
          console.error(difference);
        }
        console.error(
          `Run \`yarn test262:update\` and commit ${baselinePath} if the change is intended.`,
        );
        process.exitCode = 1;
      }
    }
  } else {
    const begin = compactReport ? Function.prototype : verboseBegin;
    const end = compactReport ? compactEnd : terseEnd;
    for await (const test of runTests({ quiet: compactReport, begin }, tests)) {
      end(test);
    }
  }
};

// Only drive the harness when run as a script (`node scripts/test.js`); when
// imported (by the golden test that pins the scenario/filter contract) the
// exports above are all a consumer needs and `main` must not parse argv or run.
const invokedPath = process.argv[1];
const isMain =
  invokedPath !== undefined &&
  fileURLToPath(import.meta.url) === fileURLToPath(pathToFileURL(invokedPath));

if (isMain) {
  main().catch(error => {
    console.error('Error running main:', error);
    process.exitCode = 1;
  });
}
