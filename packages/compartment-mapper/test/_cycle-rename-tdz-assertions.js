/**
 * Shared assertion logic and scenario table for the TDZ-observation matrix
 * of the cyclic star-export and named-reexport scenarios from
 * endojs/endo#59. Each scenario in the table corresponds to one cell of the
 * matrix and to one fixture directory under
 * `packages/compartment-mapper/test/` (named by the scenario's `fixture`
 * field). Each fixture exports a `probe` value captured by the star-reexporter (or
 * named-reexporter) during its top-level evaluation: the probe reads the
 * renamer's binding `y` through a namespace import (`r.y`) inside a try
 * block and records either the value (when the binding is already
 * initialized) or the error name (when the read raises during the temporal
 * dead zone window).
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
 * enforces the same TDZ on the cross-module namespace path that Node.js
 * enforces natively. Each scenario's parity test pins the compartment
 * mapper's behavior to Node.js's reference behavior by importing from this
 * module so the expected values live in exactly one place; if both layers
 * pass, parity is verified by construction.
 *
 * The companion in-process scenarios live in
 * `packages/ses/test/import-gauntlet.test.js` as the seven matrix cells
 * starting at "cyclic star export with renaming reexport, renamer imported
 * first, const binding observes ReferenceError during temporal dead zone".
 *
 * @module
 */

/** @import {ExecutionContext} from 'ava' */

/**
 * @typedef {object} CycleRenameTdzScenario
 * @property {string} name
 *   Short identifier used in test titles and the fixture directory's
 *   final path component. Each name is unique across the matrix.
 * @property {string} fixture
 *   The fixture directory name under
 *   `packages/compartment-mapper/test/`. Its `node_modules/app/main.js`
 *   is the import target for both the compartment-mapper test and its
 *   Node.js parity sibling.
 * @property {'star'|'named'} reexportForm
 *   Whether the upstream side of the cycle is reached through
 *   `export *` (`star`) or through `export { y } from` (`named`).
 * @property {'const'|'let'|'var'} binding
 *   The renamer's binding form for `y`. `const` and `let` participate in
 *   the temporal dead zone; `var` is hoisted.
 * @property {'renamer-first'|'star-first'} order
 *   Which module main.js imports first. The first-imported module starts
 *   evaluating first; the second is the one that observes the cycle
 *   partner mid-evaluation.
 * @property {{kind: 'error', name: string}|{kind: 'value', value: unknown}} expectedProbe
 *   What the probe is expected to record:
 *   - `{ kind: 'error', name: 'ReferenceError' }` for cells where the
 *     cross-module namespace read lands during the TDZ window of a
 *     lexically-bound (`const` or `let`) declaration that has not yet
 *     been initialized.
 *   - `{ kind: 'value', value: <expected> }` for cells where the read
 *     either follows depth-first cycle resolution of the renamer's body
 *     (the star-first cells, expected `42`) or observes the hoisting
 *     preamble's pre-initialization of a `var` binding (renamer-first
 *     plus `var`, expected `undefined`).
 */

/** @type {ReadonlyArray<CycleRenameTdzScenario>} */
export const SCENARIOS = Object.freeze([
  // Renamer imported first: depth-first traversal evaluates the
  // star-reexporter's body while the renamer is on the evaluation stack
  // with its binding `y` not yet initialized. Under ECMA-262, `const` and
  // `let` raise ReferenceError on read; `var` reads undefined (the
  // hoisting preamble clears the upstream TDZ before the downstream
  // observes).
  Object.freeze({
    name: 'star const renamer-first',
    fixture: 'fixtures-cycle-rename-tdz-const-renamer-first',
    reexportForm: 'star',
    binding: 'const',
    order: 'renamer-first',
    expectedProbe: Object.freeze({
      kind: 'error',
      name: 'ReferenceError',
    }),
  }),
  Object.freeze({
    name: 'star let renamer-first',
    fixture: 'fixtures-cycle-rename-tdz-let-renamer-first',
    reexportForm: 'star',
    binding: 'let',
    order: 'renamer-first',
    expectedProbe: Object.freeze({
      kind: 'error',
      name: 'ReferenceError',
    }),
  }),
  Object.freeze({
    name: 'star var renamer-first',
    fixture: 'fixtures-cycle-rename-tdz-var-renamer-first',
    reexportForm: 'star',
    binding: 'var',
    order: 'renamer-first',
    expectedProbe: Object.freeze({
      kind: 'value',
      value: undefined,
    }),
  }),
  // Star-reexporter imported first: depth-first cycle resolution
  // evaluates the renamer's body to completion before the star-reexporter
  // body runs, so the probe captures the assigned value for every binding
  // form. The "star reexporter imported first" cases therefore have no
  // TDZ window to observe; they are the expected non-observation that
  // completes the matrix.
  Object.freeze({
    name: 'star const star-first',
    fixture: 'fixtures-cycle-rename-tdz-const-star-first',
    reexportForm: 'star',
    binding: 'const',
    order: 'star-first',
    expectedProbe: Object.freeze({
      kind: 'value',
      value: 42,
    }),
  }),
  Object.freeze({
    name: 'star let star-first',
    fixture: 'fixtures-cycle-rename-tdz-let-star-first',
    reexportForm: 'star',
    binding: 'let',
    order: 'star-first',
    expectedProbe: Object.freeze({
      kind: 'value',
      value: 42,
    }),
  }),
  Object.freeze({
    name: 'star var star-first',
    fixture: 'fixtures-cycle-rename-tdz-var-star-first',
    reexportForm: 'star',
    binding: 'var',
    order: 'star-first',
    expectedProbe: Object.freeze({
      kind: 'value',
      value: 42,
    }),
  }),
  // Named-reexport variant with renamer imported first: the cycle is
  // reached through `export { y } from` rather than `export *`. The TDZ
  // semantics live with the binding, not with the reexport form, so the
  // const cell raises ReferenceError just as it does for the
  // star-reexport cell. This confirms the gap is not specific to
  // `export *`.
  Object.freeze({
    name: 'named const renamer-first',
    fixture: 'fixtures-cycle-named-reexport-tdz-const-renamer-first',
    reexportForm: 'named',
    binding: 'const',
    order: 'renamer-first',
    expectedProbe: Object.freeze({
      kind: 'error',
      name: 'ReferenceError',
    }),
  }),
]);

/**
 * @param {ExecutionContext} t
 * @param {object} namespace
 * @param {object} expectedProbe
 */
export const assertCycleRenameTdz = (t, namespace, expectedProbe) => {
  t.deepEqual(namespace.probe, expectedProbe);
};
