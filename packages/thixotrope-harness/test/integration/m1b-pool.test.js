// @ts-check
/**
 * The spare pool in a real daemon (M1b W1b.5; milestones.md M1b, the
 * W1b.5 row; `designs/m1b-interfaces.md` 6.6 and 10.1): createSession with
 * and without the pool, the refill after takes, a pooled session's first
 * turn, and what the pool costs at rest (disk per sleeping spare, memory
 * while refilling). Every measurement is one JSON line (`emit`).
 *
 * State: an m1b-pool template (`m1bTemplateOptions`: the real session
 * program, the stand-in exec program `guest/factory/standin-exec.js`, the
 * factory's default pool of 2 session spares and 1 exec spare), provisioned
 * with its spares made and asleep.
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-pool -- \
 *     corepack yarn test test/integration/m1b-pool.test.js
 *
 * POOL_CREATE_N (default 3) creations with the pool, POOL_COLD_N (2)
 * without.
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { statSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import {
  crankBudget,
  du,
  emit,
  loadAvg,
  runIdentity,
  stats,
  workerRss,
} from '../../perf/_harness.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, untilAsleep, waitFor } from './_m1a-slice.js';
import { poolTemplate } from './_m1b-pool.js';

takeIntegrationLock(test, 'm1b pool test');

const run = integrationEnabled ? test.serial : test.skip;

const CREATE_N = Number(process.env.POOL_CREATE_N ?? 3);
const COLD_N = Number(process.env.POOL_COLD_N ?? 2);

/** @param {any} w */
const isSpare = w => /^spare (session|exec) \d+$/.test(w.debugLabel ?? '');
/** @param {any} w */
const isSessionSpare = w => /^spare session \d+$/.test(w.debugLabel ?? '');

/**
 * Sample the state's worker RSS every `everyMs` until `stop()`.
 * @param {string} root
 * @param {number} [everyMs]
 */
const sampleRss = (root, everyMs = 250) => {
  /** @type {{ workers?: number, rssKiB?: number }[]} */
  const samples = [];
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      samples.push(workerRss(root));
      // eslint-disable-next-line no-await-in-loop
      await delay(everyMs);
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      await done;
      const rss = samples.map(s => s.rssKiB ?? 0);
      const workers = samples.map(s => s.workers ?? 0);
      return {
        samples: samples.length,
        maxRssKiB: Math.max(0, ...rss),
        maxWorkers: Math.max(0, ...workers),
      };
    },
  };
};

