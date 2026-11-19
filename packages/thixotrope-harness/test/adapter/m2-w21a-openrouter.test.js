// @ts-check
// M2 W2.1a: the streamed OpenRouter provider and the shared round driver
// (resources/agent-host/impl/providers/{openrouter,round,http}.js;
// designs/m2-interfaces.md 8.1) against the fake provider server
// (127.0.0.1, D-M2-4), through the Endpoint, with a guarded fake TurnSink
// and real blob files under H/tmp. Ported parts of lal
// test/openrouter.test.js: tool-call round trips, no output limit, the
// length note, served-by identifiers only, the shape rules of `shown`, the
// caller's cancellation, timeouts, and that no body reaches a failure.
import '../unit/_m1a-prelude.js';

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import {
  interfaces,
  shapes,
  texts,
  textOf,
} from '../../guest/lib/interfaces.js';
import { limits } from '../../guest/lib/limits.js';
import { messageBytes } from '../../guest/lib/bounded.js';
/* eslint-enable import/no-relative-packages */
import { makeEndpoint } from '../../resources/agent-host/impl/endpoint.js';
import { makeTimers } from '../../resources/agent-host/impl/timers.js';
import { makeChannelRegistry } from '../../resources/agent-host/impl/channels.js';
import {
  BASE_URL_REFUSED,
  providerBaseUrl,
} from '../../resources/agent-host/impl/providers/http.js';
import {
  describeFacts,
  makeOpenRouterProvider,
  openRouterAttempt,
  openRouterKind,
  openRouterMessages,
  shown,
} from '../../resources/agent-host/impl/providers/openrouter.js';
import { backendKinds } from '../../resources/agent-host/impl/providers/kinds.js';
import {
  BODY_MARKER,
  openRouterChunks,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import { filesIn, makeTestBlobs, partsIn } from './_m1b-blobs.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const timers = makeTimers();
const KEY = 'not a real key';
const harnessTmp = new URL('../../tmp/', import.meta.url).pathname;

/**
 * @param {() => boolean} predicate
 * @param {number} [ms]
 */
const until = async (predicate, ms = 5000) => {
  const t0 = Date.now();
  while (!predicate()) {
    if (Date.now() - t0 > ms) throw Error('timed out waiting');
    // eslint-disable-next-line no-await-in-loop
    await timers.delay(2);
  }
};

const makeFakeTurn = ({ dispatch = true } = {}) => {
  /** @type {any[]} */
  const finals = [];
  /** @type {any[]} */
  const failures = [];
  /** @type {any[]} */
  const progress = [];
  let dispatched = 0;
  const turn = makeExo('Turn', interfaces.Turn, {
    getStatus: () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    cancel: () => undefined,
    whenFinished: async () =>
      harden({ turnId: 't1', state: 'running', round: 0, at: 0 }),
    resolve: () => undefined,
    getContent: () => harden({ records: [] }),
  });
  // The folded guard checks every message as the session vat would.
  const sink = makeExo('TurnSink', interfaces.TurnSink, {
    dispatching: () => {
      dispatched += 1;
      return dispatch;
    },
    roundFinal: (/** @type {any} */ r) => {
      finals.push(r);
    },
    roundFailed: (/** @type {any} */ f) => {
      failures.push(f);
    },
    deadline: () => undefined,
    progress: (/** @type {any} */ p) => {
      progress.push(p);
      return true;
    },
  });
  return {
    turn,
    sink,
    finals,
    failures,
    progress,
    dispatched: () => dispatched,
  };
};

/** One blob directory per test file run, under H/tmp (rule 6). */
let dirSerial = 0;
const testBlobs = () => {
  dirSerial += 1;
  const dir = join(harnessTmp, `w21a-${process.pid}-${dirSerial}`);
  mkdirSync(dir, { recursive: true });
  return makeTestBlobs({ dir });
};

/**
 * Run one round through the Endpoint.
 * @param {import('../fixtures/fake-provider-server.mjs').FakeProviderServer} server
 * @param {object} [options]
 * @param {any[]} [options.transcript]
 * @param {any[]} [options.tools]
 * @param {Record<string, unknown>} [options.spec]
 * @param {Record<string, unknown>} [options.requestOptions]
 * @param {() => Promise<string>} [options.readKey]
 * @param {boolean} [options.dispatch]
 * @param {any} [options.system]
 * @param {boolean} [options.wait] wait for the round's result
 * @param {number} [options.round]
 * @param {any} [options.retry] the provider's retry wrapper (W2.1b;
 *   default: the provider's own retry schedule)
 * @param {typeof globalThis.fetch} [options.fetch] instead of the network
 */
const runRound = async (
  server,
  {
    transcript = [{ kind: 'message', role: 'user', content: 'hi' }],
    tools = [],
    spec = {},
    requestOptions = {},
    readKey = async () => KEY,
    dispatch = true,
    system,
    wait = true,
    round = 0,
    retry,
    fetch,
  } = {},
) => {
  const blobs = testBlobs();
  /** @type {any[]} */
  const log = [];
  const provider = makeOpenRouterProvider({
    label: 'openrouter-test',
    spec: { baseUrl: server.openRouterBaseUrl, ...spec },
    readKey,
    timers,
    log: (kind, fields = {}) => log.push({ kind, ...fields }),
    blobs: blobs.store,
    ...(retry === undefined ? {} : { retry }),
    ...(fetch === undefined ? {} : { fetch }),
  });
  const channels = makeChannelRegistry();
  const owner = Far('Session', {});
  const channel = channels.channelFor(owner);
  const subscription = channel.subscribe();
  const endpoint = makeEndpoint({
    provider,
    channel,
    timers,
    prepare: async () => harden({ transcript }),
    owner,
    unexpectedFailure: openRouterKind.unexpectedFailure,
  });
  const fake = makeFakeTurn({ dispatch });
  void E(endpoint).holdTurn(fake.turn);
  E.sendOnly(endpoint).startRound(
    harden({
      turn: fake.turn,
      sink: fake.sink,
      turnId: 't1',
      round,
      base: { count: 0, epoch: 0 },
      append: [{ kind: 'turn-started', turnId: 't1', input: 'hi', at: 1 }],
      tools,
      options: { modelId: 'fake-org/fake-model', ...requestOptions },
      ...(system === undefined ? {} : { system }),
    }),
  );
  const settled = () => fake.finals.length + fake.failures.length > 0;
  if (wait) await until(settled);
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
  return {
    ...fake,
    log,
    blobs,
    endpoint,
    deltas,
    settled,
    cleanup: () => {
      blobs.cleanup();
    },
  };
};

/** @param {import('ava').ExecutionContext} t */
const serverFor = async t => {
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  return server;
};

/**
 * Nothing a test recorded carries a provider body or the key.
 * @param {import('ava').ExecutionContext} t
 * @param {any} r
 */
const noBodyOrKey = (t, r) => {
  const seen = JSON.stringify([r.finals, r.failures, r.progress, r.log]);
  t.false(seen.includes(BODY_MARKER), 'no provider body');
  t.false(seen.includes(KEY), 'no key');
};

test('the openrouter kind is in backendKinds and offers only accountStatus', t => {
  t.is(
    backendKinds.find(k => k.kind === 'openrouter'),
    openRouterKind,
  );
  // M4 W4.6 (m4-interfaces 8, assumption 8): accountStatus on API kinds.
  t.deepEqual(openRouterKind.tools, ['accountStatus']);
});

test('acceptance 1: a streamed reply publishes more than one delta; the result carries usage and served-by', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'openrouter-text.sse' }]);
  const r = await runRound(server);
  t.teardown(r.cleanup);
  t.deepEqual(r.failures, []);
  const [final] = r.finals;
  t.is(final.text, 'Hello, world. How can I help?');
  t.deepEqual(final.toolCalls, []);
  t.deepEqual(final.servedBy, {
    label: 'openrouter-test',
    modelId: 'fake-org/fake-model',
    provider: 'Fake Provider',
  });
  t.is(final.usage.inputTokens, 12);
  t.is(final.usage.outputTokens, 7);
  t.true(matches(final, shapes.RoundResult));
  const deltas = await r.deltas();
  t.true(deltas.length > 1, `${deltas.length} deltas`);
  t.is(deltas.join(''), final.text);
  t.is(r.dispatched(), 1);
  const [request] = server.requests();
  t.true(request.authorization);
  t.is(request.json.stream, true);
  t.is(request.json.model, 'fake-org/fake-model');
  t.false('max_tokens' in request.json, 'no output limit (R4-92)');
  t.false('tools' in request.json);
  t.deepEqual(request.json.messages, [{ role: 'user', content: 'hi' }]);
  noBodyOrKey(t, r);
});

