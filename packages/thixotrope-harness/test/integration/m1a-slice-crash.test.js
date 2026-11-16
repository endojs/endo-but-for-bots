// @ts-check
/**
 * Acceptance 10 of M1a (milestones.md, W1a.7): a session vat that crashes
 * on every attempt at restart. Session A has a turn in flight (so its row
 * is `working` and the factory's start listener probes it) and is awake and
 * unsnapshotted when the supervisor is SIGKILLed; at the restart every
 * worker process of A is killed as soon as it appears (the killer of
 * `perf/crash.perf.mjs`), with the crash bound 2 to keep the test short.
 * The daemon serves after A is given up; the factory and session B answer;
 * a call on A rejects with the retired text and does not hang;
 * `listSessions` shows A `lost`; no other vat was given up.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1a-slice -- \
 *     corepack yarn test test/integration/m1a-slice-crash.test.js
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

import { emit } from '../../perf/_harness.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import { integrationEnabled, takeIntegrationLock } from '../template/index.js';
import {
  copyWithBound,
  incarnationNeedle,
  makeSlice,
  round1,
  sliceTemplate,
  startKiller,
  unsnapshotted,
  untilAsleep,
  waitFor,
} from './_m1a-slice.js';

takeIntegrationLock(test, 'm1a slice crash test');

const run = integrationEnabled ? test.serial : test.skip;

const RETIRED = /the target session has been retired/;

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} ms
 */
const within = async (fn, ms) => {
  const t0 = performance.now();
  try {
    const value = await Promise.race([
      fn(),
      delay(ms).then(() => {
        throw Error(`no answer in ${ms} ms`);
      }),
    ]);
    return { ok: true, value, ms: round1(performance.now() - t0) };
  } catch (error) {
    return {
      ok: false,
      error: String(/** @type {Error} */ (error)?.message ?? error),
      ms: round1(performance.now() - t0),
    };
  }
};

run(
  '10: a session vat crashing at restart is given up and listed lost; the rest answers',
  async t => {
    t.timeout(4.5 * 60_000);
    const template = await sliceTemplate();
    const served = await copyWithBound(template);
    t.teardown(() => served.cleanup());
    await served.serve(2);
    const slice = await makeSlice(served);
    const { backend, log } = await slice.makeBackend(harden(sliceScript));
    const sessionA = await slice.createSession(backend, 'A');
    const sessionB = await slice.createSession(backend, 'B');
    // B ran a turn and sleeps, checkpointed.
    const b = await slice.submit(sessionB, inputs.hi);
    t.is((await E(b.turn).whenFinished()).state, 'completed');
    await untilAsleep(slice.workers, w => w.debugLabel === 'session s2');

    // A: a stalled turn after Dispatched, so its row is `working`; kill the
    // supervisor while A is awake with frames past its snapshot.
    const a = await slice.submit(sessionA, inputs.stall);
    const aTurnId = (await E(a.turn).getStatus()).turnId;
    await waitFor(
      () => log().some(l => l.kind === 'request' && l.turnId === aTurnId),
      30_000,
      'the provider request of A',
    );
    await waitFor(
      async () =>
        (await E(slice.factory).listSessions()).rows[0].activity === 'working',
      10_000,
      'A listed working',
    );
    const rowA = await slice.sessionWorker('s1');
    const atKill = {
      awake: rowA?.awake,
      journalLength: rowA?.journalLength,
      snapshotCut: rowA?.snapshot?.cut ?? null,
      unsnapshotted: unsnapshotted(rowA),
    };
    t.log('A at the kill', JSON.stringify(atKill));
    await served.kill();

    const t0 = performance.now();
    const killer = startKiller(
      incarnationNeedle(served.root, 'session s1'),
      t0,
    );
    let servedMs;
    try {
      servedMs = await served.serve(2, t0);
      await delay(1500);
    } finally {
      await killer.stop();
    }
    await slice.refresh();

    const rows = await slice.workers();
    const failed = rows.filter(w => w.failure);
    const a2 = await E(slice.factory).findSession('s1');
    const b2 = await E(slice.factory).findSession('s2');
    const callA = await within(() => E(a2).getInfo(), 30_000);
    const callB = await within(() => E(b2).getInfo(), 30_000);
    const factoryCall = await within(
      () => E(slice.factory).listPresets(),
      30_000,
    );
    const lostMs = await within(
      () =>
        waitFor(
          async () =>
            (await E(slice.factory).listSessions()).rows[0].state === 'lost',
          60_000,
          'A listed lost',
          250,
        ),
      65_000,
    );
    const page = await E(slice.factory).listSessions();
    emit({
      metric: 'm1a.slice.crashingSession',
      unit: 'ms',
      value: servedMs,
      maxDeliveryAttempts: 2,
      atKill,
      kills: killer.kills,
      crashLog: served.crashLog(),
      failedVats: failed.map(w => ({
        label: w.debugLabel,
        failure: w.failure,
      })),
      callA,
      callB: { ok: callB.ok, ms: callB.ms },
      factoryCall: { ok: factoryCall.ok, ms: factoryCall.ms },
      lostListedMs: lostMs.ms,
      rows: page.rows.map((/** @type {any} */ r) => [
        r.key,
        r.state,
        r.activity,
      ]),
    });

    t.true(killer.kills.length >= 1, 'A was killed at the restart');
    t.deepEqual(
      failed.map(w => w.debugLabel),
      ['session s1'],
      'only A was given up',
    );
    t.false(callA.ok);
    t.regex(String(callA.error), RETIRED);
    t.true(callB.ok);
    t.is(/** @type {any} */ (callB.value).title, 'B');
    t.true(factoryCall.ok);
    t.true(lostMs.ok, 'A is listed lost');
    t.deepEqual(
      page.rows.map((/** @type {any} */ r) => [r.key, r.state]),
      [
        ['s1', 'lost'],
        ['s2', 'ready'],
      ],
    );
    // B still runs turns.
    const b3 = await slice.submit(b2, inputs.hi);
    t.is((await E(b3.turn).whenFinished()).state, 'completed');
  },
);
