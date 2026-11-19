// @ts-check
// guest/session turn side (M1a W1a.4): the Session and Turn exos, the
// records of architecture 4.3, the atomic claim, the lease, publish batching,
// watch(), the tool table with echo, results in call order, the R4-42/43/45
// texts and the round limit. In-memory fakes of the Backend, Endpoint,
// publisher, host facet, row reporter and echo tool; deterministic, no
// timers (a "crank" here is the synchronous work of one exo call plus the
// microtasks it starts, drained with `drain()`).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { makeSession } from '../../guest/session/session.js';
import { runtimeParts } from '../../guest/session/runtime-parts.js';
import { makeSpareMaker, ALREADY_MADE } from '../../guest/session/main.js';
import { makeRecordLog, inCallOrder } from '../../guest/session/records.js';
import { toolSetFor } from '../../guest/session/tool-table.js';
import { NOT_RUN_TEXT } from '../../guest/session/tools/exec.js';
import { fitEvent } from '../../guest/session/live.js';
import { makeQueue } from '../../guest/session/queue.js';
import { messageBytes } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

/**
 * M5 appends session-site tools (the local object tools and `adopt`) that
 * every session offers without an exec vat (m5-interfaces.md 2.4.3, 2.6).
 */
const alwaysOffered = harden(['list', 'lookup', 'store', 'remove', 'adopt']);
const { Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** Let every pending microtask and eventual send run. */
const drain = () => new Promise(resolve => setImmediate(resolve));

/**
 * The request's TurnStarted. M1b W1b.2: the append carries every record
 * since the previous request, so a later turn's round 0 starts with what the
 * turn before recorded after its last round.
 * @param {any} req
 */
const startedOf = req =>
  req.append.findLast((/** @type {any} */ r) => r.kind === 'turn-started');

const retired = () => Error(`ocapn hub: ${RETIRED_TEXT}`);

const usage = (input = 10, output = 5) =>
  harden({
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
  });

let requestSerial = 0;
/**
 * A valid A.4 request id issued at `at`.
 * @param {number} [at]
 */
const requestId = (at = 1_700_000_000_000) => {
  requestSerial += 1;
  const tail = `${requestSerial}`.padStart(12, '0');
  return `${at}-00000000-0000-4000-8000-${tail}`;
};
const AT = 1_700_000_000_000;

/**
 * When the first fake adapter incarnation started: before every claim the
 * tests make (`AT`).
 */
const FIRST_SINCE = AT - 60_000;

/**
 * A session with fakes. Every adapter call is logged in `log` in the order
 * it arrives. The adapter has incarnations: `restartAdapter(since)` kills the
 * current one (its endpoint refuses new leases with the retired text, its
 * sendOnly targets drop what they get, as tombstones do) and starts another
 * whose ports carry `since`; pending leases are broken by hand
 * (`leases[i].kit.reject(retired())`), as a restart breaks them. The
 * session's creation-time open has been answered when this resolves.
 * @param {object} [options]
 * @param {number} [options.maxToolRounds]
 * @param {boolean} [options.manualOpen] answer Backend.open by hand
 * @param {(options: any) => any} [options.makeQueue] wrap the queue
 * @param {readonly any[]} [options.parts] runtime parts
 */
const setup = async ({
  maxToolRounds,
  manualOpen = false,
  makeQueue: mq,
  parts,
} = {}) => {
  /** @type {any[]} */
  const log = [];
  /** @type {any[]} */
  const published = [];
  /** @type {any[]} */
  const outsidePublished = [];
  /** @type {any[]} */
  const rows = [];
  /** @type {any[]} */
  const rounds = [];
  /** @type {any[]} */
  const leases = [];
  /** @type {any[]} */
  const toolCalls = [];
  /** @type {any[]} */
  const opens = [];
  let publishFails = 0;
  /** @type {any} */
  let sessionRef;

  /** @param {number} since */
  const makeIncarnation = since => {
    const incarnation = { dead: false, ports: /** @type {any} */ (undefined) };
    const publisher = Far('LivePublisher', {
      publish: (/** @type {any} */ batch) => {
        if (incarnation.dead) {
          // A tombstone: a sendOnly publish is dropped, an answered one
          // breaks with the retired text.
          log.push(['publish-dead', batch]);
          throw retired();
        }
        log.push(['publish', batch]);
        published.push(batch);
      },
    });
    const endpoint = Far('Endpoint', {
      holdTurn: (/** @type {any} */ turn) => {
        if (incarnation.dead) {
          log.push(['holdTurn-dead', turn]);
          return Promise.reject(retired());
        }
        const kit = makePromiseKit();
        leases.push({ turn, kit });
        log.push(['holdTurn', turn]);
        return kit.promise;
      },
      releaseTurn: (/** @type {any} */ turn) => {
        log.push([incarnation.dead ? 'releaseTurn-dead' : 'releaseTurn', turn]);
      },
      startRound: (/** @type {any} */ req) => {
        if (incarnation.dead) {
          log.push(['startRound-dead', req]);
          return;
        }
        log.push(['startRound', req]);
        rounds.push(req);
      },
      cancelRound: (/** @type {any} */ turn) => log.push(['cancelRound', turn]),
      armDeadline: () => {},
      disarm: () => {},
    });
    const echoTool = Far('AdapterTool', {
      execute: (/** @type {any} */ request) => {
        const kit = makePromiseKit();
        // What the session's log holds when the effect starts.
        const current = sessionRef.getCurrentTurn();
        const kinds = current.history.records.map(
          (/** @type {any} */ r) => r.kind,
        );
        toolCalls.push({ request, kit, kindsAtCall: kinds });
        log.push(['execute', request.opId]);
        return kit.promise;
      },
    });
    incarnation.ports = harden({
      endpoint,
      publisher,
      tools: harden([harden({ name: 'echo', tool: echoTool })]),
      since,
    });
    return incarnation;
  };
  let incarnation = makeIncarnation(FIRST_SINCE);
  const ports = incarnation.ports;

  const outsidePublisher = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => {
      if (publishFails > 0) {
        publishFails -= 1;
        throw retired();
      }
      log.push(['publish-outside', batch]);
      outsidePublished.push(batch);
    },
  });
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'scripted', label: 'fake' }),
    open: () => {
      log.push(['open']);
      if (!manualOpen) return incarnation.ports;
      const kit = makePromiseKit();
      opens.push(kit);
      return kit.promise;
    },
  });
  let liveChannelCalls = 0;
  const host = Far('SessionHostFacet', {
    liveChannel: () => {
      liveChannelCalls += 1;
      return outsidePublisher;
    },
  });
  const rowReporter = Far('RowReporter', {
    changed: (/** @type {any} */ patch) => {
      log.push(['row', patch]);
      rows.push(patch);
    },
  });
  const config = harden({
    key: 's1',
    title: 'test session',
    backendTitle: 'fake',
    modelId: 'scripted',
    preset: harden({ label: 'chat-only' }),
    createdAt: AT,
    userInitiated: true,
  });
  const { session, internal } = makeSession(
    { config, services: { backend, host }, rowReporter },
    harden({
      ...(maxToolRounds === undefined ? {} : { maxToolRounds }),
      ...(mq === undefined ? {} : { makeQueue: mq }),
      ...(parts === undefined ? {} : { parts }),
    }),
  );
  sessionRef = session;
  await drain();
  return {
    session,
    internal,
    log,
    published,
    outsidePublished,
    rows,
    rounds,
    leases,
    toolCalls,
    opens,
    ports,
    currentPorts: () => incarnation.ports,
    /** @param {number} since */
    restartAdapter: since => {
      incarnation.dead = true;
      incarnation = makeIncarnation(since);
      return incarnation.ports;
    },
    liveChannelCalls: () => liveChannelCalls,
    failOutsidePublishes: (/** @type {number} */ n) => {
      publishFails = n;
    },
    /** Kinds of the session log since the last call. */
    lastRound: () => rounds[rounds.length - 1],
    eventsOf: (/** @type {any[]} */ batches) =>
      batches.flatMap(b => b.events.map((/** @type {any} */ e) => e.type)),
    kinds: () => log.map(([kind]) => kind),
  };
};