test('tool calls: fragments are joined per index, args stay text, tools go with tool_choice auto', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'openrouter-tool-calls.sse' }]);
  const tools = [
    {
      name: 'echo',
      description: 'Echo text',
      parameters: '{"type":"object","properties":{"text":{"type":"string"}}}',
    },
  ];
  const transcript = [
    { kind: 'message', role: 'user', content: 'first' },
    { kind: 'message', role: 'assistant', content: 'calling' },
    { kind: 'tool-call', id: 'op1', name: 'echo', args: '{"text":"a"}' },
    { kind: 'tool-result', id: 'op1', content: 'a' },
    { kind: 'tool-call', id: 'op2', name: 'echo', args: '{}' },
    { kind: 'tool-result', id: 'op2', content: 'b', failed: true },
    { kind: 'message', role: 'user', content: 'again' },
  ];
  const r = await runRound(server, {
    tools,
    transcript,
    system: 'You are a test.',
  });
  t.teardown(r.cleanup);
  const [final] = r.finals;
  t.is(final.text, 'Let me check.');
  t.deepEqual(final.toolCalls, [
    { callId: 'call_fake_1', name: 'echo', args: '{"text":"one"}' },
    { callId: 'call_fake_2', name: 'echo', args: '{"text":"two"}' },
  ]);
  const { json } = server.requests()[0];
  t.is(json.tool_choice, 'auto');
  t.deepEqual(json.tools, [
    {
      type: 'function',
      function: {
        name: 'echo',
        description: 'Echo text',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
        },
      },
    },
  ]);
  t.deepEqual(json.messages, [
    { role: 'system', content: 'You are a test.' },
    { role: 'user', content: 'first' },
    {
      role: 'assistant',
      content: 'calling',
      tool_calls: [
        {
          id: 'op1',
          type: 'function',
          function: { name: 'echo', arguments: '{"text":"a"}' },
        },
        {
          id: 'op2',
          type: 'function',
          function: { name: 'echo', arguments: '{}' },
        },
      ],
    },
    { role: 'tool', tool_call_id: 'op1', content: 'a' },
    { role: 'tool', tool_call_id: 'op2', content: 'b' },
    { role: 'user', content: 'again' },
  ]);
});

