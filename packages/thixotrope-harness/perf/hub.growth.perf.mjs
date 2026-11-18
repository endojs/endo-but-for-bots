// @ts-check
/**
 * Perf check "hub", growth with a session's length (core candidates C-20
 * and C-2; `perf/_hub.mjs`): how the hub's persisted state and its cost per
 * delivery grow when one session holds GROWTH_TURNS (default 1,000) turns.
 *
 *   cd packages/thixotrope-harness && node perf/hub.growth.perf.mjs
 *
 * One served copy of the m1a template, idle sleep 1 h, the scripted backend:
 * 1. A fresh session with a subscriber, 3 warm-up turns, one GROWTH_WINDOW_MS
 *    (default 30 s; it was 30 turns) window: `hub.persist` at "fresh".
 * 2. A session of GROWTH_TURNS plain turns built by `importState` and bound
 *    to the same backend (it was grown by running 1,000 turns, 8-12
 *    minutes); `hub.size`: the hub state's size on disk every GROWTH_SAMPLE
 *    (default 100) imported turns, read while the import runs.
 * 3. That session settles its sealing backlog, then one window:
 *    `hub.persist` at "after GROWTH_TURNS turns".
 * - `hub.growth` over the two points (budget 2 MB; ms per delivery <= 1.25
 *   x fresh). The many-sessions points are `perf/hub.sessions.perf.mjs`.
 * About 4 minutes.
 */
import { rmSync } from 'node:fs';
import path from 'node:path';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
} from './_harness.mjs';
import { growthRow, growthWindow, hubDiskBytes, openSlice } from './_hub.mjs';

const { round1, sliceTemplate } =
  await import('../test/integration/_m1a-slice.js');
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { importState } = await import('../scripts/export.mjs');

const GROWTH_TURNS = Number(process.env.GROWTH_TURNS ?? 1000);
const GROWTH_SAMPLE = Number(process.env.GROWTH_SAMPLE ?? 100);

await runPerf('hub', async ({ root }) => {
  const template = await sliceTemplate();
  const run = await openSlice(template, root);
  try {
    const fresh = await run.slice.createSession(run.made.backend, 'grow');
    const first = await run.open(fresh);
    for (let i = 0; i < 3; i += 1) await first.turn();
    const points = [await growthWindow(run, first.turn, 'fresh', 1)];
    await first.sub.stop();

    // A session of GROWTH_TURNS turns, by import; the hub's size sampled.
    const file = path.join(
      path.dirname(root),
      `${path.basename(root)}-hub-${GROWTH_TURNS}.jsonl`,
    );
    await writeSyntheticExport(file, [
      {
        title: `hub ${GROWTH_TURNS}`,
        turns: GROWTH_TURNS,
        backendLabel: run.label,
        shape: 'plain',
      },
    ]);
    /** @type {Promise<void>[]} */
    const reads = [];
    /** @type {Array<{ turns: number, bytes: number | null, files: Record<string, number> | null }>} */
    const sizes = [];
    let nextSample = GROWTH_SAMPLE;
    const result = await importState({
      client: run.served.client,
      file,
      backends: [run.made.backend],
      onProgress: progress => {
        if (progress.turns < nextSample) return;
        nextSample = progress.turns + GROWTH_SAMPLE;
        const turns = progress.turns;
        reads.push(
          hubDiskBytes(run.served.root).then(disk => {
            sizes.push({
              turns,
              bytes: disk?.bytes ?? null,
              files: disk?.files ?? null,
            });
          }),
        );
      },
    });
    await Promise.all(reads);
    rmSync(file, { force: true });
    const [session] = result.sessions;
    const after = await hubDiskBytes(run.served.root);
    sizes.push({
      turns: result.turns,
      bytes: after?.bytes ?? null,
      files: after?.files ?? null,
    });
    const { commit, workerSha256 } = await runIdentity();
    emit({
      metric: 'hub.size',
      unit: 'bytes',
      value: Math.max(...sizes.map(p => p.bytes ?? 0)),
      every: GROWTH_SAMPLE,
      turns: GROWTH_TURNS,
      built: 'importState (plain turns)',
      importMs: round1(result.ms),
      importTurnsPerSecond: round1((result.turns * 1000) / result.ms),
      points: sizes.sort((a, b) => a.turns - b.turns),
      samples: sizes.length,
      pass: null,
      commit,
      workerSha256,
      crankBudget,
      loadAvg: loadAvg(),
    });
    const long = await run.open(session);
    const warmups = await long.settle(result.turns);
    points.push(
      await growthWindow(run, long.turn, `after ${GROWTH_TURNS} turns`, 2, {
        built: 'importState (plain turns)',
        warmups,
      }),
    );
    await long.sub.stop();
    await growthRow(points, {
      part: 'turns',
      turns: GROWTH_TURNS,
      built: 'importState (plain turns)',
      importMs: round1(result.ms),
    });
  } finally {
    await run.served.cleanup();
  }
});
