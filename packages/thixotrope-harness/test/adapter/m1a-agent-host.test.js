// @ts-check
// The agent-host manager, attach, Endpoint, scripted provider and echo
// (M1a W1a.2; designs/m1a-interfaces.md sections 3.2, 3.3, 7 and 10), in
// Node with fake vat objects: the TurnSink, Turn and Session are local
// exos, and the manager kit is a fake that binds the real implementation.
import '../unit/_m1a-prelude.js';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  interfaces,
  shapes,
  texts,
  textOf,
} from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { fitsFrame, messageBytes } from '../../guest/lib/bounded.js';
import {
  HUB_RETIRED_MESSAGE,
  RETIRED_TEXT,
  isRetiredBreak,
} from '../../guest/lib/retired.js';
/* eslint-enable import/no-relative-packages */
import { make as makeManagerVat } from '../../resources/agent-host/durable.js';
import {
  findHarnessRoot,
  loadAgentHost,
} from '../../resources/agent-host/ephemeral.js';
import { makeAgentHostImpl } from '../../resources/agent-host/impl/index.js';
import {
  assertBackendKinds,
  backendKinds,
} from '../../resources/agent-host/impl/providers/kinds.js';
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import {
  generatedArgs,
  generatedKeys,
  makeScriptedProvider,
  scriptedUnexpectedFailure,
} from '../../resources/agent-host/impl/providers/scripted.js';
import { makeEchoTool } from '../../resources/agent-host/impl/tools/echo.js';
import { makeTestBlobs } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RETIRED = 'ocapn hub: the target session has been retired';
const timers = makeTimers();

/** @param {number} ms */
const sleep = ms => timers.delay(ms);

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
const until = async (predicate, ms = 3000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw Error('timed out waiting');
    // eslint-disable-next-line no-await-in-loop
    await sleep(5);
  }
};

const ZERO = harden({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
});

/**
 * A fake session-vat side of one turn: a guarded TurnSink that records
 * every call in `events` (shared with the log and the channel).
 * @param {{ dispatch?: boolean | (() => Promise<boolean>), events?: any[] }} [options]
 */
const makeFakeTurn = ({ dispatch = true, events = [] } = {}) => {
  // The folded Turn guard (M2 W2.0) has M1b's getContent.
  const turn = makeExo('Turn', interfaces.Turn, {
    getContent: () => harden({ records: [] }),
    getStatus: () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    cancel: () => undefined,
    whenFinished: async () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    resolve: () => undefined,
  });
  /** @type {any[]} */
  const finals = [];
  /** @type {any[]} */
  const failures = [];
  /** @type {any[]} */
  const deadlines = [];
  // A sink whose dispatching answers asynchronously (a rejection standing
  // for a lost session vat) is a plain Far: the guard's M.call answers
  // synchronously.
  /** @type {any} */
  const makeSink =
    typeof dispatch === 'function'
      ? (
          /** @type {string} */ label,
          /** @type {any} */ _i,
          /** @type {any} */ methods,
        ) => Far(label, methods)
      : makeExo;
  const sink = makeSink('TurnSink', interfaces.TurnSink, {
    /** @param {number} round */
    dispatching: round => {
      events.push(['dispatching', round]);
      if (typeof dispatch === 'function') return dispatch();
      return dispatch;
    },
    /** @param {any} result */
    roundFinal: result => {
      events.push(['roundFinal', result.round]);
      finals.push(result);
    },
    /** @param {any} failure */
    roundFailed: failure => {
      events.push(['roundFailed', failure.reason]);
      failures.push(failure);
    },
    /** @param {any} deadline */
    deadline: deadline => {
      events.push(['deadline', deadline.opId]);
      deadlines.push(deadline);
    },
    // The folded TurnSink guard (M2 W2.0) has M1b's progress.
    progress: () => false,
    // WX.1: the context window's method; nothing here asks to compact.
    compacted: () => harden({ go: false }),
  });
  return { turn, sink, events, finals, failures, deadlines };
};

/**
 * A RoundRequest for round `round` of a turn whose input is `input`.
 * @param {any} fake
 * @param {{ round?: number, input?: string, modelId?: string }} [options]
 */
const roundRequest = (fake, { round = 0, input = 'hi', modelId = 'm' } = {}) =>
  harden({
    turn: fake.turn,
    sink: fake.sink,
    turnId: 't1',
    round,
    base: { count: 0, epoch: 0 },
    append:
      round === 0 ? [{ kind: 'turn-started', turnId: 't1', input, at: 1 }] : [],
    tools: [],
    options: { modelId },
  });

/**
 * A provider + endpoint over a fake channel; log lines and deltas go to
 * `events` too, so the test sees one ordered history.
 * @param {any} script
 * @param {any[]} events
 * @param {{ blobs?: any }} [options] M1b: a blob store for staging
 */
