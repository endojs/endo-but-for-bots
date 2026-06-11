/**
 * Shared assertion logic for the TDZ-observation matrix of the cyclic
 * star-export and named-reexport scenarios from endojs/endo#59. Each fixture
 * exercises one cell of the matrix and exports a `probe` value captured by
 * the star-reexporter (or named-reexporter) during its top-level evaluation:
 * the probe reads the renamer's binding `y` through a namespace import (`r.y`)
 * inside a try block and records either the value (when the binding is
 * already initialized) or the error name (when the read raises during the
 * temporal dead zone window).
 *
 * The matrix axes are:
 *
 *   1. Which module main.js imports first (the export-renamer or the
 *      star-reexporter or the named-reexporter). The first-imported module
 *      starts evaluating first; depth-first traversal of the cycle then
 *      determines which module's body runs while the other is on the
 *      evaluation stack with bindings not yet initialized.
 *   2. The renamer's binding form for `y` (`const`, `let`, or `var`). Under
 *      ECMA-262 semantics, `const` and `let` create a binding that is in
 *      the temporal dead zone until its declaration is evaluated, so a read
 *      raises ReferenceError; `var` is hoisted and reads `undefined` until
 *      the assignment runs.
 *   3. Whether the upstream side of the cycle is reached through `export *`
 *      (the six star-reexport cells) or through `export { y } from` (the
 *      single named-reexport cell).
 *
 * After the TDZ-enforcement fix landed on endojs/endo-but-for-bots#379
 * (commit 94c88465d, plus the named-reexport coverage in 53d8662a7), SES
 * enforces the same TDZ on
 * the cross-module namespace path that Node.js enforces natively. Each
 * fixture's parity test pins the compartment mapper's behavior to Node.js's
 * reference behavior by importing from this module so the expected values
 * live in exactly one place; if both tests pass, parity is verified by
 * construction.
 *
 * The companion in-process scenarios live in
 * `packages/ses/test/import-gauntlet.test.js` as the seven matrix cells
 * starting at "cyclic star export with renaming reexport, renamer imported
 * first, const binding observes ReferenceError during temporal dead zone".
 *
 * @module
 */

/** @import {ExecutionContext} from 'ava' */

// Renamer imported first: depth-first traversal evaluates the
// star-reexporter's body while the renamer is on the evaluation stack with
// its binding `y` not yet initialized. Under ECMA-262, `const` and `let`
// raise ReferenceError on read; `var` reads undefined (the hoisting
// preamble clears the upstream TDZ before the downstream observes).

export const expectedProbeStarConstRenamerFirst = {
  kind: 'error',
  name: 'ReferenceError',
};

export const expectedProbeStarLetRenamerFirst = {
  kind: 'error',
  name: 'ReferenceError',
};

export const expectedProbeStarVarRenamerFirst = {
  kind: 'value',
  value: undefined,
};

// Star-reexporter imported first: depth-first cycle resolution evaluates
// the renamer's body to completion before the star-reexporter's body runs,
// so the probe captures the assigned value for every binding form. The
// "star reexporter imported first" cases therefore have no TDZ window to
// observe; they are the expected non-observation that completes the matrix.

export const expectedProbeStarConstStarFirst = {
  kind: 'value',
  value: 42,
};

export const expectedProbeStarLetStarFirst = {
  kind: 'value',
  value: 42,
};

export const expectedProbeStarVarStarFirst = {
  kind: 'value',
  value: 42,
};

// Named-reexport variant with renamer imported first: the cycle is reached
// through `export { y } from` rather than `export *`. The TDZ semantics
// live with the binding, not with the reexport form, so the const cell
// raises ReferenceError just as it does for the star-reexport cell. This
// confirms the gap is not specific to `export *`.

export const expectedProbeNamedConstRenamerFirst = {
  kind: 'error',
  name: 'ReferenceError',
};

/**
 * @param {ExecutionContext} t
 * @param {object} namespace
 * @param {object} expectedProbe
 */
export const assertCycleRenameTdz = (t, namespace, expectedProbe) => {
  t.deepEqual(namespace.probe, expectedProbe);
};