/**
 * Submit and run crank A, then crank B (open answered).
 * @param {any} s
 * @param {string} [text]
 */
const submit = async (/** @type {any} */ s, text = 'hi') => {
  const receipt = s.session.enqueueOnce(harden({ text }), requestId(), AT);
  await drain();
  return receipt;
};

/**
 * One RoundResult.
 * @param {number} round
 * @param {string} [text]
 * @param {readonly any[]} [calls]
 * @param {number} [at]
 */
const result = (round, text = '', calls = [], at = AT + 1000) =>
  harden({
    round,
    text,
    toolCalls: harden(calls.map(c => harden(c))),
    usage: usage(),
    at,
  });

const echoCall = (args = '{"text":"a"}', callId = '') =>
  harden({ callId, name: 'echo', args });

const historyKinds = (/** @type {any} */ page) =>
  page.turns[0].records.map((/** @type {any} */ r) => r.kind);

// ---------------------------------------------------------------- start

/**
 * The real queue, whose `claim` throws while `failing.claims > 0` (stands
 * for the C-16 engine defect of J-0271, where `claim` threw in a vat).
 */
const failingQueue = () => {
  const failing = { claims: 0 };
  const make = (/** @type {any} */ options) => {
    const queue = makeQueue(options);
    return harden({
      ...queue,
      claim: (/** @type {any} */ item, /** @type {any} */ turn) => {
        if (failing.claims > 0) {
          failing.claims -= 1;
          throw Error('xsSet ?: not writable');
        }
        return queue.claim(item, turn);
      },
    });
  };
  return { failing, make };
};

test('claim: a queue.claim that throws sends nothing and records no turn (QC advisory 1)', async t => {
  const { failing, make } = failingQueue();
  const s = await setup({ makeQueue: make });
  failing.claims = 1;
  const before = s.log.length;
  t.throws(() =>
    s.session.enqueueOnce(harden({ text: 'hi' }), requestId(), AT),
  );
  await drain();
  t.false(
    s.log
      .slice(before)
      .some(([kind]) => ['open', 'holdTurn', 'startRound'].includes(kind)),
    'no effect before the entry is claimed',
  );
  t.is(s.session.getCurrentTurn(), undefined);
  t.deepEqual(s.session.getHistoryPage().turns, []);
  // The entry is still waiting and runs exactly once at the next claim.
  t.is(s.session.listPending().entries.length, 1);
  s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
  await drain();
  t.is(s.session.getCurrentTurn().input, 'hi');
  t.is(s.log.filter(([kind]) => kind === 'open').length, 1);
});

test('settle: a claim that throws loses neither the settle batch nor the lease release (QC advisory 1)', async t => {
  const { failing, make } = failingQueue();
  const s = await setup({ makeQueue: make });
  const receipt = await submit(s);
  s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
  await drain();
  s.lastRound().sink.dispatching(0);
  failing.claims = 1;
  try {
    s.lastRound().sink.roundFinal(result(0, 'done'));
  } catch {
    // The claim's throw may reach the caller; what matters is below.
  }
  await drain();
  t.is(receipt.turn.getStatus().state, 'completed');
  t.true(
    s.log.some(
      ([kind, turn]) => kind === 'releaseTurn' && turn === receipt.turn,
    ),
    'the lease was released',
  );
  t.true(s.eventsOf(s.published).includes('end'), 'the settle batch went out');
});

test('claim: enqueue on an idle session starts a turn in the same crank', async t => {
  const s = await setup();
  const receipt = s.session.enqueueOnce(
    harden({ text: 'hi' }),
    requestId(),
    AT,
  );
  t.is(receipt.state, 'started');
  t.false(receipt.duplicate);
  t.truthy(receipt.turn);
  // Crank A: the entry is gone (atomic claim), TurnStarted is recorded.
  t.deepEqual(s.session.listPending().entries, []);
  const current = s.session.getCurrentTurn();
  t.is(current.input, 'hi');
  t.is(current.turn, receipt.turn);
  t.deepEqual(historyKinds({ turns: [current.history] }), ['turn-started']);
  t.is(receipt.turn.getStatus().state, 'running');
  await drain();
  // Crank A sent open and the row change; crank B published, leased, started.
  const kinds = s.log.map(([kind]) => kind);
  t.deepEqual(kinds.slice(0, 2), ['open', 'row']);
  t.deepEqual(s.rows[0], { activity: 'working', queuedCount: 0 });
  t.deepEqual(kinds.slice(2), ['publish', 'holdTurn', 'startRound']);
  t.deepEqual(s.eventsOf(s.published), ['turn-start', 'phase', 'pending']);
  t.is(s.published.length, 1, 'one publish in crank B');
  const req = s.lastRound();
  t.is(req.round, 0);
  t.is(req.turn, receipt.turn);
  t.deepEqual(req.base, { count: 0, epoch: 0 });
  t.deepEqual(
    req.append.map((/** @type {any} */ r) => r.kind),
    ['turn-started'],
  );
  t.deepEqual(
    req.tools.map((/** @type {any} */ d) => d.name),
    ['echo', ...alwaysOffered],
  );
  t.deepEqual(req.options, { modelId: 'scripted' });
  t.is(s.leases[0].turn, receipt.turn);
  // Crank C: dispatching(0) records Dispatched and answers true.
  t.true(req.sink.dispatching(0));
  t.deepEqual(historyKinds({ turns: [s.session.getCurrentTurn().history] }), [
    'turn-started',
    'dispatched',
  ]);
  t.is(s.published.length, 1, 'crank C publishes nothing');
});

test('a toolless round settles completed: final, usage, end in one batch; lease released', async t => {
  const s = await setup();
  const receipt = await submit(s);
  const req = s.lastRound();
  req.sink.dispatching(0);
  const before = s.published.length;
  req.sink.roundFinal(result(0, 'Hello!'));
  await drain();
  const settleBatches = s.published.slice(before);
  t.is(settleBatches.length, 1);
  const events = settleBatches[0].events;
  t.deepEqual(
    events.map((/** @type {any} */ e) => e.type),
    ['final', 'usage', 'end'],
  );
  t.is(events[0].text, 'Hello!');
  t.is(events[1].turns, 1);
  t.is(events[1].incompleteTurns, 0);
  t.is(events[1].inputTokens, 10);
  t.is(events[2].status, 'completed');
  t.true(
    s.log.some(
      ([kind, turn]) => kind === 'releaseTurn' && turn === receipt.turn,
    ),
  );
  const status = await receipt.turn.whenFinished();
  t.is(status.state, 'completed');
  t.is(s.session.getCurrentTurn(), undefined);
  t.deepEqual(s.rows[s.rows.length - 1], {
    activity: 'passive',
    messageCount: 1,
    queuedCount: 0,
  });
  const page = s.session.getHistoryPage();
  t.deepEqual(historyKinds(page), [
    'turn-started',
    'dispatched',
    'round-settled',
    'turn-settled',
  ]);
  const settled = page.turns[0].records[3];
  t.is(settled.final, 'Hello!');
  t.is(settled.status, 'completed');
  t.deepEqual(settled.usage, usage());
  t.is(s.session.getUsage().turns, 1);
  t.deepEqual(s.internal.rowSnapshot(), {
    title: 'test session',
    activity: 'passive',
    messageCount: 1,
    queuedCount: 0,
  });
  // A late roundFinal or dispatching for the settled turn is ignored.
  req.sink.roundFinal(result(0, 'late'));
  t.false(req.sink.dispatching(0));
  await drain();
  t.is(s.published.length, before + 1);
});