const makeRig = (script, events, { blobs } = {}) => {
  /** @type {any[]} */
  const log = [];
  /**
   * @param {string} kind
   * @param {Record<string, unknown>} [fields]
   */
  const logFn = (kind, fields = {}) => {
    // `delta` and `round-start` lines are written on a later turn of the
    // event loop (perf, W1a.7); these tests check the order of the others.
    if (kind === 'delta' || kind === 'round-start') return;
    log.push({ kind, ...fields });
    events.push(['log', kind]);
  };
  const provider = makeScriptedProvider({
    label: 'scripted',
    script,
    timers,
    log: logFn,
    blobs,
  });
  /** @type {any[]} */
  const deltas = [];
  const channel = harden({
    /** @param {any} event */
    publishDelta: event => {
      deltas.push(event);
      events.push(['delta', event.text]);
    },
  });
  const endpoint = makeEndpoint({
    provider,
    channel,
    timers,
    unexpectedFailure: scriptedUnexpectedFailure,
  });
  return { provider, endpoint, log, deltas };
};

test('handshake order: dispatching(0) answered before the request, deltas before roundFinal', async t => {
  const fake = makeFakeTurn();
  const script = harden({
    turns: [
      {
        input: 'hi',
        rounds: [
          {
            chunks: [{ text: 'Hel' }, { text: 'lo' }, { text: '!' }],
            chunkDelayMs: 2,
            usage: { ...ZERO, inputTokens: 10, outputTokens: 5 },
          },
        ],
      },
    ],
  });
  const { endpoint, deltas } = makeRig(script, fake.events);
  const lease = E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => fake.finals.length === 1);
  t.deepEqual(fake.events, [
    ['dispatching', 0],
    ['log', 'request'],
    ['delta', 'Hel'],
    ['delta', 'lo'],
    ['delta', '!'],
    ['log', 'round-final'],
    ['roundFinal', 0],
  ]);
  const [result] = fake.finals;
  t.is(result.text, 'Hello!');
  t.deepEqual(result.servedBy, { label: 'scripted', modelId: 'm' });
  t.is(result.usage.inputTokens, 10);
  t.true(matches(result, shapes.RoundResult));
  t.true(deltas.every(delta => matches(delta, shapes.DeltaEvent)));
  // The lease is still pending until releaseTurn.
  let settled = false;
  void lease.then(() => {
    settled = true;
  });
  await sleep(20);
  t.false(settled);
  E.sendOnly(endpoint).releaseTurn(fake.turn);
  await lease;
  t.true(true);
});

test('dispatching(0) answered false: no request, no deltas, nothing sent', async t => {
  const fake = makeFakeTurn({ dispatch: false });
  const script = harden({
    turns: [{ rounds: [{ chunks: [{ text: 'never' }] }] }],
  });
  const { endpoint, log, deltas } = makeRig(script, fake.events);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => log.length === 1);
  await sleep(20);
  t.deepEqual(
    log.map(line => line.kind),
    ['dispatch-refused'],
  );
  t.is(deltas.length, 0);
  t.is(fake.finals.length + fake.failures.length, 0);
});

test('dispatching(0) rejected (session vat lost): the round is abandoned', async t => {
  const fake = makeFakeTurn({
    dispatch: async () => {
      throw Error(RETIRED);
    },
  });
  const script = harden({ turns: [{ rounds: [{ chunks: [{ text: 'x' }] }] }] });
  const { endpoint, log } = makeRig(script, fake.events);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => log.length === 1);
  t.is(log[0].kind, 'dispatch-refused');
  t.is(fake.finals.length + fake.failures.length, 0);
});

test('lease: one pending lease per turn; settles at release; no round without it', async t => {
  const fake = makeFakeTurn();
  const script = harden({
    turns: [
      { rounds: [{ chunks: [{ text: 'a' }] }, { chunks: [{ text: 'b' }] }] },
    ],
  });
  const { endpoint, log } = makeRig(script, fake.events);
  // startRound before holdTurn is parked, not run.
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await sleep(30);
  t.is(fake.events.length, 0, 'nothing ran without the lease');
  const first = E(endpoint).holdTurn(fake.turn);
  const second = E(endpoint).holdTurn(fake.turn);
  await until(() => fake.finals.length === 1);
  t.is(log.filter(line => line.kind === 'request').length, 1);
  let settled = 0;
  void first.then(() => {
    settled += 1;
  });
  void second.then(() => {
    settled += 1;
  });
  await sleep(20);
  t.is(settled, 0);
  E.sendOnly(endpoint).releaseTurn(fake.turn);
  await Promise.all([first, second]);
  t.is(settled, 2);
  // A round for a released turn is ignored; a lease for it settles at once.
  E.sendOnly(endpoint).startRound(roundRequest(fake, { round: 1 }));
  await E(endpoint).holdTurn(fake.turn);
  await sleep(30);
  t.is(fake.finals.length, 1);
  t.is(log.filter(line => line.kind === 'request').length, 1);
});

