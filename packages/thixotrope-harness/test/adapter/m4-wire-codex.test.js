// @ts-check
// M4 W4.3: the Codex subscription wire client
// (resources/agent-host/impl/subscriptions/responses.js; designs/m4-interfaces.md
// 5.3) against the fake subscription server (127.0.0.1). One attempt at a
// time, called directly: text deltas and usage, function calls, encrypted
// reasoning kept as native context and replayed, R4-30's request
// (`instructions`, `store: false`, encrypted reasoning included, headers),
// R4-23's `ultra` sent as `max`, failure texts with symbolic facts only,
// `server_is_overloaded` retried on the schedule (scaled) only before
// visible delivery (R4-75, R4-105), HTTP refusals, the empty answer, and no
// token or provider prose in anything a failure carries. Ported in part
// from lal `test/subscription-responses.test.js` (1315bef86).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
import {
  codexExplanations,
  m4Texts,
  m4TextOf,
} from '../../guest/lib/texts-m4.js';
/* eslint-enable import/no-relative-packages */
import { NATIVE_CONTEXT_FORMAT } from '../../resources/agent-host/impl/projection.js';
import { ProviderFailure } from '../../resources/agent-host/impl/providers/round.js';
import {
  codexAttempt,
  codexBody,
  codexEffort,
  responsesFailureText,
} from '../../resources/agent-host/impl/subscriptions/responses.js';
import { withOverloadRetry } from '../../resources/agent-host/impl/subscriptions/wire.js';
import {
  BODY_MARKER,
  codexEvents,
  exhaustedEntry,
  readingHeaders,
  startFakeSubscriptionServer,
} from '../fixtures/fake-subscription-server.mjs';

const MODEL = 'gpt-fake-1';
// Placeholders that do not look like provider tokens (joined at run time).
const TOKEN = ['fake', 'access', 'w43', 'codex'].join('-');
const ACCOUNT = ['acct', 'fake', '1'].join('_');
const credential = harden({
  accessToken: TOKEN,
  expiresAtMs: 4_000_000_000_000,
  accountId: ACCOUNT,
});
const DELAYS = [5, 10, 20, 40, 60];

/** @param {import('ava').ExecutionContext} t */
const serverFor = async t => {
  const server = await startFakeSubscriptionServer();
  t.teardown(server.close);
  return server;
};

