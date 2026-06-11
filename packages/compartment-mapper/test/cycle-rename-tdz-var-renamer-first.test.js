/**
 * One cell of the TDZ-observation matrix for the cyclic star-export with
 * renaming reexport scenario from issue #59: renamer's binding is `var y =
 * 42`, main.js imports the renamer before the star-reexporter. The
 * star-reexporter's probe observes `undefined` rather than ReferenceError
 * because the hoisting preamble clears the upstream's TDZ before the
 * downstream observes (`var` declarations are hoisted and initialized to
 * `undefined` during `InitializeEnvironment`). Exercised through the
 * compartment-mapper test scaffold; the Node.js parity sibling in
 * cycle-rename-tdz-var-renamer-first-node-parity.test.js asserts the same
 * expected value against plain Node.js. See `_cycle-rename-tdz-assertions.js`
 * for the matrix's framing.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import {
  assertCycleRenameTdz,
  expectedProbeStarVarRenamerFirst,
} from './_cycle-rename-tdz-assertions.js';

const fixture = new URL(
  'fixtures-cycle-rename-tdz-var-renamer-first/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureAssertionCount = 1;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertCycleRenameTdz(t, namespace, expectedProbeStarVarRenamerFirst);
};

scaffold(
  'cycle-rename-tdz var renamer-first (issue #59)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);
