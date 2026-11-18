// @ts-check
/**
 * M2 acceptance 16 (milestones.md M2; m2-interfaces.md 4.5; W2.5), part 1
 * of 2: SIGKILL of the supervisor during a seal of the record archive at S,
 * then at A3, in real vats from the m1a state template, on the scripted
 * backend. Part 2 (`m2-archive-restart-2.test.js`) kills at A2 and Z. The
 * points, the checks after each restart and the `archive.kill.<point>` rows
 * are `_m2-archive-kill.js`'s.
 *
 * One session of 159 imported turns (the next settle starts a seal; the
 * archive seals at its 160th settle and every 32 settles after, 8 after a
 * failed seal); live turns then run until each kill. The second point's
 * kill lands on the seal the first point's restart retries (8 settles
 * later), so that seal's outcome is the first point's next-seal check.
 *
 * M2-T1 (J-9481): the file grew its session by 159 live turns and killed at
 * all four points in turn, 274-315 s against a 5-minute file budget. It now
 * imports the session and splits the points over two files, about the same
 * number of live turns in each (an unacknowledged kill retries 8 settles
 * later, an acknowledged one seals again 32 settles later).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m2-archive -- \
 *     corepack yarn test test/integration/m2-archive-restart.test.js
 */
import '../unit/_m1a-prelude.js';

import test from 'ava';

import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import { killAt, startNearSeal } from './_m2-archive-kill.js';

takeIntegrationLock(test, 'm2 archive restart test');

const run = integrationEnabled ? test.serial : test.skip;

run('16: SIGKILL during a seal at S and A3', async t => {
  t.timeout(8 * 60_000);
  const ctx = await startNearSeal(t);
  // A3's kill lands on the seal S's restart retries 8 settles later.
  await killAt(t, ctx, 'S', { nextSeal: false });
  await killAt(t, ctx, 'A3');
});