test('rounds after round 0 follow the script turn chosen at round 0', async t => {
  const fake = makeFakeTurn();
  const script = harden({
    turns: [
      { input: 'other', rounds: [{ chunks: [{ text: 'wrong' }] }] },
      {
        rounds: [
          { chunks: [{ text: 'r0' }], toolCalls: [{ name: 'echo' }] },
          { chunks: [{ text: 'r1' }] },
        ],
      },
    ],
  });
  const { endpoint, log } = makeRig(script, fake.events);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => fake.finals.length === 1);
  t.is(fake.finals[0].text, 'r0');
  t.deepEqual(fake.finals[0].toolCalls, [
    { callId: '', name: 'echo', args: '{}' },
  ]);
  E.sendOnly(endpoint).startRound(roundRequest(fake, { round: 1 }));
  await until(() => fake.finals.length === 2);
  t.is(fake.finals[1].text, 'r1');
  t.is(
    fake.events.filter(([kind]) => kind === 'dispatching').length,
    1,
    'dispatching only before round 0',
  );
  E.sendOnly(endpoint).startRound(roundRequest(fake, { round: 2 }));
  await until(() => fake.failures.length === 1);
  t.is(fake.failures[0].reason, textOf.scriptExhausted(2));
  t.deepEqual(
    log.map(line => line.kind),
    ['request', 'round-final', 'request', 'round-final', 'round-failed'],
  );
});

// M1b (W1b.1): a 64 KiB reply is staged now; a round of 300 tool calls is
// what still cannot be sent (m1b-interfaces.md 5.4).
test('frame limit: a round of 300 tool calls fails before any message reaches the vat', async t => {
  const fake = makeFakeTurn();
  const toolCalls = Array.from({ length: 300 }, () => ({ name: 'echo' }));
  const script = harden({
    turns: [
      { rounds: [{ chunks: [{ text: 'x', repeat: 65_536 }], toolCalls }] },
    ],
  });
  const { endpoint, log, deltas } = makeRig(script, fake.events);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => fake.failures.length === 1);
  t.is(fake.finals.length, 0);
  t.is(fake.failures[0].reason, texts.frameLimit);
  t.true(matches(fake.failures[0], shapes.RoundFailure));
  t.deepEqual(
    log.map(line => line.kind),
    ['request', 'frame-limit'],
  );
  // The delta itself streamed in-process (it never enters a vat).
  t.is(deltas[0].text.length, 65_536);
});

test('scripted error: roundFailed carries the partial text cut to fit the frame', async t => {
  const fake = makeFakeTurn();
  const script = harden({
    turns: [
      {
        rounds: [
          {
            chunks: [{ text: '€', repeat: 20_000 }],
            error: 'scripted failure',
          },
        ],
      },
    ],
  });
  const { endpoint } = makeRig(script, fake.events);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => fake.failures.length === 1);
  const failure = /** @type {{ reason: string, partial: string }} */ (
    fake.failures[0]
  );
  t.is(failure.reason, 'scripted failure');
  t.true(failure.partial.length > 0);
  t.true(messageBytes(failure) + 'roundFailed'.length <= limits.frameBytes);
  t.true('€'.repeat(20_000).startsWith(failure.partial));
  t.true(matches(failure, shapes.RoundFailure));
});

test('stall until cancel: cancelRound stops the round silently; release stops it without a log', async t => {
  const fake = makeFakeTurn();
  const script = harden({
    turns: [
      { rounds: [{ chunks: [{ text: 'thinking' }], stall: 'untilCancel' }] },
    ],
  });
  const { endpoint, log } = makeRig(script, fake.events);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => log.some(line => line.kind === 'request'));
  await sleep(30);
  t.is(fake.finals.length + fake.failures.length, 0);
  E.sendOnly(endpoint).cancelRound(fake.turn);
  await until(() => log.some(line => line.kind === 'cancelled'));
  t.is(fake.finals.length + fake.failures.length, 0);

  const other = makeFakeTurn();
  const rig = makeRig(script, other.events);
  void E(rig.endpoint).holdTurn(other.turn);
  E.sendOnly(rig.endpoint).startRound(roundRequest(other));
  await until(() => rig.log.some(line => line.kind === 'request'));
  E.sendOnly(rig.endpoint).releaseTurn(other.turn);
  await sleep(30);
  t.deepEqual(
    rig.log.map(line => line.kind),
    ['request'],
  );
  t.is(other.finals.length + other.failures.length, 0);
});

test('cancel during the dispatch delay sends nothing to the provider', async t => {
  const fake = makeFakeTurn();
  const script = harden({
    turns: [{ rounds: [{ dispatchDelayMs: 200, chunks: [{ text: 'x' }] }] }],
  });
  const { endpoint, log } = makeRig(script, fake.events);
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await sleep(20);
  E.sendOnly(endpoint).cancelRound(fake.turn);
  await until(() => log.length === 1);
  t.deepEqual(
    log.map(line => line.kind),
    ['cancelled'],
  );
  t.false(fake.events.some(([kind]) => kind === 'dispatching'));
});

