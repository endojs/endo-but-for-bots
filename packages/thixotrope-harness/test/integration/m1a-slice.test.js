// @ts-check
/**
 * The M1a headless session slice, end to end (milestones.md M1a, W1a.7):
 * acceptance tests 1-4, 8 and 9 against a real Ironhorse supervisor, from
 * the m1a state template (real session program, agent host, factory), with
 * the scripted backend and the echo adapter tool. Acceptance 5-7 (SIGKILL
 * and restart) are in m1a-slice-restart.test.js and acceptance 10 (a
 * crashing session vat at restart) in m1a-slice-crash.test.js, so that each
 * file runs alone in under 5 minutes.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   THIX_HARNESS_INTEGRATION=1 node scripts/run-lock.mjs --label m1a-slice -- \
 *     corepack yarn test test/integration/m1a-slice.test.js
 *
 * PERF_OUT appends the JSON lines it emits to a file.
 */
import '../unit/_m1a-prelude.js';

import { performance } from 'node:perf_hooks';

import test from 'ava';

import { E } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { generatedArgs } from '../../resources/agent-host/impl/providers/scripted.js';
import { emit } from '../../perf/_harness.mjs';
import {
  ECHO_DELAY_MS,
  inputs,
  sliceScript,
} from '../fixtures/scripts/m1a-slice.js';
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
} from './_m1a-slice.js';

takeIntegrationLock(test, 'm1a slice test');

const run = integrationEnabled ? test.serial : test.skip;

/** @type {Awaited<ReturnType<typeof sliceTemplate>> | undefined} */
let template;
/** @param {import('ava').ExecutionContext} t */
const open = async t => {
  template ??= await sliceTemplate();
  const state = await startFromTemplate(template, { t });
  const slice = await makeSlice(state);
  const { backend, logPath, log } = await slice.makeBackend(
    harden(sliceScript),
  );
  return { state, slice, backend, logPath, log };
};

run(
  '1-2: create, list, refuse model; a turn streams to a subscriber',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, backend } = await open(t);

    // Acceptance 1.
    const t0 = performance.now();
    const session = await E(slice.factory).createSession(
      harden({ title: 't', preset: slice.chatOnly, backend }),
    );
    const createMs = round1(performance.now() - t0);
    const page = await E(slice.factory).listSessions();
    t.is(page.rows.length, 1);
    t.like(page.rows[0], {
      key: 's1',
      title: 't',
      state: 'ready',
      activity: 'passive',
    });
    t.is(page.rows[0].session, session);
    await t.throwsAsync(
      () => E(slice.factory).createSession(harden({ model: 'x', backend })),
      { message: texts.modelOption },
    );
    t.is((await E(slice.factory).listSessions()).rows.length, 1);

    // Acceptance 2.
    const sub = await slice.subscribe(session);
    const receipt = await slice.submit(session, inputs.hi);
    t.is(receipt.state, 'started');
    t.truthy(receipt.turn);
    await sub.until(e => e.type === 'end');
    const types = sub.events().map(e => e.type);
    t.log(types.join(' '));
    t.is(types[0], 'snapshot');
    const first = (/** @type {string} */ type) => types.indexOf(type);
    t.true(first('phase') > 0);
    t.true(types.filter(x => x === 'delta').length >= 3);
    t.true(first('phase') < first('delta'));
    t.true(first('delta') < first('final'));
    t.true(first('final') < first('usage'));
    t.true(first('usage') < first('end'));
    const deltas = sub
      .events()
      .filter(e => e.type === 'delta')
      .map(e => e.text)
      .join('');
    t.is(deltas, 'Hello!');
    t.is(sub.events().find(e => e.type === 'final').text, 'Hello!');
    t.is(sub.events().find(e => e.type === 'end').status, 'completed');
    // seq numbers every delivery from the snapshot's.
    const seqs = sub.deliveries.map(d => d.seq);
    t.deepEqual(
      seqs,
      seqs.map((_, i) => seqs[0] + i),
    );
    await sub.stop();
    const status = await E(receipt.turn).whenFinished();
    t.is(status.state, 'completed');
    emit({ metric: 'm1a.slice.createCold', unit: 'ms', value: createMs });
  },
);

