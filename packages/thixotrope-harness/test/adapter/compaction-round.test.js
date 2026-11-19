// @ts-check
// The compaction step of a provider round (resources/agent-host/impl/
// providers/compaction-round.js; designs/m8-interfaces.md 5.1, D-M8-1,
// D-M8-6; acceptance 11 and 17) through the Endpoint and the real context
// cache, against the fake provider server (127.0.0.1), for the Anthropic
// API and OpenRouter: the summary request offers no tools and carries the
// R4-36 instruction, its deltas are not published, `compacted` is called
// once, and the round's request starts with the summary; the skipped path;
// a provider failure of the summary call fails the round; a cancel during
// the summary sends nothing; K3 (summary staged, `compacted` not sent) and
// K4 in both orders, by faults of the fake session.
import '../unit/_m1a-prelude.js';

import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { isStaged } from '../../guest/session/staging.js';
/* eslint-enable import/no-relative-packages */
import { makeAnthropicProvider } from '../../resources/agent-host/impl/providers/anthropic.js';
import { makeOpenRouterProvider } from '../../resources/agent-host/impl/providers/openrouter.js';
import { makeContextCache } from '../../resources/agent-host/impl/context-cache.js';
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeChannelRegistry } from '../../resources/agent-host/impl/channels.js';
import {
  compactionSkipTexts,
  summaryInstruction,
} from '../../resources/agent-host/impl/providers/compaction-texts.js';
import {
  BODY_MARKER,
  anthropicEvents,
  openRouterChunks,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import { makeTestBlobs } from './_m1b-blobs.js';
import { KEY, timers, until } from './_m2-w21b-round.js';
import { makeCompactingSession, makeTurnSink } from './_compaction-session.js';

const { E } = /** @type {any} */ (globalThis);

const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;
const TOOLS = harden([
  {
    name: 'echo',
    description: 'Echo text',
    parameters: '{"type":"object","properties":{"text":{"type":"string"}}}',
  },
]);
const SUMMARY = `## Goal\nKeep going (summary under test). ${'s'.repeat(200)}`;

const kinds = harden({
  anthropic: {
    makeProvider: makeAnthropicProvider,
    baseUrl: (/** @type {any} */ server) => server.anthropicBaseUrl,
    modelId: 'claude-fake-1',
    text: (
      /** @type {string[]} */ deltas,
      /** @type {any} */ usage = undefined,
    ) => anthropicEvents({ deltas, ...(usage ? { usage } : {}) }),
    toolCall: () =>
      anthropicEvents({
        toolCalls: [{ id: 'toolu_s', name: 'echo', args: '{}' }],
      }),
    /** The first message's text of a recorded request. */
    first: (/** @type {any} */ json) => JSON.stringify(json.messages[0]),
    tools: (/** @type {any} */ json) => json.tools,
  },
  openrouter: {
    makeProvider: makeOpenRouterProvider,
    baseUrl: (/** @type {any} */ server) => server.openRouterBaseUrl,
    modelId: 'vendor/model-fake-1',
    text: (
      /** @type {string[]} */ deltas,
      /** @type {any} */ usage = undefined,
    ) =>
      openRouterChunks({
        deltas,
        ...(usage ? { usage: { prompt_tokens: 7, completion_tokens: 3 } } : {}),
      }),
    toolCall: () =>
      openRouterChunks({ toolCalls: [{ name: 'echo', args: '{}' }] }),
    first: (/** @type {any} */ json) =>
      JSON.stringify(
        json.messages.find((/** @type {any} */ m) => m.role !== 'system'),
      ),
    tools: (/** @type {any} */ json) => json.tools,
  },
});

/** A fresh blob directory under H/tmp. */
const testBlobs = (/** @type {any} */ trace) => {
  mkdirSync(harnessTmp, { recursive: true });
  const dir = mkdtempSync(join(harnessTmp, 'compaction-round-'));
  return { ...makeTestBlobs({ dir, trace }), dir };
};

/**
 * One compacting round through the Endpoint: six history turns of about
 * 2 KB each, then the current turn with an ask before round 0.
 * @param {import('ava').ExecutionContext} t
 * @param {keyof typeof kinds} kindName
 * @param {object} [options]
 * @param {import('./_compaction-session.js').SinkFaults} [options.faults]
 * @param {(endpoint: any, fake: any) => any} [options.blobTrace]
 * @param {number} [options.history] history turns
 */
const setup = async (t, kindName, { faults, blobTrace, history = 6 } = {}) => {
  const kind = kinds[kindName];
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  /** @type {any} */
  let endpoint;
  /** @type {any} */
  let fake;
  const blobs = testBlobs(
    blobTrace === undefined
      ? undefined
      : (/** @type {any} */ step) => blobTrace(endpoint, fake)?.(step),
  );
  t.teardown(blobs.cleanup);
  const cache = makeContextCache({ store: blobs.store });
  const s = makeCompactingSession();
  for (let i = 0; i < history; i += 1) {
    s.historyTurn({
      replies: [
        {
          text: `reply ${i} ${'r'.repeat(1000)}`,
          calls: 1,
          result: 'x'.repeat(900),
        },
        { text: `after the call ${i}` },
      ],
    });
  }
  /** @type {any[]} */
  const log = [];
  const provider = kind.makeProvider({
    label: 'api-test',
    spec: { baseUrl: kind.baseUrl(server) },
    readKey: async () => KEY,
    timers,
    log: (/** @type {string} */ k, fields = {}) =>
      log.push({ kind: k, ...fields }),
    blobs: blobs.store,
  });
  const channels = makeChannelRegistry();
  const channel = channels.channelFor(s.session);
  const subscription = channel.subscribe();
  endpoint = makeEndpoint({
    provider,
    channel,
    timers,
    prepare: (req, options) => cache.prepare(s.session, req, options),
    owner: s.session,
    unexpectedFailure: 'compaction round test: the provider threw',
  });
  const current = s.startTurn();
  fake = makeTurnSink(s, current.turnId, faults);
  const start = () => {
    const ask = s.askFor(current.turnId, 0, current.start);
    void E(endpoint).holdTurn(fake.turn);
    E.sendOnly(endpoint).startRound(
      s.request({
        turn: fake.turn,
        sink: fake.sink,
        turnId: current.turnId,
        round: 0,
        compaction: ask,
        tools: TOOLS,
        modelId: kind.modelId,
      }),
    );
  };
  /** Deltas a subscriber received (drains what is queued). */
  const deltas = async () => {
    /** @type {string[]} */
    const out = [];
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await Promise.race([
        E(subscription).next(),
        timers.delay(50).then(() => undefined),
      ]);
      if (batch === undefined) return out;
      for (const delivery of batch.deliveries) {
        if (delivery.event.type === 'delta') out.push(delivery.event.text);
      }
      if (batch.closed) return out;
    }
  };
  const settled = () =>
    Number(fake.finals.length) + Number(fake.failures.length) > 0;
  return {
    kind,
    server,
    s,
    fake,
    endpoint,
    log,
    deltas,
    start,
    settled,
    cache,
    blobs,
  };
};

