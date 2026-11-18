// @ts-check
/**
 * Perf check "pool" (milestones.md M1b perf table, W1b.6), on the m1b
 * template (real session and exec programs; the factory's default pool of 2
 * session spares and 1 exec spare, made and asleep), idle sleep 2 s:
 *
 * - `session.create.pool`: `createSession` taking a sleeping, checkpointed
 *   session spare (the pool settled first). Budget median 750 ms.
 * - `session.create.poolAwake`: the same with the spare awake (taken at
 *   once after the refill that made it); recorded (no budget), to separate
 *   the wake from the hops.
 * - `session.create.cold`: `createSession` with the pool emptied
 *   (`spareSessions: 0`). Budget median 6 s.
 * - `pool.refill`: 2 session spares after 2 takes, 4 lanes, from the second
 *   take answering to `whenSettled()`. Recorded (M0: 6.4 s per spare).
 * - `pool.firstTurn`: a pooled session's first turn, submit to `end`
 *   (recorded; acceptance 12 checks it runs once).
 *
 *   cd packages/thixotrope-harness && node perf/pool.perf.mjs
 *
 * POOL_CREATE_WINDOW_MS (default 45 s of wall, the settle and sleep waits
 * between takes included, at least 3 takes; it was POOL_CREATE_N = 8),
 * POOL_COLD_WINDOW_MS (default 20 s, at least 3; it was POOL_COLD_N = 3);
 * POOL_AWAKE_N (4) and POOL_REFILL_N (3) stay counts: each sample is a
 * scenario (a spare caught awake, a refill of 2 after 2 takes).
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import { performance } from 'node:perf_hooks';

import { runPerf, stats, workerRss } from './_harness.mjs';
import { runWindow, windowFields, windowMs } from './_window.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { makeSlice, untilAsleep } =
  await import('../test/integration/_m1a-slice.js');
const { execTemplate } = await import('../test/integration/_m1b-exec.js');
const { runTurn } = await import('../test/integration/_m1b.js');
const { inputs, sliceScript } =
  await import('../test/fixtures/scripts/m1a-slice.js');

/** Takes of a sleeping spare for this window (it was POOL_CREATE_N = 8). */
const CREATE_WINDOW_MS = windowMs('POOL_CREATE_WINDOW_MS', 45_000);
const AWAKE_N = Number(process.env.POOL_AWAKE_N ?? 4);
/** Cold creates for this window (it was POOL_COLD_N = 3). */
const COLD_WINDOW_MS = windowMs('POOL_COLD_WINDOW_MS', 20_000);
const REFILL_N = Number(process.env.POOL_REFILL_N ?? 3);

/** @param {any} w */
const isSessionSpare = w => /^spare session \d+$/.test(w.debugLabel ?? '');

await runPerf('pool', async ({ provision }) => {
  const template = await execTemplate();
  const state = await provision({ template, idleSleepMs: 2000 });
  const slice = await makeSlice(state);
  const { harness } = slice;
  const made = await slice.makeBackend(harden(sliceScript));

  // ---- session.create.pool (sleeping spare)
  /** @type {number[]} */
  const pooledMs = [];
  /** @type {any[]} */
  const pooled = [];
  const before = await state.counters();
  const pooledWindow = await runWindow(
    async i => {
      await E(harness).whenSettled();
      await untilAsleep(slice.workers, isSessionSpare);
      const t0 = performance.now();
      pooled.push(await slice.createSession(made.backend, `pooled ${i}`));
      pooledMs.push(performance.now() - t0);
    },
    { ms: CREATE_WINDOW_MS, min: 3 },
  );
  const after = await state.counters();
  await stats('session.create.pool', pooledMs, {
    budget: { median: 750 },
    extra: {
      spare: 'asleep and checkpointed',
      note: 'deliveries include each take`s refill (createWorker, staging, evaluation)',
      ...windowFields(pooledWindow),
      windowIncludes: 'the settle and sleep waits between takes',
    },
    before,
    after,
    ops: pooledMs.length,
  });

  // ---- session.create.poolAwake (a spare just made, not yet asleep)
  /** @type {number[]} */
  const awakeMs = [];
  for (let i = 0; i < AWAKE_N; i += 1) {
    await E(harness).whenSettled();
    const rows = (await slice.workers()).filter(isSessionSpare);
    const t0 = performance.now();
    await slice.createSession(made.backend, `awake ${i}`);
    awakeMs.push(performance.now() - t0);
    if (!rows.some(w => w.awake)) awakeMs.pop();
  }
  if (awakeMs.length)
    await stats('session.create.poolAwake', awakeMs, {
      extra: { spare: 'awake (just refilled)', attempted: AWAKE_N },
    });

  // ---- pool.firstTurn: a pooled session's first turn
  const live = await slice.subscribe(pooled[0]);
  const t1 = performance.now();
  const first = await runTurn(slice, pooled[0], live, inputs.hi);
  const firstMs = performance.now() - t1;
  await live.stop();
  await stats('pool.firstTurn', [firstMs], {
    extra: {
      status: first.end.status,
      providerRequests: made.log().filter(l => l.kind === 'request').length,
    },
  });

  // ---- pool.refill: 2 spares after 2 takes
  /** @type {number[]} */
  const refillMs = [];
  /** @type {any[]} */
  const rss = [];
  for (let i = 0; i < REFILL_N; i += 1) {
    await E(harness).whenSettled();
    await untilAsleep(slice.workers, isSessionSpare);
    await slice.createSession(made.backend, `take a${i}`);
    await slice.createSession(made.backend, `take b${i}`);
    const t0 = performance.now();
    let peak = 0;
    const sampling = (async () => {
      for (;;) {
        const status = await E(harness).status();
        const r = workerRss(state.root).rssKiB ?? 0;
        if (r > peak) peak = r;
        if (status.pool.refilling === 0) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    })();
    const settled = await E(harness).whenSettled();
    refillMs.push(performance.now() - t0);
    await sampling;
    rss.push({ peakRssKiB: peak, spareSessions: settled.spareSessions });
  }
  await stats('pool.refill', refillMs, {
    extra: {
      spares: 2,
      lanes: 4,
      note: 'from the second take answering to whenSettled (the first lane started at the first take)',
      runs: rss,
      recorded: 'M0: 6.4 s per spare, 50 in 108.7 s',
    },
  });

  // ---- session.create.cold
  await E(harness).configure(harden({ spareSessions: 0 }));
  await E(harness).whenSettled();
  /** @type {number[]} */
  const coldMs = [];
  const coldWindow = await runWindow(
    async i => {
      const t0 = performance.now();
      await slice.createSession(made.backend, `cold ${i}`);
      coldMs.push(performance.now() - t0);
    },
    { ms: COLD_WINDOW_MS, min: 3 },
  );
  await stats('session.create.cold', coldMs, {
    budget: { median: 6000 },
    extra: { depends: 'C-5 (staging cost)', ...windowFields(coldWindow) },
  });
});