/**
 * The time the subscriber saw a round's tool phase take: from the first
 * `tool_call` to the next round's `phase thinking`.
 * @param {{ deliveries: any[] }} sub
 * @param {string} turnId
 */
const toolPhaseMs = (sub, turnId) => {
  const mine = sub.deliveries.filter(d => d.event.turnId === turnId);
  const i = mine.findIndex(d => d.event.type === 'tool_call');
  const j = mine.findIndex(
    (d, k) => k > i && d.event.type === 'phase' && d.event.phase === 'thinking',
  );
  return i >= 0 && j >= 0 ? mine[j].arrivedAt - mine[i].arrivedAt : NaN;
};

run(
  '3: a parallel tool round; intents before results, results in call order',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, backend, log } = await open(t);
    const session = await slice.createSession(backend);
    const sub = await slice.subscribe(session);

    /** @param {string} input */
    const turnOf = async input => {
      const receipt = await slice.submit(session, input);
      const status = await E(receipt.turn).whenFinished();
      t.is(status.state, 'completed', input);
      return status.turnId;
    };
    const oneId = await turnOf(inputs.echoOne);
    const twoId = await turnOf(inputs.echoTwo);
    const orderId = await turnOf(inputs.echoOrder);
    await sub.until(e => e.type === 'end' && e.turnId === orderId);

    const one = toolPhaseMs(sub, oneId);
    const two = toolPhaseMs(sub, twoId);
    const lines = log();
    /** @param {string} turnId */
    const echoSpan = turnId => {
      const mine = lines.filter(
        l => typeof l.opId === 'string' && l.opId.startsWith(`${turnId}/`),
      );
      const starts = mine.filter(l => l.kind === 'echo-start').map(l => l.at);
      const ends = mine.filter(l => l.kind === 'echo-end').map(l => l.at);
      return {
        calls: starts.length,
        ms: Math.max(...ends) - Math.min(...starts),
      };
    };
    emit({
      metric: 'm1a.slice.parallelRound',
      unit: 'ms',
      echoDelayMs: ECHO_DELAY_MS,
      oneCall: { toolPhaseMs: one, echo: echoSpan(oneId) },
      twoCalls: { toolPhaseMs: two, echo: echoSpan(twoId) },
      ratio: +(two / one).toFixed(3),
    });
    t.is(echoSpan(twoId).calls, 2);
    t.true(two < 1.6 * one, `two calls ${two} ms, one call ${one} ms`);

    // The history page: one intent record before both results, results in
    // call order (also when the second call finished first).
    const page = await E(session).getHistoryPage();
    for (const [input, turnId] of [
      [inputs.echoTwo, twoId],
      [inputs.echoOrder, orderId],
    ]) {
      const preview = turnWithInput(page, input);
      t.is(preview.turnId, turnId);
      const kinds = preview.records.map((/** @type {any} */ r) => r.kind);
      t.deepEqual(kinds, [
        'turn-started',
        'dispatched',
        'round-settled',
        'tool-intents',
        'tool-result',
        'tool-result',
        'round-settled',
        'turn-settled',
      ]);
      const intents = preview.records[3].intents;
      t.is(intents.length, 2);
      t.deepEqual(
        preview.records.slice(4, 6).map((/** @type {any} */ r) => r.opId),
        intents.map((/** @type {any} */ i) => i.opId),
      );
    }
    const order = turnWithInput(page, inputs.echoOrder);
    t.deepEqual(
      order.records.slice(4, 6).map((/** @type {any} */ r) => r.result),
      ['first', 'second'],
    );
    t.deepEqual(
      order.records[3].intents.map((/** @type {any} */ i) => i.callId),
      ['call-first', 'call-second'],
    );
    // Completion order was the other way round (echo log).
    const ends = lines
      .filter(l => l.kind === 'echo-end' && l.opId.startsWith(`${orderId}/`))
      .map(l => l.opId);
    t.deepEqual(ends, [`${orderId}/r0/c1`, `${orderId}/r0/c0`]);
    // Live: both tool_call events before any tool_result of the round.
    const twoTypes = sub
      .events()
      .filter(e => e.turnId === twoId)
      .map(e => e.type);
    t.true(
      twoTypes.lastIndexOf('tool_call') < twoTypes.indexOf('tool_result'),
      twoTypes.join(' '),
    );
    await sub.stop();
  },
);

