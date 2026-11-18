// @ts-check
// M4 W4.3: the Claude subscription wire client
// (resources/agent-host/impl/subscriptions/messages.js; designs/m4-interfaces.md
// 5.3) against the fake subscription server (127.0.0.1). One attempt at a
// time, called directly (the pool provider that loops over members is
// W4.6's): text deltas, thinking kept as native context and replayed,
// tool use, R4-30's request (billing block, headers, no cache breakpoint),
// R4-23 efforts, R4-92's output limit, the R4-76 texts (SSE error,
// non-200, empty), the overload retry before delivery only (D-M4-4), the
// 429-exhausted and 401 facts, readings from every answer's headers, and no
// token or provider body in anything a failure carries. Ported in part from
// lal `test/subscription-messages.test.js` (1315bef86).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import { m4Texts, m4TextOf } from '../../guest/lib/texts-m4.js';
/* eslint-enable import/no-relative-packages */
import { NATIVE_CONTEXT_FORMAT } from '../../resources/agent-host/impl/projection.js';
import { ProviderFailure } from '../../resources/agent-host/impl/providers/round.js';
import {
  claudeAttempt,
  claudeBody,
  claudeClient,
  claudeEfforts,
} from '../../resources/agent-host/impl/subscriptions/messages.js';
import { withOverloadRetry } from '../../resources/agent-host/impl/subscriptions/wire.js';
import {
  BODY_MARKER,
  claudeEvents,
  exhaustedEntry,
  readingHeaders,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';

const MODEL = 'claude-sonnet-5';
// A placeholder that does not look like a provider token (joined at run time).
const TOKEN = ['fake', 'access', 'w43', 'claude'].join('-');
const credential = harden({
  accessToken: TOKEN,
  expiresAtMs: 4_000_000_000_000,
});

/** @param {import('ava').ExecutionContext} t */
const serverFor = async t => {
  const server = await startFakeSubscriptionServer();
  t.teardown(server.close);
  return server;
};

/**
 * Run one attempt (or a retried one) to its end.
 * @param {AsyncIterable<any>} events
 */
const drain = async events => {
  /** @type {any[]} */
  const seen = [];
  try {
    for await (const event of events) seen.push(event);
    return { events: seen, error: undefined };
  } catch (error) {
    return { events: seen, error: /** @type {any} */ (error) };
  }
};

/**
 * @param {Awaited<ReturnType<typeof startFakeSubscriptionServer>>} server
 * @param {object} [options]
 * @param {any} [options.request]
 * @param {any} [options.spec]
 * @param {any} [options.projection]
 * @param {any[]} [options.readings]
 * @param {AbortSignal} [options.signal]
 */
const attempt = (server, options = {}) =>
  claudeAttempt({
    credential,
    projection: options.projection ?? {
      transcript: [{ kind: 'message', role: 'user', content: 'hi' }],
    },
    request: { modelId: MODEL, tools: [], ...options.request },
    spec: { baseUrl: server.url, ...options.spec },
    signal: options.signal ?? new AbortController().signal,
    onReading: reading => options.readings?.push(reading),
  });

/**
 * No token and no provider body in a failure or its events.
 * @param {import('ava').ExecutionContext} t
 * @param {{ events: any[], error: any }} result
 */
const clean = (t, result) => {
  const text = JSON.stringify([
    result.events,
    result.error?.message,
    { ...result.error },
  ]);
  t.false(text.includes(TOKEN), 'no token');
  t.false(text.includes(BODY_MARKER), 'no provider body');
};

test('text: deltas, usage, served model; R4-30 body and header names', async t => {
  const server = await serverFor(t);
  server.setPlan([
    {
      sse: 'claude-text.sse',
      headers: readingHeaders('claude', {
        primaryPercent: 20,
        secondaryPercent: 50,
        primaryResetSec: 1_800_000_000,
        secondaryResetSec: 1_800_100_000,
      }),
    },
  ]);
  /** @type {any[]} */
  const readings = [];
  const result = await drain(
    attempt(server, {
      readings,
      request: {
        system: 'You are terse.',
        tools: [
          {
            name: 'echo',
            description: 'Echo the text.',
            parameters:
              '{"type":"object","properties":{"text":{"type":"string"}}}',
          },
        ],
      },
    }),
  );
  t.is(result.error, undefined);
  const deltas = result.events.filter(e => 'delta' in e).map(e => e.delta);
  t.is(deltas.join(''), 'Hello, world. How can I help?');
  t.deepEqual(
    result.events.find(e => 'servedBy' in e),
    { servedBy: { modelId: MODEL } },
  );
  t.like(result.events.find(e => 'usage' in e)?.usage, {
    inputTokens: 12,
    outputTokens: 7,
  });
  t.deepEqual(result.events.at(-1), { stop: 'end_turn' });
  const [request] = server.requests();
  t.is(request.path, '/v1/messages');
  t.true(request.authorization, 'a bearer was sent');
  for (const name of [
    'anthropic-beta',
    'anthropic-version',
    'x-app',
    'user-agent',
  ]) {
    t.true(request.headerNames.includes(name), name);
  }
  t.false(request.headerNames.includes('x-api-key'), 'no API key header');
  t.deepEqual(request.json.system, [
    { type: 'text', text: claudeClient.billingBlock },
    { type: 'text', text: 'You are terse.' },
  ]);
  t.is(request.json.max_tokens, 16_384, 'R4-92');
  t.is(request.json.stream, true);
  t.is(request.json.thinking, undefined, 'no effort, no thinking');
  t.deepEqual(request.json.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]);
  t.is(request.json.tools[0].name, 'echo');
  t.false(
    JSON.stringify(request.json).includes('cache_control'),
    'no prompt-cache breakpoint (R4-30)',
  );
  t.false(JSON.stringify(request.json).includes(TOKEN), 'no token in body');
  t.is(readings.length, 1, 'one reading from the answer headers');
  t.is(readings[0].windows.length, 2);
  clean(t, result);
});

