/**
 * Companion to the star-reexport cells with the star reexport replaced by
 * a named reexport: the upstream module uses `export { y } from
 * './export-renamer.js'` instead of `export * from './export-renamer.js'`.
 * The cycle has the same shape (the named-reexporter and the export-renamer
 * reference each other) and the observation of `r.y` through the namespace
 * import lands during the same linked-but-not-yet-bound window when main.js
 * imports the renamer first. Node.js raises ReferenceError here, matching
 * the star-reexport case, because temporal-dead-zone semantics live with
 * the binding rather than the reexport form. After the TDZ-enforcement
 * fix landed on endojs/endo-but-for-bots#379, SES enforces the same TDZ on the namespace path
 * whether the reexport is reached through `export *` or through
 * `export { y } from`. Exercised through the compartment-mapper test
 * scaffold; the Node.js parity sibling in
 * cycle-named-reexport-tdz-const-renamer-first-node-parity.test.js asserts
 * the same expected value against plain Node.js. See
 * `_cycle-rename-tdz-assertions.js` for the matrix's framing.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import {
  assertCycleRenameTdz,
  expectedProbeNamedConstRenamerFirst,
} from './_cycle-rename-tdz-assertions.js';

const fixture = new URL(
  'fixtures-cycle-named-reexport-tdz-const-renamer-first/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureAssertionCount = 1;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertCycleRenameTdz(t, namespace, expectedProbeNamedConstRenamerFirst);
};

scaffold(
  'cycle-named-reexport-tdz const renamer-first (issue #59)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);
