// @ts-check
/**
 * Perf check "throughput" (milestones.md M2 perf rows `restart.serving`
 * and `throughput`; W2.9), from the m1a state template served with
 * idleSleepMs 2,000:
 *
 * 1. Setup: THROUGHPUT_SESSIONS (50) sessions of THROUGHPUT_TURNS (300)
 *    synthetic turns each, imported with `importState` (shape plain by
 *    default: 4 records a turn; `THROUGHPUT_SHAPE=tool` for 8), bound to a
 *    scripted backend with a one-round reply. `throughput.import` reports
 *    the import.
 * 2. `restart.serving` (M2 row; budget 15 s; gate: 0 idle vats woken): with
 *    every session vat asleep and checkpointed, SIGKILL the supervisor and
 *    serve again; serving time, woken session vats (worker rows' `wakes`,
 *    else a moved delivery frontier) and crashes. RESTART_N runs (3).
 * 3. `throughput`: THROUGHPUT_BUSY (20) of the sessions each run turns back
 *    to back (`startTurn`, then `whenFinished`) for THROUGHPUT_MS (60 s);
 *    deliveries per second (the engine's delivery count over the stretch,
 *    every vat), turns per second, and the per-delivery worker time.
 *    Recorded; the milestone asks for a journal entry when under 50/s.
 *
 *   cd packages/thixotrope-harness && node perf/throughput.perf.mjs
 *
 * About 30 minutes with the defaults (most of it the import).
 */
