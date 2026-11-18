// @ts-check
/**
 * The spare pool across restarts (M1b W1b.5; milestones.md M1b acceptance
 * 12, the factory half; `designs/m1b-interfaces.md` 6.6):
 *
 * 1. A restart with the pool full of sleeping, checkpointed spares wakes
 *    none of them (each spare's worker row counts no wake since the start;
 *    `wakes`, J-9122), and the daemon start time with the pool full is
 *    recorded (`pool.rest.restart`).
 * 2. SIGKILL right after a take (`createSession` with the pool, the kill
 *    `POOL_KILL_DELAYS_MS` after the call is sent): after the restart the
 *    session is listed at most once, the creation is completed or rolled
 *    back (none pending), the pool refills to its target, and when the
 *    session is listed its first turn runs once (the fake provider gets
 *    one request for it).
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-pool -- \
 *     corepack yarn test test/integration/m1b-pool-restart.test.js
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
} from '../../perf/_harness.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, untilAsleep, waitFor } from './_m1a-slice.js';
import { poolTemplate } from './_m1b-pool.js';

takeIntegrationLock(test, 'm1b pool restart test');

const run = integrationEnabled ? test.serial : test.skip;

const delaysText = process.env.POOL_KILL_DELAYS_MS;
const KILL_DELAYS = delaysText
  ? delaysText.split(',').map(s => Number(s.trim()))
  : [0, 150];

/** @param {any} w */
const isSpare = w => /^spare (session|exec) \d+$/.test(w.debugLabel ?? '');

run('a restart with sleeping spares wakes none of them', async t => {
  t.timeout(4 * 60_000);
  const template = await poolTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  await E(slice.harness).whenSettled();
  await untilAsleep(slice.workers, isSpare);
  const before = (await slice.workers()).filter(isSpare);
  t.is(before.length, 3);
  /** @type {any[]} */
  const runs = [];
  for (const how of ['kill', 'kill']) {
    if (how === 'kill') await state.kill();
    const t0 = performance.now();
    const { servedMs } = await state.restart();
    const restartMs = round1(performance.now() - t0);
    await slice.refresh();
    const status = await E(slice.harness).status();
    const after = (await slice.workers()).filter(isSpare);
    const woken = after.filter(w => Number(w.wakes ?? 0) > 0);
    runs.push({
      how,
      servedMs,
      restartMs,
      spares: after.length,
      woken: woken.map(w => w.debugLabel),
      awake: after.filter(w => w.awake).map(w => w.debugLabel),
      pool: status.pool,
    });
    t.deepEqual(
      woken.map(w => w.debugLabel),
      [],
      'no spare was woken by the start',
    );
    t.is(status.pool.spareSessions, 2);
    t.is(status.pool.spareExec, 1);
    t.is(status.pool.refilling, 0);
  }
  emit({
    metric: 'pool.rest.restart',
    unit: 'ms',
    value: runs[runs.length - 1].servedMs,
    runs,
    ...(await runIdentity()),
    crankBudget,
    loadAvg: loadAvg(),
  });
});

for (const killDelayMs of KILL_DELAYS) {
  run(`SIGKILL right after a take [kill +${killDelayMs} ms]`, async t => {
    t.timeout(4 * 60_000);
    const template = await poolTemplate();
    const state = await startFromTemplate(template, { t });
    const slice = await makeSlice(state);
    await E(slice.harness).whenSettled();
    await untilAsleep(slice.workers, isSpare);
    const made = await slice.makeBackend(harden(sliceScript));
    const title = `taken ${killDelayMs}`;
    const creating = slice.createSession(made.backend, title);
    creating.catch(() => undefined);
    if (killDelayMs > 0) await delay(killDelayMs);
    await state.kill();
    const { servedMs } = await state.restart();
    t.log('served', round1(servedMs));
    await slice.refresh();
    const status = await E(slice.harness).whenSettled();
    t.log('settled', status);
    const page = await E(slice.factory).listSessions();
    /** @type {any[]} */
    const listed = page.rows.filter(
      (/** @type {any} */ r) => r.title === title,
    );
    const workers = await slice.workers();
    /** @type {Record<string, unknown>} */
    const seen = {
      killDelayMs,
      servedMs,
      listed: listed.length,
      state: listed[0]?.state,
      pool: status,
      spareWorkers: workers.filter(isSpare).map(w => ({
        label: w.debugLabel,
        retired: w.retired ?? w.state,
      })),
    };
    t.true(listed.length <= 1, 'listed at most once');
    t.deepEqual(
      { spareSessions: status.spareSessions, refilling: status.refilling },
      { spareSessions: 2, refilling: 0 },
      'the pool refilled; the taken spare was not put back',
    );
    if (listed.length === 1) {
      const session = listed[0].session;
      t.is(listed[0].state, 'ready');
      const live = await slice.subscribe(session);
      const receipt = await slice.submit(session, inputs.hi);
      t.log('submitted', receipt.state);
      await live.until(e => e.type === 'end', 30_000);
      await live.stop();
      await waitFor(
        () => made.log().some(l => l.kind === 'request'),
        10_000,
        'the provider request',
      );
      await delay(500);
      const requests = made.log().filter(l => l.kind === 'request');
      seen.requests = requests.length;
      t.is(requests.length, 1, 'the first turn ran once');
    }
    emit({ metric: 'm1b.pool.killAfterTake', ...seen, loadAvg: loadAvg() });
  });
}
