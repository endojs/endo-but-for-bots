// @ts-check
// M2 W2.6 turn completeness (designs/m2-interfaces.md 10; milestones.md M2
// acceptance 2, 3, 6's vat side and 12) in Node, on the real pieces: the
// session program (guest/session/session.js, under the guest prelude), the
// Endpoint, the streamed OpenRouter provider against the fake provider
// server on 127.0.0.1 (D-M2-4), the context cache and projection, and the
// echo tool. Only the manager vat (Backend.open) and the list row are
// fakes. What the model would see is read where it arrives: the request
// bodies the fake server recorded.
//
// - R4-43 / R4-45: an unknown tool and bad JSON arguments get their exact
//   texts, the turn continues, and the next request carries them.
// - R4-42: a call without an id gets `floot-synth-<round>-<index>`.
// - R4-47: at the round limit the turn ends `completed` with the fixed text.
// - R4-7 / R4-49: cancel tears down the provider stream (the server sees the
//   connection close); late results are ignored; a running tool is not
//   interrupted and its result is recorded.
// - R4-32: failed and outcome-unknown turns enter the next request; a turn
//   never dispatched does not.
// - R4-33 / R4-83: five counts summed per turn, the context reading, the
//   `usage` event, `getUsage()` and `usageOfRecords` agree.
// - The turn deadline (seam 4, default off): a turn past it fails with
//   `textOf.turnDeadline(ms)` and its request is torn down.
import '../unit/_m1a-prelude.js';

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { RETIRED_TEXT } from '../../guest/lib/retired.js';
import { addUsage, usageFromOpenRouter } from '../../guest/lib/token-usage.js';
import { usageOfRecords } from '../../guest/lib/journal-usage.js';
import { makeSession } from '../../guest/session/session.js';
/* eslint-enable import/no-relative-packages */
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import { makeChannelRegistry } from '../../resources/agent-host/impl/channels.js';
import { makeContextCache } from '../../resources/agent-host/impl/context-cache.js';
import { makeEchoTool } from '../../resources/agent-host/impl/tools/echo.js';
import { makeOpenRouterProvider } from '../../resources/agent-host/impl/providers/openrouter.js';
import {
  openRouterChunks,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import { makeTestBlobs } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

const timers = makeTimers();
const MODEL = 'fake-org/fake-model';
const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;
const RAW_USAGE = harden({
  prompt_tokens: 12,
  completion_tokens: 7,
  total_tokens: 19,
});

/**
 * @param {() => unknown} predicate
 * @param {string} what
 * @param {number} [ms]
 */
const until = async (predicate, what, ms = 10_000) => {
  const t0 = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - t0 > ms) throw Error(`timed out waiting for ${what}`);
    // eslint-disable-next-line no-await-in-loop
    await timers.delay(5);
  }
};

let dirSerial = 0;

/**
 * One session on the real turn path with an OpenRouter backend against the
 * fake server. `backend.open` hands out a fresh incarnation's ports each
 * time it is asked (the session asks again after a restart signal).
 * @param {import('ava').ExecutionContext} t
 * @param {object} [options]
 * @param {number} [options.maxToolRounds]
 * @param {Record<string, any>} [options.config] SessionConfig additions
 */
