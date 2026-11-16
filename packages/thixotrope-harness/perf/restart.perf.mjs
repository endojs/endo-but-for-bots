// @ts-check
/**
 * Perf check "restart" (milestones.md M1a perf table, W1a.7), from the m1a
 * state template served with idleSleepMs 2,000:
 *
 * - `restart.serving`: SIGKILL with 10 checkpointed idle sessions and one
 *   session with a turn in flight (stalled after Dispatched), then serve
 *   again; budget 10 s to serving; gate: exactly one session vat woken (the
 *   in-flight one; a vat counts as woken when its journal grew across the
 *   restart). After serving, the in-flight turn must already read
 *   outcome-unknown. RESTART_N runs (default 5).
 * - `restart.crashingSession`: acceptance 10 with the crash bound 5: a new
 *   session with a turn in flight, awake and unsnapshotted, SIGKILL, and its
 *   worker killed on sight at the restart. Recorded against 15 s (depends on
 *   core candidates C-8 and C-9; M0 measured 36-69 s for a plain vat).
 *   CRASH_RUNS runs (default 5), each with a fresh session.
 *
 *   cd packages/thixotrope-harness && node perf/restart.perf.mjs
 *
 * The script exits 1 while restart.crashingSession misses 15 s, by design
 * (as perf/crash.perf.mjs).
 */
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import {
  crankBudget,
  du,
  emit,
  loadAvg,
  runIdentity,
  runPerf,
  single,
  stats,
} from './_harness.mjs';

// After the harness module (it locks down first).
const { installGuestPrelude } = await import('../scripts/guest-prelude.js');
installGuestPrelude();
const { E } = await import('@endo/far');
const { inputs, perfScript } =
  await import('../test/fixtures/scripts/m1a-slice.js');
const {
  copyWithBound,
  incarnationNeedle,
  journalTail,
  makeSlice,
  round1,
  sliceTemplate,
  startKiller,
  unsnapshotted,
  untilAsleep,
  waitFor,
} = await import('../test/integration/_m1a-slice.js');

const RESTART_N = Number(process.env.RESTART_N ?? 5);
const CRASH_RUNS = Number(process.env.CRASH_RUNS ?? 5);
const IDLE_SESSIONS = 10;
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
      error: String(/** @type {Error} */ (error)?.message ?? error).slice(
        0,
        200,
      ),
      ms: round1(performance.now() - t0),
    };
  }
};