test('tool arguments stay text: 2,000 keys reach the vat as one string and echo intact', async t => {
  const fake = makeFakeTurn();
  const script = harden({
    turns: [
      {
        rounds: [
          {
            toolCalls: [
              { name: 'echo', callId: 'c1', argsKeys: 2000 },
              { name: 'echo', args: '{"text":"a"}' },
            ],
          },
        ],
      },
    ],
  });
  // M1b (W1b.1): 2,000 keys are about 19 KB, over inlineBytes: staged.
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const { endpoint } = makeRig(script, fake.events, { blobs: blobs.store });
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => fake.finals.length === 1);
  const [result] = fake.finals;
  t.true(matches(result, shapes.RoundResult), 'closed shape, fixed keys');
  const [many, plain] = result.toolCalls;
  t.is(many.args.bytes, generatedArgs(2000).length, 'staged, exact bytes');
  const full = await blobs.store.read(many.args.blob);
  t.is(full, generatedArgs(2000));
  t.is(Object.keys(JSON.parse(full).data).length, 2000);
  t.is(many.callId, 'c1');
  t.deepEqual(plain, { callId: '', name: 'echo', args: '{"text":"a"}' });

  /** @type {any[]} */
  const echoLog = [];
  const echo = makeEchoTool({
    timers,
    log: (kind, fields = {}) => echoLog.push({ kind, ...fields }),
    blobs: blobs.store,
  });
  const outcome = await E(echo).execute(
    harden({ opId: 't1/r0/c0', args: many.args }),
  );
  t.deepEqual(outcome, { status: 'ok', text: '' });
  t.is(echoLog[0].kind, 'echo-start');
  t.is(echoLog[0].units, full.length, 'echo read the staged arguments');
  t.is(echoLog[1].kind, 'echo-end');
});

test('echo: text, bytes, delay, and the output bounds', async t => {
  /** @type {any[]} */
  const echoLog = [];
  const blobs = makeTestBlobs();
  t.teardown(blobs.cleanup);
  const echo = makeEchoTool({
    timers,
    log: (kind, fields = {}) => echoLog.push({ kind, ...fields }),
    blobs: blobs.store,
  });
  /** @param {string} args */
  const run = args => E(echo).execute(harden({ opId: 'op', args }));

  t.deepEqual(await run('{"text":"hello"}'), { status: 'ok', text: 'hello' });
  const cut = await run('{"text":"ab","bytes":5}');
  t.deepEqual(cut, { status: 'ok', text: 'ababa' });
  const xs = await run('{"bytes":3}');
  t.is(xs.text, 'xxx');
  // Surrogate-safe: a pair is never split.
  const emoji = await run(JSON.stringify({ text: '😀', bytes: 3 }));
  t.is(emoji.text, '😀');

  const t0 = Date.now();
  await run('{"text":"slow","delayMs":120}');
  t.true(Date.now() - t0 >= 110);

  // R4-46: cut in the callee with the marker. M1b (W1b.1): an output over
  // inlineBytes is staged (256-unit preview) instead of hitting the frame.
  const big = await run('{"bytes":20000}');
  t.is(big.status, 'ok');
  t.is(big.text.bytes, 20_000);
  t.is(big.text.preview, 'x'.repeat(limits.toolPreviewUnits));
  t.is((await blobs.store.read(big.text.blob)).length, 20_000);
  const bounded = await run(JSON.stringify({ text: 'é', bytes: 40_000 }));
  t.is(bounded.status, 'ok');
  const boundedText = await blobs.store.read(bounded.text.blob);
  t.is(boundedText.length, limits.toolOutputUnits);
  t.true(boundedText.endsWith(textOf.truncationMarker(40_000)));
  const huge = await run('{"bytes":300000}');
  const marker = textOf.truncationMarker(300_000);
  const hugeText = await blobs.store.read(huge.text.blob);
  t.is(hugeText.length, limits.toolOutputUnits);
  t.true(hugeText.endsWith(marker));
  t.is(echoLog.filter(line => line.kind === 'echo-frame-limit').length, 0);
});

