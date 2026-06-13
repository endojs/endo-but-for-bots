/**
 * Table-driven Node.js parity test for the TDZ-observation matrix from
 * endojs/endo#59. Each row in the `SCENARIOS` table from
 * `_cycle-rename-tdz-assertions.js` corresponds to one fixture directory
 * under `packages/compartment-mapper/test/` (named by the scenario's
 * `fixture` field). This test runs each fixture's `main.js` under plain
 * Node.js (no SES, no compartment mapper) and asserts the same probe
 * value asserted in the compartment-mapper sibling
 * `cycle-rename-tdz-matrix.test.js`. Parity is verified by construction:
 * if both tests pass for a scenario, SES enforces the same
 * temporal-dead-zone (or hoisting, or cycle-resolution) semantics on the
 * cross-module namespace read as Node.js for that cell. See
 * `_cycle-rename-tdz-assertions.js` for the matrix's framing.
 */

import test from 'ava';
import {
  SCENARIOS,
  assertCycleRenameTdz,
} from './_cycle-rename-tdz-assertions.js';

for (const scenario of SCENARIOS) {
  test(`cycle-rename-tdz ${scenario.name} (endojs/endo#59) - node parity`, async t => {
    t.plan(1);
    const namespace = await import(
      new URL(`${scenario.fixture}/node_modules/app/main.js`, import.meta.url)
        .href
    );
    assertCycleRenameTdz(t, namespace, scenario.expectedProbe);
  });
}
