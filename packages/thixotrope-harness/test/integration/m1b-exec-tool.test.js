// @ts-check
/**
 * The exec tool in a real daemon, live (M1b W1b.4; milestones.md M1b
 * acceptance 4, 5 and 11 at the tool level; m1b-interfaces.md 8): a
 * runaway yields the terminated result and the next call has a fresh scope;
 * an await that never ends with `execDeadlineMs` 5 s yields the timeout
 * result; an exec vat whose worker is killed on every attempt while a call
 * runs ends the call with the terminated result, is retired, and the next
 * call has a fresh scope. Perf rows `exec.trivial`, `exec.first` (spare
 * exec vat) and `exec.sends` (100 answered sends from one body).
 *
 * State: the m1b template (real session and exec programs, the factory's
 * default pool of 2 session spares and 1 exec spare, asleep), crash bound 2.
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1b-exec -- \
 *     corepack yarn test test/integration/m1b-exec-tool.test.js
 *
 * EXEC_TRIVIAL_N (default 20) trivial calls; EXEC_FIRST_N (3) first calls
 * on fresh sessions; EXEC_SENDS_N (3) bodies of 100 answered sends.
 */
/* eslint-disable no-await-in-loop -- steps of one scenario run in order */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

// eslint-disable-next-line import/no-relative-packages
import { texts, textOf } from '../../guest/lib/interfaces.js';
import {
  crankBudget,
  emit,
  loadAvg,
  runIdentity,
  stats,
} from '../../perf/_harness.mjs';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  incarnationNeedle,
  makeSlice,
  round1,
  startKiller,
  untilAsleep,
  waitFor,
} from './_m1a-slice.js';
import {
  execScript,
  execTemplate,
  execTurn,
  isExecVat,
  resultsOf,
  UNSET,
} from './_m1b-exec.js';

takeIntegrationLock(test, 'm1b exec tool test');

const run = integrationEnabled ? test.serial : test.skip;

const TRIVIAL_N = Number(process.env.EXEC_TRIVIAL_N ?? 20);
const FIRST_N = Number(process.env.EXEC_FIRST_N ?? 3);
const SENDS_N = Number(process.env.EXEC_SENDS_N ?? 3);
const ATTEMPTS = 2;