test('an unknown tool and bad JSON arguments reach the vat as the model sent them (R4-43, R4-45 are the vat’s)', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'openrouter-bad-tools.sse' }]);
  const r = await runRound(server);
  t.teardown(r.cleanup);
  t.deepEqual(
    r.finals[0].toolCalls.map((/** @type {any} */ c) => [c.name, c.args]),
    [
      ['no_such_tool', '{}'],
      ['echo', '{"text": not json'],
    ],
  );
  t.is(r.finals[0].text, '');
});

test('an empty answer fails with the R4-78 text and its finish reason', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'openrouter-empty.sse' }]);
  const r = await runRound(server);
  t.teardown(r.cleanup);
  t.deepEqual(r.finals, []);
  t.is(
    r.failures[0].reason,
    textOf.openRouterEmpty(
      // lal's own text: the finish reason, then the served-by facts.
      ' (finish_reason stop) (served by fake-org/fake-model, via Fake Provider)',
    ),
  );
  t.true(matches(r.failures[0], shapes.RoundFailure));
});

test('a length stop with text is delivered with the note; without text it fails', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'openrouter-length.sse' },
    { sse: 'openrouter-length-empty.sse' },
  ]);
  const a = await runRound(server);
  t.teardown(a.cleanup);
  t.is(
    a.finals[0].text,
    `A reply the model cut at its limit\n\n${texts.outputLimitNote}`,
  );
  t.is((await a.deltas()).join(''), a.finals[0].text);
  const b = await runRound(server);
  t.teardown(b.cleanup);
  t.is(
    b.failures[0].reason,
    textOf.openRouterStopped(
      'length',
      ' (served by fake-org/fake-model, via Fake Provider)',
    ),
  );
});

test('content filtering fails with the R4-78 text and keeps the partial text', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'openrouter-content-filter.sse' }]);
  const r = await runRound(server);
  t.teardown(r.cleanup);
  t.is(
    r.failures[0].reason,
    textOf.openRouterStopped(
      'content_filter',
      ' (served by fake-org/fake-model, via Fake Provider)',
    ),
  );
  t.is(r.failures[0].partial, 'Partly');
});

