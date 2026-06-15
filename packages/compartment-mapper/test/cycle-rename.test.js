/**
 * Regression for endojs/endo#59 (cyclic star export with renaming reexport)
 * exercised twice in this module, back-to-back: once through the
 * compartment-mapper test scaffold (the SES treatment) and once through
 * plain Node.js (the parity treatment). Both treatments target the same
 * three-module fixture and assert the same expected values through the
 * shared assertion module. The paired registration makes the shared
 * coverage legible at a glance and pins the compartment mapper's linker
 * behavior to Node.js's reference behavior.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import { assertCycleRename } from './_cycle-rename-assertions.js';

const fixture = new URL(
  'fixtures-cycle-rename/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureAssertionCount = 3;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertCycleRename(t, namespace);
};

// SES treatment: load through the compartment-mapper scaffold, which
// exercises loadLocation, importLocation, and the archive paths.
scaffold(
  'cycle-rename (ses)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);

// Node.js parity treatment: dynamically import the same `main.js` directly
// under plain Node.js (no SES, no compartment mapper) and assert the same
// expected values.
test('cycle-rename (node parity)', async t => {
  t.plan(3);
  const namespace = await import(fixture);
  assertCycleRename(t, namespace);
});