const setup = async (t, { maxToolRounds, config: extra = {} } = {}) => {
  const server = await startFakeProviderServer();
  dirSerial += 1;
  const dir = join(harnessTmp, `w26-${process.pid}-${dirSerial}`);
  mkdirSync(dir, { recursive: true });
  const blobs = makeTestBlobs({ dir });
  // Last (teardowns run in reverse): after the server closed and a round
  // still running had its moment to stage, so nothing recreates the dir.
  t.teardown(async () => {
    await timers.delay(100);
    blobs.cleanup();
  });
  t.teardown(server.close);
  /** @type {any[]} */
  const log = [];
  const record = (/** @type {string} */ kind, fields = {}) =>
    log.push({ kind, ...fields });
  const provider = makeOpenRouterProvider({
    label: 'OpenRouter test',
    spec: { baseUrl: server.openRouterBaseUrl, modelId: MODEL },
    readKey: async () => 'not a real key',
    timers,
    log: record,
    blobs: blobs.store,
  });
  /** RoundRequests as the endpoint passed them on (their sinks). */
  /** @type {any[]} */
  const requests = [];
  const watched = harden({
    ...provider,
    startRound: (
      /** @type {any} */ req,
      /** @type {any} */ channel,
      /** @type {any} */ prepare,
      /** @type {any} */ owner,
    ) => {
      requests.push(req);
      return provider.startRound(req, channel, prepare, owner);
    },
  });
  const channels = makeChannelRegistry();
  const contextCache = makeContextCache({ store: blobs.store });
  /** A gate the next prepare waits at (a turn kept from dispatching). */
  /** @type {{ promise: Promise<void>, resolve: (v?: any) => void } | undefined} */
  let prepareGate;
  /** @type {any[]} */
  const events = [];
  /** @type {any} */
  let sessionRef;
  /** What an adapter tool does: the echo tool, or a retired break. */
  let toolMode = 'echo';
  let incarnations = 0;
  /** @type {any[]} */
  const endpoints = [];
  const makePorts = () => {
    incarnations += 1;
    const channel = channels.channelFor(sessionRef);
    const endpoint = makeEndpoint({
      provider: watched,
      channel,
      timers,
      prepare: async req => {
        const gate = prepareGate;
        if (gate !== undefined) {
          prepareGate = undefined;
          await gate.promise;
        }
        return contextCache.prepare(sessionRef, req);
      },
      owner: sessionRef,
    });
    endpoints.push(endpoint);
    const echo = makeEchoTool({ timers, log: record, blobs: blobs.store });
    const tool = Far('AdapterTool', {
      execute: (/** @type {any} */ request) => {
        if (toolMode === 'retired') {
          record('tool-retired', { opId: request.opId });
          return Promise.reject(Error(`ocapn hub: ${RETIRED_TEXT}`));
        }
        return E(echo).execute(request);
      },
    });
    const publisher = Far('LivePublisher', {
      publish: (/** @type {any} */ batch) => {
        events.push(...batch.events);
      },
    });
    return harden({
      endpoint,
      publisher,
      tools: harden([harden({ name: 'echo', tool })]),
      since: Date.now() - 1,
    });
  };
  const backend = Far('Backend', {
    describe: () => harden({ kind: 'openrouter', label: 'OpenRouter test' }),
    open: () => makePorts(),
  });
  const host = Far('SessionHostFacet', {
    liveChannel: () =>
      Far('LivePublisher', {
        publish: (/** @type {any} */ batch) => {
          events.push(...batch.events);
        },
      }),
  });
  /** @type {any[]} */
  const rows = [];
  const rowReporter = Far('RowReporter', {
    changed: (/** @type {any} */ patch) => rows.push(patch),
  });
  const config = harden({
    key: 's1',
    title: 'w2.6',
    backendTitle: 'OpenRouter test',
    modelId: MODEL,
    preset: harden({ label: 'chat-only' }),
    createdAt: Date.now(),
    userInitiated: true,
    ...extra,
  });
  const { session } = makeSession(
    { config, services: harden({ backend, host }), rowReporter },
    harden(maxToolRounds === undefined ? {} : { maxToolRounds }),
  );
  sessionRef = session;
  await until(() => incarnations > 0, 'the creation-time open');
  let serial = 0;
  const self = {
    server,
    session,
    log,
    events,
    requests,
    endpoints,
    blobs,
    /** @param {string} text */
    start: text => {
      serial += 1;
      return E(session).startTurn(harden({ text }), Date.now() + serial);
    },
    /** @param {any} turn */
    finished: turn => E(turn).whenFinished(),
    holdNextPrepare: () => {
      const kit = makePromiseKit();
      prepareGate = /** @type {any} */ (kit);
      return () => kit.resolve(undefined);
    },
    /** @param {string} mode */
    setToolMode: mode => {
      toolMode = mode;
    },
    incarnations: () => incarnations,
    /** Every record of every turn, in turn order, read through Turn.getContent. */
    allRecords: async () => {
      /** @type {any[]} */
      const turns = [];
      /** @type {string | undefined} */
      let cursor;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const page = await E(session).getHistoryPage(cursor);
        turns.push(...page.turns);
        if (page.next === undefined) break;
        cursor = page.next;
      }
      turns.reverse();
      /** @type {any[]} */
      const out = [];
      for (const preview of turns) {
        /** @type {string | undefined} */
        let at;
        for (;;) {
          // eslint-disable-next-line no-await-in-loop
          const page = await E(preview.turn).getContent(at);
          out.push(...page.records);
          if (page.next === undefined) break;
          at = page.next;
        }
      }
      return out;
    },
    /**
     * The records of one turn.
     * @param {any} turn
     */
    recordsOf: async turn => (await E(turn).getContent()).records,
  };
  return self;
};