run(
  '4: FIFO while a turn runs; startTurn refused while active (R4-10)',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, backend, log } = await open(t);
    const session = await slice.createSession(backend);
    const sub = await slice.subscribe(session);
    const first = await slice.submit(session, inputs.slow);
    t.is(first.state, 'started');
    const second = await slice.submit(session, 'fifo 1');
    const third = await slice.submit(session, 'fifo 2');
    t.is(second.state, 'queued');
    t.is(third.state, 'queued');
    const pending = await E(session).listPending();
    t.deepEqual(
      pending.entries.map((/** @type {any} */ e) => e.preview),
      ['fifo 1', 'fifo 2'],
    );
    t.is(pending.hold, undefined);
    await t.throwsAsync(
      () => E(session).startTurn(harden({ text: 'direct' })),
      {
        message: texts.activeTurn,
      },
    );
    t.is((await E(first.turn).getStatus()).state, 'running');
    await sub.until(
      e =>
        e.type === 'end' &&
        sub.events().filter(x => x.type === 'end').length >= 3,
      60_000,
    );
    const started = sub
      .events()
      .filter(e => e.type === 'turn-start')
      .map(e => e.input);
    t.deepEqual(started, [inputs.slow, 'fifo 1', 'fifo 2']);
    // Live order across turns: every event of a turn (its deltas through
    // the adapter, its vat events through the hub) arrives before the next
    // turn's turn-start; seq has no gap.
    const order = sub.deliveries
      .filter(d => d.event.turnId !== undefined)
      .map(d => d.event.turnId);
    t.deepEqual(
      order,
      [...order].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))),
      order.join(' '),
    );
    const seqs = sub.deliveries.map(d => d.seq);
    t.deepEqual(
      seqs,
      seqs.map((_, i) => seqs[0] + i),
    );
    const third2 = await E(session).getSubmissionReceipt(
      /** @type {any} */ (third).requestId,
    );
    t.is(third2?.state, 'started');
    t.is((await E(third2?.turn).whenFinished()).state, 'completed');
    t.is(log().filter(l => l.kind === 'request').length, 3);
    // startTurn works while idle.
    const direct = await E(session).startTurn(harden({ text: 'direct' }));
    t.is((await E(direct).whenFinished()).state, 'completed');
    await sub.stop();
  },
);

run(
  '8: frame limit: a 64 KiB reply and a 64 KiB echo result fail the turn; the session goes on',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, backend, log } = await open(t);
    const session = await slice.createSession(backend);
    const sub = await slice.subscribe(session);

    /** @param {string} input */
    const finished = async input => {
      const receipt = await slice.submit(session, input);
      return E(receipt.turn).whenFinished();
    };
    const reply = await finished(inputs.bigReply);
    t.is(reply.state, 'failed');
    t.is(reply.error, texts.frameLimit);
    const afterReply = await finished(inputs.hi);
    t.is(afterReply.state, 'completed');

    const result = await finished(inputs.bigEcho);
    t.is(result.state, 'failed');
    t.is(result.error, texts.frameLimit);
    const afterResult = await finished(inputs.hi);
    t.is(afterResult.state, 'completed');

    const lines = log();
    t.is(
      lines.filter(l => l.kind === 'frame-limit' && l.turnId === reply.turnId)
        .length,
      1,
    );
    t.is(
      lines.filter(
        l =>
          l.kind === 'echo-frame-limit' &&
          l.opId.startsWith(`${result.turnId}/`),
      ).length,
      1,
    );
    // The recorded reason, and the tool result the model would see.
    const page = await E(session).getHistoryPage();
    const replyTurn = turnWithInput(page, inputs.bigReply);
    const replySettled = replyTurn.records.at(-1);
    t.like(replySettled, {
      kind: 'turn-settled',
      status: 'failed',
      error: texts.frameLimit,
    });
    t.false(
      replyTurn.records.some(
        (/** @type {any} */ r) => r.kind === 'round-settled',
      ),
      'no round result reached the vat',
    );
    const echoTurn = turnWithInput(page, inputs.bigEcho);
    t.like(
      echoTurn.records.find((/** @type {any} */ r) => r.kind === 'tool-result'),
      { result: texts.frameLimit, failed: true },
    );
    t.like(echoTurn.records.at(-1), {
      kind: 'turn-settled',
      status: 'failed',
      error: texts.frameLimit,
    });
    await sub.until(e => e.type === 'abort' && e.turnId === result.turnId);
    t.deepEqual(
      sub
        .events()
        .filter(e => e.type === 'abort')
        .map(e => e.reason),
      [texts.frameLimit, texts.frameLimit],
    );
    // The session vat was not halted.
    const row = await slice.sessionWorker('s1');
    t.falsy(row?.failure);
    await sub.stop();
  },
);

