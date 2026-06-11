/**
 * One cell of the TDZ-observation matrix for the cyclic star-export with
 * renaming reexport scenario from issue #59: renamer's binding is `let y =
 * 42`, main.js imports the renamer before the star-reexporter. The
 * star-reexporter's probe observes ReferenceError on the cross-module read
 * through the namespace import during the temporal dead zone window.
 * Exercised through the compartment-mapper test scaffold; the Node.js
 * parity sibling in cycle-rename-tdz-let-renamer-first-node-parity.test.js
 * asserts the same expected value against plain Node.js. See
 * `_cycle-rename-tdz-assertions.js` for the matrix's framing.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import {
  assertCycleRenameTdz,
  expectedProbeStarLetRenamerFirst,
} from './_cycle-rename-tdz-assertions.js';

const fixture = new URL(
  'fixtures-cycle-rename-tdz-let-renamer-first/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureAssertionCount = 1;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertCycleRenameTdz(t, namespace, expectedProbeStarLetRenamerFirst);
};

scaffold(
  'cycle-rename-tdz let renamer-first (issue #59)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);