/**
 * The OpenAI-format messages of the fake server's n-th chat request.
 * @param {any} server
 * @param {number} n
 */
const messagesOf = (server, n) =>
  server
    .requests()
    .filter((/** @type {any} */ r) => r.path === '/api/v1/chat/completions')[n]
    .json.messages;

/** @param {any} server */
const chatRequests = server =>
  server
    .requests()
    .filter((/** @type {any} */ r) => r.path === '/api/v1/chat/completions');

test('R4-43, R4-45, R4-42: an unknown tool, bad JSON and a call without an id; the turn continues and the model is told', async t => {
  const s = await setup(t);
  s.server.setPlan([
    {
      events: openRouterChunks({
        deltas: ['Let me try.'],
        toolCalls: [
          { id: 'call-a', name: 'nope', args: '{}' },
          { id: 'call-b', name: 'echo', args: '{"text": "unclosed' },
          { name: 'echo', args: '{"text":"fine"}' },
        ],
        usage: RAW_USAGE,
      }),
    },
    {
      events: openRouterChunks({ deltas: ['All ', 'done.'], usage: RAW_USAGE }),
    },
  ]);
  const turn = await s.start('use tools');
  const status = await s.finished(turn);
  t.is(status.state, 'completed');
  const records = await s.recordsOf(turn);
  const intents = records.find(
    (/** @type {any} */ r) => r.kind === 'tool-intents',
  ).intents;
  t.deepEqual(
    intents.map((/** @type {any} */ i) => [i.callId, i.name]),
    [
      ['call-a', 'nope'],
      ['call-b', 'echo'],
      [textOf.synthesizedCallId(0, 2), 'echo'],
    ],
    'R4-42: floot-synth-0-2',
  );
  t.is(intents[2].callId, 'floot-synth-0-2');
  // R4-43: a stable operation id from turn id and call ordinal.
  t.deepEqual(
    intents.map((/** @type {any} */ i) => i.opId),
    [0, 1, 2].map(n => textOf.opId('t1', 0, n)),
  );
  const results = new Map(
    records
      .filter((/** @type {any} */ r) => r.kind === 'tool-result')
      .map((/** @type {any} */ r) => [r.opId, r]),
  );
  const unknown = results.get(intents[0].opId);
  t.is(
    unknown.result,
    // The tools this session offered (exec needs an exec vat: none here;
    // M5's local object tools and `adopt` need none).
    textOf.errorResult(
      textOf.unknownTool('nope', [
        'echo',
        'list',
        'lookup',
        'store',
        'remove',
        'adopt',
      ]),
    ),
  );
  t.true(unknown.failed);
  t.true(
    unknown.result.startsWith('Error: Unknown tool: "nope". Available tools: '),
  );
  const bad = results.get(intents[1].opId);
  t.true(bad.failed);
  t.regex(
    bad.result,
    /^Error: could not parse tool arguments as JSON \(.+\)\. Re-send this tool call with valid JSON arguments\.$/,
  );
  const fine = results.get(intents[2].opId);
  t.false(fine.failed);
  // The turn continued: a second request carrying the three results.
  t.is(chatRequests(s.server).length, 2);
  const second = messagesOf(s.server, 1);
  const toolMessages = second.filter(
    (/** @type {any} */ m) => m.role === 'tool',
  );
  t.is(toolMessages.length, 3);
  t.deepEqual(
    toolMessages.map((/** @type {any} */ m) => m.content),
    [unknown.result, bad.result, fine.result],
    'results in call order, as recorded',
  );
  const final = records.findLast(
    (/** @type {any} */ r) => r.kind === 'turn-settled',
  );
  t.is(final.final, 'All done.');
});

