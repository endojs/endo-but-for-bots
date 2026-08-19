// Shared accessors that derive an agent's execution parameters from the single
// scenario object `generateScenariosForTests` (../test.js) yields, so the node
// and xs agents cannot drift apart on field paths or flag names. The panel that
// reviewed the initial mirror found the xs agent reading `test.module`,
// `test.raw`, and `test.includes` off the top-level scenario — fields the
// generator never sets — while the node agent read the real ones; routing both
// through these accessors is the single source of truth that closes that gap.

/** The default test262 harness includes injected into every non-raw case. */
export const defaultIncludes = ['assert.js', 'sta.js'];

/**
 * The harness includes a scenario loads: the default `assert.js`/`sta.js` PLUS
 * whatever the case declares in its `includes:` front-matter. The declared
 * includes are ADDITIVE, not a replacement: `propertyHelper.js` (the common
 * declared include) itself calls `assert.sameValue`, so dropping the defaults
 * when a case declares its own would `ReferenceError` on `assert`.
 * `test262-stream` normalizes an absent `includes:` to `[]`, so the empty case
 * falls through to just the defaults. Deduplicated in case a case lists a
 * default explicitly.
 *
 * @param {{ attrs?: { includes?: string[] } }} test
 * @returns {string[]}
 */
export const scenarioIncludes = test => {
  const declared = test.attrs?.includes ?? [];
  return [...new Set([...defaultIncludes, ...declared])];
};

/**
 * Whether a scenario runs its subject as an ES module. The `sesNode` agent
 * always drives its subject through `await import(...)` (node-helper.js); `xst`
 * needs the `-m` flag to match. Derived from the scenario's own `mode`, which
 * the generator sets to `module` for the module axis.
 *
 * @param {{ mode?: string }} test
 * @returns {boolean}
 */
export const scenarioIsModule = test => test.mode === 'module';

/**
 * Whether a scenario is a raw test262 case: no harness wrapper, and therefore no
 * injected includes. Reads the canonical `raw` flag `test262-stream` parses out
 * of the front-matter.
 *
 * @param {{ attrs?: { flags?: Record<string, boolean> } }} test
 * @returns {boolean}
 */
export const scenarioIsRaw = test => Boolean(test.attrs?.flags?.raw);

/**
 * Whether a scenario runs under the test262 async protocol. An `async`-flagged
 * case reports its outcome by calling `$DONE` (harness/doneprintHandle.js), which
 * only `print()`s a `Test262:AsyncTestComplete` / `Test262:AsyncTestFailure:...`
 * marker and NEVER sets a nonzero exit. A clean child exit is therefore not, on
 * its own, a pass for these cases.
 *
 * @param {{ attrs?: { flags?: Record<string, boolean> } }} test
 * @returns {boolean}
 */
export const scenarioIsAsync = test => Boolean(test.attrs?.flags?.async);

/** Markers `$DONE` prints (harness/doneprintHandle.js) to signal async outcome. */
export const asyncFailureMarker = 'Test262:AsyncTestFailure';
export const asyncCompleteMarker = 'Test262:AsyncTestComplete';

/**
 * Decide a scenario's pass/fail from the child's exit `code` and its captured
 * `stdout`. Shared by the node and xs agents so they cannot drift on the async
 * protocol. A nonzero exit is always a fail; beyond that, an async case's outcome
 * lives in the printed marker, not the exit code, so a clean exit that either
 * printed a failure marker OR (for a declared-async case) never printed the
 * completion marker is a fail rather than a laundered false pass.
 *
 * @param {{ attrs?: { flags?: Record<string, boolean> } }} test
 * @param {number | null} code
 * @param {string} stdout
 * @returns {boolean}
 */
export const scenarioOk = (test, code, stdout) => {
  if (code !== 0) {
    return false;
  }
  if (stdout.includes(asyncFailureMarker)) {
    return false;
  }
  if (scenarioIsAsync(test) && !stdout.includes(asyncCompleteMarker)) {
    return false;
  }
  return true;
};