test('rev: watch() reports the last batch; each batch is one more', async t => {
  const s = await setup();
  t.is(s.session.watch().rev, 1);
  await submit(s);
  const req = s.lastRound();
  req.sink.dispatching(0);
  req.sink.roundFinal(result(0, 'x'));
  await drain();
  const revs = s.published.map(b => b.rev);
  t.deepEqual(revs, [2, 3]);
  const watched = s.session.watch();
  t.is(watched.rev, 3);
  t.is(watched.current, undefined);
  t.is(watched.info.presetLabel, 'chat-only');
  t.is(watched.usage.turns, 1);
});

// ---------------------------------------------------------------- tools

test('intent before effect; results recorded in completion order, presented in call order', async t => {
  const s = await setup();
  await submit(s);
  const req = s.lastRound();
  req.sink.dispatching(0);
  const before = s.published.length;
  req.sink.roundFinal(
    result(0, 'calling', [
      echoCall('{"text":"a","delayMs":1000}'),
      echoCall('{"text":"b","delayMs":1000}', 'c2'),
    ]),
  );
  await drain();
  // Crank D: one publish, both calls issued in call order.
  t.is(s.published.length, before + 1);
  t.deepEqual(s.eventsOf(s.published.slice(before)), [
    'phase',
    'tool_call',
    'tool_call',
  ]);
  t.is(s.published[before].events[0].phase, 'using tools');
  t.is(s.toolCalls.length, 2);
  t.deepEqual(
    s.toolCalls.map(c => c.request.opId),
    ['t1/r0/c0', 't1/r0/c1'],
  );
  // Each effect started after its intent was recorded.
  for (const call of s.toolCalls) {
    t.deepEqual(call.kindsAtCall, [
      'turn-started',
      'dispatched',
      'round-settled',
      'tool-intents',
    ]);
  }
  t.is(s.toolCalls[0].request.args, '{"text":"a","delayMs":1000}');
  const intents = s.session.getCurrentTurn().history.records[3];
  t.deepEqual(
    intents.intents.map((/** @type {any} */ i) => i.callId),
    [textOf.synthesizedCallId(0, 0), 'c2'],
  );

  // The second call answers first.
  s.toolCalls[1].kit.resolve(harden({ status: 'ok', text: 'b' }));
  await drain();
  t.is(s.published.length, before + 2, 'one publish for the first result');
  t.deepEqual(s.eventsOf(s.published.slice(before + 1)), ['tool_result']);
  t.is(s.rounds.length, 1, 'no next round while a call runs');
  s.toolCalls[0].kit.resolve(harden({ status: 'ok', text: 'a' }));
  await drain();
  // The last result's crank: one publish (result + thinking), then round 1.
  t.is(s.published.length, before + 3);
  t.deepEqual(s.eventsOf(s.published.slice(before + 2)), [
    'tool_result',
    'phase',
  ]);
  const publishAt = s.log.findLastIndex(([kind]) => kind === 'publish');
  const roundAt = s.log.findLastIndex(([kind]) => kind === 'startRound');
  t.true(publishAt < roundAt, 'publish before startRound');
  const next = s.lastRound();
  t.is(next.round, 1);
  t.deepEqual(
    next.append.map((/** @type {any} */ r) => [r.kind, r.opId]),
    [
      ['dispatched', undefined],
      ['round-settled', undefined],
      ['tool-intents', undefined],
      ['tool-result', 't1/r0/c0'],
      ['tool-result', 't1/r0/c1'],
    ],
  );
  t.is(next.base.count, 1);
  next.sink.roundFinal(result(1, 'done'));
  await drain();
  const page = s.session.getHistoryPage();
  const records = page.turns[0].records;
  t.deepEqual(
    records.map((/** @type {any} */ r) => r.opId ?? r.kind),
    [
      'turn-started',
      'dispatched',
      'round-settled',
      'tool-intents',
      't1/r0/c0',
      't1/r0/c1',
      'round-settled',
      'turn-settled',
    ],
  );
  t.is(records[4].result, 'a');
  t.is(records[5].result, 'b');
});

test('local refusals: unknown tool (R4-43), more than maxCallsPerRound, window of callWindow', async t => {
  const s = await setup();
  await submit(s);
  const req = s.lastRound();
  req.sink.dispatching(0);
  const calls = [harden({ callId: '', name: 'nope', args: '{}' })];
  for (let i = 1; i < limits.maxCallsPerRound + 2; i += 1) {
    calls.push(echoCall(`{"text":"${i}"}`));
  }
  req.sink.roundFinal(result(0, '', calls));
  await drain();
  t.is(s.toolCalls.length, limits.callWindow, 'at most callWindow in flight');
  const history = s.session.getCurrentTurn().history.records;
  const results = history.filter(
    (/** @type {any} */ r) => r.kind === 'tool-result',
  );
  t.is(results.length, 3);
  t.is(results[0].opId, 't1/r0/c0');
  t.is(
    results[0].result,
    `Error: ${textOf.unknownTool('nope', ['echo', ...alwaysOffered])}`,
  );
  t.is(
    results[0].result,
    'Error: Unknown tool: "nope". Available tools: echo, list, lookup, store, remove, adopt',
  );
  t.true(results[0].failed);
  t.is(
    results[1].result,
    textOf.tooManyCalls(calls.length, limits.maxCallsPerRound),
  );
  t.is(results[1].opId, `t1/r0/c${limits.maxCallsPerRound}`);
  // Each answer issues the next waiting call.
  s.toolCalls[0].kit.resolve(harden({ status: 'ok', text: '' }));
  await drain();
  t.is(s.toolCalls.length, limits.callWindow + 1);
  // Answer every call (63 echo calls run).
  for (let i = 1; i < 63; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await drain();
    s.toolCalls[i].kit.resolve(harden({ status: 'ok', text: `${i}` }));
  }
  await drain();
  t.is(s.toolCalls.length, 63);
  t.is(s.lastRound().round, 1);
});