test('R4-47: at the round limit the turn ends completed with the fixed text; no further request', async t => {
  const s = await setup(t, { maxToolRounds: 2 });
  s.server.setPlan([
    {
      events: openRouterChunks({
        toolCalls: [{ id: 'again', name: 'echo', args: '{"text":"again"}' }],
        usage: RAW_USAGE,
      }),
      repeat: 5,
    },
  ]);
  const turn = await s.start('loop forever');
  const status = await s.finished(turn);
  t.is(status.state, 'completed');
  t.is(chatRequests(s.server).length, 2, 'rounds 0 and 1 only');
  const records = await s.recordsOf(turn);
  const settled = records.findLast(
    (/** @type {any} */ r) => r.kind === 'turn-settled',
  );
  t.is(settled.status, 'completed');
  t.is(settled.final, texts.roundLimit);
  const finals = s.events.filter(
    (/** @type {any} */ e) => e.type === 'final' && e.turnId === 't1',
  );
  t.deepEqual(
    finals.map((/** @type {any} */ e) => e.text),
    [texts.roundLimit],
  );
  t.true(
    s.events.some(
      (/** @type {any} */ e) => e.type === 'end' && e.status === 'completed',
    ),
  );
  // Both rounds' tool calls ran and were recorded.
  t.is(
    records.filter((/** @type {any} */ r) => r.kind === 'tool-result').length,
    2,
  );
});

test('R4-7: cancel mid-stream closes the connection, settles cancelled, and ignores late results', async t => {
  const s = await setup(t);
  s.server.setPlan([
    {
      events: [
        ...openRouterChunks({ deltas: ['partial '], done: false }).slice(0, 3),
        { comment: 'stall', delayMs: 60_000 },
      ],
    },
  ]);
  const turn = await s.start('stream then stop');
  await until(
    () => s.log.some(e => e.kind === 'request'),
    'the provider request',
  );
  await until(() => chatRequests(s.server).length === 1, 'the server request');
  await E(turn).cancel();
  const status = await s.finished(turn);
  t.is(status.state, 'cancelled');
  await until(() => chatRequests(s.server)[0].closed, 'the connection closed');
  t.true(chatRequests(s.server)[0].closed, 'the server saw the client go');
  t.false(chatRequests(s.server)[0].completed);
  const kinds = s.events
    .filter((/** @type {any} */ e) => e.turnId === 't1')
    .map((/** @type {any} */ e) => e.type);
  t.true(kinds.includes('end'));
  t.true(
    s.events.some(
      (/** @type {any} */ e) => e.type === 'phase' && e.phase === 'cancelling',
    ),
  );
  // Late answers from the round's sink: ignored, nothing recorded.
  const before = (await s.recordsOf(turn)).length;
  const [req] = s.requests;
  t.false(await E(req.sink).dispatching(0));
  E.sendOnly(req.sink).roundFinal(
    harden({
      round: 0,
      text: 'too late',
      toolCalls: [],
      usage: usageFromOpenRouter(RAW_USAGE),
      at: Date.now(),
    }),
  );
  E.sendOnly(req.sink).roundFailed(
    harden({ round: 0, reason: 'too late', at: Date.now() }),
  );
  await timers.delay(20);
  const after = await s.recordsOf(turn);
  t.is(after.length, before, 'no record after the settle');
  t.false(JSON.stringify(after).includes('too late'));
  t.is((await E(turn).getStatus()).state, 'cancelled');
  // The session goes on.
  s.server.setPlan([{ events: openRouterChunks({ deltas: ['next'] }) }]);
  const next = await s.start('after cancel');
  t.is((await s.finished(next)).state, 'completed');
});

test('R4-49: cancel while a tool runs waits for it; its result is recorded; no next request', async t => {
  const s = await setup(t);
  s.server.setPlan([
    {
      events: openRouterChunks({
        toolCalls: [
          {
            id: 'slow',
            name: 'echo',
            args: '{"text":"slow result","delayMs":600}',
          },
        ],
        usage: RAW_USAGE,
      }),
    },
    { events: openRouterChunks({ deltas: ['never asked'] }) },
  ]);
  const turn = await s.start('slow tool');
  await until(
    () => s.log.some(e => e.kind === 'echo-start'),
    'the tool to start',
  );
  await E(turn).cancel();
  t.is((await E(turn).getStatus()).state, 'cancelling', 'waits for the tool');
  const status = await s.finished(turn);
  t.is(status.state, 'cancelled');
  t.true(
    s.log.some(e => e.kind === 'echo-end'),
    'the running tool was not interrupted',
  );
  const records = await s.recordsOf(turn);
  const result = records.find(
    (/** @type {any} */ r) => r.kind === 'tool-result',
  );
  t.false(result.failed);
  t.regex(result.result, /slow result/);
  t.is(chatRequests(s.server).length, 1, 'no round after the cancel');
});

