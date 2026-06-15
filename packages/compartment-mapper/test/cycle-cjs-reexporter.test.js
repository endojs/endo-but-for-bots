/**
 * Cyclic CommonJS reexporter scenario exercised twice in this module,
 * back-to-back: once through the compartment-mapper test scaffold (the SES
 * treatment) and once through plain Node.js (the parity treatment). Both
 * treatments target the same fixture and assert the same expected values
 * through the shared assertion module. The paired registration makes the
 * shared coverage legible at a glance and pins the compartment mapper's
 * CommonJS cycle behavior to Node.js's reference behavior.
 *
 * This is the pure-CommonJS counterpart to the ESM-in-CJS-cycle divergence
 * exercised by cycle-esm-in-cjs.test.js, where Node.js rejects the topology
 * with ERR_REQUIRE_CYCLE_MODULE but SES allows it.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import { scaffold } from './scaffold.js';
import { assertCycleCjsReexporter } from './_cycle-cjs-reexporter-assertions.js';

const fixture = new URL(
  'fixtures-cycle-cjs-reexporter/node_modules/app/main.js',
  import.meta.url,
).toString();

const fixtureAssertionCount = 3;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  assertCycleCjsReexporter(t, namespace);
};

// SES treatment: load through the compartment-mapper scaffold, which
// exercises loadLocation, importLocation, and the archive paths.
scaffold(
  'cycle-cjs-reexporter (ses)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);

// Node.js parity treatment: dynamically import the same `main.js` directly
// under plain Node.js (no SES, no compartment mapper) and assert the same
// expected values. Node exposes a CommonJS module's `module.exports` as the
// namespace's default export, so the shared assertion module is reused by
// projecting through `default`.
test('cycle-cjs-reexporter (node parity)', async t => {
  t.plan(3);
  const moduleNamespace = await import(fixture);
  assertCycleCjsReexporter(t, moduleNamespace.default);
});
