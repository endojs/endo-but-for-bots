/**
 * One cell of the TDZ-observation matrix for the cyclic star-export with
 * renaming reexport scenario from issue #59: renamer's binding is `const y
 * = 42`, main.js imports the star-reexporter before the renamer.
 * Depth-first cycle resolution evaluates the renamer's body to completion
 * before the star-reexporter's body runs, so the probe captures the
 * assigned value 42. This cell has no TDZ window to observe; it pins the
 * expected non-observation that completes the matrix. Exercised through
 * the compartment-mapper test scaffold; the Node.js parity sibling in
 * cycle-rename-tdz-const-star-first-node-parity.test.js asserts the same
 * expected value against plain Node.js. See
 * `_cycle-rename-tdz-assertions.js` for the matrix's framing.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import {
  assertCycleRenameTdz,
  expectedProbeStarConstStarFirst,
} from './_cycle-rename-tdz-assertions.js';

const fixture = new URL(
  'fixtures-cycle-rename-tdz-const-star-first/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureAssertionCount = 1;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertCycleRenameTdz(t, namespace, expectedProbeStarConstStarFirst);
};

scaffold(
  'cycle-rename-tdz const star-first (issue #59)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);