/** @param {any} s */
const kindsOf = s => s.records.since(0).map((/** @type {any} */ r) => r.kind);

for (const kindName of /** @type {const} */ (['anthropic', 'openrouter'])) {
  test(`${kindName}: the summary call has no tools and the instruction; deltas are not published; compacted once; the next request starts with the summary`, async t => {
    const r = await setup(t, kindName);
    r.server.setPlan([
      { events: r.kind.text([SUMMARY.slice(0, 40), SUMMARY.slice(40)], true) },
      { events: r.kind.text(['the answer']) },
    ]);
    r.start();
    await until(r.settled);
    t.deepEqual(r.fake.failures, []);
    t.is(r.fake.finals[0].text, 'the answer');
    const [summaryCall, roundCall] = r.server.requests();
    t.is(r.server.requests().length, 2);
    t.is(r.kind.tools(summaryCall.json), undefined, 'no tools offered');
    t.true(
      r.kind.first(summaryCall.json).includes(summaryInstruction.slice(0, 60)),
    );
    t.true(
      Number(r.kind.tools(roundCall.json).length) > 0,
      'the round offers its tools',
    );
    // The round's request starts with the summary as an assistant message.
    const first = r.kind.first(roundCall.json);
    t.true(first.includes('summary under test'), first.slice(0, 200));
    t.true(first.includes('assistant'));
    t.false(
      JSON.stringify(roundCall.json).includes('input of t1'),
      'the oldest turn is summarized',
    );
    t.true(JSON.stringify(roundCall.json).includes('the current request'));
    // compacted once, with the boundary and the summary's usage.
    t.is(r.fake.compactions.length, 1);
    const [result] = r.fake.compactions;
    t.is(result.outcome, 'done');
    t.is(result.summary, SUMMARY);
    t.truthy(result.usage, 'the summary call is charged');
    t.is(result.servedBy.label, 'api-test');
    t.true(r.s.window.isCut(result.boundary));
    t.is(r.s.window.epoch(), 1);
    t.deepEqual(kindsOf(r.s).slice(-3), [
      'compaction-started',
      'dispatched',
      'compaction',
    ]);
    // Only the round's text was published.
    t.deepEqual(await r.deltas(), ['the answer']);
    t.is(r.cache.stats().rebases, 1, 'the cache rebased in place');
    const seen = JSON.stringify([
      r.fake.finals,
      r.fake.failures,
      r.fake.compactions,
      r.log,
    ]);
    t.false(seen.includes(BODY_MARKER));
    t.false(seen.includes(KEY));
  });

  test(`${kindName}: a summary that calls a tool is skipped; the round runs uncompacted`, async t => {
    const r = await setup(t, kindName);
    r.server.setPlan([
      { events: r.kind.toolCall() },
      { events: r.kind.text(['uncompacted']) },
    ]);
    r.start();
    await until(r.settled);
    t.is(r.fake.finals[0].text, 'uncompacted');
    t.is(r.fake.compactions[0].outcome, 'skipped');
    t.is(r.fake.compactions[0].reason, compactionSkipTexts.invalidSummary);
    t.is(r.s.window.epoch(), 0);
    t.true(JSON.stringify(r.server.requests()[1].json).includes('input of t1'));
    t.is(kindsOf(r.s).at(-1), 'compaction-skipped');
  });

  test(`${kindName}: a provider failure of the summary call fails the round`, async t => {
    const r = await setup(t, kindName);
    r.server.setPlan([{ status: 400 }]);
    r.start();
    await until(r.settled);
    t.deepEqual(r.fake.finals, []);
    t.is(r.fake.failures.length, 1);
    t.is(typeof r.fake.failures[0].reason, 'string');
    t.false(JSON.stringify(r.fake.failures).includes(BODY_MARKER));
    t.is(r.fake.compactions.length, 0, 'nothing reported');
    t.is(r.server.requests().length, 1, 'the round itself was not sent');
  });
}

