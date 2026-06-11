/**
 * Node.js parity test for the cyclic named-reexport with renaming reexport
 * cell from issue #59: renamer's binding is `const y = 42`, main.js imports
 * the renamer first, the cycle is reached through `export { y } from`
 * instead of `export *`. This test runs the same fixture under plain
 * Node.js (no SES, no compartment mapper) and asserts the same probe value
 * asserted in the compartment-mapper test. Parity is verified by
 * construction: if both tests pass, SES enforces the same TDZ semantics on
 * the named-reexport path that Node.js enforces natively for this cell.
 */

import test from 'ava';
import {
  assertCycleRenameTdz,
  expectedProbeNamedConstRenamerFirst,
} from './_cycle-rename-tdz-assertions.js';

test('cyclic named reexport with renaming reexport, renamer first, const TDZ (issue #59) - node parity', async t => {
  t.plan(1);
  const namespace = await import(
    new URL(
      'fixtures-cycle-named-reexport-tdz-const-renamer-first/node_modules/app/main.js',
      import.meta.url,
    ).href
  );
  assertCycleRenameTdz(t, namespace, expectedProbeNamedConstRenamerFirst);
});
