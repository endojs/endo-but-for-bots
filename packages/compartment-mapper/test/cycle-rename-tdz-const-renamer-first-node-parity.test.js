/**
 * Node.js parity test for one cell of the TDZ-observation matrix from
 * issue #59: cyclic star-export with renaming reexport, renamer's binding
 * is `const y = 42`, main.js imports the renamer first. This test runs the
 * same fixture under plain Node.js (no SES, no compartment mapper) and
 * asserts the same probe value asserted in the compartment-mapper test.
 * Parity is verified by construction: if both tests pass, SES enforces the
 * same temporal-dead-zone semantics on the cross-module namespace read as
 * Node.js for this cell.
 */

import test from 'ava';
import {
  assertCycleRenameTdz,
  expectedProbeStarConstRenamerFirst,
} from './_cycle-rename-tdz-assertions.js';

test('cyclic star export with renaming reexport, renamer first, const TDZ (issue #59) - node parity', async t => {
  t.plan(1);
  const namespace = await import(
    new URL(
      'fixtures-cycle-rename-tdz-const-renamer-first/node_modules/app/main.js',
      import.meta.url,
    ).href
  );
  assertCycleRenameTdz(t, namespace, expectedProbeStarConstRenamerFirst);
});
