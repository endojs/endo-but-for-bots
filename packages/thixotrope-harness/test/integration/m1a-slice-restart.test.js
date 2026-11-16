// @ts-check
/**
 * The M1a slice across a SIGKILL of the supervisor (milestones.md M1a,
 * W1a.7): acceptance tests 5, 6 and 7. Each test starts from the m1a state
 * template, makes a session on the scripted backend, kills the supervisor
 * with SIGKILL (`state.kill()`) at a chosen point of a turn, serves the
 * same state again, and checks what a client sees as soon as the daemon
 * serves.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1a-slice -- \
 *     corepack yarn test test/integration/m1a-slice-restart.test.js
 *
 * `M1A_KILL_DELAYS_MS=0,100,500,1500,4000` repeats each case once per
 * delay: the kill comes that long after the case's trigger point (above
 * the 2,000 ms idle sleep the session vat has slept and checkpointed with
 * its call pending). Every run emits one `m1a.slice.restart.case` line
 * before its assertions, so a failing run still reports what it saw.
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { emit } from '../../perf/_harness.mjs';
import { inputs, sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  integrationEnabled,
  startFromTemplate,
  takeIntegrationLock,
} from '../template/index.js';
import {
  makeSlice,
  round1,
  sliceTemplate,
  turnWithInput,
  unsnapshotted,
  waitFor,
} from './_m1a-slice.js';

takeIntegrationLock(test, 'm1a slice restart test');

const run = integrationEnabled ? test.serial : test.skip;

const delaysText = process.env.M1A_KILL_DELAYS_MS;
/** Kill delays after each case's trigger point, in ms. */
const KILL_DELAYS = delaysText
  ? delaysText.split(',').map(s => Number(s.trim()))
  : [0];
/**
 * @param {string} title
 * @param {number} killDelayMs
 */
const named = (title, killDelayMs) =>
  delaysText ? `${title} [kill +${killDelayMs} ms]` : title;

/** @type {Awaited<ReturnType<typeof sliceTemplate>> | undefined} */
let template;
/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  template ??= await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  const session = await slice.createSession(made.backend);
  return { state, slice, session, ...made };
};

/**
 * Wait `killDelayMs`, SIGKILL the supervisor, serve again, and read the
 * session's state with the first calls after serving.
 * @param {any} state
 * @param {any} slice
 * @param {number} killDelayMs
 */
const killAndRestart = async (state, slice, killDelayMs) => {
  if (killDelayMs > 0) await delay(killDelayMs);
  const atKill = await slice.sessionWorker('s1');
  const t0 = performance.now();
  await state.kill();
  const killMs = round1(performance.now() - t0);
  const restarted = await state.restart();
  const t1 = performance.now();
  await slice.refresh();
  const session = await E(slice.factory).findSession('s1');
  const page = await E(session).getHistoryPage();
  const pending = await E(session).listPending();
  const firstReadMs = round1(performance.now() - t1);
  const worker = await slice.sessionWorker('s1');
  return {
    session,
    page,
    pending,
    t1,
    timings: { killMs, ...restarted, firstReadMs },
    atKill: {
      awake: atKill?.awake ?? null,
      unsnapshotted: unsnapshotted(atKill),
      journalLength: atKill?.journalLength ?? null,
    },
    worker,
  };
};

/**
 * The turn's state at the first read, and, if it was not yet settled, how
 * long after serving it settled (polled every 50 ms, up to 30 s).
 * @param {any} after
 * @param {string} input
 */
const settleOf = async (after, input) => {
  const first = turnWithInput(after.page, input)?.state ?? null;
  if (first !== 'running') return { firstRead: first, settled: first };
  /** @type {string | null} */
  let settled = null;
  await waitFor(
    async () => {
      const page = await E(after.session).getHistoryPage();
      settled = turnWithInput(page, input)?.state ?? null;
      return settled !== 'running';
    },
    30_000,
    'the turn to settle',
  ).catch(() => {});
  return {
    firstRead: first,
    settled,
    settledAfterFirstReadMs: round1(performance.now() - after.t1),
  };
};

/** @param {any} preview */
const settledOf = preview =>
  preview.records.find((/** @type {any} */ r) => r.kind === 'turn-settled');