test('R4-45: failed outcomes and rejections become "Error: ..." results; the turn goes on', async t => {
  const s = await setup();
  await submit(s);
  const req = s.lastRound();
  req.sink.dispatching(0);
  req.sink.roundFinal(
    result(0, '', [echoCall('not json'), echoCall('{}'), echoCall('{"x":1}')]),
  );
  await drain();
  s.toolCalls[0].kit.resolve(
    harden({
      status: 'failed',
      text: textOf.argumentsNotJson('Unexpected token'),
    }),
  );
  s.toolCalls[1].kit.reject(Error('boom'));
  s.toolCalls[2].kit.resolve(
    harden({
      status: 'failed',
      text: textOf.unexpectedArgument('x', 'echo', [
        'text',
        'delayMs',
        'bytes',
        'data',
      ]),
    }),
  );
  await drain();
  const page = s.session.getCurrentTurn().history.records;
  const results = page.filter(
    (/** @type {any} */ r) => r.kind === 'tool-result',
  );
  t.deepEqual(
    results.map((/** @type {any} */ r) => [r.failed, r.result]),
    [
      [true, `Error: ${textOf.argumentsNotJson('Unexpected token')}`],
      [true, 'Error: boom'],
      [
        true,
        'Error: Unexpected argument "x" for echo; allowed arguments: text, delayMs, bytes, data',
      ],
    ],
  );
  t.is(s.lastRound().round, 1, 'the turn continues');
});

test('R4-46: a long tool output is bounded with the marker before it is recorded', async t => {
  const s = await setup();
  await submit(s);
  const req = s.lastRound();
  req.sink.dispatching(0);
  req.sink.roundFinal(result(0, '', [echoCall()]));
  await drain();
  // The guard admits up to toolOutputUnits; a callee that sends exactly that
  // is kept as is.
  const text = 'y'.repeat(limits.toolOutputUnits);
  s.toolCalls[0].kit.resolve(harden({ status: 'ok', text }));
  await drain();
  const page = s.session.getHistoryPage();
  t.is(page.turns[0].cut, true, 'history previews are cut');
  const preview = page.turns[0].records.find(
    (/** @type {any} */ r) => r.kind === 'tool-result',
  );
  t.is(preview.result.length, limits.toolPreviewUnits);
});

test('R4-42: missing name and duplicate ids fail the turn before any intent', async t => {
  for (const [calls, error] of /** @type {const} */ ([
    [[harden({ callId: 'a', name: '', args: '{}' })], texts.invalidToolCall],
    [[echoCall('{}', 'x'), echoCall('{}', 'x')], texts.duplicateToolCallId],
    [
      [echoCall('{}', textOf.synthesizedCallId(0, 1)), echoCall('{}')],
      texts.duplicateToolCallId,
    ],
  ])) {
    // eslint-disable-next-line no-await-in-loop
    const s = await setup();
    // eslint-disable-next-line no-await-in-loop
    const receipt = await submit(s);
    const req = s.lastRound();
    req.sink.dispatching(0);
    req.sink.roundFinal(result(0, '', calls));
    // eslint-disable-next-line no-await-in-loop
    await drain();
    t.is(s.toolCalls.length, 0);
    const status = receipt.turn.getStatus();
    t.is(status.state, 'failed');
    t.is(status.error, error);
    const kinds = historyKinds(s.session.getHistoryPage());
    t.false(kinds.includes('tool-intents'));
    const last = s.published[s.published.length - 1].events;
    t.deepEqual(
      last.map((/** @type {any} */ e) => e.type),
      ['usage', 'abort'],
    );
    t.is(last[1].reason, error);
    t.is(s.rows[s.rows.length - 1].activity, 'error');
  }
});

test('round limit (R4-47): the turn ends completed with the fixed text', async t => {
  const s = await setup({ maxToolRounds: 2 });
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  for (let round = 0; round < 2; round += 1) {
    s.lastRound().sink.roundFinal(result(round, '', [echoCall()]));
    // eslint-disable-next-line no-await-in-loop
    await drain();
    s.toolCalls[round].kit.resolve(harden({ status: 'ok', text: 'r' }));
    // eslint-disable-next-line no-await-in-loop
    await drain();
  }
  t.is(s.rounds.length, 2, 'no third round');
  const status = receipt.turn.getStatus();
  t.is(status.state, 'completed');
  const page = s.session.getHistoryPage();
  const settled = page.turns[0].records.at(-1);
  t.is(settled.final, texts.roundLimit);
  const last = s.published[s.published.length - 1].events;
  t.deepEqual(
    last.map((/** @type {any} */ e) => e.type),
    ['tool_result', 'final', 'usage', 'end'],
  );
  t.is(last[1].text, texts.roundLimit);
});

test("frame-limit tool result fails the turn after the round's other calls settle", async t => {
  const s = await setup();
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, '', [echoCall(), echoCall()]));
  await drain();
  s.toolCalls[0].kit.resolve(
    harden({ status: 'frame-limit', text: texts.frameLimit }),
  );
  await drain();
  t.is(receipt.turn.getStatus().state, 'running');
  s.toolCalls[1].kit.resolve(harden({ status: 'ok', text: 'fine' }));
  await drain();
  const status = receipt.turn.getStatus();
  t.is(status.state, 'failed');
  t.is(status.error, texts.frameLimit);
  t.is(s.rounds.length, 1, 'no next round');
  // The session runs a normal turn afterwards.
  await submit(s, 'again');
  t.is(s.lastRound().round, 0);
  t.is(startedOf(s.lastRound()).input, 'again');
});

// ---------------------------------------------------------------- queue

test('FIFO: a message waits while a turn runs and is claimed in the settle crank', async t => {
  const s = await setup();
  const first = await submit(s, 'one');
  const second = s.session.enqueueOnce(
    harden({ text: 'two' }),
    requestId(),
    AT,
  );
  t.is(second.state, 'queued');
  t.truthy(second.entry);
  await drain();
  t.deepEqual(
    s.session.listPending().entries.map((/** @type {any} */ e) => e.preview),
    ['two'],
  );
  // The enqueue crank published `pending` with the turn's publisher.
  t.deepEqual(s.eventsOf(s.published.slice(-1)), ['pending']);
  t.deepEqual(s.rows.at(-1), { queuedCount: 1 });
  // R4-10: a direct start is refused while a turn is current.
  t.throws(() => s.session.startTurn(harden({ text: 'x' })), {
    message: texts.activeTurn,
  });
  s.lastRound().sink.dispatching(0);
  const before = s.published.length;
  s.lastRound().sink.roundFinal(result(0, 'done one'));
  await drain();
  t.is(first.turn.getStatus().state, 'completed');
  // Settle crank: final/usage/end, the next turn's start on the held ports,
  // then pending: one batch (contract 6.3).
  t.deepEqual(s.eventsOf(s.published.slice(before, before + 1)), [
    'final',
    'usage',
    'end',
    'turn-start',
    'phase',
    'pending',
  ]);
  t.is(s.published.length, before + 1, 'one publish in the settle crank');
  t.deepEqual(s.published[before].events[5].pending.entries, []);
  const receipt = s.session.getSubmissionReceipt(
    /** @type {string} */ (second.requestId),
  );
  t.is(receipt?.state, 'started');
  const current = s.session.getCurrentTurn();
  t.is(current.input, 'two');
  t.is(current.turn, receipt?.turn);
  t.is(startedOf(s.lastRound()).input, 'two');
  // The TurnStarted is record 4; the append starts after the last request.
  t.is(s.lastRound().base.count + s.lastRound().append.length, 5);
  t.deepEqual(s.rows.at(-1), {
    activity: 'working',
    messageCount: 1,
    queuedCount: 0,
  });
});

test('duplicate request ids answer the stored receipt without a second turn', async t => {
  const s = await setup();
  const id = requestId();
  const first = s.session.enqueueOnce(harden({ text: 'hi' }), id, AT);
  const again = s.session.enqueueOnce(harden({ text: 'hi' }), id, AT);
  t.true(again.duplicate);
  t.is(again.state, 'started');
  t.is(again.turn, first.turn);
  await drain();
  t.is(s.log.filter(([kind]) => kind === 'open').length, 1);
});

