/**
 * Cyclic ESM-in-CommonJS divergence scenario exercised twice in this module,
 * back-to-back: once through the compartment-mapper test scaffold (the SES
 * treatment, where the topology loads and `main.bridgeValue` resolves to 42)
 * and once through plain Node.js (the parity treatment, where Node rejects
 * the topology with ERR_REQUIRE_CYCLE_MODULE). The paired registration
 * verifies the divergence programmatically rather than narratively: SES
 * allows the topology that Node rejects.
 *
 * Topology (under fixtures-cycle-esm-in-cjs/node_modules/app/):
 *
 *   main.mjs:   import * as bridge from './bridge.cjs';
 *               export const bridgeValue = bridge.value;
 *   bridge.cjs: const m = require('./peer.mjs');
 *               exports.value = m.value;
 *   peer.mjs:   import { value as bridgeValue } from './bridge.cjs';
 *               export const value = 42;
 *
 * On the SES side, bridge.cjs reads `m.value` from peer.mjs's namespace
 * after the cycle's back-edge has reached peer.mjs (which then re-entered
 * bridge.cjs). Because the ESM side resolves through live bindings, by the
 * time main reads bridge.value the snapshot capture in bridge.cjs sees
 * peer.mjs's `value = 42`.
 */

/** @import {ExecutionContext} from 'ava' */

import 'ses';
import test from 'ava';
import process from 'process';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { scaffold } from './scaffold.js';

const fixtureUrl = new URL(
  'fixtures-cycle-esm-in-cjs/node_modules/app/main.mjs',
  import.meta.url,
);
const fixture = fixtureUrl.toString();

const fixtureAssertionCount = 1;

/**
 * @param {ExecutionContext} t
 * @param {{namespace: object}} result
 */
const assertFixture = (t, { namespace }) => {
  t.is(namespace.bridgeValue, 42);
};

// SES treatment: load through the compartment-mapper scaffold. SES allows
// the topology Node rejects and exposes the cycle's snapshot / live-binding
// shape on the namespace.
scaffold(
  'cycle-esm-in-cjs divergence (ses)',
  test,
  fixture,
  assertFixture,
  fixtureAssertionCount,
);

// Node.js parity treatment: spawn a fresh Node process to execute the same
// fixture. The expected outcome is a non-zero exit with
// ERR_REQUIRE_CYCLE_MODULE printed on stderr. Spawning isolates the failure
// from the test runner's own module graph and keeps the rest of the suite
// running. Together with the SES treatment above, this pins the divergence
// programmatically: SES allows what Node rejects.
test('cycle-esm-in-cjs divergence (node parity)', t => {
  t.plan(2);
  const result = spawnSync(process.execPath, [fileURLToPath(fixtureUrl)], {
    encoding: 'utf8',
  });
  t.not(
    result.status,
    0,
    `Expected Node to reject ESM-in-CJS-cycle, got exit ${result.status}`,
  );
  t.regex(
    result.stderr,
    /ERR_REQUIRE_CYCLE_MODULE/,
    `Expected ERR_REQUIRE_CYCLE_MODULE in stderr, got:\n${result.stderr}`,
  );
});