test('an error chunk fails with the API-error text and its code, never the error message', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'openrouter-error.sse' }]);
  const r = await runRound(server);
  t.teardown(r.cleanup);
  t.is(
    r.failures[0].reason,
    textOf.openRouterApiError(
      ' (code 502, served by fake-org/fake-model, via Fake Provider)',
    ),
  );
  t.is(r.failures[0].partial, 'Before');
  noBodyOrKey(t, r);
});

test('a stream cut before its finish, or mid-stream, fails as unreachable with the partial text', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'openrouter-truncated.sse' },
    { sse: 'openrouter-text.sse', disconnectAfter: 4 },
  ]);
  const a = await runRound(server);
  t.teardown(a.cleanup);
  t.is(a.failures[0].reason, texts.openRouterUnreachable);
  t.is(a.failures[0].partial, 'Cut off');
  const b = await runRound(server);
  t.teardown(b.cleanup);
  t.is(b.failures[0].reason, texts.openRouterUnreachable);
  t.is(b.failures[0].partial, 'Hello, ');
});

test('HTTP failures carry the status only; their bodies are never read', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { status: 401 },
    { status: 429, headers: { 'retry-after': '3' } },
    { status: 503 },
    { status: 529 },
    { status: 200, body: { error: { message: `${BODY_MARKER} json` } } },
  ]);
  // One attempt per round here (W2.1b's retries are tested in
  // m2-w21b-retry.test.js).
  /** @type {any} */
  const once = ({ attempt, signal }) => attempt(signal);
  for (const status of [401, 429, 503, 529]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runRound(server, { retry: once });
    t.teardown(r.cleanup);
    t.is(r.failures[0].reason, textOf.openRouterHttp(status));
    noBodyOrKey(t, r);
  }
  const json = await runRound(server, { retry: once });
  t.teardown(json.cleanup);
  t.is(json.failures[0].reason, texts.openRouterUnreachable);
  noBodyOrKey(t, json);
});

test('an attempt says what the retry wrapper needs: retryable, Retry-After, timed out, delivered', async t => {
  const server = await serverFor(t);
  const url = `${server.openRouterBaseUrl}/chat/completions`;
  /** @param {number} [timeoutMs] */
  const attempt = async (timeoutMs = 60_000) => {
    const events = [];
    try {
      for await (const event of openRouterAttempt({
        url,
        key: KEY,
        body: { model: 'fake-org/fake-model', stream: true, messages: [] },
        signal: new AbortController().signal,
        timeoutMs,
      })) {
        events.push(event);
      }
      return { events };
    } catch (error) {
      return { events, error: /** @type {any} */ (error) };
    }
  };
  server.setPlan([
    { status: 429, headers: { 'retry-after': '2' } },
    { status: 400 },
    { hang: true },
    { sse: 'openrouter-empty.sse' },
    { sse: 'openrouter-text.sse', disconnectAfter: 4 },
  ]);
  const limited = await attempt();
  t.is(limited.error.retryable, true);
  t.is(limited.error.retryAfterMs, 2000);
  t.is(limited.error.status, 429);
  const refused = await attempt();
  t.is(refused.error.retryable, false);
  const hung = await attempt(150);
  t.is(hung.error.reason, textOf.openRouterTimeout(0));
  t.is(hung.error.timedOut, true);
  t.is(hung.error.retryable, true);
  await until(() => server.requests()[2].closed);
  const empty = await attempt();
  t.is(empty.error.retryable, false, 'whitespace was delivered');
  t.is(empty.error.delivered, true);
  const cut = await attempt();
  t.is(cut.error.reason, texts.openRouterUnreachable);
  t.is(cut.error.delivered, true);
});

test('acceptance 6: cancel mid-stream closes the connection and sends nothing more', async t => {
  const server = await serverFor(t);
  server.setPlan([
    {
      events: openRouterChunks({
        deltas: Array.from({ length: 200 }, (_, i) => `d${i} `),
      }),
      delayMs: 10,
    },
  ]);
  const r = await runRound(server, { wait: false });
  t.teardown(r.cleanup);
  await until(
    () => server.requests().length === 1 && server.requests()[0].events > 5,
  );
  E.sendOnly(r.endpoint).cancelRound(r.turn);
  await until(() => server.requests()[0].closed);
  await timers.delay(100);
  t.deepEqual(r.finals, []);
  t.deepEqual(r.failures, []);
  t.true(r.log.some(line => line.kind === 'cancelled'));
  t.false(server.requests()[0].completed);
});

