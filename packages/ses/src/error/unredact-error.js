// @ts-check

import {
  freeze,
  arrayMap,
  arrayJoin,
  arrayPush,
  stringifyJson,
  isError,
} from '../commons.js';
import { defineCausalConsoleFromLogger } from './console.js';

// gap: see PR body §Gap 1 (API name) and §Gap 4 (signature / return shape).
// This skeleton commits to `unredactError(err) => string`: a single, flat,
// operator-readable rendering of the *unredacted* form of an error — its
// unredacted message-template args, its stack (via the privileged
// `getStackString`), its cause chain, and any `note(err, ...)` annotations —
// as SES's causal console would print them. This is the shape the daemon's
// `TraceRecord.stack` consumer needs (§Gap 3, coupling: daemon / distributed
// traces). It is deliberately NOT the shape `@endo/ses-ava` needs (a
// logger-bound VirtualConsole); that consumer is left on the legacy symbol and
// its migration is a gap (§Gap 3, coupling: ses-ava; §Gap 5).

/**
 * Render one causal-console logger argument to a flat string. The causal
 * console emits a heterogeneous arg list (a leading format string, then
 * values); we stringify each independently rather than imitate `util.format`
 * because the goal is operator-readable text, not a wire format.
 *
 * This logic is lifted verbatim from the daemon's `unredacted-stack.js`
 * `renderArg`, which is exactly the boilerplate a sanctioned string API should
 * absorb so consumers stop reimplementing it.
 *
 * @param {(err: Error) => string} unredactError
 * @param {unknown} arg
 * @returns {string}
 */
const renderArg = (unredactError, arg) => {
  if (typeof arg === 'string') {
    return arg;
  }
  if (isError(arg)) {
    // Recurse through the same rendering so a nested error carries its own
    // unredacted form. `String(err)` here would re-redact whatever the parent
    // causal console just expanded.
    return unredactError(/** @type {Error} */ (arg));
  }
  try {
    return stringifyJson(arg);
  } catch (_e) {
    return `${arg}`;
  }
};

/**
 * Build the sanctioned `unredactError` renderer over a privileged
 * `loggedErrorHandler`. Kept as a factory (rather than a bare function) so the
 * privileged handler is captured by closure and never reachable from the
 * returned function's surface — the same containment shape as
 * `defineCausalConsoleFromLogger`.
 *
 * @param {import('./internal-types.js').LoggedErrorHandler} loggedErrorHandler
 * @returns {(err: Error) => string}
 */
export const defineUnredactError = loggedErrorHandler => {
  const makeCausalConsoleFromLogger =
    defineCausalConsoleFromLogger(loggedErrorHandler);

  /**
   * Render the unredacted diagnostic form of `err` to a single string.
   *
   * @param {Error} err
   * @returns {string}
   */
  const unredactError = err => {
    /** @type {string[]} */
    const lines = [];
    /** @param {unknown[]} args */
    const logger = (...args) => {
      arrayPush(
        lines,
        arrayJoin(
          arrayMap(args, arg => renderArg(unredactError, arg)),
          ' ',
        ),
      );
    };
    const causalConsole = makeCausalConsoleFromLogger(logger);
    // The causal console's `error` method drives the unredaction: it takes the
    // hidden message-log-args, appends the privileged stack string, then walks
    // the cause chain and the note annotations, emitting each as a logger call.
    // eslint-disable-next-line @endo/no-polymorphic-call
    causalConsole.error(err);
    return arrayJoin(lines, '\n');
  };
  return freeze(unredactError);
};
freeze(defineUnredactError);
