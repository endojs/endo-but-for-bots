// @ts-check
/**
 * Perf check "hub", growth with the number of sessions (core candidates
 * C-20 and C-2; `perf/_hub.mjs`): how the hub's persisted state and its cost
 * per delivery grow when more sessions hold one turn each.
 *
 *   cd packages/thixotrope-harness && node perf/hub.sessions.perf.mjs
 *
 * One served copy of the m1a template, idle sleep 1 h, the scripted backend:
 * one measured session with a subscriber, 3 warm-up turns, one
 * GROWTH_WINDOW_MS (default 30 s; it was 30 turns) window fresh; then the
 * other sessions, one plain turn each, are built by `importState` (they were
 * created cold and each ran one turn), and a window runs on the measured
 * session at each of GROWTH_STEPS (default "10,20") sessions (the measured
 * one included). Rows: `hub.import` per step (sessions per second),
 * `hub.persist` per window, `hub.growth` over the measured points (budget
 * 2 MB; ms per delivery <= 1.25 x fresh), and `hub.growth.slope`: the slope
 * per 10 sessions between the two largest points, projected to
 * GROWTH_PROJECT (default 50) sessions and checked against the same budget
 * (`projected: true`).
 *
 * The 50-session point does not fit the box: a session costs 3-4 s to
 * create unloaded and about 10 s to import under load (session vat creation
 * dominates both), so 49 sessions alone take 3-8 minutes; the cold-create
 * file and a first import version both overran the 10-minute box under load
 * (J-9471). 20 is the largest point kept; 50 is a projection. The long-session
 * point is `perf/hub.growth.perf.mjs`. About 5-6 minutes under load.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
} from './_harness.mjs';
import { growthRow, growthWindow, openSlice } from './_hub.mjs';

const { round1, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { importState } = await import('../scripts/export.mjs');

const GROWTH_PROJECT = Number(process.env.GROWTH_PROJECT ?? 50);
const GROWTH_STEPS = (process.env.GROWTH_STEPS ?? '10,20')
  .split(',')
  .map(Number)
  .filter(n => n > 1)
  .sort((a, b) => a - b)
  .filter((n, i, all) => i === 0 || n > all[i - 1]);

/**
 * `hub.growth.slope`: per 10 sessions between the two largest measured
 * points, projected to GROWTH_PROJECT sessions; checked against the
 * `hub.growth` budget, a miss sets the exit code.
 * @param {Array<{ sessions: number, hubJsonBytes: number | null, msPerDelivery: number | null }>} points
 */
const slopeRow = async points => {
  const fresh = points[0];
  const [a, b] = points.slice(-2);
  const span = b.sessions - a.sessions;
  /**
   * @param {number | null} ya
   * @param {number | null} yb
   */
  const line = (ya, yb) => {
    if (ya === null || yb === null || span <= 0) return null;
    const per10 = ((yb - ya) * 10) / span;
    return {
      per10Sessions: round1(per10),
      projected: round1(yb + (per10 * (GROWTH_PROJECT - b.sessions)) / 10),
    };
  };
  const bytes = line(a.hubJsonBytes, b.hubJsonBytes);
  const ms = line(a.msPerDelivery, b.msPerDelivery);
  const ratio =
    ms && fresh.msPerDelivery
      ? +(ms.projected / fresh.msPerDelivery).toFixed(3)
      : null;
  const exceeded = [
    ...(bytes && bytes.projected > 2_000_000
      ? [`projected bytes: ${bytes.projected} > 2_000_000`]
      : []),
    ...(ratio !== null && ratio > 1.25
      ? [`projected msPerDelivery: ${ratio} x fresh > 1.25`]
      : []),
  ];
  if (exceeded.length) process.exitCode = 1;
  const { commit, workerSha256 } = await runIdentity();
  emit({
    metric: 'hub.growth.slope',
    unit: 'bytes',
    value: bytes?.projected ?? null,
    at: GROWTH_PROJECT,
    basis: `slope from ${a.sessions} and ${b.sessions} sessions`,
    bytes,
    msPerDelivery: ms,
    msPerDeliveryVsFresh: ratio,
    projected: true,
    budget: { bytes: 2_000_000, msPerDeliveryVsFresh: 1.25 },
    pass: exceeded.length === 0,
    ...(exceeded.length ? { exceeded } : {}),
    commit,
    workerSha256,
    crankBudget,
    loadAvg: loadAvg(),
  });
};

await runPerf('hub', async ({ root }) => {
  const template = await sliceTemplate();
  const run = await openSlice(template, root);
  try {
    const session = await run.slice.createSession(run.made.backend, 'grow');
    const { sub, turn } = await run.open(session);
    for (let i = 0; i < 3; i += 1) await turn();
    const points = [await growthWindow(run, turn, 'fresh', 1)];
    let made = 1;
    let importMs = 0;
    for (const target of GROWTH_STEPS) {
      const count = target - made;
      const file = path.join(
        path.dirname(root),
        `${path.basename(root)}-hub-sessions-${target}.jsonl`,
      );
      await writeSyntheticExport(
        file,
        Array.from({ length: count }, (_, i) => ({
          title: `g${made + i}`,
          turns: 1,
          backendLabel: run.label,
          shape: 'plain',
        })),
      );
      const result = await importState({
        client: run.served.client,
        file,
        backends: [run.made.backend],
      });
      rmSync(file, { force: true });
      made += result.sessions.length;
      importMs += result.ms;
      const { commit, workerSha256 } = await runIdentity();
      emit({
        metric: 'hub.import',
        unit: 'ms',
        value: round1(result.ms),
        sessions: result.sessions.length,
        turns: result.turns,
        at: `to ${target} sessions`,
        sessionsPerSecond: round1((result.sessions.length * 1000) / result.ms),
        built: 'importState (one plain turn per session)',
        pass: null,
        commit,
        workerSha256,
        crankBudget,
        loadAvg: loadAvg(),
      });
      // The imported sessions' sealing and GC settle before the window.
      await delay(2000);
      points.push(
        await growthWindow(run, turn, `at ${target} sessions`, target, {
          built: 'importState (one plain turn per session)',
        }),
      );
    }
    await growthRow(points, {
      part: 'sessions',
      sessions: made,
      built: 'importState (one plain turn per session)',
      importMs: round1(importMs),
    });
    if (points.length >= 3) await slopeRow(points);
    await sub.stop();
  } finally {
    await run.served.cleanup();
  }
});