test('effort: adaptive thinking with the effort (R4-23); refused before any request when the model does not take it', async t => {
  t.deepEqual(claudeEfforts('claude-sonnet-5'), [
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ]);
  t.deepEqual(claudeEfforts('claude-opus-4-6-20260101'), [
    'low',
    'medium',
    'high',
    'max',
  ]);
  t.deepEqual(claudeEfforts('claude-fake-1'), []);
  const server = await serverFor(t);
  server.setPlan([{ sse: 'claude-text.sse' }]);
  const ok = await drain(
    attempt(server, {
      request: { reasoningEffort: 'xhigh', maxOutputTokens: 2048 },
    }),
  );
  t.is(ok.error, undefined);
  const [request] = server.requests();
  t.deepEqual(request.json.thinking, { type: 'adaptive' });
  t.deepEqual(request.json.output_config, { effort: 'xhigh' });
  t.is(request.json.max_tokens, 2048, 'the request limit wins');
  const refused = await drain(
    attempt(server, {
      request: { modelId: 'claude-fake-1', reasoningEffort: 'high' },
    }),
  );
  t.is(refused.error.message, m4Texts.unsupportedEffort);
  t.is(server.requests().length, 1, 'nothing sent for the refused effort');
});

test('spec maxOutputTokens applies when the request sets none', t => {
  const body = claudeBody({ modelId: MODEL, tools: [], maxOutputTokens: 0 });
  t.is(body.max_tokens, 16_384);
  t.deepEqual(body.system, [{ type: 'text', text: claudeClient.billingBlock }]);
});

test('tool use: calls with their ids; thinking kept as native context and replayed for the same model and text', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'claude-tool-use.sse' },
    { sse: 'claude-thinking.sse' },
  ]);
  const tools = await drain(attempt(server));
  t.is(tools.error, undefined);
  t.deepEqual(
    tools.events.filter(e => 'toolCall' in e).map(e => e.toolCall),
    [{ callId: 'toolu_fake_1', name: 'exec', args: '{"code":"1 + 1"}' }],
  );
  t.deepEqual(tools.events.at(-1), { stop: 'tool_use' });

  const thinking = await drain(attempt(server));
  t.is(thinking.error, undefined);
  const native = thinking.events.find(e => 'nativeContext' in e).nativeContext;
  const text = thinking.events
    .filter(e => 'delta' in e)
    .map(e => e.delta)
    .join('');
  t.is(text, 'Done.');
  // The next round replays the signed thinking before the text.
  const replay = claudeBody({
    modelId: MODEL,
    tools: [],
    transcript: [
      { kind: 'message', role: 'user', content: 'hi' },
      {
        kind: 'message',
        role: 'assistant',
        content: text,
        providerContext: { format: NATIVE_CONTEXT_FORMAT, payload: native },
      },
      { kind: 'message', role: 'user', content: 'again' },
    ],
  });
  t.deepEqual(replay.messages[1].content, [
    { type: 'thinking', thinking: 'Weighing it.', signature: 'sig-fake-1' },
    { type: 'text', text: 'Done.' },
  ]);
  // Another model: the thinking is left out.
  const other = claudeBody({
    modelId: 'claude-haiku-5-5',
    tools: [],
    transcript: [
      {
        kind: 'message',
        role: 'assistant',
        content: text,
        providerContext: { format: NATIVE_CONTEXT_FORMAT, payload: native },
      },
    ],
  });
  t.deepEqual(other.messages[0].content, [{ type: 'text', text: 'Done.' }]);
});

test('R4-76: an SSE error event, a non-200 and an empty answer give the three texts, none retryable', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'claude-error.sse' },
    { status: 500 },
    { sse: 'claude-empty.sse' },
  ]);
  const error = await drain(attempt(server));
  t.true(error.error instanceof ProviderFailure);
  t.is(error.error.message, m4Texts.claudeInferenceFailed);
  t.false(error.error.retryable);
  t.is(error.error.overloaded, undefined);
  clean(t, error);

  const http = await drain(attempt(server));
  t.is(http.error.message, m4TextOf.subscriptionHttp(500));
  t.is(http.error.status, 500);
  t.false(http.error.retryable);
  clean(t, http);

  const empty = await drain(attempt(server));
  t.is(empty.error.message, m4Texts.emptyMessagesOutput);
  t.false(empty.error.retryable);
  t.deepEqual(
    empty.events.map(e => Object.keys(e)[0]),
    ['usage'],
    'only the usage of the empty answer is reported',
  );
  clean(t, empty);
});