test('echo: argument errors use the R4-43 / R4-45 texts, answered as failed outcomes', async t => {
  /** @type {any[]} */
  const echoLog = [];
  const echo = makeEchoTool({
    timers,
    log: (kind, fields) => echoLog.push({ kind, ...fields }),
  });
  /** @param {string} args */
  const run = args => E(echo).execute(harden({ opId: 'op', args }));
  /** @param {string} text */
  const failed = text => harden({ status: 'failed', text });
  const notJson = await run('{nope');
  t.is(notJson.status, 'failed');
  t.regex(
    notJson.text,
    /^could not parse tool arguments as JSON \(.+\)\. Re-send this tool call with valid JSON arguments\.$/,
  );
  t.deepEqual(
    await run('[1]'),
    failed(textOf.invalidArgument('args', 'echo', 'a JSON object')),
  );
  t.deepEqual(
    await run('null'),
    failed(textOf.invalidArgument('args', 'echo', 'a JSON object')),
  );
  t.deepEqual(
    await run('{"text":"a","colour":1}'),
    failed(
      textOf.unexpectedArgument('colour', 'echo', [
        'text',
        'delayMs',
        'bytes',
        'data',
      ]),
    ),
  );
  t.deepEqual(
    await run('{"text":5}'),
    failed(textOf.invalidArgument('text', 'echo', 'a string')),
  );
  t.deepEqual(
    await run('{"delayMs":-1}'),
    failed(
      textOf.invalidArgument(
        'delayMs',
        'echo',
        `a number from 0 to ${limits.maxDelayMs}`,
      ),
    ),
  );
  t.deepEqual(
    await run('{"bytes":"9"}'),
    failed(
      textOf.invalidArgument(
        'bytes',
        'echo',
        `a number from 0 to ${limits.echoMaxUnits}`,
      ),
    ),
  );
  t.deepEqual(
    echoLog.map(line => line.kind),
    [...Array(7)].flatMap(() => ['echo-start', 'echo-failed']),
  );
});

test('echo: an argument error that quotes the hub break text is not a break (QC 1)', async t => {
  const echo = makeEchoTool({ timers });
  /** @param {string} args */
  const run = args => E(echo).execute(harden({ opId: 'op', args }));
  // Before QC 1 both of these rejected with an Error whose message contained
  // the retired text, which the session took for a daemon restart.
  const outcomes = await Promise.all(
    [`{"${HUB_RETIRED_MESSAGE}":1}`, `${HUB_RETIRED_MESSAGE}`].map(run),
  );
  for (const outcome of outcomes) {
    t.is(outcome.status, 'failed');
    t.false(isRetiredBreak(Error(outcome.text)));
  }
  const quoted = await run(`{"${HUB_RETIRED_MESSAGE}":1}`);
  t.true(quoted.text.includes(RETIRED_TEXT), 'the R4-43 text quotes the key');
  // An argument error whose text is over the frame (60 KB) is cut to fit.
  const huge = await run(`{"${'\u20ac'.repeat(20_000)}":1}`);
  t.is(huge.status, 'failed');
  t.true(String(huge.text).length < 20_000);
  t.true(fitsFrame(huge));
});

/**
 * Timers fired by hand, so a test of deadline order does not depend on how
 * late the real timers run under load (QC finding 2: with real timers, a
 * 10 ms timer ran 50-80 ms late in the full lane, the 60 ms one fired
 * before the test released the turn, and `deadlines.length === 1` was
 * never seen).
 */