test('release (lease) aborts silently; a refused dispatch sends no request', async t => {
  const server = await serverFor(t);
  server.setPlan([{ hang: true }]);
  const r = await runRound(server, { wait: false });
  t.teardown(r.cleanup);
  await until(() => server.requests().length === 1);
  E.sendOnly(r.endpoint).releaseTurn(r.turn);
  await until(() => server.requests()[0].closed);
  t.false(r.log.some(line => line.kind === 'cancelled'));
  t.deepEqual(r.failures, []);

  const refused = await runRound(server, { dispatch: false, wait: false });
  t.teardown(refused.cleanup);
  await until(() => refused.log.some(l => l.kind === 'dispatch-refused'));
  await timers.delay(50);
  t.is(server.requests().length, 1, 'no second request');
});

test('a model without its organisation prefix and a key read failure fail before any request', async t => {
  const server = await serverFor(t);
  const a = await runRound(server, { requestOptions: { modelId: 'bare' } });
  t.teardown(a.cleanup);
  t.is(a.failures[0].reason, texts.openRouterModelPrefix);
  const b = await runRound(server, {
    readKey: async () => {
      throw Error(textOf.secretFailed('REVOKED'));
    },
  });
  t.teardown(b.cleanup);
  t.is(b.failures[0].reason, textOf.secretFailed('REVOKED'));
  const c = await runRound(server, {
    readKey: async () => {
      throw Error(`${BODY_MARKER} anything else`);
    },
  });
  t.teardown(c.cleanup);
  t.is(c.failures[0].reason, textOf.secretFailed('READ_FAILED'));
  t.is(server.requests().length, 0);
  // Round 1 does not ask dispatching again.
  server.setPlan([{ sse: 'openrouter-text.sse' }]);
  const d = await runRound(server, { round: 1 });
  t.teardown(d.cleanup);
  t.is(d.dispatched(), 0);
  t.is(d.finals[0].round, 1);
});

test('the key is read at every round (R4-82)', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'openrouter-text.sse', repeat: 2 }]);
  let reads = 0;
  const readKey = async () => {
    reads += 1;
    return KEY;
  };
  const a = await runRound(server, { readKey });
  t.teardown(a.cleanup);
  const b = await runRound(server, { readKey, round: 1 });
  t.teardown(b.cleanup);
  t.is(reads, 2);
});

test('a long reply is staged with progress checkpoints; the result fits its bound', async t => {
  const server = await serverFor(t);
  const piece = 'p'.repeat(8192);
  server.setPlan([
    {
      events: openRouterChunks({
        deltas: Array.from({ length: 64 }, () => piece),
      }),
    },
  ]);
  const r = await runRound(server);
  t.teardown(r.cleanup);
  const [final] = r.finals;
  t.truthy(final.text.blob, 'staged');
  t.is(final.text.bytes, 64 * 8192);
  t.true(r.progress.length >= 1);
  t.true(messageBytes(final) <= limits.roundResultBytes);
  t.is(await r.blobs.store.read(final.text.blob), piece.repeat(64));
  t.deepEqual(partsIn(r.blobs.blobDir), []);
  t.true(filesIn(r.blobs.blobDir).length >= 1);
});

test('more tool calls than maxCallsPerMessage fail the round with the frame-limit text', async t => {
  const server = await serverFor(t);
  const toolCalls = Array.from(
    { length: limits.maxCallsPerMessage + 1 },
    (_, i) => ({
      id: `c${i}`,
      name: 'echo',
      args: '{}',
      pieces: 1,
    }),
  );
  server.setPlan([{ events: openRouterChunks({ toolCalls }) }]);
  const r = await runRound(server);
  t.teardown(r.cleanup);
  t.is(r.failures[0].reason, texts.frameLimit);
});