// ---------------------------------------------------------------- cancel

test('cancel with nothing in flight settles at once; late answers are ignored', async t => {
  const s = await setup();
  const receipt = await submit(s);
  const req = s.lastRound();
  req.sink.dispatching(0);
  const before = s.published.length;
  receipt.turn.cancel();
  await drain();
  t.is(receipt.turn.getStatus().state, 'cancelled');
  t.true(s.log.some(([kind]) => kind === 'cancelRound'));
  t.deepEqual(s.eventsOf(s.published.slice(before)), ['phase', 'usage', 'end']);
  t.is(s.published[before].events[0].phase, 'cancelling');
  req.sink.roundFinal(result(0, 'late'));
  req.sink.roundFailed(harden({ round: 0, reason: 'late', at: AT }));
  await drain();
  t.is(s.published.length, before + 1);
  t.is(s.session.getUsage().incompleteTurns, 1);
  receipt.turn.cancel();
  t.is(receipt.turn.getStatus().state, 'cancelled');
});

test('cancel waits for running calls; waiting calls never run', async t => {
  const s = await setup();
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  const calls = [];
  for (let i = 0; i < limits.callWindow + 2; i += 1) calls.push(echoCall());
  s.lastRound().sink.roundFinal(result(0, '', calls));
  await drain();
  receipt.turn.cancel();
  await drain();
  t.is(receipt.turn.getStatus().state, 'cancelling');
  for (const call of s.toolCalls) {
    call.kit.resolve(harden({ status: 'ok', text: 'r' }));
  }
  await drain();
  t.is(s.toolCalls.length, limits.callWindow, 'no new call after cancel');
  t.is(receipt.turn.getStatus().state, 'cancelled');
  t.is(s.rounds.length, 1);
  const results = s.session
    .getHistoryPage()
    .turns[0].records.filter(
      (/** @type {any} */ r) => r.kind === 'tool-result',
    );
  t.is(results.length, limits.callWindow + 2);
  t.is(
    results.at(-1).result.slice(0, 40),
    `Error: ${NOT_RUN_TEXT}`.slice(0, 40),
  );
});

test('cancel before the open answered settles at once and sends nothing after', async t => {
  const s = await setup({ manualOpen: true });
  const receipt = s.session.enqueueOnce(
    harden({ text: 'hi' }),
    requestId(),
    AT,
  );
  receipt.turn.cancel();
  await drain();
  t.is(receipt.turn.getStatus().state, 'cancelled');
  s.opens[0].resolve(s.ports);
  await drain();
  t.false(s.log.some(([kind]) => kind === 'holdTurn' || kind === 'startRound'));
  // Published outside the turn: no ports were ever kept.
  t.deepEqual(s.eventsOf(s.outsidePublished), [
    'phase',
    'usage',
    'end',
    'pending',
  ]);
});

// ---------------------------------------------------------------- failures

test('roundFailed records the partial text and fails the turn', async t => {
  const s = await setup();
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFailed(
    harden({
      round: 0,
      reason: 'scripted failure',
      at: AT + 5,
      partial: 'Hel',
    }),
  );
  await drain();
  t.is(receipt.turn.getStatus().error, 'scripted failure');
  const records = s.session.getHistoryPage().turns[0].records;
  t.deepEqual(
    records.map((/** @type {any} */ r) => r.kind),
    ['turn-started', 'dispatched', 'partial', 'turn-settled'],
  );
  t.is(records[2].text, 'Hel');
  t.is(records[3].at, AT + 5);
});

test('open rejected: failed with openFailed, published outside, next entry claimed', async t => {
  const s = await setup({ manualOpen: true });
  const first = s.session.enqueueOnce(harden({ text: 'one' }), requestId(), AT);
  s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
  await drain();
  // A guest-vat retired break is not a restart signal here.
  s.opens[0].reject(retired());
  await drain();
  const status = first.turn.getStatus();
  t.is(status.state, 'failed');
  t.is(status.error, textOf.openFailed(`ocapn hub: ${RETIRED_TEXT}`));
  t.is(s.session.getCurrentTurn().input, 'two');
  t.is(s.liveChannelCalls(), 1);
  t.true(s.eventsOf(s.outsidePublished).includes('abort'));
});

test('outside publish: a retired break refreshes the publisher once', async t => {
  const s = await setup({ manualOpen: true });
  const receipt = s.session.enqueueOnce(
    harden({ text: 'hi' }),
    requestId(),
    AT,
  );
  s.failOutsidePublishes(1);
  receipt.turn.cancel();
  await drain();
  t.is(s.liveChannelCalls(), 2);
  t.is(s.outsidePublished.length, 1);
});

// ---------------------------------------------------------------- restart

test('restart: a retired break on the lease before dispatch closes the turn interrupted', async t => {
  const s = await setup();
  const receipt = await submit(s, 'one');
  s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
  await drain();
  // The adapter restarts after the claim (at AT): its new incarnation
  // started at AT + 500, so fresh ports show the turn was in flight.
  s.restartAdapter(AT + 500);
  s.leases[0].kit.reject(retired());
  await drain();
  t.is(s.kinds().filter(kind => kind === 'open').length, 2, 'one reopen');
  const status = receipt.turn.getStatus();
  t.is(status.state, 'interrupted');
  t.is(status.error, texts.interruptedBeforeDispatch);
  // The queue is held and nothing was claimed.
  const pending = s.session.listPending();
  t.is(pending.hold?.reason, 'restart');
  t.is(s.session.getCurrentTurn(), undefined);
  t.is(s.rounds.length, 1);
  // The input stays in the log once.
  const page = s.session.getHistoryPage();
  t.is(page.turns.length, 1);
  t.deepEqual(
    page.turns[0].records.map((/** @type {any} */ r) => r.kind),
    ['turn-started', 'turn-settled'],
  );
  // A new message releases the hold; the old one is claimed first (FIFO).
  s.session.enqueueOnce(harden({ text: 'three' }), requestId(), AT);
  t.is(s.session.getCurrentTurn().input, 'two');
});

test('restart: a retired break on a tool call is never a tool failure', async t => {
  const s = await setup();
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, '', [echoCall(), echoCall()]));
  await drain();
  s.toolCalls[0].kit.resolve(harden({ status: 'ok', text: 'done' }));
  await drain();
  s.toolCalls[1].kit.reject(retired());
  await drain();
  t.is(receipt.turn.getStatus().state, 'outcome-unknown');
  const results = s.session
    .getHistoryPage()
    .turns[0].records.filter(
      (/** @type {any} */ r) => r.kind === 'tool-result',
    );
  t.deepEqual(
    results.map((/** @type {any} */ r) => [r.opId, r.result, r.outcome]),
    [
      ['t1/r0/c0', 'done', undefined],
      ['t1/r0/c1', texts.toolOutcomeUnknown, 'unknown'],
    ],
  );
  t.is(s.rounds.length, 1, 'no further round');
  // The late lease break of the same generation does nothing.
  s.leases[0].kit.reject(retired());
  await drain();
  t.is(receipt.turn.getStatus().state, 'outcome-unknown');
  // Turn.resolve while idle (A.4).
  receipt.turn.resolve('checked');
  t.is(receipt.turn.getStatus().resolution, 'checked');
  const kinds = historyKinds(s.session.getHistoryPage());
  t.is(kinds.at(-1), 'turn-resolved');
});