test('a plan that cannot help is skipped with its reason (no completed work before the tail)', async t => {
  const r = await setup(t, 'anthropic', { history: 0 });
  r.server.setPlan([{ events: r.kind.text(['plain']) }]);
  r.start();
  await until(r.settled);
  t.is(r.fake.compactions[0].outcome, 'skipped');
  t.is(r.fake.compactions[0].reason, compactionSkipTexts.nothingToSummarize);
  t.is(r.fake.finals[0].text, 'plain');
  t.is(r.server.requests().length, 1, 'no summary call');
});

test('a summary over 100 KB is skipped as too long', async t => {
  const r = await setup(t, 'anthropic');
  const piece = 'y'.repeat(25_000);
  r.server.setPlan([
    { events: r.kind.text([piece, piece, piece, piece, piece]) },
    { events: r.kind.text(['after']) },
  ]);
  r.start();
  await until(r.settled);
  t.is(r.fake.compactions[0].reason, compactionSkipTexts.summaryTooLong);
  t.is(r.fake.finals[0].text, 'after');
});

test('a summary over inlineBytes is staged; the record names it and the next request carries its full text', async t => {
  const r = await setup(t, 'anthropic', { history: 12 });
  const long = `## Goal\nstaged summary ${'z'.repeat(limits.inlineBytes)}`;
  r.server.setPlan([
    { events: r.kind.text([long]) },
    { events: r.kind.text(['ok']) },
  ]);
  r.start();
  await until(r.settled);
  t.deepEqual(r.fake.failures, []);
  const [result] = r.fake.compactions;
  t.is(result.outcome, 'done');
  t.true(isStaged(result.summary));
  t.true(r.kind.first(r.server.requests()[1].json).includes('staged summary'));
  t.true(JSON.stringify(r.server.requests()[1].json).includes(long.slice(-50)));
});