/** @param {AsyncIterable<any>} events */
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
  codexAttempt({
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
 * @param {Awaited<ReturnType<typeof startFakeSubscriptionServer>>} server
 * @param {number[]} waits
 */
const retried = (server, waits) =>
  drain(
    withOverloadRetry({
      attempt: signal => attempt(server, { signal }),
      delaysMs: DELAYS,
      sleep: async ms => {
        waits.push(ms);
      },
      signal: new AbortController().signal,
    }),
  );

/**
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
  t.false(text.includes(ACCOUNT), 'no account id');
  t.false(text.includes(BODY_MARKER), 'no provider body');
  t.false(text.includes('FAKE-PROSE'), 'no provider prose');
};

/** @param {{ events: any[] }} result */
const joined = result =>
  result.events
    .filter(e => 'delta' in e)
    .map(e => e.delta)
    .join('');

test('text: deltas, disjoint usage, served model; R4-30 body and header names; a reading per answer', async t => {
  const server = await serverFor(t);
  server.setPlan([
    {
      sse: 'codex-text.sse',
      headers: readingHeaders('codex', {
        primaryPercent: 10,
        secondaryPercent: 30,
        primaryResetSec: 1_800_000_000,
        secondaryResetSec: 1_800_500_000,
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
            description: 'Echo.',
            parameters:
              '{"type":"object","properties":{"text":{"type":"string"}}}',
          },
        ],
      },
    }),
  );
  t.is(result.error, undefined);
  t.is(joined(result), 'Hello, world. How can I help?');
  t.deepEqual(
    result.events.find(e => 'servedBy' in e),
    {
      servedBy: { modelId: MODEL },
    },
  );
  t.like(result.events.find(e => 'usage' in e)?.usage, {
    inputTokens: 12,
    outputTokens: 7,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
  });
  t.deepEqual(result.events.at(-1), { stop: 'completed' });
  const [request] = server.requests();
  t.is(request.path, '/backend-api/codex/responses');
  t.true(request.authorization);
  t.true(request.headerNames.includes('chatgpt-account-id'));
  t.true(request.headerNames.includes('originator'));
  t.is(request.json.instructions, 'You are terse.');
  t.is(request.json.store, false);
  t.is(request.json.stream, true);
  t.deepEqual(request.json.include, ['reasoning.encrypted_content']);
  t.deepEqual(request.json.input, [{ role: 'user', content: 'hi' }]);
  t.deepEqual(request.json.tools, [
    {
      type: 'function',
      name: 'echo',
      description: 'Echo.',
      parameters: { type: 'object', properties: { text: { type: 'string' } } },
    },
  ]);
  t.is(request.json.reasoning, undefined);
  t.false(JSON.stringify(request.json).includes('cache_control'));
  t.false(JSON.stringify(request.json).includes(TOKEN));
  t.is(readings.length, 1);
  t.is(readings[0].windows.length, 2);
  clean(t, result);
});

test('efforts: ultra is sent as max (R4-23); an unknown effort is refused before any request', async t => {
  t.is(codexEffort('ultra'), 'max');
  t.is(codexEffort('high'), 'high');
  t.is(codexEffort('turbo'), undefined);
  const server = await serverFor(t);
  server.setPlan([{ sse: 'codex-text.sse' }]);
  const ok = await drain(
    attempt(server, { request: { reasoningEffort: 'ultra' } }),
  );
  t.is(ok.error, undefined);
  t.deepEqual(server.requests()[0].json.reasoning, { effort: 'max' });
  const refused = await drain(
    attempt(server, { request: { reasoningEffort: 'turbo' } }),
  );
  t.is(refused.error.message, m4Texts.unsupportedEffort);
  t.is(server.requests().length, 1);
});

test('function calls keep their call ids; encrypted reasoning is native context, replayed with call identities on the next round', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'codex-tool-calls.sse' },
    { sse: 'codex-reasoning.sse' },
  ]);
  const calls = await drain(attempt(server));
  t.is(calls.error, undefined);
  t.deepEqual(
    calls.events.filter(e => 'toolCall' in e).map(e => e.toolCall),
    [
      { callId: 'call_fake_1', name: 'exec', args: '{"code":"1 + 1"}' },
      { callId: 'call_fake_2', name: 'echo', args: '{"text":"hi"}' },
    ],
  );
  t.deepEqual(calls.events.at(-1), { stop: 'tool_calls' });

  const reasoning = await drain(attempt(server));
  t.is(reasoning.error, undefined);
  const native = reasoning.events.find(e => 'nativeContext' in e).nativeContext;
  t.true(native.includes('ENCRYPTED-FAKE-REASONING'));
  const providerContext = { format: NATIVE_CONTEXT_FORMAT, payload: native };
  const body = codexBody({
    modelId: MODEL,
    tools: [],
    transcript: [
      { kind: 'message', role: 'user', content: 'hi' },
      { kind: 'message', role: 'assistant', content: 'Done.', providerContext },
      { kind: 'tool-call', id: 't1/r0/c0', name: 'exec', args: '{"code":"2"}' },
      { kind: 'tool-result', id: 't1/r0/c0', content: '2' },
      { kind: 'tool-call', id: 't1/r0/c1', name: 'echo', args: '{}' },
    ],
  });
  t.deepEqual(body.input, [
    { role: 'user', content: 'hi' },
    {
      type: 'reasoning',
      id: 'rs_fake_0',
      summary: [],
      encrypted_content: 'ENCRYPTED-FAKE-REASONING',
    },
    { role: 'assistant', content: 'Done.' },
    {
      type: 'function_call',
      call_id: 't1_2fr0_2fc0',
      name: 'exec',
      arguments: '{"code":"2"}',
    },
    { type: 'function_call_output', call_id: 't1_2fr0_2fc0', output: '2' },
    {
      type: 'function_call',
      call_id: 't1_2fr0_2fc1',
      name: 'echo',
      arguments: '{}',
    },
    {
      type: 'function_call_output',
      call_id: 't1_2fr0_2fc1',
      output: texts.toolOutcomeUnknown,
    },
  ]);
  // Another model, or other text: the reasoning is left out.
  const other = codexBody({
    modelId: 'gpt-fake-mini',
    tools: [],
    transcript: [
      { kind: 'message', role: 'assistant', content: 'Done.', providerContext },
    ],
  });
  t.deepEqual(other.input, [{ role: 'assistant', content: 'Done.' }]);
});

test('completion with items only in the completed output, and a refusal part, are replies', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { events: codexEvents({ deltas: ['Hi.'], completedOutput: true }) },
    {
      events: [
        {
          data: {
            type: 'response.completed',
            response: {
              model: MODEL,
              status: 'completed',
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'refusal', refusal: 'I cannot.' }],
                },
              ],
            },
          },
        },
      ],
    },
  ]);
  const both = await drain(attempt(server));
  t.is(both.error, undefined);
  t.is(joined(both), 'Hi.', 'the text is not delivered twice');
  const refusal = await drain(attempt(server));
  t.is(refusal.error, undefined);
  t.is(joined(refusal), 'I cannot.');
});

test('failure events: symbolic facts and the fixed explanation, never prose; inherited names are not explanations', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'codex-failed.sse' }]);
  const failed = await drain(attempt(server));
  t.is(
    failed.error.message,
    m4TextOf.responsesFailed(
      'response.failed',
      [
        'code=context_length_exceeded',
        'type=invalid_request_error',
        'param=input',
      ],
      codexExplanations.context_length_exceeded,
    ),
  );
  t.false(failed.error.retryable);
  clean(t, failed);
  t.is(
    responsesFailureText({
      type: 'response.failed',
      response: { error: { code: 'constructor', message: 'FAKE-PROSE' } },
    }),
    m4TextOf.responsesFailed('response.failed', ['code=constructor']),
  );
  t.is(
    responsesFailureText({ type: 'error', code: 'rate_limit_exceeded' }),
    m4TextOf.responsesFailed(
      'error',
      ['code=rate_limit_exceeded'],
      codexExplanations.rate_limit_exceeded,
    ),
  );
  t.is(
    responsesFailureText({
      type: 'response.failed',
      response: { error: { code: 'sk_live_abc', param: 'bearer.x' } },
    }),
    m4TextOf.responsesFailed('response.failed', []),
    'credential-shaped values are dropped',
  );
});