test('restart: a tool rejection that only quotes the retired text is a tool failure (QC 1)', async t => {
  // The model chose the argument name; echo's R4-43 text quotes it. The
  // session must not read that as a hub break and fake a restart.
  const s = await setup();
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(
    result(0, '', [echoCall(`{"${RETIRED_TEXT}":1}`)]),
  );
  await drain();
  const quoted = textOf.unexpectedArgument(RETIRED_TEXT, 'echo', [
    'text',
    'delayMs',
    'bytes',
    'data',
  ]);
  s.toolCalls[0].kit.reject(Error(quoted));
  // A message queued behind the turn must not be held 'restart'.
  s.session.enqueueOnce(harden({ text: 'next' }), requestId(), AT);
  await drain();
  t.is(receipt.turn.getStatus().state, 'running');
  const results = s.session
    .getCurrentTurn()
    .history.records.filter((/** @type {any} */ r) => r.kind === 'tool-result');
  t.deepEqual(
    results.map((/** @type {any} */ r) => [r.result, r.outcome]),
    [[textOf.errorResult(quoted), undefined]],
  );
  t.is(s.rounds.length, 2, 'the next round was requested');
  t.is(s.session.listPending().hold, undefined);
  // A real hub break (the exact hub message) is still a restart.
  s.lastRound().sink.dispatching(1);
  s.lastRound().sink.roundFinal(result(1, '', [echoCall()]));
  await drain();
  s.toolCalls[1].kit.reject(retired());
  await drain();
  t.is(receipt.turn.getStatus().state, 'outcome-unknown');
});

test('Turn.resolve refuses with the fixed texts', async t => {
  const s = await setup();
  const receipt = await submit(s);
  t.throws(() => receipt.turn.resolve('n'), { message: texts.activeTurn });
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, 'x'));
  await drain();
  t.throws(() => receipt.turn.resolve('n'), {
    message: texts.resolveNotUnknown,
  });
});

// ---------------------------------------------------------------- history

test('history pages: newest first, 32 turns, cursors, frame bound', async t => {
  const s = await setup();
  for (let i = 0; i < 40; i += 1) {
    const receipt = s.session.startTurn(
      harden({ text: `m${i} ${'€'.repeat(2000)}` }),
    );
    // eslint-disable-next-line no-await-in-loop
    await drain();
    s.lastRound().sink.dispatching(0);
    s.lastRound().sink.roundFinal(result(0, 'é'.repeat(3000)));
    // eslint-disable-next-line no-await-in-loop
    await drain();
    t.is(receipt.getStatus().state, 'completed');
  }
  const seen = [];
  let page = s.session.getHistoryPage();
  for (;;) {
    t.true(/** @type {number} */ (messageBytes(page)) <= limits.frameBytes);
    t.true(
      /** @type {number} */ (page.turns.length) <= limits.historyPageTurns,
    );
    seen.push(...page.turns.map((/** @type {any} */ p) => p.turnId));
    if (page.next === undefined) break;
    page = s.session.getHistoryPage(page.next);
  }
  t.is(seen.length, 40);
  t.is(seen[0], 't40');
  t.is(seen[39], 't1');
  t.is(new Set(seen).size, 40);
  t.throws(() => s.session.getHistoryPage('h999'), {
    message: texts.badCursor,
  });
  t.throws(() => s.session.getHistoryPage('x1'), { message: texts.badCursor });
});

test('startTurn on an idle session ignores the queue hold (A.4 direct start)', async t => {
  const s = await setup();
  const turn = s.session.startTurn(harden({ text: 'direct' }), AT + 7);
  t.is(turn.getStatus().at, AT + 7);
  await drain();
  t.is(startedOf(s.lastRound()).input, 'direct');
});

test('rename reports the title; getInfo', async t => {
  const s = await setup();
  s.session.rename('new');
  await drain();
  t.deepEqual(s.rows.at(-1), { title: 'new' });
  t.is(s.session.getInfo().title, 'new');
  t.is(s.internal.rowSnapshot().title, 'new');
});

// ---------------------------------------------------------------- modules

test('records: closed shapes, one turn-started per turn, call order', t => {
  const records = makeRecordLog();
  records.append({ kind: 'turn-started', turnId: 't1', input: 'x', at: 1 });
  t.throws(() =>
    records.append({ kind: 'dispatched', turnId: 't1', round: 0, extra: 1 }),
  );
  t.throws(() =>
    records.append({ kind: 'turn-started', turnId: 't1', input: 'x', at: 1 }),
  );
  t.throws(() =>
    records.append({ kind: 'dispatched', turnId: 't2', round: 0 }),
  );
  t.is(records.count(), 1);
  const intents = harden({
    kind: 'tool-intents',
    turnId: 't1',
    round: 0,
    intents: ['a', 'b', 'c'].map(opId =>
      harden({ opId, callId: opId, name: 'echo', args: '{}' }),
    ),
  });
  const r = (/** @type {string} */ opId) =>
    harden({
      kind: 'tool-result',
      turnId: 't1',
      opId,
      name: 'echo',
      result: opId,
      failed: false,
    });
  const ordered = inCallOrder([intents, r('c'), r('a'), r('b')]);
  t.deepEqual(
    ordered.map(x => x.opId ?? x.kind),
    ['tool-intents', 'a', 'b', 'c'],
  );
});

test('tool table: echo only when the ports offer it', t => {
  const without = toolSetFor(harden({ tools: [] }));
  t.false(without.byName.has('echo'));
  t.deepEqual(
    without.descriptions.map((/** @type {any} */ d) => d.name),
    alwaysOffered,
  );
  const set = toolSetFor(
    harden({ tools: [harden({ name: 'echo', tool: Far('AdapterTool', {}) })] }),
  );
  t.deepEqual(
    set.descriptions.map((/** @type {any} */ d) => d.name),
    ['echo', ...alwaysOffered],
  );
  t.true(set.byName.has('echo'));
});

test('SpareMaker makes one session per vat', async t => {
  const maker = makeSpareMaker();
  const s = await setup();
  const args = harden({
    config: harden({
      key: 's2',
      title: 't',
      backendTitle: 'fake',
      modelId: 'scripted',
      preset: harden({ label: 'chat-only' }),
      createdAt: AT,
      userInitiated: true,
    }),
    services: harden({
      backend: Far('Backend', {}),
      host: Far('SessionHostFacet', {}),
    }),
    rowReporter: Far('RowReporter', { changed: () => {} }),
  });
  const made = maker.make(args);
  t.truthy(made.session);
  t.truthy(made.internal);
  t.throws(() => maker.make(args), { message: ALREADY_MADE });
  t.truthy(s);
});

test('a waiting entry cancelled from outside a turn crank publishes pending at the end of its crank', async t => {
  const s = await setup();
  await submit(s, 'one');
  const second = s.session.enqueueOnce(
    harden({ text: 'two' }),
    requestId(),
    AT,
  );
  await drain();
  const before = s.published.length;
  t.true(second.entry.cancel());
  await drain();
  t.deepEqual(s.eventsOf(s.published.slice(before)), ['pending']);
  t.deepEqual(s.published.at(-1).events[0].pending.entries, []);
  t.deepEqual(s.rows.at(-1), { queuedCount: 0 });
});