const makeManualTimers = () => {
  /** @type {{ ms: number, fn: () => void, cancelled: boolean, fired: boolean }[]} */
  const pending = [];
  const after = (/** @type {number} */ ms, /** @type {() => void} */ fn) => {
    const entry = { ms, fn, cancelled: false, fired: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  /** Fire every live timer due by `ms`, in due order. */
  const runUntil = (/** @type {number} */ ms) => {
    for (const entry of [...pending].sort((x, y) => x.ms - y.ms)) {
      if (entry.ms <= ms && !entry.cancelled && !entry.fired) {
        entry.fired = true;
        entry.fn();
      }
    }
  };
  return {
    timers: harden({ after, delay: () => Promise.resolve() }),
    pending,
    runUntil,
  };
};

test('deadlines: armDeadline calls sink.deadline; disarm and release cancel', async t => {
  const fake = makeFakeTurn();
  const script = harden({ turns: [{ rounds: [{ stall: 'untilCancel' }] }] });
  const provider = makeScriptedProvider({
    label: 'scripted',
    script,
    timers,
    log: () => {},
  });
  const manual = makeManualTimers();
  const endpoint = makeEndpoint({
    provider,
    channel: harden({ publishDelta: () => {} }),
    timers: manual.timers,
    unexpectedFailure: scriptedUnexpectedFailure,
  });
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => fake.events.some(([kind]) => kind === 'dispatching'));
  E.sendOnly(endpoint).armDeadline(
    harden({ turn: fake.turn, opId: 'a', ms: 10 }),
  );
  E.sendOnly(endpoint).armDeadline(
    harden({ turn: fake.turn, opId: 'b', ms: 30 }),
  );
  E.sendOnly(endpoint).disarm(harden({ turn: fake.turn, opId: 'b' }));
  E.sendOnly(endpoint).armDeadline(
    harden({ turn: fake.turn, opId: 'c', ms: 60 }),
  );
  await until(() => manual.pending.length === 3);
  t.deepEqual(
    manual.pending.map(entry => [entry.ms, entry.cancelled]),
    [
      [10, false],
      [30, true],
      [60, false],
    ],
    'disarm cancelled b',
  );
  manual.runUntil(30);
  await until(() => fake.deadlines.length === 1);
  t.is(fake.deadlines[0].opId, 'a');
  E.sendOnly(endpoint).releaseTurn(fake.turn);
  await until(() => manual.pending[2].cancelled);
  manual.runUntil(Infinity);
  await sleep(20);
  t.deepEqual(
    fake.deadlines.map(deadline => deadline.opId),
    ['a'],
    'release cancelled c; the disarmed b never fired',
  );
});

test("provider throwing fails the round with the kind's fixed text, never the error message (HR-SYN-12)", async t => {
  const fake = makeFakeTurn();
  const endpoint = makeEndpoint({
    provider: harden({
      startRound: async () => {
        throw Error('boom: a provider body');
      },
      cancelRound: () => {},
    }),
    channel: harden({ publishDelta: () => {} }),
    timers,
    unexpectedFailure: scriptedUnexpectedFailure,
  });
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(roundRequest(fake));
  await until(() => fake.failures.length === 1);
  t.is(fake.failures[0].reason, 'scripted provider failed');
  t.is(scriptedUnexpectedFailure, 'scripted provider failed');
});

test('an Endpoint without the fixed failure text is refused (HR-SYN-12)', t => {
  const provider = harden({
    startRound: async () => {},
    cancelRound: () => {},
  });
  const channel = harden({ publishDelta: () => {} });
  t.throws(
    () => makeEndpoint(/** @type {any} */ ({ provider, channel, timers })),
    {
      message: /unexpectedFailure/,
    },
  );
  t.throws(
    () => makeEndpoint({ provider, channel, timers, unexpectedFailure: '' }),
    { message: /unexpectedFailure/ },
  );
});

test('every backend kind names its fixed failure text; a kind without one is refused when the incarnation is made (HR-SYN-12)', t => {
  for (const kind of backendKinds) {
    t.is(typeof kind.unexpectedFailure, 'string', kind.kind);
    t.true(kind.unexpectedFailure.length > 0, kind.kind);
    // HR-SYN-3 (a): the kind chooses its catalogue (no kind string is
    // matched outside the table).
    t.is(typeof kind.catalog, 'function', kind.kind);
  }
  const bare = harden({
    kind: 'bare',
    makeProvider: () => {
      throw Error('not made');
    },
    tools: [],
  });
  t.throws(() => assertBackendKinds(/** @type {any} */ ([bare])), {
    message: 'backend kind "bare" has no unexpectedFailure text',
  });
  t.throws(
    () =>
      makeAgentHostImpl({
        kinds: /** @type {any} */ ([...backendKinds, bare]),
      }),
    { message: 'backend kind "bare" has no unexpectedFailure text' },
  );
});

/** State directories of the fake manager kits, removed after the file. */
/** @type {string[]} */
const kitStateDirs = [];
test.after.always(() => {
  for (const dir of kitStateDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake of the core's manager kit (pkg/src/native/manager-kit.js): one
 * registration, bound by a fresh implementation per "incarnation". A
 * restart retires the incarnation's ops (every call breaks with the
 * retired text) without telling the manager vat, as a SIGKILL does.
 */
const makeFakeManagerKit = () => {
  // Every incarnation keeps its files in one state directory, as a daemon's
  // do across restarts (HR-SYN-9: a store with no directory reports a
  // failed sweep).
  const stateDir = mkdtempSync(join(tmpdir(), 'w1a2-kit-'));
  kitStateDirs.push(stateDir);
  let registers = 0;
  let incarnations = 0;
  /** @type {{ retired: boolean, impl: any } | undefined} */
  let current;
  /** @type {any} */
  let desiredSpec;
  const bindFresh = async () => {
    incarnations += 1;
    const incarnation = {
      retired: false,
      impl: makeAgentHostImpl({ stateDir }),
    };
    current = incarnation;
    /** @param {() => any} fn */
    const guard = fn => {
      if (incarnation.retired) throw Error(RETIRED);
      return fn();
    };
    const { ops } = incarnation.impl;
    const wrapper = Far('AgentHostOps', {
      /** @param {any} request */
      open: request => guard(() => E(ops).open(request)),
      /** @param {any} session */
      liveChannel: session => guard(() => E(ops).liveChannel(session)),
      live: () => guard(() => E(ops).live()),
      composer: () => guard(() => E(ops).composer()),
    });
    await E(desiredSpec.sink).attach(wrapper, `fake-${incarnations}`);
  };
  /** @param {any} _options */
  const makeManager = _options =>
    harden({
      /**
       * @param {unknown} key
       * @param {any} spec
       */
      register: async (key, spec) => {
        registers += 1;
        desiredSpec = spec;
        if (current === undefined || current.retired) await bindFresh();
        return harden({ handle: {}, status: { key, status: 'bound' } });
      },
      keys: () => harden(['agent-host']),
      lifecycle: Far('ManagerLifecycle', {
        started: async () => {
          if (desiredSpec !== undefined && (current?.retired ?? true))
            await bindFresh();
        },
        exited: async () => {},
      }),
    });
  return {
    makeManager,
    restart: () => {
      if (current) current.retired = true;
    },
    counts: () => ({ registers, incarnations }),
  };
};

test('manager: backends, host facets and TurnPorts through the attach pattern', async t => {
  const kit = makeFakeManagerKit();
  const { facet: admin, lifecycle } = makeManagerVat({
    makeManager: kit.makeManager,
  });
  const script = harden({
    turns: [{ rounds: [{ chunks: [{ text: 'hi' }] }] }],
  });
  const backend = await E(admin).makeBackend(
    harden({ kind: 'scripted', label: 'Scripted', script }),
  );
  t.deepEqual(await E(backend).describe(), {
    kind: 'scripted',
    label: 'Scripted',
  });
  t.is(kit.counts().registers, 0, 'no adapter until one is needed');

  const host = await E(admin).forSession();
  await t.throwsAsync(E(backend).open(Far('SessionHostFacet', {})), {
    message: texts.unknownSessionHost,
  });
  // A minted host not bound yet: the session opens its ports in make,
  // before the factory binds the facet (contract 6.1), so open waits.
  const early = E(backend).open(host);
  let earlySettled = false;
  early.then(
    () => {
      earlySettled = true;
    },
    () => {
      earlySettled = true;
    },
  );
  await sleep(20);
  t.false(earlySettled, 'open waits for the bind');
  const session = Far('Session', {});
  await E(admin).bindSession(host, session);
  const earlyPorts = await early;
  t.true(matches(earlyPorts, shapes.TurnPorts));
  await E(admin).bindSession(host, session); // idempotent
  await t.throwsAsync(E(admin).bindSession(host, Far('Session', {})), {
    message: /bound to another session/,
  });
  await t.throwsAsync(E(admin).bindSession(Far('Stranger', {}), session), {
    message: texts.unknownSessionHost,
  });

  const ports = await E(backend).open(host);
  t.true(matches(ports, shapes.TurnPorts));
  t.is(ports.since, earlyPorts.since, 'one incarnation, one since');
  t.true(Number(ports.since) <= Date.now());
  t.deepEqual(
    ports.tools.map((/** @type {any} */ entry) => entry.name),
    // M8 (S-18): every kind's ports also carry viewImage.
    ['echo', 'viewImage'],
  );
  t.deepEqual(kit.counts(), { registers: 1, incarnations: 1 });
  const publisher = await E(host).liveChannel();
  t.is(publisher, ports.publisher, 'one channel per Session presence');
  const live = await E(admin).live();
  const composer = await E(admin).composer();
  t.truthy(live);
  t.truthy(composer);

  // The turn runs over the ports: echo answers through them.
  const outcome = await E(ports.tools[0].tool).execute(
    harden({ opId: 'op', args: '{"text":"x"}' }),
  );
  t.deepEqual(outcome, { status: 'ok', text: 'x' });

  // Restart: the held ops facet is retired; the next open reconciles once
  // and gets ports from a fresh incarnation; old ports stay dead.
  kit.restart();
  const fresh = await E(backend).open(host);
  t.true(matches(fresh, shapes.TurnPorts));
  t.not(fresh.endpoint, ports.endpoint);
  t.true(Number(fresh.since) >= Number(ports.since), 'a later incarnation');
  t.deepEqual(kit.counts(), { registers: 2, incarnations: 2 });

  // Start listeners hear every start, after the restore.
  /** @type {string[]} */
  const heard = [];
  const listener = Far('StartListener', {
    started: () => {
      heard.push('started');
    },
  });
  const registration = await E(admin).onStart(listener);
  kit.restart();
  await E(lifecycle).started();
  await until(() => heard.length === 1);
  t.deepEqual(kit.counts(), { registers: 2, incarnations: 3 });
  await E(registration).cancel();
  await E(lifecycle).started();
  await sleep(20);
  t.is(heard.length, 1);
});

test('manager: refuses specs the contract does not admit', async t => {
  const kit = makeFakeManagerKit();
  const { facet: admin } = makeManagerVat({ makeManager: kit.makeManager });
  await t.throwsAsync(
    E(admin).makeBackend(
      /** @type {any} */ (
        harden({ kind: 'openrouter', label: 'x', script: { turns: [] } })
      ),
    ),
  );
  await t.throwsAsync(
    E(admin).makeBackend(
      /** @type {any} */ (
        harden({
          kind: 'scripted',
          label: 'x',
          script: { turns: [] },
          extra: 1,
        })
      ),
    ),
  );
  // A spec within every guard bound but over the frame as a whole.
  const big = 'y'.repeat(5000);
  const turns = Array.from({ length: 6 }, () => ({
    rounds: [{ chunks: [{ text: big }] }],
  }));
  await t.throwsAsync(
    E(admin).makeBackend(
      harden({ kind: 'scripted', label: 'x', script: { turns } }),
    ),
    { message: texts.frameLimit },
  );
});

test('scripted backend writes its event log as fsynced JSON lines', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'w1a2-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const logPath = join(dir, 'events.jsonl');
  const impl = makeAgentHostImpl({ stateDir: dir });
  const fake = makeFakeTurn();
  const backend = Far('Backend', {});
  const session = Far('Session', {});
  const spec = harden({
    kind: 'scripted',
    label: 'Logged',
    logPath,
    script: {
      turns: [
        {
          rounds: [
            {
              chunks: [{ text: 'a' }],
              toolCalls: [{ name: 'echo', args: '{"text":"z"}' }],
            },
          ],
        },
      ],
    },
  });
  const ports = await E(impl.ops).open(harden({ backend, spec, session }));
  void E(ports.endpoint).holdTurn(fake.turn);
  E.sendOnly(ports.endpoint).startRound(roundRequest(fake));
  await until(() => fake.finals.length === 1);
  await E(ports.tools[0].tool).execute(
    harden({ opId: 't1/r0/c0', args: '{"text":"z"}' }),
  );
  // The delta and round-start lines are written on a later turn of the
  // event loop.
  await new Promise(wake => setTimeout(wake, 20));
  const all = readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const deltas = all.filter(line => line.kind === 'delta');
  t.is(deltas.length, 1);
  t.like(deltas[0], { turnId: 't1', round: 0, units: 1 });
  t.like(
    all.find(line => line.kind === 'round-start'),
    { turnId: 't1', round: 0 },
  );
  // M1b W1b.2: a `context` line per round (what the provider received),
  // written off the round's path like `delta` and `round-start`.
  t.like(
    all.find(line => line.kind === 'context'),
    { turnId: 't1', round: 0 },
  );
  const lines = all.filter(
    line =>
      line.kind !== 'delta' &&
      line.kind !== 'round-start' &&
      line.kind !== 'context',
  );
  const [publishedAt, requestAt, finalAt] = [
    deltas[0].at,
    lines[0].at,
    lines[1].at,
  ].map(Number);
  t.true(publishedAt >= requestAt && publishedAt <= finalAt);
  t.deepEqual(
    lines.map(line => line.kind),
    ['request', 'round-final', 'echo-start', 'echo-end'],
  );
  t.true(
    lines.every(line => line.label === 'Logged' && line.pid === process.pid),
  );
  t.is(lines[2].args, '{"text":"z"}');
  t.is(lines[2].opId, 't1/r0/c0');
  // The same backend presence keeps its provider (and log) across opens.
  const again = await E(impl.ops).open(harden({ backend, spec, session }));
  t.is(again.tools[0].tool, ports.tools[0].tool);
  t.is(again.publisher, ports.publisher);
});

test('loader: finds the implementation and returns an adapter that attaches', async t => {
  t.is(
    findHarnessRoot(
      join(
        harnessRoot,
        '..',
        'thixotrope',
        'src',
        'platform',
        'node',
        'adapter-process-entry.js',
      ),
    ),
    harnessRoot,
  );
  t.throws(() => findHarnessRoot('/nowhere/a/b/c/d/entry.js'), {
    message: /no implementation under/,
  });
  const stateDir = mkdtempSync(join(tmpdir(), 'w1a2-load-'));
  t.teardown(() => rmSync(stateDir, { recursive: true, force: true }));
  const adapter = loadAgentHost({ harnessRoot, implOptions: { stateDir } });
  /** @type {any[]} */
  const attached = [];
  const sink = Far('AgentHostSink', {
    /**
     * @param {any} ops
     * @param {string} incarnation
     */
    attach: (ops, incarnation) => {
      attached.push({ ops, incarnation });
      return attached.length;
    },
  });
  await E(adapter).bind('agent-host', harden({ sink }), 1n);
  t.is(attached.length, 1);
  t.regex(attached[0].incarnation, /^\d+-[0-9a-f]{8}$/);
  // A repeated bind under the same epoch changes nothing.
  await E(adapter).bind('agent-host', harden({ sink }), 1n);
  t.is(attached.length, 1);
  await t.throwsAsync(E(adapter).bind('other', harden({ sink }), 2n), {
    message: /no registration "other"/,
  });
});

test('generatedKeys builds a flood of fresh keys in the adapter (J-9381)', t => {
  t.is(
    generatedKeys({ prefix: 'r', from: 5, count: 3 }),
    '{"r5":5,"r6":6,"r7":7}',
  );
  const many = JSON.parse(generatedKeys({ prefix: 'x', from: 0, count: 1000 }));
  t.is(Object.keys(many).length, 1000);
  t.is(generatedKeys({ prefix: 'x', from: 0, count: 0 }), '{}');
});
