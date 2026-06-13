/**
 * Table-driven test for the TDZ-observation matrix of the cyclic
 * star-export and named-reexport scenarios exercised through the
 * compartment-mapper test scaffold. Each row in the
 * `SCENARIOS` table from `_cycle-rename-tdz-assertions.js` corresponds to
 * one fixture directory under
 * `packages/compartment-mapper/test/` (named by the scenario's `fixture`
 * field) and to one matrix cell described in that module's preamble. The
 * Node.js parity sibling in `cycle-rename-tdz-matrix-node-parity.test.js`
 * walks the same table and asserts the same expected probe values against
 * plain Node.js; if both layers pass for every scenario, parity is
 * verified by construction. See `_cycle-rename-tdz-assertions.js` for the
 * matrix's framing and the per-scenario expected-probe rationale.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import {
  SCENARIOS,
  assertCycleRenameTdz,
} from './_cycle-rename-tdz-assertions.js';

const fixtureAssertionCount = 1;

for (const scenario of SCENARIOS) {
  const fixture = new URL(
    `${scenario.fixture}/node_modules/app/main.js`,
    import.meta.url,
  ).toString();

  /**
   * @param {ExecutionContext} t
   * @param {{namespace: object}} result
   */
  const assertFixture = (t, { namespace }) => {
    assertCycleRenameTdz(t, namespace, scenario.expectedProbe);
  };

  scaffold(
    `cycle-rename-tdz ${scenario.name}`,
    test,
    fixture,
    assertFixture,
    fixtureAssertionCount,
  );
}