test('a round request whose new records exceed the frame carries none (base = log count)', async t => {
  const s = await setup();
  await submit(s);
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, '', [echoCall(), echoCall()]));
  await drain();
  for (const call of s.toolCalls) {
    call.kit.resolve(harden({ status: 'ok', text: 'z'.repeat(13_000) }));
  }
  await drain();
  const next = s.lastRound();
  t.is(next.round, 1);
  t.deepEqual(next.append, []);
  t.is(next.base.count, 6);
  // The live events were cut to fit one frame each; the records are whole.
  const results = s.session
    .getCurrentTurn()
    .history.records.filter((/** @type {any} */ r) => r.kind === 'tool-result');
  t.is(results.length, 2);
});

test('live: an event alone over the frame has its large field cut to fit', async t => {
  const event = harden({
    type: 'tool_call',
    turnId: 't1',
    id: 't1/r0/c0',
    name: 'echo',
    args: '€'.repeat(limits.textUnits),
  });
  const fitted = fitEvent(event);
  t.true(messageBytes(fitted) <= limits.frameBytes - 64);
  t.true(messageBytes(fitted) > limits.frameBytes - 64 - 3);
  t.true(event.args.startsWith(fitted.args));
  const small = harden({ type: 'phase', turnId: 't1', phase: 'thinking' });
  t.is(fitEvent(small), small);
});

// ---------------------------------------------------------------- held ports (J-9151)

/**
 * Run one plain turn to completion.
 * @param {any} s
 * @param {string} text
 * @param {number} [at]
 */
const plainTurn = async (s, text, at = AT) => {
  const receipt = s.session.enqueueOnce(harden({ text }), requestId(), at);
  await drain();
  const req = s.lastRound();
  req.sink.dispatching(0);
  req.sink.roundFinal(result(0, `re ${text}`));
  await drain();
  return receipt;
};

test('held ports: opened once at creation; each turn starts in its claim crank without open', async t => {
  const s = await setup();
  t.deepEqual(s.kinds(), ['open'], 'the creation-time open');
  for (let i = 0; i < 3; i += 1) {
    const before = s.log.length;
    const publishedBefore = s.published.length;
    const receipt = s.session.enqueueOnce(
      harden({ text: `m${i}` }),
      requestId(),
      AT + i,
    );
    // eslint-disable-next-line no-await-in-loop
    await drain();
    // One crank (A): row, one publish, the lease, round 0; no manager hop.
    t.deepEqual(
      s.log.slice(before).map(([kind]) => kind),
      ['row', 'publish', 'holdTurn', 'startRound'],
      `turn ${i}`,
    );
    t.deepEqual(s.eventsOf(s.published.slice(publishedBefore)), [
      'turn-start',
      'phase',
      'pending',
    ]);
    const req = s.lastRound();
    t.is(req.turn, receipt.turn);
    t.is(startedOf(req).input, `m${i}`);
    t.true(req.sink.dispatching(0));
    req.sink.roundFinal(result(0, 'ok'));
    // eslint-disable-next-line no-await-in-loop
    await drain();
    t.is(receipt.turn.getStatus().state, 'completed');
    t.true(
      s.log.some(
        ([kind, turn]) => kind === 'releaseTurn' && turn === receipt.turn,
      ),
      'one lease per turn, released at settle',
    );
  }
  t.is(s.kinds().filter(kind => kind === 'open').length, 1);
  t.is(s.leases.length, 3);
});

test('restart while idle: the first claim on dead ports opens fresh ones and sends round 0 there', async t => {
  const s = await setup();
  await plainTurn(s, 'one');
  // The adapter restarts while the session is idle: nothing tells it.
  s.restartAdapter(AT + 500);
  const before = s.log.length;
  const receipt = s.session.enqueueOnce(
    harden({ text: 'two' }),
    requestId(),
    AT + 1000,
  );
  await drain();
  t.deepEqual(
    s.log.slice(before).map(([kind]) => kind),
    [
      'row',
      'publish-dead',
      'holdTurn-dead',
      'startRound-dead',
      'open',
      'publish',
      'holdTurn',
      'startRound',
    ],
  );
  // Claimed after the fresh incarnation started: not in flight at the
  // restart, so the same round 0 goes to the fresh ports.
  t.is(receipt.turn.getStatus().state, 'running');
  const req = s.lastRound();
  t.is(req.round, 0);
  t.is(req.turn, receipt.turn);
  t.deepEqual(
    req.append
      .filter((/** @type {any} */ r) => r.kind === 'turn-started')
      .map((/** @type {any} */ r) => [r.kind, r.input]),
    [['turn-started', 'two']],
  );
  t.deepEqual(s.eventsOf(s.published.slice(-1)), ['turn-start', 'phase']);
  t.true(req.sink.dispatching(0));
  req.sink.roundFinal(result(0, 'fine'));
  await drain();
  t.is(receipt.turn.getStatus().state, 'completed');
  t.is(s.session.listPending().hold, undefined);
  t.deepEqual(historyKinds(s.session.getHistoryPage()), [
    'turn-started',
    'dispatched',
    'round-settled',
    'turn-settled',
  ]);
  // The next turn starts on the fresh ports without another open.
  await plainTurn(s, 'three', AT + 2000);
  t.is(s.kinds().filter(kind => kind === 'open').length, 2);
});

test('an open answered with ports of the incarnation that broke is asked again', async t => {
  const s = await setup({ manualOpen: true });
  s.opens[0].resolve(s.ports);
  await drain();
  await plainTurn(s, 'one');
  const fresh = s.restartAdapter(AT + 500);
  const receipt = s.session.enqueueOnce(
    harden({ text: 'two' }),
    requestId(),
    AT + 1000,
  );
  await drain();
  t.is(s.opens.length, 2, 'reopened after the lease broke');
  // A late answer from before the restart: the dead incarnation's ports.
  s.opens[1].resolve(s.ports);
  await drain();
  t.is(s.opens.length, 3, 'asked again');
  t.is(receipt.turn.getStatus().state, 'running');
  s.opens[2].resolve(fresh);
  await drain();
  t.is(startedOf(s.lastRound()).input, 'two');
  t.is(receipt.turn.getStatus().state, 'running');
});

test('a reopen that fails after a pre-dispatch break recovers the turn interrupted', async t => {
  const s = await setup({ manualOpen: true });
  s.opens[0].resolve(s.ports);
  await drain();
  const receipt = s.session.enqueueOnce(
    harden({ text: 'one' }),
    requestId(),
    AT,
  );
  s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
  await drain();
  s.leases[0].kit.reject(retired());
  await drain();
  t.is(receipt.turn.getStatus().state, 'running', 'waiting for fresh ports');
  s.opens[1].reject(Error('manager says no'));
  await drain();
  const status = receipt.turn.getStatus();
  t.is(status.state, 'interrupted');
  t.is(status.error, texts.interruptedBeforeDispatch);
  t.is(s.session.listPending().hold?.reason, 'restart');
});

test('a lease break after Dispatched recovers at once, without an open', async t => {
  const s = await setup();
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  s.restartAdapter(AT + 500);
  s.leases[0].kit.reject(retired());
  await drain();
  t.is(receipt.turn.getStatus().state, 'outcome-unknown');
  t.is(s.kinds().filter(kind => kind === 'open').length, 1, 'no reopen');
  // The held ports were dropped: the next claim opens fresh ones.
  receipt.turn.resolve('checked');
  await plainTurn(s, 'next', AT + 1000);
  t.is(s.kinds().filter(kind => kind === 'open').length, 2);
  t.is(startedOf(s.lastRound()).input, 'next');
});

