// @ts-check
/**
 * Perf check "hub", growth with the number of sessions (core candidates
 * C-20 and C-2; `perf/_hub.mjs`): how the hub's persisted state and its cost
 * per delivery grow when more sessions have each run one turn.
 *
 *   cd packages/thixotrope-harness && node perf/hub.sessions.perf.mjs
 *
 * One served copy of the m1a template, idle sleep 1 h, the scripted backend:
 * one measured session with a subscriber, 3 warm-up turns, one
 * GROWTH_WINDOW_MS (default 30 s; it was 30 turns) window fresh; then more
 * sessions are created and each submits one turn, and a window runs on the
 * measured session at each of GROWTH_STEPS (default "10,50") sessions (the
 * measured one included; the last is GROWTH_SESSIONS, default 50, when that
 * is set). Rows: `hub.persist` per window, `hub.growth` over the points
 * (budget 2 MB; ms per delivery <= 1.25 x fresh). The long-session point is
 * `perf/hub.growth.perf.mjs`. About 5 minutes: the sessions are created
 * cold (the m1a template has no pool), about 3-4 s each.
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { runPerf } from './_harness.mjs';
import { growthRow, growthWindow, openSlice, perfInputs } from './_hub.mjs';

const { round1, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');

const GROWTH_SESSIONS = Number(process.env.GROWTH_SESSIONS ?? 50);
const GROWTH_STEPS = (process.env.GROWTH_STEPS ?? `10,${GROWTH_SESSIONS}`)
  .split(',')
  .map(Number)
  .filter(n => n > 1);

await runPerf('hub', async ({ root }) => {
  const template = await sliceTemplate();
  const run = await openSlice(template, root);
  try {
    const session = await run.slice.createSession(run.made.backend, 'grow');
    const { sub, turn } = await run.open(session);
    for (let i = 0; i < 3; i += 1) await turn();
    const points = [await growthWindow(run, turn, 'fresh', 1)];
    const t1 = performance.now();
    /** @type {number[]} */
    const createMs = [];
    let made = 1;
    for (const target of GROWTH_STEPS) {
      for (; made < target; made += 1) {
        const t = performance.now();
        const other = await run.slice.createSession(
          run.made.backend,
          `g${made}`,
        );
        createMs.push(performance.now() - t);
        await run.slice.submit(other, perfInputs.start);
      }
      // The last sessions' turns settle before the window.
      await delay(2000);
      points.push(
        await growthWindow(run, turn, `at ${target} sessions`, target),
      );
    }
    const sorted = [...createMs].sort((a, b) => a - b);
    await growthRow(points, {
      part: 'sessions',
      sessions: made,
      sessionsMs: round1(performance.now() - t1),
      createMsMedian: sorted.length
        ? round1(sorted[Math.floor(sorted.length / 2)])
        : null,
    });
    await sub.stop();
  } finally {
    await run.served.cleanup();
  }
});
