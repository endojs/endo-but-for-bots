/**
 * Companion to cycle-rename.test.js covering the unused-live-binding shape
 * of the cyclic star-export regression (endojs/endo#59). The renamer's
 * `export var y` has no initializer; every projection of the cycle reads
 * `undefined`. Exercised twice in this module, back-to-back: once through
 * the compartment-mapper test scaffold (the SES treatment) and once through
 * plain Node.js (the parity treatment). Both treatments target the same
 * fixture and assert the same expected values through the shared assertion
 * module. The paired registration makes the shared coverage legible at a
 * glance and pins the compartment mapper's behavior for this shape to
 * Node.js's reference behavior.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import { assertCycleRenameUnused } from './_cycle-rename-unused-assertions.js';

const fixture = new URL(
  'fixtures-cycle-rename-unused/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureAssertionCount = 3;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertCycleRenameUnused(t, namespace);
};

// SES treatment: load through the compartment-mapper scaffold, which
// exercises loadLocation, importLocation, and the archive paths.
scaffold(
  'cycle-rename-unused unused live binding (ses)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);

// Node.js parity treatment: dynamically import the same `main.js` directly
// under plain Node.js (no SES, no compartment mapper) and assert the same
// expected values.
test('cycle-rename-unused unused live binding (node parity)', async t => {
  t.plan(3);
  const namespace = await import(fixture);
  assertCycleRenameUnused(t, namespace);
});