run(
  'exec live: runaway, deadline, worker killed on every attempt; trivial, first and sends',
  async t => {
    t.timeout(5 * 60_000);
    const tStart = performance.now();
    const template = await execTemplate();
    const state = await startFromTemplate(template, {
      t,
      maxDeliveryAttempts: ATTEMPTS,
    });
    const slice = await makeSlice(state);
    const { harness } = slice;
    const identity = {
      ...(await runIdentity()),
      crankBudget,
      loadAvg: loadAvg(),
    };
    const made = await slice.makeBackend(harden(execScript));

    /** A fresh session whose first exec call takes a sleeping exec spare. */
    /**
     * A fresh session whose first exec call takes a sleeping exec spare: the
     * pool is settled (no refill competing for the CPU) and every exec vat
     * is asleep and checkpointed before it is returned.
     * @param {string} title
     */
    const freshSession = async title => {
      const session = await slice.createSession(made.backend, title);
      await E(harness).whenSettled();
      await untilAsleep(slice.workers, isExecVat);
      const live = await slice.subscribe(session);
      return { session, live };
    };
    /** Journal lengths of the exec vats, by label. */
    const execJournals = async () =>
      new Map(
        (await slice.workers())
          .filter(isExecVat)
          .map(w => [w.debugLabel, Number(w.journalLength)]),
      );

    // ---- exec.first and exec.trivial
    /** @type {number[]} */
    const firstMs = [];
    /** @type {any} */
    let main;
    for (let i = 0; i < FIRST_N; i += 1) {
      const fresh = await freshSession(`first ${i}`);
      const r = await execTurn(
        slice,
        fresh.session,
        fresh.live,
        'exec trivial',
      );
      t.is(r.result, '1');
      t.is(r.endStatus, 'completed');
      firstMs.push(/** @type {number} */ (r.callMs));
      if (i === 0) main = fresh;
      else await fresh.live.stop();
    }
    await stats('exec.first', firstMs, {
      budget: { median: 750 },
      extra: {
        what: 'tool_call to tool_result at a live subscriber; first exec call of a fresh session: ExecHandle.scope() takes a sleeping spare exec vat, then run',
      },
    });
    /** @type {number[]} */
    const trivialMs = [];
    for (let i = 0; i < TRIVIAL_N; i += 1) {
      const r = await execTurn(slice, main.session, main.live, 'exec trivial');
      t.is(r.result, '1');
      trivialMs.push(/** @type {number} */ (r.callMs));
    }
    await stats('exec.trivial', trivialMs, {
      budget: { median: 250 },
      extra: {
        what: 'tool_call to tool_result at a live subscriber (crank D publish to crank E publish: run, one exec crank, answer)',
      },
    });

    // ---- exec.sends: 100 answered sends (Timer.sleep(0)) from one body
    /** @type {number[]} */
    const sendsMs = [];
    for (let i = 0; i < SENDS_N; i += 1) {
      const r = await execTurn(slice, main.session, main.live, 'exec sends');
      t.is(r.result, '100');
      sendsMs.push(/** @type {number} */ (r.callMs));
    }
    const failedVats = (await slice.workers()).filter(w => w.failure);
    t.deepEqual(failedVats, [], 'no MeterAbort');
    await stats('exec.sends.answered', sendsMs, {
      budget: { median: 8000 },
      extra: {
        what: '100 E(timer).sleep(0) sent in one exec crank, until all answers are back and the body returned (tool_call to tool_result)',
        trivialMedianMs: trivialMs.sort((a, b) => a - b)[
          Math.floor(trivialMs.length / 2)
        ],
        sendOnly:
          'not measurable from model code in M1b: powers is empty, so model code reaches no remote it could sendOnly to (M5)',
      },
    });

    // ---- acceptance 4: a runaway yields the terminated result; fresh scope after
    const set1 = await execTurn(slice, main.session, main.live, 'exec set');
    t.is(set1.result, '5');
    const loop = await execTurn(slice, main.session, main.live, 'exec loop', {
      ms: 60_000,
    });
    t.is(loop.result, textOf.errorResult(texts.execTerminated));
    t.is(loop.endStatus, 'completed', 'the session keeps working');
    const afterLoop = await execTurn(
      slice,
      main.session,
      main.live,
      'exec get',
    );
    t.is(afterLoop.result, UNSET, 'the next call has a fresh scope');
    emit({
      metric: 'exec.runaway',
      unit: 'ms',
      value: loop.callMs,
      what: 'tool_call to tool_result: run, MeterAbort, the retired break, the terminated result',
      nextCallMs: afterLoop.callMs,
      budget: { value: 1000 },
      ...identity,
    });

    // ---- acceptance 5: an await that never ends, execDeadlineMs 5 s
    await E(harness).configure(harden({ execDeadlineMs: 5000 }));
    const timed = await freshSession('deadline');
    t.is(
      (await execTurn(slice, timed.session, timed.live, 'exec set')).result,
      '5',
    );
    const forever = await execTurn(
      slice,
      timed.session,
      timed.live,
      'exec forever',
      { ms: 30_000 },
    );
    t.is(forever.result, textOf.errorResult(textOf.execTimeout(5000)));
    t.regex(String(forever.result), /the scope was reset/);
    const afterTimeout = await execTurn(
      slice,
      timed.session,
      timed.live,
      'exec get',
    );
    t.is(afterTimeout.result, UNSET);
    emit({
      metric: 'exec.deadline',
      unit: 'ms',
      value: forever.callMs,
      deadlineMs: 5000,
      nextCallMs: afterTimeout.callMs,
      ...identity,
    });
    await E(harness).configure(harden({ execDeadlineMs: 120_000 }));
    await timed.live.stop();

    // ---- acceptance 11: the exec vat's worker killed on every attempt
    const victim = await freshSession('killed exec');
    const journalsBefore = await execJournals();
    t.is(
      (await execTurn(slice, victim.session, victim.live, 'exec set')).result,
      '5',
    );
    // The victim's exec vat: the one existing before whose journal grew.
    const journalsAfter = await execJournals();
    const grew = [...journalsBefore].filter(
      ([label, n]) => (journalsAfter.get(label) ?? n) > n,
    );
    t.is(grew.length, 1, 'one exec vat ran the call');
    const [[execLabel]] = grew;
    const sleeping = await execTurn(
      slice,
      victim.session,
      victim.live,
      'exec sleep4',
      { wait: 'call' },
    );
    const t0 = performance.now();
    const killer = startKiller(incarnationNeedle(state.root, execLabel), t0);
    /** @type {any} */
    let ended;
    try {
      ended = await waitFor(
        async () => {
          const r = await resultsOf(victim.session, sleeping.turnId);
          return /** @type {any[]} */ (r.results).length > 0 && r;
        },
        90_000,
        'the killed call to end',
        100,
      );
    } finally {
      await killer.stop();
    }
    const endedMs = round1(performance.now() - t0);
    t.deepEqual(ended.results, [textOf.errorResult(texts.execTerminated)]);
    const retired = await waitFor(
      async () =>
        (await slice.workers()).some(w => w.debugLabel === execLabel)
          ? false
          : 'yes',
      30_000,
      'the lost exec vat retired',
    ).catch(() => 'no');
    const execRow = (await slice.workers()).find(
      w => w.debugLabel === execLabel,
    );
    const after11 = await execTurn(
      slice,
      victim.session,
      victim.live,
      'exec get',
    );
    t.is(after11.result, UNSET, 'the next exec gets a fresh scope');
    emit({
      metric: 'exec.workerKilled',
      unit: 'ms',
      value: endedMs,
      what: 'from the first kill to the terminated result in the transcript',
      maxDeliveryAttempts: ATTEMPTS,
      kills: killer.kills,
      execVatRetired: retired,
      execRowAfter: execRow
        ? { failure: execRow.failure, awake: execRow.awake }
        : null,
      crashLog: state.crashLog(),
      nextCallMs: after11.callMs,
      ...identity,
    });
    t.is(retired, 'yes', 'the lost exec vat was retired');
    t.true(killer.kills.length >= 1);

    await main.live.stop();
    await victim.live.stop();
    emit({
      metric: 'm1b.exec.tool.file',
      unit: 'ms',
      value: round1(performance.now() - tStart),
      ...identity,
    });
  },
);