test('429 with exhaustion headers carries exhausted and its reset; a plain 429 does not; 401 is rejected', async t => {
  const server = await serverFor(t);
  const resetSec = 1_800_000_000;
  server.setPlan([
    exhaustedEntry('claude', resetSec),
    { status: 429, headers: { 'retry-after': '3' } },
    { status: 401 },
  ]);
  /** @type {any[]} */
  const readings = [];
  const exhausted = await drain(attempt(server, { readings }));
  t.is(exhausted.error.message, m4TextOf.subscriptionHttp(429));
  t.deepEqual(exhausted.error.exhausted, { untilMs: resetSec * 1000 });
  t.false(exhausted.error.retryable);
  t.is(readings.length, 1, 'the refusal reading is observed too');
  t.true(readings[0].limitReached);

  const throttled = await drain(attempt(server));
  t.is(throttled.error.exhausted, undefined);
  t.is(throttled.error.retryAfterMs, 3000);
  t.false(throttled.error.retryable);

  const rejected = await drain(attempt(server));
  t.is(rejected.error.message, m4TextOf.subscriptionHttp(401));
  t.true(rejected.error.rejected);
  for (const result of [exhausted, throttled, rejected]) clean(t, result);
});

test('overload (529 or overloaded_error) before delivery is retried on the schedule; after a delta it is not', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { status: 529 },
    { sse: 'claude-overloaded.sse' },
    { sse: 'claude-text.sse' },
  ]);
  /** @type {number[]} */
  const waits = [];
  const signal = new AbortController().signal;
  const delaysMs = [5, 10, 20, 40, 60];
  const retried = await drain(
    withOverloadRetry({
      attempt: attemptSignal => attempt(server, { signal: attemptSignal }),
      delaysMs,
      sleep: async ms => {
        waits.push(ms);
      },
      signal,
    }),
  );
  t.is(retried.error, undefined);
  t.deepEqual(waits, [5, 10]);
  t.is(server.requests().length, 3);
  t.is(
    retried.events
      .filter(e => 'delta' in e)
      .map(e => e.delta)
      .join(''),
    'Hello, world. How can I help?',
  );

  server.setPlan([{ sse: 'claude-overloaded-late.sse' }]);
  const late = await drain(
    withOverloadRetry({
      attempt: attemptSignal => attempt(server, { signal: attemptSignal }),
      delaysMs,
      sleep: async ms => {
        waits.push(ms);
      },
      signal,
    }),
  );
  t.is(late.error.message, m4Texts.claudeInferenceFailed);
  t.true(late.error.overloaded);
  t.true(late.error.delivered);
  t.false(late.error.retryable);
  t.deepEqual(waits, [5, 10], 'no wait after a delivery');
  t.is(server.requests().length, 4, 'not sent again');
  clean(t, late);
});

test('persistent overload: six attempts, five delays, then the failure keeps its facts', async t => {
  const server = await serverFor(t);
  server.setPlan([{ status: 529, repeat: 6 }]);
  /** @type {number[]} */
  const waits = [];
  const result = await drain(
    withOverloadRetry({
      attempt: attemptSignal => attempt(server, { signal: attemptSignal }),
      delaysMs: [5, 10, 20, 40, 60],
      sleep: async ms => {
        waits.push(ms);
      },
      signal: new AbortController().signal,
    }),
  );
  t.deepEqual(waits, [5, 10, 20, 40, 60]);
  t.is(server.requests().length, 6);
  t.is(
    result.error.message,
    textOf.afterAttempts(m4TextOf.subscriptionHttp(529), 6),
  );
  t.true(result.error.overloaded);
  t.is(result.error.status, 529);
});

test('a refused token and a provider body never reach the failure; transport failures keep fixed texts', async t => {
  const server = await serverFor(t);
  server.setPlan([{ hang: true }]);
  const controller = new AbortController();
  const pending = drain(attempt(server, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 50);
  const aborted = await pending;
  t.false(aborted.error instanceof ProviderFailure, 'a cancel is passed on');
  server.setPlan([{ hang: true }]);
  const timedOut = await drain(attempt(server, { spec: { timeoutMs: 100 } }));
  t.is(timedOut.error.message, textOf.anthropicTimeout(0));
  t.true(timedOut.error.timedOut);
  t.false(timedOut.error.retryable);
  server.setPlan([{ events: claudeEvents({ deltas: ['a'], stop: false }) }]);
  const cut = await drain(attempt(server));
  t.is(cut.error.message, texts.anthropicUnreachable);
  t.true(cut.error.delivered);
  for (const result of [timedOut, cut]) clean(t, result);
});
