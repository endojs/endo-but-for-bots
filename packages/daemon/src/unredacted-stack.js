// @ts-check
/* global globalThis */

/**
 * Feature-test for the SES start-compartment hooks that expose unredacted
 * error info via the internal tables SES maintains. This is the same hack
 * `@endo/ses-ava` uses to surface unredacted causal traces to AVA's
 * `t.log` (see packages/ses-ava/src/ses-ava-test.js). Until a less
 * tightly-coupled API exists we tap the same surface from worker- and
 * daemon-side error capture.
 *
 * Two hooks are consulted in order:
 *
 *  1. `globalThis[Symbol.for('MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA')]`
 *     yields a causal-console factory: passing it a logger callback
 *     returns a virtual console whose `error` method renders the
 *     unredacted form of an Error (including the hidden message-template
 *     args and any `note(err, ...)` annotations) into the logger.
 *     Catching those logger calls into a buffer reconstructs the full
 *     unredacted rendering.
 *
 *  2. `globalThis.getStackString` is the SES `tame-v8-error-constructor`
 *     accessor for the unredacted stack string only (no notes, no cause
 *     chain). Used as a narrower fallback.
 *
 * Both hooks are privileged: SES only installs them on the start
 * compartment, on the assumption that the host of the start compartment
 * is trusted. The daemon worker runs in the start compartment (it loads
 * `@endo/init` before forking the marshal hooks), so this is the
 * intended consumer surface.
 *
 * If neither hook is present (e.g. a non-SES test harness, or a future
 * SES that retires the symbol), we fall back to `err.stack`. The
 * fallback preserves the prior behavior so non-SES paths and the unit
 * tests that do not lockdown still work.
 */

const MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA = Symbol.for(
  'MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA',
);

/** @type {Record<PropertyKey, unknown>} */
const globalRecord = globalThis;

const optMakeCausalConsoleFromLogger =
  /** @type {((logger: (...args: unknown[]) => void) => Console) | undefined} */ (
    globalRecord[MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA]
  );

const optGetStackString = /** @type {((err: Error) => string) | undefined} */ (
  globalRecord.getStackString
);

// Sanctioned SES unredaction API (gap-revealing prototype of endo #595). When
// SES installs `globalThis.unredactError`, it renders the full unredacted
// diagnostic form (message-template args + stack + cause chain + notes) to a
// string directly — exactly the shape this module needs for
// `TraceRecord.stack`. Preferring it lets the daemon stop driving the ses-ava
// causal-console factory through a buffering logger (see `getUnredactedRendering`
// below, which becomes dead once every supported SES ships `unredactError`).
// Still feature-tested and still fully fallback-guarded, so a SES without the
// sanctioned API keeps working via the legacy path.
const optUnredactError = /** @type {((err: Error) => string) | undefined} */ (
  globalRecord.unredactError
);

/**
 * Render one logger argument to a flat string. The causal console emits
 * a heterogeneous arg list (leading format string, then values); we
 * stringify each one independently rather than imitate `util.format`
 * because the goal is operator-readable text, not a wire format.
 *
 * @param {unknown} arg
 */
const renderArg = arg => {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    // Recurse via the same hook so nested errors carry their own
    // unredacted rendering. Falling back to `String(err)` here would
    // re-redact whatever the parent causal console just expanded.
    const nested = getUnredactedRendering(arg);
    return nested === undefined ? String(arg) : nested;
  }
  try {
    return JSON.stringify(arg);
  } catch (_e) {
    return String(arg);
  }
};

/**
 * Render an Error through SES's causal-console hack, returning a single
 * string with the full unredacted rendering (stack, cause chain, hidden
 * notes) joined by newlines. Returns `undefined` when the hack is not
 * available, so callers can decide whether to fall back to `err.stack`
 * or to `getStackString`.
 *
 * @param {Error} err
 */
const getUnredactedRendering = err => {
  if (optMakeCausalConsoleFromLogger === undefined) return undefined;
  /** @type {string[]} */
  const lines = [];
  /** @param {unknown[]} args */
  const buffer = (...args) => {
    lines.push(args.map(renderArg).join(' '));
  };
  let causalConsole;
  try {
    causalConsole = optMakeCausalConsoleFromLogger(buffer);
  } catch (_e) {
    return undefined;
  }
  try {
    causalConsole.error(err);
  } catch (_e) {
    // The causal console can throw if `err` is malformed. Prefer a
    // partial rendering to nothing.
  }
  return lines.join('\n');
};

/**
 * Best-effort unredacted stack-and-context string for `err`, suitable
 * for inclusion in a `TraceRecord.stack` field. Order of preference:
 *
 *  1. Full causal rendering via the ses-ava hack
 *     (stack + cause chain + hidden notes).
 *  2. `globalThis.getStackString(err)` (stack only, no notes/causes).
 *  3. `err.stack` (whatever the host platform's default is; under SES
 *     `safe` errorTaming on V8 this is `''`).
 *  4. Empty string.
 *
 * @param {Error} err
 * @returns {string}
 */
export const getUnredactedStackString = err => {
  // Preference 0: the sanctioned SES `unredactError` (endo #595). When
  // present it supersedes the ses-ava-symbol buffering path below, returning
  // the same full rendering without the daemon reaching into SES internals.
  if (optUnredactError !== undefined) {
    try {
      const rendered = optUnredactError(err);
      if (typeof rendered === 'string' && rendered.length > 0) {
        return rendered;
      }
    } catch (_e) {
      // Fall through to the legacy ses-ava-symbol path.
    }
  }
  const rendered = getUnredactedRendering(err);
  if (rendered !== undefined && rendered.length > 0) {
    return rendered;
  }
  if (optGetStackString !== undefined) {
    try {
      const stackString = optGetStackString(err);
      if (typeof stackString === 'string' && stackString.length > 0) {
        return stackString;
      }
    } catch (_e) {
      // Fall through to err.stack.
    }
  }
  if (typeof err.stack === 'string') {
    return err.stack;
  }
  return '';
};

/**
 * Feature flag indicating whether SES's privileged unredaction hook is
 * installed in this realm. Useful for tests that want to assert the
 * production capture path is exercising the hack rather than the
 * fallback.
 */
export const hasUnredactedStackHook =
  optUnredactError !== undefined || optMakeCausalConsoleFromLogger !== undefined;
