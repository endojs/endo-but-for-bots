// @ts-check
/**
 * M2 acceptance 16 (milestones.md M2; m2-interfaces.md 4.5; W2.5), part 2
 * of 2: SIGKILL of the supervisor during a seal of the record archive at
 * A2, then at Z, in real vats from the m1a state template, on the scripted
 * backend. Part 1 (`m2-archive-restart.test.js`) kills at S and A3 and says
 * how the two files are built.
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-archive-2 -- \
 *     corepack yarn test test/integration/m2-archive-restart-2.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { killAt, startNearSeal } from './_m2-archive-kill.js';

takeIntegrationLock(test, 'm2 archive restart test 2');

const run = integrationEnabled ? test.serial : test.skip;

run('16: SIGKILL during a seal at A2 and Z', async t => {
  t.timeout(8 * 60_000);
  const ctx = await startNearSeal(t);
  // Z's kill lands on the seal A2's restart retries 8 settles later.
  await killAt(t, ctx, 'A2', { nextSeal: false });
  await killAt(t, ctx, 'Z');
});