test('R4-32: failed and outcome-unknown turns are in the next request; a never-dispatched turn is not', async t => {
  const s = await setup(t);
  // t1: fails mid-stream after some text (an API error chunk).
  s.server.setPlan([
    {
      events: openRouterChunks({
        deltas: ['half an answer'],
        error: { code: 502, message: 'upstream went away' },
        usage: RAW_USAGE,
      }),
    },
  ]);
  const t1 = await s.start('first question');
  const s1 = await s.finished(t1);
  t.is(s1.state, 'failed');
  t.true(s1.error.startsWith('OpenRouter returned an API error'));

  // t2: cancelled before it was dispatched (its context is still being
  // prepared): no Dispatched record, nothing sent.
  const release = s.holdNextPrepare();
  const t2 = await s.start('second question');
  await timers.delay(20);
  await E(t2).cancel();
  t.is((await s.finished(t2)).state, 'cancelled');
  release();
  await timers.delay(50);
  t.is(chatRequests(s.server).length, 1, 't2 reached no provider');
  t.false(
    (await s.recordsOf(t2)).some(
      (/** @type {any} */ r) => r.kind === 'dispatched',
    ),
  );

  // t3: its tool call meets a restart signal (a retired break from the
  // adapter tool): recovery records the unknown outcome.
  s.server.setPlan([
    {
      events: openRouterChunks({
        deltas: ['calling'],
        toolCalls: [{ id: 'risky', name: 'echo', args: '{"text":"risky"}' }],
        usage: RAW_USAGE,
      }),
    },
  ]);
  s.setToolMode('retired');
  const t3 = await s.start('third question');
  const s3 = await s.finished(t3);
  t.is(s3.state, 'outcome-unknown');
  s.setToolMode('echo');

  // t4: the next request (on fresh ports) carries t1 and t3, not t2.
  s.server.setPlan([{ events: openRouterChunks({ deltas: ['ok'] }) }]);
  const t4 = await s.start('fourth question');
  t.is((await s.finished(t4)).state, 'completed');
  t.true(s.incarnations() >= 2, 'fresh ports after the restart signal');
  const messages = messagesOf(s.server, chatRequests(s.server).length - 1);
  const users = messages
    .filter((/** @type {any} */ m) => m.role === 'user')
    .map((/** @type {any} */ m) => m.content);
  t.deepEqual(users, ['first question', 'third question', 'fourth question']);
  const flat = JSON.stringify(messages);
  t.false(flat.includes('second question'), 'never dispatched: left out');
  t.true(flat.includes('half an answer'), "the failed turn's partial text");
  const tool = messages.find((/** @type {any} */ m) => m.role === 'tool');
  t.is(tool.content, texts.toolOutcomeUnknown);
  // Each tool result follows its call (OpenAI format).
  const callIndex = /** @type {number} */ (
    messages.findIndex(
      (/** @type {any} */ m) =>
        m.role === 'assistant' && Array.isArray(m.tool_calls),
    )
  );
  t.true(callIndex >= 0);
  t.is(messages[callIndex + 1].role, 'tool');
});