run(
  'create with and without the pool, refill, a pooled first turn, costs at rest',
  async t => {
    t.timeout(5 * 60_000);
    const template = await poolTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    const { harness } = slice;
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };

    // ---- the template's pool: full and asleep
    const status0 = await E(harness).status();
    t.deepEqual(status0.pool, {
      spareSessions: 2,
      spareExec: 1,
      refilling: 0,
      target: { spareSessions: 2, spareExec: 1 },
    });
    const spareRows0 = (await slice.workers()).filter(isSpare);
    t.is(spareRows0.length, 3);
    emit({
      metric: 'pool.rest.start',
      spares: spareRows0.map(w => ({
        label: w.debugLabel,
        awake: w.awake,
        wakes: w.wakes,
      })),
      servedMs: state.timings?.servedMs,
      ...identity,
    });

    // ---- disk per sleeping spare and memory while refilling: 4 more session spares
    await untilAsleep(slice.workers, isSpare);
    const kibBefore = du(state.root);
    const sampler = sampleRss(state.root);
    const tFill = performance.now();
    await E(harness).configure(harden({ spareSessions: 6 }));
    const filled = await E(harness).whenSettled();
    const fillMs = performance.now() - tFill;
    const rss = await sampler.stop();
    t.is(filled.spareSessions, 6);
    await untilAsleep(slice.workers, isSpare);
    const kibAfter = du(state.root);
    // A sleeping spare's disk is its snapshot (heaps/snapshots/<ref>.sqlite;
    // its journal is cut to it). The whole-state du delta is kept for
    // reference: it depends on when snapshots were written (J-0353).
    const snapshotKiB = (await slice.workers()).filter(isSpare).map(w => {
      try {
        const file = path.join(
          state.root,
          'heaps',
          'snapshots',
          `${w.snapshot?.ref}.sqlite`,
        );
        return round1(statSync(file).size / 1024);
      } catch {
        return NaN;
      }
    });
    const known = snapshotKiB
      .filter(n => !Number.isNaN(n))
      .sort((a, b) => a - b);
    emit({
      metric: 'pool.rest.diskPerSpare',
      unit: 'KiB',
      value: known[Math.floor(known.length / 2)] ?? NaN,
      snapshotKiB,
      stateKiBDeltaPer4: round1((kibAfter - kibBefore) / 4),
      ...identity,
    });
    emit({
      metric: 'pool.fill4',
      unit: 'ms',
      value: round1(fillMs),
      spares: 4,
      lanes: 4,
      perSpareMs: round1(fillMs / 4),
      whileRefilling: rss,
      ...identity,
    });
    await E(harness).configure(harden({ spareSessions: 2 }));
    t.is((await E(harness).status()).pool.spareSessions, 2);

    // ---- session.create with the pool (a sleeping, checkpointed spare each time)
    const made = await slice.makeBackend(harden(sliceScript));
    /** @type {number[]} */
    const pooledMs = [];
    /** @type {any[]} */
    const pooled = [];
    for (let i = 0; i < CREATE_N; i += 1) {
      await E(harness).whenSettled();
      await untilAsleep(slice.workers, isSessionSpare);
      const takenBefore = (await slice.workers()).filter(isSessionSpare).length;
      const t0 = performance.now();
      const session = await slice.createSession(made.backend, `pooled ${i}`);
      pooledMs.push(performance.now() - t0);
      pooled.push(session);
      t.true(takenBefore >= 1);
    }
    await stats('session.create.pool', pooledMs, {
      budget: { median: 750 },
      extra: { runs: CREATE_N, spareAsleep: true },
    });

    // ---- a pooled session's first turn runs on the ports its make() opened
    const first = pooled[0];
    const live = await slice.subscribe(first);
    await slice.submit(first, inputs.hi);
    await live.until(e => e.type === 'end', 30_000);
    await live.stop();
    const requests = made
      .log()
      .filter(l => l.kind === 'request' || l.kind === 'open');
    emit({
      metric: 'm1b.pool.firstTurn',
      kinds: requests.map(l => l.kind),
    });
    t.is(made.log().filter(l => l.kind === 'request').length, 1);

    // ---- pool.refill: 2 spares after 2 takes, 4 lanes
    await E(harness).whenSettled();
    await untilAsleep(slice.workers, isSessionSpare);
    await slice.createSession(made.backend, 'take a');
    await slice.createSession(made.backend, 'take b');
    const tRefill = performance.now();
    const refilled = await E(harness).whenSettled();
    const refillMs = performance.now() - tRefill;
    t.is(refilled.spareSessions, 2);
    emit({
      metric: 'pool.refill',
      unit: 'ms',
      value: round1(refillMs),
      spares: 2,
      lanes: 4,
      note: 'from the second take answering to whenSettled; the first refill lane started at the first take',
      ...identity,
    });

    // ---- session.create without the pool (cold, as M1a)
    await E(harness).configure(harden({ spareSessions: 0 }));
    await E(harness).whenSettled();
    /** @type {number[]} */
    const coldMs = [];
    for (let i = 0; i < COLD_N; i += 1) {
      const t0 = performance.now();
      await slice.createSession(made.backend, `cold ${i}`);
      coldMs.push(performance.now() - t0);
    }
    await stats('session.create.cold', coldMs, {
      budget: { median: 6000 },
      extra: { runs: COLD_N, depends: 'C-5 (staging cost)' },
    });
    const cold = (await slice.workers()).filter(w =>
      /^session s\d+$/.test(w.debugLabel ?? ''),
    );
    t.is(cold.length, COLD_N, 'cold creations are labelled by their key');

    const page = await E(slice.factory).listSessions();
    const titles = page.rows.map((/** @type {any} */ r) => r.title);
    t.is(new Set(titles).size, titles.length, 'every session listed once');
    t.is(page.rows.length, CREATE_N + 2 + COLD_N);
    await waitFor(
      async () => (await E(harness).status()).pool.refilling === 0,
      10_000,
      'no refill',
    );
  },
);
