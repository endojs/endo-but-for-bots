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
 * Whether a scenario runs under Lockdown. Reads the scenario's own `lockdown`
 * axis the generator (../test.js) sets — the SAME single source of truth the xs
 * agent (agents/xs.js) already reads via `test.lockdown` — so the node agent no
 * longer has to re-derive it by string-matching the composed scenario NAME
 * (`scenario === 'lockdownModule'`), which silently breaks the moment any other
 * lockdown scenario (say `lockdownStrict`) wires to an agent.
 *
 * @param {{ lockdown?: boolean }} test
 * @returns {boolean}
 */
export const scenarioIsLockdown = test => Boolean(test.lockdown);

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

/**
 * Per-scenario child wall-clock budget in milliseconds. Defaults to 60s and is
 * overridable with `HARDENED262_TIMEOUT_MS` (set `0` to disable). A malformed or
 * negative value falls back to the default rather than silently disabling the
 * guard.
 *
 * @returns {number}
 */
export const scenarioTimeoutMs = () => {
  const raw = process.env.HARDENED262_TIMEOUT_MS;
  if (raw === undefined) {
    return 60_000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 60_000;
};

/**
 * Await a spawned scenario child to completion and report its `{ code, signal }`.
 * Adds the wall-clock timeout the wire-watcher seat required: a non-terminating
 * case would otherwise hang its child forever and, because `runTests` (../test.js)
 * awaits scenarios sequentially, silently wedge the ENTIRE run behind one stuck
 * child. On timeout the child is SIGKILLed (uncatchable, so a child that traps
 * SIGTERM cannot keep the run wedged) and reported as `{ code: null, signal:
 * 'SIGKILL' }` — a nonzero outcome `scenarioOk` rejects — rather than a hang.
 * Resolves on `close` (not `exit`) so every stdout chunk is captured before the
 * caller inspects it for the async markers, and rejects on a launch failure (a
 * missing `${label}` binary on the PATH) so the run fails loud with a diagnostic
 * instead of hanging.
 *
 * @param {import('child_process').ChildProcess} child
 * @param {string} label the binary name, for the launch-failure diagnostic
 * @returns {Promise<{ code: number | null, signal: string | null }>}
 */
export const awaitScenarioChild = (child, label) =>
  new Promise((resolve, reject) => {
    const timeoutMs = scenarioTimeoutMs();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, signal: 'SIGKILL' });
      }, timeoutMs);
      // Do not let the pending timeout keep the process alive on its own.
      timer.unref();
    }
    child.on('error', error => {
      clearTimeout(timer);
      // Name the binary so a missing `${label}` on the PATH is diagnosable.
      reject(new Error(`Failed to launch ${label}: ${error.message}`));
    });
    child.on('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
