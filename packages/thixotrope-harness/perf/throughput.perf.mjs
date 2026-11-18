// @ts-check
/**
 * Perf check "throughput" (milestones.md M2 perf rows `restart.serving`
 * and `throughput`; W2.9; fixed windows M2-P1), from a cached template of
 * THROUGHPUT_SESSIONS (50) sessions of THROUGHPUT_TURNS (300) synthetic
 * turns each (shape plain: 4 records a turn; `THROUGHPUT_SHAPE=tool` for
 * 8), imported with `importState` and bound to scripted backends with a
 * one-round reply, served with idleSleepMs 2,000.
 *
 * 1. Setup: a copy of the template. Importing the 15,000 turns took 26
 *    minutes (J-9412), so the template is built as a chain of boxed steps of
 *    THROUGHPUT_BATCH (10) sessions, before and outside this check:
 *    `node perf/_long-template.mjs throughput`. `throughput.template` names
 *    the template and its import figures.
 * 2. `restart.serving` (M2 row; budget 15 s; gate: 0 idle vats woken): with
 *    every session vat asleep and checkpointed, SIGKILL the supervisor and
 *    serve again; serving time, woken session vats (worker rows' `wakes`,
 *    else a moved delivery frontier) and crashes. RESTART_N runs (3).
 * 3. `throughput`: THROUGHPUT_BUSY (20) of the sessions each run turns back
 *    to back (`startTurn`, then `whenFinished`) for THROUGHPUT_MS (60 s);
 *    deliveries per second (the engine's delivery count over the window,
 *    every vat), turns per second, the per-delivery worker time, and the
 *    per-turn median and p99 with the samples the window held. Recorded; the
 *    milestone asks for a journal entry when under 50/s.
 *
 *   cd packages/thixotrope-harness && node perf/throughput.perf.mjs
 *
 * About 5 minutes once the template exists.
 */
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
import { windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { killStrays, startFromTemplate } =
  await import('../test/template/index.js');
const { makeSlice, round1, sliceTemplate, untilAsleep } =
  await import('../test/integration/_m1a-slice.js');
const { specsFor, useTemplate } = await import('./_long-template.mjs');

const BUSY = Number(process.env.THROUGHPUT_BUSY ?? 20);
const STRETCH_MS = windowMs('THROUGHPUT_MS', 60_000);
const RESTART_N = Number(process.env.RESTART_N ?? 3);
const spec = /** @type {import('./_long-template.mjs').BusySpec} */ (
  specsFor('throughput').at(-1)
);
const SESSIONS = spec.sessions;
const TURNS = spec.turns;

const identity = async () => ({
  ...(await runIdentity()),
  crankBudget,
  loadAvg: loadAvg(),
});

await runPerf('throughput', async ({ root }) => {
  const used = await useTemplate(spec);
  /** @type {any} */
  let served;
  try {
    const base = await sliceTemplate();
    served = await startFromTemplate(
      /** @type {any} */ ({ dir: used.dir, crankBudget: base.crankBudget }),
      { root, maxDeliveryAttempts: 5 },
    );
    const slice = await makeSlice(served);

    // ---- 1. setup: the template
    emit({
      metric: 'throughput.template',
      key: used.key,
      sessions: used.sessionKeys.length,
      turnsEach: TURNS,
      shape: spec.shape,
      batch: spec.batch,
      lastStepImport: used.import,
      copyMs: served.timings.copyMs,
      servedMs: served.timings.servedMs,
      builtAt: used.builtAt,
      builtBy: used.commit,
      ...(await identity()),
    });
    const keys = used.sessionKeys;

    // ---- 2. restart.serving
    const isSession = (/** @type {any} */ w) =>
      /^(spare session \d+|session s\d+)$/.test(w.debugLabel ?? '');
    /** @type {number[]} */
    const servedRuns = [];
    for (let run = 1; run <= RESTART_N; run += 1) {
      await untilAsleep(slice.workers, isSession, 3 * 60_000);
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
    const samples = turnMs.length;
    const status1 = await served.client.call('status');
    const engine = delta(status0.timings ?? {}, status1.timings ?? {});
    const deliveries = engine.delivery ?? { count: 0, ms: 0 };
    turnMs.sort((a, b) => a - b);
    const q = (/** @type {number} */ p) =>
      round1(turnMs[Math.min(samples - 1, Math.floor(p * samples))] ?? 0);
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
      turnMsMedian: q(0.5),
      turnMsP95: q(0.95),
      turnMsP99: q(0.99),
      window: STRETCH_MS,
      windowMs: round1(seconds * 1000),
      samples,
      journalIfUnder: 50,
      engine,
      ...(await identity()),
    });
  } finally {
    await served?.cleanup();
    await used.release();
  }
});
