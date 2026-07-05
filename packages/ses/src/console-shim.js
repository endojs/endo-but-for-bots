import { symbolFor, globalThis } from './commons.js';
import { defineCausalConsoleFromLogger } from './error/console.js';
import { defineUnredactError } from './error/unredact-error.js';
import { loggedErrorHandler } from './error/assert.js';

// TODO possible additional exports. Some are privileged.
// export { loggedErrorHandler };
// export {
//   makeCausalConsole,
//   consoleLevelMethods,
//   consoleOtherMethods,
//   makeLoggingConsoleKit,
//   filterConsole,
//   pumpLogToConsole,
// } from './src/error/console.js';
// export { assertLogs, throwsAndLogs } from './src/error/throws-and-logs.js';

/**
 * Makes a Console like the
 * [SES causal `console`](https://github.com/endojs/endo/blob/master/packages/ses/src/error/README.md)
 * but whose output is redirected to the supplied `logger` function.
 */
const makeCausalConsoleFromLoggerForSesAva =
  defineCausalConsoleFromLogger(loggedErrorHandler);

/**
 *`makeCausalConsoleFromLoggerForSesAva` is privileged because it exposes
 * unredacted error info onto the `Logger` provided by the caller. It
 * should not be made available to non-privileged code.
 *
 * Further, we consider this particular API choice to be experimental
 * and may change in the future. It is currently only intended for use by
 * `@endo/ses-ava`, with which it will be co-maintained.
 *
 * Thus, this `console-shim.js` makes `makeCausalConsoleFromLoggerForSesAva`
 * available on `globalThis` which it *assumes* is the global of the start
 * compartment and is therefore allowed to hold powers that should not be
 * available in constructed compartments. It makes it available as the value of
 * a global property named by a registered symbol named
 * `MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA`.
 *
 * Anyone accessing this, including `@endo/ses-ava`, should feature test for
 * this and be tolerant of its absence. It may indeed disappear from later
 * versions of the ses-shim.
 */
const MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA = symbolFor(
  'MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA',
);

globalThis[MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA] =
  makeCausalConsoleFromLoggerForSesAva;

// ---------------------------------------------------------------------------
// Sanctioned unredacted-error rendering API (gap-revealing prototype of #595).
//
// `unredactError(err)` renders the *unredacted* diagnostic form of an error to
// a flat string: the unredacted message-template args, the privileged stack,
// the cause chain, and any `note(err, ...)` annotations. It is the supported
// replacement for the two ad-hoc taps the daemon's `unredacted-stack.js` uses
// today (the `MAKE_CAUSAL_CONSOLE_FROM_LOGGER_KEY_FOR_SES_AVA` symbol and
// `globalThis.getStackString`), so a privileged consumer never has to drive the
// causal console with a buffering logger itself.
//
// EXPOSURE — start-compartment-only (design constraint #2). Like
// `getStackString` and the ses-ava symbol above, this is installed by direct
// assignment onto `globalThis` at shim load, when `globalThis` is (by the same
// assumption this file already documents) the start compartment's global. A
// child `Compartment` receives a FRESH global built from
// `sharedGlobalPropertyNames` (packages/ses/src/permits.js) and therefore does
// NOT inherit this property — that fresh-global boundary is the mechanism that
// keeps `unredactError` out of child compartments. It is not passed implicitly.
//
// gap: see PR body §Gap 2 (exposure mechanism) — a truly first-class,
// permit-hardened surface would route this through
// `initialGlobalPropertyNames` + an `%InitialUnredactError%` intrinsic (the
// mechanism `getStackString` uses at permits.js:162), rather than this
// un-permitted direct assignment. That is the ad-hoc precedent, not the
// sanctioned one; choosing between "named global", "registered symbol", and
// "permit-driven intrinsic" is the design author's call.
const unredactError = defineUnredactError(loggedErrorHandler);

globalThis.unredactError = unredactError;