test('shown and describeFacts show identifiers only, never key-shaped values', t => {
  t.is(shown('model', 'org/model-7b:free'), 'org/model-7b:free');
  t.is(shown('model', 'no-org'), undefined);
  t.is(shown('provider', 'Google AI Studio'), 'Google AI Studio');
  t.is(shown('provider', 'a very long provider name here'), undefined);
  t.is(shown('code', 429), '429');
  t.is(shown('code', 'rate_limited'), 'rate_limited');
  // Key-shaped values, built at run time so the source has no full pattern.
  const prefix = ['s', 'k'].join('');
  t.is(shown('provider', `${prefix}-or-v1`), undefined);
  t.is(shown('code', `${prefix}_live`), undefined);
  t.is(shown('model', `org/${'a1b2c3d4e5f6'.repeat(2)}`), undefined);
  t.is(
    describeFacts([
      ['code', 'code', 502],
      ['served by', 'model', 'org/x'],
      ['via', 'provider', `${BODY_MARKER} prose`],
    ]),
    ' (code 502, served by org/x)',
  );
});

test('openRouterMessages turns tool calls without an assistant text into content null', t => {
  t.deepEqual(
    openRouterMessages(
      [
        { kind: 'message', role: 'user', content: 'q' },
        { kind: 'tool-call', id: 'a', name: 'echo', args: '{}' },
        { kind: 'tool-result', id: 'a', content: 'r' },
      ],
      undefined,
    ),
    [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'a',
            type: 'function',
            function: { name: 'echo', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'a', content: 'r' },
    ],
  );
});

test('J-9486: a base URL the key may not go to is refused before any request', async t => {
  const fallback = 'https://api.example.test/v1';
  t.is(providerBaseUrl(undefined, fallback), fallback);
  t.is(providerBaseUrl('https://api.example.test/v1//', fallback), fallback);
  t.is(
    providerBaseUrl('http://127.0.0.1:4100/api', fallback),
    'http://127.0.0.1:4100/api',
  );
  t.is(
    providerBaseUrl('http://localhost:9/x', fallback),
    'http://localhost:9/x',
  );
  t.is(providerBaseUrl('http://[::1]:9', fallback), 'http://[::1]:9');
  for (const bad of [
    'http://api.example.test/v1',
    'http://127.0.0.1.example.test/v1',
    'ftp://127.0.0.1/x',
    ['https://user', 'pass@api.example.test'].join(':'),
    'https://api.example.test/v1?x=1',
    'https://api.example.test/v1#f',
    'https://api.example.test/v1?',
    'not a url',
  ]) {
    t.throws(
      () => providerBaseUrl(bad, fallback),
      { message: BASE_URL_REFUSED },
      bad,
    );
  }
  t.throws(
    () =>
      makeOpenRouterProvider({
        label: 'openrouter-test',
        spec: { baseUrl: 'http://api.example.test' },
        readKey: async () => KEY,
        timers,
        log: () => {},
        blobs: /** @type {any} */ ({}),
      }),
    { message: BASE_URL_REFUSED },
  );
});

test('J-9486: a key over the provider token bound fails the round before any request', async t => {
  const server = await serverFor(t);
  const r = await runRound(server, {
    readKey: async () => 'k'.repeat(limits.providerTokenBytes + 1),
  });
  t.teardown(r.cleanup);
  t.is(r.failures[0].reason, textOf.secretFailed('INVALID_SECRET_BYTES'));
  t.is(server.requests().length, 0);
  // At the bound it is sent.
  server.setPlan([{ sse: 'openrouter-text.sse' }]);
  const ok = await runRound(server, {
    readKey: async () => 'k'.repeat(limits.providerTokenBytes),
  });
  t.teardown(ok.cleanup);
  t.is(ok.finals.length, 1);
});

test('J-9486: a stream over the round bound fails with the frame-limit text and is cancelled', async t => {
  const server = await serverFor(t);
  const chunk = new TextEncoder().encode(`: ${'k'.repeat(1_048_570)}\n`);
  let sent = 0;
  let cancelled = false;
  /** @type {typeof globalThis.fetch} */
  const fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  const t0 = Date.now();
  const r = await runRound(server, { fetch });
  t.teardown(r.cleanup);
  t.is(r.failures[0].reason, texts.frameLimit);
  t.true(sent > limits.roundStreamBytes);
  t.true(sent <= limits.roundStreamBytes + 4 * chunk.byteLength);
  await until(() => cancelled);
  t.log({ streamedBytes: sent, ms: Date.now() - t0 });
});