for (const killDelayMs of KILL_DELAYS) {
  run(
    named(
      '5: stalled after Dispatched: outcome-unknown at serving, queue held, resolve while idle',
      killDelayMs,
    ),
    async t => {
      t.timeout(4 * 60_000);
      const { state, slice, session, log } = await open(t);
      const receipt = await slice.submit(session, inputs.stall);
      t.is(receipt.state, 'started');
      const turnId = (await E(receipt.turn).getStatus()).turnId;
      await waitFor(
        () => log().some(l => l.kind === 'request' && l.turnId === turnId),
        30_000,
        'the provider request',
      );
      const queued = await slice.submit(session, 'after the stall');
      t.is(queued.state, 'queued');

      const after = await killAndRestart(state, slice, killDelayMs);
      const requestsAfterRestart = log().filter(
        l => l.kind === 'request' && l.turnId === turnId,
      ).length;
      emit({
        metric: 'm1a.slice.restart.stalled',
        unit: 'ms',
        ...after.timings,
      });
      emit({
        metric: 'm1a.slice.restart.case',
        case: 5,
        killDelayMs,
        atKill: after.atKill,
        ...after.timings,
        ...(await settleOf(after, inputs.stall)),
        requests: requestsAfterRestart,
        hold: after.pending.hold?.reason ?? null,
      });
      // As soon as the daemon serves: session, transcript and queue are there
      // and the turn is already outcome-unknown.
      const preview = turnWithInput(after.page, inputs.stall);
      t.is(preview.turnId, turnId);
      t.is(preview.state, 'outcome-unknown');
      t.like(settledOf(preview), { status: 'outcome-unknown' });
      t.deepEqual(
        preview.records.map((/** @type {any} */ r) => r.kind),
        ['turn-started', 'dispatched', 'turn-settled'],
      );
      t.deepEqual(
        after.pending.entries.map((/** @type {any} */ e) => e.preview),
        ['after the stall'],
      );
      t.deepEqual(after.pending.hold, {
        reason: 'restart',
        message: texts.holdRestart,
      });
      t.is(
        (await E(after.session).getInfo()).title,
        't',
        'the session answers after the restart',
      );
      // The provider received exactly one request for the turn.
      t.is(requestsAfterRestart, 1);
      // resolve(note) while idle.
      t.is(await E(after.session).getCurrentTurn(), undefined);
      await E(preview.turn).resolve('checked by hand');
      const status = await E(preview.turn).getStatus();
      t.is(status.state, 'outcome-unknown');
      t.is(status.resolution, 'checked by hand');
      const page2 = await E(after.session).getHistoryPage();
      t.is(
        turnWithInput(page2, inputs.stall).records.at(-1).kind,
        'turn-resolved',
      );
      // Nothing was claimed while the queue is held.
      t.is((await E(after.session).listPending()).entries.length, 1);
      t.is(
        log().filter(l => l.kind === 'request').length,
        1,
        'no request after the restart',
      );
      emit({
        metric: 'm1a.slice.restart.stalledWorker',
        awake: after.worker?.awake ?? null,
        journalLength: after.worker?.journalLength ?? null,
        snapshotCut: after.worker?.snapshot?.cut ?? null,
      });
    },
  );

  run(
    named(
      '6: killed before dispatching(): interrupted, the message once, a new message releases the hold',
      killDelayMs,
    ),
    async t => {
      t.timeout(4 * 60_000);
      const { state, slice, session, log } = await open(t);
      const sub = await slice.subscribe(session);
      const receipt = await slice.submit(session, inputs.undispatched);
      const turnId = (await E(receipt.turn).getStatus()).turnId;
      // The claim crank: the lease is held and round 0 is with the adapter,
      // which waits ten minutes before dispatching(0).
      await sub.until(e => e.type === 'turn-start' && e.turnId === turnId);
      const queued = await slice.submit(session, 'six b');
      t.is(queued.state, 'queued');
      await sub.stop();

      const after = await killAndRestart(state, slice, killDelayMs);
      emit({
        metric: 'm1a.slice.restart.undispatched',
        unit: 'ms',
        ...after.timings,
      });
      emit({
        metric: 'm1a.slice.restart.case',
        case: 6,
        killDelayMs,
        atKill: after.atKill,
        ...after.timings,
        ...(await settleOf(after, inputs.undispatched)),
        requests: log().filter(l => l.kind === 'request' && l.turnId === turnId)
          .length,
        hold: after.pending.hold?.reason ?? null,
      });
      const preview = turnWithInput(after.page, inputs.undispatched);
      t.is(preview.state, 'interrupted');
      t.like(settledOf(preview), {
        status: 'interrupted',
        error: texts.interruptedBeforeDispatch,
      });
      t.false(
        preview.records.some((/** @type {any} */ r) => r.kind === 'dispatched'),
      );
      t.deepEqual(after.pending.hold, {
        reason: 'restart',
        message: texts.holdRestart,
      });
      // A new message releases the hold; the queue runs in order and the
      // interrupted message is not sent again.
      const sub2 = await slice.subscribe(after.session);
      const third = await slice.submit(after.session, 'six c');
      t.is(third.state, 'queued');
      await sub2.until(
        e => e.type === 'turn-start' && e.input === 'six c',
        30_000,
      );
      const ends = await sub2.until(
        e =>
          e.type === 'end' &&
          sub2.events().filter(x => x.type === 'end').length >= 2,
        30_000,
      );
      t.true(ends > 0);
      await sub2.stop();
      const page = await E(after.session).getHistoryPage();
      const inputsInOrder = page.turns
        .map((/** @type {any} */ tp) => tp.records[0].input)
        .reverse();
      t.deepEqual(inputsInOrder, [inputs.undispatched, 'six b', 'six c']);
      t.is(
        page.turns.filter(
          (/** @type {any} */ tp) =>
            tp.records[0].input === inputs.undispatched,
        ).length,
        1,
        'the user message appears once',
      );
      const lines = log();
      t.false(lines.some(l => l.kind === 'request' && l.turnId === turnId));
      t.is(lines.filter(l => l.kind === 'request').length, 2);
    },
  );

  run(
    named(
      '7: killed while echo runs: outcome unknown, no further round, echo ran at most once',
      killDelayMs,
    ),
    async t => {
      t.timeout(4 * 60_000);
      const { state, slice, session, log } = await open(t);
      const receipt = await slice.submit(session, inputs.echoHang);
      const turnId = (await E(receipt.turn).getStatus()).turnId;
      const start = await waitFor(
        () =>
          log().find(
            l => l.kind === 'echo-start' && l.opId.startsWith(`${turnId}/`),
          ),
        30_000,
        'the echo call',
      );

      const after = await killAndRestart(state, slice, killDelayMs);
      emit({ metric: 'm1a.slice.restart.echo', unit: 'ms', ...after.timings });
      // No further round was requested, now or later.
      const rounds = () =>
        log()
          .filter(l => l.kind === 'request' && l.turnId === turnId)
          .map(l => l.round);
      const starts = () => log().filter(l => l.kind === 'echo-start').length;
      emit({
        metric: 'm1a.slice.restart.case',
        case: 7,
        killDelayMs,
        atKill: after.atKill,
        ...after.timings,
        ...(await settleOf(after, inputs.echoHang)),
        requests: rounds().length,
        echoStarts: starts(),
        hold: after.pending.hold?.reason ?? null,
      });
      const preview = turnWithInput(after.page, inputs.echoHang);
      t.is(preview.state, 'outcome-unknown');
      const result = preview.records.find(
        (/** @type {any} */ r) => r.kind === 'tool-result',
      );
      t.like(result, {
        opId: start.opId,
        result: texts.toolOutcomeUnknown,
        failed: true,
        outcome: 'unknown',
      });
      t.deepEqual(
        preview.records.map((/** @type {any} */ r) => r.kind),
        [
          'turn-started',
          'dispatched',
          'round-settled',
          'tool-intents',
          'tool-result',
          'turn-settled',
        ],
      );
      t.deepEqual(rounds(), [0]);
      t.is(starts(), 1, 'echo ran at most once');
      t.is(log().filter(l => l.kind === 'echo-end').length, 0);
      // The session goes on.
      const next = await slice.submit(after.session, inputs.hi);
      t.is((await E(next.turn).whenFinished()).state, 'completed');
      t.deepEqual(rounds(), [0]);
      t.is(starts(), 1, 'echo still ran once');
    },
  );

  run(
    named(
      'held ports: a session idle across the restart runs its next turn once (contract 7.1 case 3)',
      killDelayMs,
    ),
    async t => {
      t.timeout(4 * 60_000);
      const { state, slice, session, log } = await open(t);
      const first = await slice.submit(session, inputs.hi);
      t.is((await E(first.turn).whenFinished()).state, 'completed');

      const after = await killAndRestart(state, slice, killDelayMs);
      const t2 = performance.now();
      const next = await slice.submit(after.session, inputs.hi);
      const { turnId } = await E(next.turn).getStatus();
      const finished = await E(next.turn).whenFinished();
      const turnMs = round1(performance.now() - t2);
      const requests = log().filter(
        l => l.kind === 'request' && l.turnId === turnId,
      ).length;
      emit({
        metric: 'm1a.slice.restart.case',
        case: 3,
        killDelayMs,
        atKill: after.atKill,
        ...after.timings,
        firstRead: turnWithInput(after.page, inputs.hi)?.state ?? null,
        nextTurn: finished.state,
        nextTurnMs: turnMs,
        requests,
        hold: after.pending.hold?.reason ?? null,
      });
      t.is(after.pending.hold, undefined, 'an idle session holds nothing');
      t.is(finished.state, 'completed');
      t.is(requests, 1, 'the provider got the turn exactly once');
      t.is(log().filter(l => l.kind === 'request').length, 2);
    },
  );
}