run(
  '9: 2,000-key tool arguments reach echo as text; three more turns',
  async t => {
    t.timeout(4 * 60_000);
    const { slice, backend, log } = await open(t);
    const session = await slice.createSession(backend);
    const sub = await slice.subscribe(session);
    const receipt = await slice.submit(session, inputs.keys);
    const status = await E(receipt.turn).whenFinished();
    t.is(status.state, 'completed');
    const expected = generatedArgs(2000);
    const start = log().find(
      l => l.kind === 'echo-start' && l.opId.startsWith(`${status.turnId}/`),
    );
    t.is(start.args, expected, 'echo received the arguments byte for byte');
    t.is(
      log().filter(l => l.kind === 'echo-end' && l.opId === start.opId).length,
      1,
    );
    // Recorded as text: the intent's args (a preview in history pages) and
    // the live tool_call event (the whole text).
    const page = await E(session).getHistoryPage();
    const intents = turnWithInput(page, inputs.keys).records.find(
      (/** @type {any} */ r) => r.kind === 'tool-intents',
    );
    t.is(typeof intents.intents[0].args, 'string');
    t.true(expected.startsWith(intents.intents[0].args));
    await sub.until(e => e.type === 'end' && e.turnId === status.turnId);
    const call = sub.events().find(e => e.type === 'tool_call');
    t.is(call.args, expected);
    for (const text of ['after 1', 'after 2', 'after 3']) {
      // eslint-disable-next-line no-await-in-loop
      const next = await slice.submit(session, text);
      // eslint-disable-next-line no-await-in-loop
      t.is((await E(next.turn).whenFinished()).state, 'completed', text);
    }
    t.is((await E(session).getUsage()).turns, 4);
    await sub.stop();
  },
);

run(
  'QC 1: a tool error quoting the hub break text is a tool failure, not a restart',
  async t => {
    t.timeout(3 * 60_000);
    const { slice, backend, log } = await open(t);
    const session = await slice.createSession(backend);
    const receipt = await slice.submit(session, inputs.fakeRestart);
    // A message queued behind the turn must run, not be held 'restart'.
    const queued = await slice.submit(session, 'after fake');
    const status = await E(receipt.turn).whenFinished();
    t.is(status.state, 'completed');
    const page = await E(session).getHistoryPage();
    const result = turnWithInput(page, inputs.fakeRestart).records.find(
      (/** @type {any} */ r) => r.kind === 'tool-result',
    );
    const key = 'ocapn hub: the target session has been retired';
    t.is(
      result.result,
      textOf.errorResult(
        textOf.unexpectedArgument(key, 'echo', [
          'text',
          'delayMs',
          'bytes',
          'data',
        ]),
      ),
    );
    t.is(result.outcome, undefined);
    const opId = result.opId;
    t.deepEqual(
      log()
        .filter(l => l.opId === opId)
        .map(l => l.kind),
      ['echo-start', 'echo-failed'],
    );
    t.is(log().filter(l => l.kind === 'request').length >= 2, true);
    t.is((await E(queued.turn).whenFinished()).state, 'completed');
    t.is((await E(session).listPending()).hold, undefined);
  },
);