/* eslint-disable no-await-in-loop -- phases run in order */
import { rmSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  crankBudget,
  delta,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { killStrays, startFromTemplate } =
  await import('../test/template/index.js');
const { makeSlice, round1, sliceTemplate, untilAsleep } =
  await import('../test/integration/_m1a-slice.js');
const { writeSyntheticExport } =
  await import('../test/integration/_m2-lifecycle.js');
const { importState } = await import('../scripts/export.mjs');

const SESSIONS = Number(process.env.THROUGHPUT_SESSIONS ?? 50);
const TURNS = Number(process.env.THROUGHPUT_TURNS ?? 300);
const BUSY = Number(process.env.THROUGHPUT_BUSY ?? 20);
const STRETCH_MS = Number(process.env.THROUGHPUT_MS ?? 60_000);
const RESTART_N = Number(process.env.RESTART_N ?? 3);
const SHAPE = process.env.THROUGHPUT_SHAPE === 'tool' ? 'tool' : 'plain';

const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
/** One round, a short reply (every turn). */
const script = harden({
  turns: [{ rounds: [{ chunks: [{ text: 'a short reply' }], usage }] }],
});

const identity = async () => ({
  ...(await runIdentity()),
  crankBudget,
  loadAvg: loadAvg(),
});

await runPerf('throughput', async ({ root }) => {
  const template = await sliceTemplate();
  const served = await startFromTemplate(template, {
    root,
    maxDeliveryAttempts: 5,
  });
  try {
    const slice = await makeSlice(served);
    const made = await slice.makeBackend(script, { label: 'Scripted' });

    // ---- 1. setup by import
    const file = path.join(path.dirname(root), `${path.basename(root)}.jsonl`);
    const written = await writeSyntheticExport(
      file,
      Array.from({ length: SESSIONS }, (_, i) => ({
        title: `busy ${i + 1}`,
        turns: TURNS,
        backendLabel: 'Scripted',
        shape: SHAPE,
      })),
    );
    const result = await importState({
      client: served.client,
      file,
      backends: [made.backend],
    });
    rmSync(file, { force: true });
    emit({
      metric: 'throughput.import',
      sessions: result.sessions.length,
      turns: result.turns,
      records: result.records,
      fileBytes: written.bytes,
      ms: Math.round(result.ms),
      turnsPerSecond: round1((result.turns * 1000) / result.ms),
      shape: SHAPE,
      ...(await identity()),
    });
    const keys = [];
    for (const session of result.sessions)
      keys.push((await E(session).getInfo()).key);

    // ---- 2. restart.serving
    const isSession = (/** @type {any} */ w) =>
      /^(spare session \d+|session s\d+)$/.test(w.debugLabel ?? '');
    /** @type {number[]} */
    const servedRuns = [];
    for (let run = 1; run <= RESTART_N; run += 1) {
      await untilAsleep(slice.workers, isSession, 20 * 60_000);
      const before = new Map(
        (await slice.workers()).filter(isSession).map(w => [w.debugLabel, w]),
      );
      await served.kill();
      await killStrays(served.root);
      const { servedMs } = await served.restart();
      const after = (await slice.workers()).filter(isSession);
      const counted = after.some(w => w.wakes !== undefined);
      const grew = after.filter(
        w =>
          Number(w.journalLength) >
          Number(before.get(w.debugLabel)?.journalLength ?? 0),
      );
      const woken = (
        counted ? after.filter(w => Number(w.wakes) > 0) : grew
      ).map(w => w.debugLabel);
      const crashes = served.crashLog?.() ?? [];
      servedRuns.push(servedMs);
      await single('restart.serving.m2.run', servedMs, {
        budget: { value: 15_000 },
        extra: {
          run,
          sessions: after.length,
          turnsEach: TURNS,
          woken,
          wokenBy: counted ? 'wakes' : 'journal grew',
          gate: woken.length === 0,
          crashes: crashes.length,
        },
      });
      if (woken.length > 0) process.exitCode = 1;
      await slice.refresh();
    }
    servedRuns.sort((a, b) => a - b);
    await single(
      'restart.serving.m2',
      servedRuns[Math.floor(servedRuns.length / 2)],
      {
        budget: { value: 15_000 },
        extra: {
          runs: servedRuns.map(round1),
          sessions: SESSIONS,
          turnsEach: TURNS,
        },
      },
    );

    // ---- 3. throughput at saturation
    const busy = [];
    for (const key of keys.slice(0, BUSY))
      busy.push(await E(slice.factory).findSession(key));
    // Wake every busy session with one turn first (the wake is not
    // throughput).
    await Promise.all(
      busy.map(async session => {
        const turn = await E(session).startTurn(
          harden({ text: 'wake' }),
          Date.now(),
        );
        await E(turn).whenFinished();
      }),
    );
    const status0 = await served.client.call('status');
    const t0 = performance.now();
    let turns = 0;
    let failed = 0;
    /** @type {number[]} */
    const turnMs = [];
    await Promise.all(
      busy.map(async (session, i) => {
        let k = 0;
        while (performance.now() - t0 < STRETCH_MS) {
          k += 1;
          const a = performance.now();
          const turn = await E(session).startTurn(
            harden({ text: `busy ${i} ${k}` }),
            Date.now(),
          );
          const status = await E(turn).whenFinished();
          turnMs.push(performance.now() - a);
          if (status.state === 'completed') turns += 1;
          else failed += 1;
        }
      }),
    );
    const seconds = (performance.now() - t0) / 1000;
    const status1 = await served.client.call('status');
    const engine = delta(status0.timings ?? {}, status1.timings ?? {});
    const deliveries = engine.delivery ?? { count: 0, ms: 0 };
    turnMs.sort((a, b) => a - b);
    const perSecond = round1(deliveries.count / seconds);
    emit({
      metric: 'throughput',
      unit: 'deliveries/s',
      value: perSecond,
      sessions: BUSY,
      seconds: round1(seconds),
      deliveries: deliveries.count,
      perDeliveryMs: deliveries.count
        ? round1(deliveries.ms / deliveries.count)
        : null,
      turnsPerSecond: round1(turns / seconds),
      turns,
      failed,
      turnMsMedian: round1(turnMs[Math.floor(turnMs.length / 2)] ?? 0),
      turnMsP95: round1(turnMs[Math.floor(turnMs.length * 0.95)] ?? 0),
      journalIfUnder: 50,
      engine,
      ...(await identity()),
    });
  } finally {
    await served.cleanup();
  }
});