test('server_is_overloaded before visible delivery is retried on the schedule (R4-75, R4-105); after it, and when incomplete, it is not', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'codex-overloaded.sse' },
    { sse: 'codex-overloaded.sse' },
    { sse: 'codex-text.sse' },
  ]);
  /** @type {number[]} */
  const waits = [];
  const ok = await retried(server, waits);
  t.is(ok.error, undefined);
  t.deepEqual(waits, [5, 10]);
  t.is(joined(ok), 'Hello, world. How can I help?');
  t.is(server.requests().length, 3);

  server.setPlan([{ sse: 'codex-overloaded-late.sse' }]);
  const late = await retried(server, waits);
  t.true(late.error.overloaded);
  t.true(late.error.delivered);
  t.false(late.error.retryable);
  t.is(joined(late), 'Part');
  t.deepEqual(waits, [5, 10], 'no wait after a delivery');
  t.is(server.requests().length, 4);

  server.setPlan([
    {
      events: codexEvents({
        failure: {
          type: 'response.incomplete',
          code: 'server_is_overloaded',
          reason: 'max_output_tokens',
        },
      }),
    },
  ]);
  const incomplete = await retried(server, waits);
  t.false(incomplete.error.retryable);
  t.is(incomplete.error.overloaded, undefined);
  t.is(server.requests().length, 5);

  // Usage fences a retry (tokens were consumed).
  server.setPlan([
    {
      events: [
        { data: { type: 'response.created', response: { output: [] } } },
        { data: { type: 'response.metadata', usage: { input_tokens: 3 } } },
        {
          data: {
            type: 'response.failed',
            response: { error: { code: 'server_is_overloaded' } },
          },
        },
      ],
    },
  ]);
  const fenced = await retried(server, waits);
  t.true(fenced.error.overloaded);
  t.false(fenced.error.retryable);
  t.is(server.requests().length, 6);
  for (const result of [late, incomplete, fenced]) clean(t, result);
});

test('persistent overload: six attempts and five delays', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'codex-overloaded.sse', repeat: 6 }]);
  /** @type {number[]} */
  const waits = [];
  const result = await retried(server, waits);
  t.deepEqual(waits, DELAYS);
  t.is(server.requests().length, 6);
  t.true(result.error instanceof ProviderFailure);
  t.true(result.error.overloaded);
  t.is(
    result.error.message,
    textOf.afterAttempts(
      m4TextOf.responsesFailed('response.failed', [
        'code=server_is_overloaded',
      ]),
      6,
    ),
  );
});

test('HTTP: 429 exhausted carries its reset, 401 rejected, others the subscription text; bodies never read', async t => {
  const server = await serverFor(t);
  const resetSec = 1_800_000_000;
  server.setPlan([
    exhaustedEntry('codex', resetSec),
    { status: 401 },
    { status: 503 },
  ]);
  const exhausted = await drain(attempt(server));
  t.is(exhausted.error.message, m4TextOf.subscriptionHttp(429));
  t.deepEqual(exhausted.error.exhausted, { untilMs: resetSec * 1000 });
  const rejected = await drain(attempt(server));
  t.true(rejected.error.rejected);
  const other = await drain(attempt(server));
  t.is(other.error.message, m4TextOf.subscriptionHttp(503));
  t.false(other.error.retryable);
  for (const result of [exhausted, rejected, other]) clean(t, result);
});

test('empty answer, cut stream, timeout and cancel', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'codex-empty.sse' },
    { events: codexEvents({ deltas: ['a', 'b'], complete: false }) },
  ]);
  const empty = await drain(attempt(server));
  t.is(empty.error.message, m4Texts.emptyResponsesOutput);
  t.deepEqual(
    empty.events.map(e => Object.keys(e)[0]),
    ['usage'],
  );
  const cut = await drain(attempt(server));
  t.is(cut.error.message, m4TextOf.responsesFailed('stream.incomplete', []));
  t.true(cut.error.delivered);

  server.setPlan([{ hang: true }]);
  const timedOut = await drain(attempt(server, { spec: { timeoutMs: 100 } }));
  t.is(timedOut.error.message, m4TextOf.responsesFailed('stream.timeout', []));
  t.true(timedOut.error.timedOut);

  server.setPlan([{ hang: true }]);
  const controller = new AbortController();
  const pending = drain(attempt(server, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 50);
  const aborted = await pending;
  t.false(aborted.error instanceof ProviderFailure);
  for (const result of [empty, cut, timedOut]) clean(t, result);
});