await runPerf('restart', async ({ root }) => {
  const template = await sliceTemplate();
  const served = await copyWithBound(template, { root });
  /** @type {string[]} */
  const wrong = [];
  try {
    await served.serve(5);
    const slice = await makeSlice(served);
    let made = await slice.makeBackend(harden(perfScript));
    const tCreate = performance.now();
    /** @type {string[]} */
    const keys = [];
    for (let i = 0; i <= IDLE_SESSIONS; i += 1) {
      const session = await slice.createSession(made.backend, `r${i}`);
      const r = await slice.submit(session, inputs.hi);
      await E(r.turn).whenFinished();
      keys.push(`s${i + 1}`);
    }
    emit({
      metric: 'restart.setup',
      sessions: keys.length,
      ms: round1(performance.now() - tCreate),
      template: template.key,
      loadAvg: loadAvg(),
    });
    const idleKeys = keys.slice(0, IDLE_SESSIONS);
    const flightKey = keys[IDLE_SESSIONS];
    const isSession = (/** @type {any} */ w) =>
      /^session s\d+$/.test(w.debugLabel ?? '');

    // ---- restart.serving
    /** @type {number[]} */
    const servedRuns = [];
    for (let run = 1; run <= RESTART_N; run += 1) {
      const flight = await E(slice.factory).findSession(flightKey);
      const r = await slice.submit(flight, inputs.stall);
      const { turnId } = await E(r.turn).getStatus();
      await waitFor(
        () => made.log().some(l => l.kind === 'request' && l.turnId === turnId),
        30_000,
        'the in-flight request',
      );
      await untilAsleep(slice.workers, w =>
        idleKeys.some(k => w.debugLabel === `session ${k}`),
      );
      const before = new Map(
        (await slice.workers()).filter(isSession).map(w => [w.debugLabel, w]),
      );
      const flightRow = before.get(`session ${flightKey}`);
      await served.kill();
      const t0 = performance.now();
      const servedMs = await served.serve(5, t0);
      const { timings } = await served.client.call('status');
      const rows = await slice.workers();
      const after = rows.filter(isSession);
      const grew = after.filter(
        w =>
          Number(w.journalLength) >
          Number(before.get(w.debugLabel)?.journalLength ?? 0),
      );
      await slice.refresh();
      const flight2 = await E(slice.factory).findSession(flightKey);
      const page = await E(flight2).getHistoryPage();
      const preview = page.turns.find(
        (/** @type {any} */ tp) => tp.turnId === turnId,
      );
      const woken = grew.map(w => w.debugLabel);
      const gate = woken.length === 1 && woken[0] === `session ${flightKey}`;
      if (!gate) wrong.push(`run ${run}: woken ${woken.join(', ')}`);
      if (preview?.state !== 'outcome-unknown')
        wrong.push(`run ${run}: in-flight turn ${preview?.state}`);
      servedRuns.push(servedMs);
      await single('restart.serving.run', servedMs, {
        budget: { value: 10_000 },
        extra: {
          run,
          sessions: after.length,
          wokenSessions: woken,
          gate,
          awakeAfterServing: after.filter(w => w.awake).map(w => w.debugLabel),
          engineSinceStart: timings,
          grownFrames: Object.fromEntries(
            grew.map(w => {
              const n =
                Number(w.journalLength) -
                Number(before.get(w.debugLabel)?.journalLength ?? 0);
              return [w.debugLabel, journalTail(served.root, w.workerId, n)];
            }),
          ),
          inFlight: {
            atKill: {
              awake: flightRow?.awake,
              unsnapshotted: unsnapshotted(flightRow),
            },
            framesAcrossRestart:
              Number(
                after.find(w => w.debugLabel === `session ${flightKey}`)
                  ?.journalLength,
              ) - Number(flightRow?.journalLength),
            stateAtFirstRead: preview?.state ?? null,
          },
          daemonWorkers: rows.length,
          awakeWorkers: rows.filter(w => w.awake).length,
          stateKiB: du(served.root),
        },
      });
    }
    await stats('restart.serving', servedRuns, {
      budget: { median: 10_000 },
      extra: {
        idleSessions: IDLE_SESSIONS,
        inFlight: 1,
        how: 'SIGKILL',
        gateWokenSessions: 1,
      },
    });

    // ---- restart.crashingSession
    /** @type {number[]} */
    const crashRuns = [];
    for (let run = 1; run <= CRASH_RUNS; run += 1) {
      made = await slice.makeBackend(harden(perfScript));
      const session = await slice.createSession(made.backend, `crash ${run}`);
      const { rows: listed } = await E(slice.factory).listSessions(
        harden({ limit: 50 }),
      );
      const key = listed.at(-1).key;
      const r = await slice.submit(session, inputs.stall);
      const { turnId } = await E(r.turn).getStatus();
      await waitFor(
        () => made.log().some(l => l.kind === 'request' && l.turnId === turnId),
        30_000,
        'the request',
      );
      const atKillRow = await slice.sessionWorker(key);
      await served.kill();
      const t0 = performance.now();
      const killer = startKiller(
        incarnationNeedle(served.root, `session ${key}`),
        t0,
      );
      let servedMs;
      try {
        servedMs = await served.serve(5, t0);
        await delay(1500);
      } finally {
        await killer.stop();
      }
      await slice.refresh();
      const rows = await slice.workers();
      const failedNow = rows
        .filter(w => w.failure)
        .map(w => w.debugLabel)
        .filter(label => label === `session ${key}`);
      const lostSession = await E(slice.factory).findSession(key);
      const callLost = await within(() => E(lostSession).getInfo(), 30_000);
      const other = await E(slice.factory).findSession(idleKeys[0]);
      const callOther = await within(() => E(other).getInfo(), 30_000);
      const lost = await within(
        () =>
          waitFor(
            async () =>
              (
                await E(slice.factory).listSessions(harden({ limit: 50 }))
              ).rows.find((/** @type {any} */ row) => row.key === key)
                ?.state === 'lost',
            60_000,
            'listed lost',
            250,
          ),
        65_000,
      );
      const ok =
        failedNow.length === 1 &&
        !callLost.ok &&
        RETIRED.test(String(callLost.error)) &&
        callOther.ok &&
        lost.ok;
      if (!ok) wrong.push(`crash run ${run}: not as acceptance 10`);
      crashRuns.push(servedMs);
      await single('restart.crashingSession.run', servedMs, {
        budget: { value: 15_000 },
        extra: {
          run,
          maxDeliveryAttempts: 5,
          atKill: {
            awake: atKillRow?.awake,
            unsnapshotted: unsnapshotted(atKillRow),
          },
          kills: killer.kills,
          crashLog: served.crashLog(),
          callLost: { ok: callLost.ok, ms: callLost.ms, error: callLost.error },
          callOther: { ok: callOther.ok, ms: callOther.ms },
          lostListedMs: lost.ms,
          failedVats: rows.filter(w => w.failure).length,
          asAcceptance10: ok,
          depends: 'C-8, C-9',
        },
      });
    }
    await stats('restart.crashingSession', crashRuns, {
      budget: { median: 15_000 },
      extra: { maxDeliveryAttempts: 5, depends: 'C-8, C-9' },
    });
    emit({
      metric: 'restart.summary',
      stateKiB: du(served.root),
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    });
  } finally {
    await served.cleanup();
  }
  if (wrong.length) throw Error(wrong.join('; '));
});
