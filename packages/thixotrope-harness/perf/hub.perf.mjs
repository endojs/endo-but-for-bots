// @ts-check
/**
 * Perf check "hub", the GC burst (core candidates C-20 and C-2; journal
 * J-9127, J-9195): what the supervisor's OCapN hub costs per incoming GC
 * frame. The growth parts are `perf/hub.growth.perf.mjs` (a long session)
 * and `perf/hub.sessions.perf.mjs` (many sessions); shared code is
 * `perf/_hub.mjs`.
 *
 *   cd packages/thixotrope-harness && node perf/hub.perf.mjs
 *
 * One served copy of the m1a template, idle sleep 1 h: one session of the
 * real program on the scripted backend with a Live subscriber in this
 * process, 3 warm-up turns, then one-chunk turns back to back for
 * HUB_WINDOW_MS (default 60 s; it was HUB_TURNS = 150 turns), as
 * `gc.perf.mjs` runs them. Rows:
 * - `hub.gcBurst`: host time per incoming GC frame (`value`), split into
 *   persist (and its serialization) and send (journal append) time per
 *   frame, persists and sends per frame, frames per delivery (batching),
 *   the same per-frame numbers for all other inbound frames, and the turns
 *   with the most GC frames with their hub time and start latency; `window`
 *   and `samples` (turns). Recorded; it decides C-20.
 * - `hub.gcBurst.turnStart`: turn start latency of the same turns (budget
 *   median 350 ms as `turn.start`; p99 recorded, target 1 s).
 * About 2 minutes.
 */
import { performance } from 'node:perf_hooks';

import {
  crankBudget,
  emit,
  hubJsonBytes,
  loadAvg,
  runIdentity,
  runPerf,
  stats,
} from './_harness.mjs';
import { hubDiskBytes, openSlice, per, perFrame, sum } from './_hub.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

const { round1, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');

const HUB_WINDOW_MS = windowMs('HUB_WINDOW_MS', 60_000);

await runPerf('hub', async ({ root }) => {
  const template = await sliceTemplate();
  const run = await openSlice(template, root);
  try {
    const session = await run.slice.createSession(run.made.backend, 'hub');
    const { sub, turn } = await run.open(session);
    for (let i = 0; i < 3; i += 1) await turn();
    const t0 = performance.now();
    const w = await runWindow(async () => turn(), { ms: HUB_WINDOW_MS });
    const turns = w.results;
    const n = turns.length;
    const wallMs = round1(performance.now() - t0);
    const requestAt = new Map(
      run
        .log()
        .filter(l => l.kind === 'request' && l.round === 0)
        .map(l => [l.turnId, l.at]),
    );
    const startMs = turns.map(t => Number(requestAt.get(t.turnId)) - t.at);
    if (startMs.some(v => !Number.isFinite(v)))
      throw Error('a turn has no paired request line');
    const gc = sum(turns.map(t => t.hub.gcOnly));
    const other = sum(turns.map(t => t.hub.other));
    const outside = sum(turns.map(t => t.hub.outside));
    const { commit, workerSha256 } = await runIdentity();
    emit({
      metric: 'hub.gcBurst',
      unit: 'ms per incoming GC frame',
      value: per(gc.ms, gc.frames),
      turns: n,
      ...windowFields(w),
      gcFramesPerTurn: per(gc.frames, n),
      gc: perFrame(gc),
      other: perFrame(other),
      outside: {
        persists: outside.persists,
        persistMs: round1(outside.persistMs),
        sends: outside.sends,
        sendMs: round1(outside.sendMs),
      },
      largestBursts: turns
        .map((t, k) => ({
          turnId: t.turnId,
          gcFrames: t.hub.gcOnly.frames,
          gcDeliveries: t.hub.gcOnly.deliveries,
          gcMs: round1(t.hub.gcOnly.ms),
          persistMs: round1(t.hub.gcOnly.persistMs),
          sendMs: round1(t.hub.gcOnly.sendMs),
          startMs: startMs[k],
        }))
        .sort((a, b) => b.gcFrames - a.gcFrames)
        .slice(0, 5),
      hubJsonBytes: await hubJsonBytes(run.served.root),
      hubDisk: await hubDiskBytes(run.served.root),
      wallMs,
      clock: 'supervisor monotonic clock, synchronous hub work only',
      pass: null,
      commit,
      workerSha256,
      crankBudget,
      loadAvg: loadAvg(),
    });
    await stats('hub.gcBurst.turnStart', startMs, {
      budget: { median: 350 },
      extra: {
        from: 'Composer stamp (adapter clock)',
        to: 'request log line',
        turns: n,
        ...windowFields(w),
        p99Target: 1000,
      },
    });
    await sub.stop();
  } finally {
    await run.served.cleanup();
  }
});