test('an outside publish that breaks drops the held ports; the next claim opens', async t => {
  /** @type {any} */
  let queue;
  const s = await setup({
    makeQueue: (/** @type {any} */ options) => {
      queue = makeQueue(options);
      return queue;
    },
  });
  const first = s.session.enqueueOnce(harden({ text: 'one' }), requestId(), AT);
  await drain();
  const second = s.session.enqueueOnce(
    harden({ text: 'two' }),
    requestId(),
    AT,
  );
  queue.hold('stopped', texts.holdStopped);
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, 'done'));
  await drain();
  t.is(first.turn.getStatus().state, 'completed');
  t.is(s.session.getCurrentTurn(), undefined, 'held: nothing claimed');
  s.restartAdapter(AT + 500);
  // Idle: the cancel's `pending` goes out answered, and breaks.
  t.true(second.entry.cancel());
  await drain();
  t.true(s.kinds().includes('publish-dead'));
  t.is(s.liveChannelCalls(), 1, 'a fresh publisher for the batch');
  const before = s.log.length;
  await plainTurn(s, 'three', AT + 1000);
  t.deepEqual(
    s.log.slice(before, before + 5).map(([kind]) => kind),
    ['open', 'row', 'publish', 'holdTurn', 'startRound'],
    'no claim on the dead ports',
  );
});

// ---------------------------------------------------------------- contract fixes (J-9150)

test('blank submissions are refused with the fixed text; nothing is kept', async t => {
  const s = await setup();
  for (const text of ['', '   ', '\n\t ']) {
    const id = requestId();
    t.throws(() => s.session.enqueueOnce(harden({ text }), id, AT), {
      message: texts.blankSubmission,
    });
    t.is(s.session.getSubmissionReceipt(id), undefined);
    t.throws(() => s.session.startTurn(harden({ text }), AT), {
      message: texts.blankSubmission,
    });
  }
  t.deepEqual(s.session.listPending().entries, []);
  t.is(s.session.getCurrentTurn(), undefined);
  t.deepEqual(s.session.getHistoryPage().turns, []);
  // Text with content around blanks is kept exactly.
  const receipt = s.session.enqueueOnce(
    harden({ text: '  hi  ' }),
    requestId(),
    AT,
  );
  t.is(s.session.getCurrentTurn().input, '  hi  ');
  t.is(receipt.state, 'started');
});

test('Turn.resolve records one resolution; a second is refused', async t => {
  const s = await setup();
  const receipt = await submit(s);
  s.lastRound().sink.dispatching(0);
  s.leases[0].kit.reject(retired());
  await drain();
  t.is(receipt.turn.getStatus().state, 'outcome-unknown');
  receipt.turn.resolve('checked');
  t.throws(() => receipt.turn.resolve('again'), {
    message: texts.turnAlreadyResolved,
  });
  const kinds = historyKinds(s.session.getHistoryPage());
  t.is(kinds.filter(kind => kind === 'turn-resolved').length, 1);
  t.is(receipt.turn.getStatus().resolution, 'checked');
});

test('turn sources are not asked while the queue is held', async t => {
  /** @type {any} */
  let queue;
  let asked = 0;
  const source = () => {
    asked += 1;
    return harden({ text: 'from a source', at: AT });
  };
  const s = await setup({
    makeQueue: (/** @type {any} */ options) => {
      queue = makeQueue(options);
      return queue;
    },
    parts: harden([
      ...runtimeParts,
      harden({
        name: 'probe',
        make: () => harden({ hooks: harden({ nextTurn: source }) }),
      }),
    ]),
  });
  const first = s.session.enqueueOnce(harden({ text: 'one' }), requestId(), AT);
  await drain();
  s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
  queue.hold('stopped', texts.holdStopped);
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, 'done'));
  await drain();
  t.is(first.turn.getStatus().state, 'completed');
  t.is(asked, 0, 'a held queue holds the sources too');
  t.is(s.session.getCurrentTurn(), undefined);
  // Unheld: the next settle with an empty queue asks the source once.
  const listed = s.session.listPending().entries;
  t.true(listed[0].entry.cancel());
  const third = s.session.enqueueOnce(
    harden({ text: 'three' }),
    requestId(),
    AT,
  );
  await drain();
  t.is(third.state, 'started');
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, 'done'));
  await drain();
  t.is(asked, 1);
  t.is(s.session.getCurrentTurn()?.input, 'from a source');
});

test('a restart hold holds only the queue: a turn source still starts, its take runs before any record (WX.1, m9 S2)', async t => {
  /** @type {any} */
  let queue;
  /** @type {any[]} */
  const takes = [];
  let offered = false;
  /** @type {any} */
  let sessionRef;
  const source = () => {
    if (offered) return undefined;
    return harden({
      text: 'from a source',
      at: AT,
      take: (/** @type {any} */ info) => {
        offered = true;
        // Before TurnStarted: the session still shows the settled turn.
        takes.push([info.turnId, sessionRef.getCurrentTurn()]);
      },
    });
  };
  const s = await setup({
    makeQueue: (/** @type {any} */ options) => {
      queue = makeQueue(options);
      return queue;
    },
    parts: harden([
      ...runtimeParts,
      harden({
        name: 'probe',
        make: () => harden({ hooks: harden({ nextTurn: source }) }),
      }),
    ]),
  });
  sessionRef = s.session;
  // The source has nothing yet when the first turn is claimed.
  offered = true;
  const first = s.session.enqueueOnce(harden({ text: 'one' }), requestId(), AT);
  await drain();
  s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
  queue.hold('restart', texts.holdRestart);
  offered = false;
  s.lastRound().sink.dispatching(0);
  s.lastRound().sink.roundFinal(result(0, 'done'));
  await drain();
  t.is(first.turn.getStatus().state, 'completed');
  t.is(takes.length, 1);
  const [turnId, atTake] = takes[0];
  t.is(atTake, undefined, 'take ran before the turn was current');
  const current = s.session.getCurrentTurn();
  t.is(current?.input, 'from a source');
  t.is(current?.turn.getStatus().turnId, turnId);
  t.is(queue.holdReason(), 'restart', 'the queue stays held');
  t.is(s.session.listPending().entries.length, 1);
});

test('every other hold still holds a turn source with a take (WX.1, m9 S2)', async t => {
  for (const why of ['stopped', 'refused', 'interrupted', 'unavailable']) {
    /** @type {any} */
    let queue;
    let asked = 0;
    const source = () => {
      asked += 1;
      return harden({ text: 'from a source', at: AT, take: () => {} });
    };
    // eslint-disable-next-line no-await-in-loop
    const s = await setup({
      makeQueue: (/** @type {any} */ options) => {
        queue = makeQueue(options);
        return queue;
      },
      parts: harden([
        ...runtimeParts,
        harden({
          name: 'probe',
          make: () => harden({ hooks: harden({ nextTurn: source }) }),
        }),
      ]),
    });
    asked = 0;
    s.session.enqueueOnce(harden({ text: 'one' }), requestId(), AT);
    // eslint-disable-next-line no-await-in-loop
    await drain();
    s.session.enqueueOnce(harden({ text: 'two' }), requestId(), AT);
    queue.hold(why, texts.holdStopped);
    t.is(queue.holdReason(), why);
    s.lastRound().sink.dispatching(0);
    s.lastRound().sink.roundFinal(result(0, 'done'));
    // eslint-disable-next-line no-await-in-loop
    await drain();
    t.is(asked, 0, why);
    t.is(s.session.getCurrentTurn(), undefined, why);
  }
});