test('cancel during the summary call sends nothing and tears the request down', async t => {
  const r = await setup(t, 'anthropic');
  r.server.setPlan([{ hang: true }]);
  r.start();
  await until(() => r.server.requests().length === 1);
  E(r.endpoint).cancelRound(r.fake.turn);
  await until(() => r.server.requests()[0].closed);
  await timers.delay(100);
  t.deepEqual(r.fake.finals, []);
  t.deepEqual(r.fake.failures, []);
  t.is(r.fake.compactions.length, 0, 'compacted is not sent');
  t.is(r.server.requests().length, 1);
});

test('K3: the summary staged, the round released before compacted: nothing sent, the pending file removed', async t => {
  let fired = false;
  const r = await setup(t, 'anthropic', {
    history: 12,
    blobTrace: (endpoint, fake) => (/** @type {string} */ step) => {
      if (step === 'write' && !fired) {
        fired = true;
        endpoint.releaseTurn(fake.turn);
      }
    },
  });
  r.server.setPlan([
    { events: r.kind.text([`## Goal\n${'k'.repeat(limits.inlineBytes)}`]) },
  ]);
  r.start();
  await until(() => fired);
  await timers.delay(200);
  t.is(r.fake.compactions.length, 0);
  t.deepEqual(r.fake.finals, []);
  t.deepEqual(r.fake.failures, []);
  t.is(r.server.requests().length, 1);
  const files = readdirSync(join(r.blobs.dir, 'agent-host', 'blobs'));
  t.deepEqual(
    files.filter(name => name.endsWith('.part')),
    [],
    'no part file left',
  );
  t.is(kindsOf(r.s).includes('compaction'), false);
});

test('K4, the frame first: compaction recorded, then the lease breaks; nothing more is sent', async t => {
  /** @type {any} */
  let ep;
  /** @type {any} */
  let turn;
  const r = await setup(t, 'anthropic', {
    faults: {
      afterCompacted: () => ep.releaseTurn(turn),
    },
  });
  ep = r.endpoint;
  turn = r.fake.turn;
  r.server.setPlan([{ events: r.kind.text([SUMMARY]) }]);
  r.start();
  await until(() => r.fake.compactions.length === 1);
  await timers.delay(200);
  t.is(kindsOf(r.s).filter(k => k === 'compaction').length, 1, 'one record');
  t.is(r.server.requests().length, 1, 'the round is not streamed');
  t.deepEqual(r.fake.finals, []);
  t.deepEqual(r.fake.failures, []);
});

for (const fault of /** @type {const} */ (['refuse', 'break'])) {
  test(`K4, the break first (${fault}): no record, nothing more is sent`, async t => {
    const r = await setup(t, 'anthropic', {
      faults: { beforeCompacted: () => fault },
    });
    r.server.setPlan([{ events: r.kind.text([SUMMARY]) }]);
    r.start();
    await until(() => r.fake.compactions.length === 1);
    await timers.delay(200);
    t.false(kindsOf(r.s).includes('compaction'), 'no record');
    t.is(r.server.requests().length, 1);
    t.deepEqual(r.fake.finals, []);
    t.deepEqual(r.fake.failures, []);
    t.true(
      r.log.some(
        e =>
          e.kind ===
          (fault === 'break' ? 'compaction-lost' : 'compaction-refused'),
      ),
    );
  });
}