test('R4-33, R4-83: five counts summed per turn; the usage event, getUsage and the records agree', async t => {
  const s = await setup(t, { config: { contextLength: 131_072 } });
  const second = harden({
    prompt_tokens: 40,
    completion_tokens: 9,
    total_tokens: 49,
    prompt_tokens_details: { cached_tokens: 30 },
    completion_tokens_details: { reasoning_tokens: 4 },
  });
  s.server.setPlan([
    {
      events: openRouterChunks({
        toolCalls: [{ id: 'u', name: 'echo', args: '{"text":"u"}' }],
        usage: RAW_USAGE,
      }),
    },
    { events: openRouterChunks({ deltas: ['done'], usage: second }) },
  ]);
  const turn = await s.start('count tokens');
  t.is((await s.finished(turn)).state, 'completed');
  const one = usageFromOpenRouter(RAW_USAGE);
  const two = usageFromOpenRouter(second);
  const sum = addUsage(one, two);
  const usage = await E(s.session).getUsage();
  for (const key of /** @type {const} */ ([
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'reasoningOutputTokens',
  ])) {
    t.is(usage[key], sum[key], key);
  }
  t.deepEqual(
    [usage.cachedInputTokens, usage.reasoningOutputTokens],
    [30, 4],
    'disjoint counts',
  );
  // The context reading is the last request's, with the stored window
  // (seam 3; R4-33).
  // Every input kind plus the output of the last request: 40 + 9.
  t.is(usage.context.usedTokens, 49);
  t.is(usage.context.windowTokens, 131_072);
  t.is(usage.turns, 1);
  t.is(usage.incompleteTurns, 0);
  const event = s.events.findLast((/** @type {any} */ e) => e.type === 'usage');
  const { type: _type, turnId: _turnId, ...fromEvent } = event;
  t.deepEqual(fromEvent, usage, 'the settle publishes the same totals');
  // The records imply the same totals (export, import, archived turns).
  t.deepEqual(usageOfRecords(await s.allRecords()), usage);
  // A failed turn: its counts still add; it is incomplete.
  s.server.setPlan([
    {
      events: openRouterChunks({
        deltas: ['x'],
        error: { code: 500, message: 'no' },
        usage: RAW_USAGE,
      }),
    },
  ]);
  const failed = await s.start('fail');
  t.is((await s.finished(failed)).state, 'failed');
  const after = await E(s.session).getUsage();
  t.is(after.turns, 2);
  t.is(after.incompleteTurns, 1);
  t.deepEqual(usageOfRecords(await s.allRecords()), after);
});

// Seam 4 sends `armDeadline` in the crank that sends `holdTurn` (answered,
// `M.callWhen`) and `startRound`; the Endpoint keeps an arm that arrives
// before the turn's first round and arms it when the round brings the sink
// (J-0475 defect, fixed by W2.9).
test('turn deadline (seam 4, G-06): off by default; when set, a turn past it fails with its text and its request is torn down', async t => {
  const s = await setup(t, { config: { turnDeadlineMs: 300 } });
  s.server.setPlan([{ hang: true }]);
  const turn = await s.start('hang');
  const t0 = Date.now();
  const status = await Promise.race([
    s.finished(turn),
    timers.delay(5000).then(() => {
      throw Error('the deadline never fired');
    }),
  ]);
  const ms = Date.now() - t0;
  t.is(status.state, 'failed');
  t.is(status.error, textOf.turnDeadline(300));
  t.true(ms >= 250 && ms < 5000, `${ms} ms`);
  await until(() => chatRequests(s.server)[0]?.closed, 'the connection closed');
  t.true(
    s.events.some(
      (/** @type {any} */ e) =>
        e.type === 'abort' && e.reason === textOf.turnDeadline(300),
    ),
  );
  // Default off: a session without the setting arms nothing.
  const plain = await setup(t);
  plain.server.setPlan([
    {
      events: openRouterChunks({ deltas: ['slow'], usage: RAW_USAGE }),
      firstByteDelayMs: 500,
    },
  ]);
  const ok = await plain.start('slow but fine');
  t.is((await plain.finished(ok)).state, 'completed');
});

// The same at the Endpoint alone (J-0475): `holdTurn`, `armDeadline` and
// `startRound` sent in one crank, as seam 4 sends them.
test('Endpoint: an armDeadline sent with holdTurn and startRound in one crank fires', async t => {
  /** @type {any[]} */
  const deadlines = [];
  const sink = Far('TurnSink', {
    dispatching: () => true,
    roundFinal: () => {},
    roundFailed: () => {},
    deadline: (/** @type {any} */ request) => deadlines.push(request),
    progress: () => true,
  });
  const turn = Far('Turn', {});
  const endpoint = makeEndpoint({
    provider: {
      startRound: () => new Promise(() => {}),
      cancelRound: () => {},
    },
    channel: Far('Channel', {}),
    timers,
  });
  void E(endpoint).holdTurn(turn);
  E.sendOnly(endpoint).armDeadline(
    harden({ turn, opId: textOf.turnDeadlineOpId('t1'), ms: 50 }),
  );
  E.sendOnly(endpoint).startRound(
    harden({
      turn,
      sink,
      turnId: 't1',
      round: 0,
      base: { count: 0, epoch: 0 },
      append: [],
      tools: [],
      options: { modelId: 'm' },
    }),
  );
  await timers.delay(300);
  t.deepEqual(deadlines, [{ opId: 't1/deadline' }]);
});
