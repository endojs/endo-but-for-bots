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
  subscriptionTextOf,
  subscriptionTexts,
} from '../../guest/lib/subscription-texts.js';
/* eslint-enable import/no-relative-packages */
import { NATIVE_CONTEXT_FORMAT } from '../../resources/agent-host/impl/projection.js';
import { BASE_URL_REFUSED } from '../../resources/agent-host/impl/providers/http.js';
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
  t.is(refused.error.message, subscriptionTexts.unsupportedEffort);
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
    subscriptionTextOf.responsesFailed(
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
    subscriptionTextOf.responsesFailed('response.failed', ['code=constructor']),
  );
  t.is(
    responsesFailureText({ type: 'error', code: 'rate_limit_exceeded' }),
    subscriptionTextOf.responsesFailed(
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
    subscriptionTextOf.responsesFailed('response.failed', []),
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
      subscriptionTextOf.responsesFailed('response.failed', [
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
  t.is(exhausted.error.message, subscriptionTextOf.subscriptionHttp(429));
  t.deepEqual(exhausted.error.exhausted, { untilMs: resetSec * 1000 });
  const rejected = await drain(attempt(server));
  t.true(rejected.error.rejected);
  const other = await drain(attempt(server));
  t.is(other.error.message, subscriptionTextOf.subscriptionHttp(503));
  t.false(other.error.retryable);
  for (const result of [exhausted, rejected, other]) clean(t, result);
});

test('unreadable Responses diagnostics expose only fixed MIME and event categories', async t => {
  const sse = 'text/event-stream; marker=FAKE-PROSE';
  const cases = [
    ['application/problem+json; marker=FAKE-PROSE', BODY_MARKER, 'mime=json'],
    ['text/html; marker=FAKE-PROSE', BODY_MARKER, 'mime=html'],
    ['application/FAKE-PROSE', BODY_MARKER, 'mime=other'],
    [sse, 'FAKE-PROSE', 'reason=json-parse'],
    [sse, JSON.stringify([BODY_MARKER]), 'reason=non-object'],
    [sse, '{}', 'reason=event-type-no-name'],
    [sse, '{}', 'reason=event-type-message', 'message'],
    [sse, '{}', 'reason=event-type-known-name', 'response.output_text.delta'],
    [sse, '{}', 'reason=event-type-other-name', 'FAKE-PROSE'],
    [
      sse,
      JSON.stringify({ type: 'response.output_item.done', output_index: null }),
      'reason=output-index',
    ],
    [
      sse,
      JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: {},
      }),
      'reason=output-item-type',
    ],
    [
      sse,
      JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: BODY_MARKER,
      }),
      'reason=output-item',
    ],
  ];
  await Promise.all(
    cases.map(async ([contentType, data, fact, name]) => {
      const prefix = name ? `event: ${name}\n` : '';
      const result = await drain(
        codexAttempt({
          credential,
          projection: { transcript: [] },
          request: { modelId: MODEL, tools: [] },
          signal: new AbortController().signal,
          fetch: async () =>
            new Response(
              new TextEncoder().encode(`${prefix}data: ${data}\n\n`),
              {
                headers: contentType ? { 'content-type': contentType } : {},
              },
            ),
        }),
      );
      t.is(
        result.error?.message,
        subscriptionTextOf.responsesFailed('stream.unreadable', [fact]),
      );
      clean(t, result);
    }),
  );
});

test('headerless success requires a complete Responses SSE stream', async t => {
  const run = (/** @type {string | null} */ body, status = 200) =>
    drain(
      codexAttempt({
        credential,
        projection: { transcript: [] },
        request: { modelId: MODEL, tools: [] },
        signal: new AbortController().signal,
        fetch: async () =>
          new Response(body === null ? null : new TextEncoder().encode(body), {
            status,
          }),
      }),
    );
  const delta = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n';
  const completed =
    'data: {"type":"response.completed","response":{"output":[]}}\n\n';
  const good = await run(delta + completed);
  t.is(good.error, undefined);
  t.is(joined(good), 'ok');
  t.deepEqual(good.events.at(-1), { stop: 'completed' });
  const incomplete = (status = 200, event = 'none') =>
    subscriptionTextOf.responsesFailed('stream.incomplete', [
      'mime=missing',
      `status=${status}`,
      `sse=${event}`,
    ]);
  /** @type {Array<[ReturnType<typeof run>, string]>} */
  const cases = [
    [run(JSON.stringify({ error: BODY_MARKER })), incomplete()],
    [run(`<html>${BODY_MARKER}</html>\n`), incomplete()],
    [run(''), incomplete()],
    [run(null, 204), incomplete(204)],
    [run(delta + completed.trimEnd()), incomplete(200, 'seen')],
    [
      run(`${delta}data: FAKE-PROSE\n\n`),
      subscriptionTextOf.responsesFailed('stream.unreadable', [
        'reason=json-parse',
        'mime=missing',
        'status=200',
        'sse=seen',
      ]),
    ],
  ];
  await Promise.all(
    cases.map(async ([pending, expected]) => {
      const result = await pending;
      t.is(result.error?.message, expected);
      t.false(result.events.some(event => event.stop === 'completed'));
      clean(t, result);
    }),
  );
});

test('streamed output preserves index-free arrival order and reserves explicit positions', async t => {
  const server = await serverFor(t);
  const done = (
    /** @type {string} */ text,
    /** @type {number} */ index = -1,
  ) => ({
    data: {
      type: 'response.output_item.done',
      ...(index === -1 ? {} : { output_index: index }),
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    },
  });
  const completed = {
    data: { type: 'response.completed', response: { output: [] } },
  };
  server.setPlan([
    { events: [done('A'), done('B'), completed] },
    { events: [done('B'), done('D', 3), done('C'), done('A', 0), completed] },
    { events: [done('B', 1), done('A', 0), completed] },
  ]);
  for (const expected of ['AB', 'ABCD', 'AB']) {
    // eslint-disable-next-line no-await-in-loop -- consume the fixtures in order
    const result = await drain(attempt(server));
    t.is(result.error, undefined);
    t.is(joined(result), expected);
  }
});

test('named SSE errors retain symbolic facts and honor the delivery fence', async t => {
  const code = 'server_is_overloaded';
  const error = { code, message: 'FAKE-PROSE' };
  const failure = `event: error\ndata: ${JSON.stringify({ error })}\n\n`;
  const delta = 'data: {"type":"response.output_text.delta","delta":"ok"}\n\n';
  const run = async (/** @type {string} */ prefix) =>
    drain(
      codexAttempt({
        credential,
        projection: { transcript: [] },
        request: { modelId: MODEL, tools: [] },
        signal: new AbortController().signal,
        fetch: async () =>
          new Response(prefix + failure, {
            headers: { 'content-type': 'Text/Event-Stream ; charset=UTF-8' },
          }),
      }),
    );
  const [early, late] = await Promise.all([run(''), run(delta)]);
  t.true(early.error.retryable);
  t.false(late.error.retryable);
  t.is(joined(late), 'ok');
  for (const result of [early, late]) {
    t.true(result.error.overloaded);
    t.is(result.error.message, responsesFailureText({ type: 'error', error }));
    clean(t, result);
  }
});

test('empty answer, cut stream, timeout and cancel', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'codex-empty.sse' },
    { events: codexEvents({ deltas: ['a', 'b'], complete: false }) },
  ]);
  const empty = await drain(attempt(server));
  t.is(empty.error.message, subscriptionTexts.emptyResponsesOutput);
  t.deepEqual(
    empty.events.map(e => Object.keys(e)[0]),
    ['usage'],
  );
  const cut = await drain(attempt(server));
  t.is(
    cut.error.message,
    subscriptionTextOf.responsesFailed('stream.incomplete', []),
  );
  t.true(cut.error.delivered);

  server.setPlan([{ hang: true }]);
  const timedOut = await drain(attempt(server, { spec: { timeoutMs: 100 } }));
  t.is(
    timedOut.error.message,
    subscriptionTextOf.responsesFailed('stream.timeout', []),
  );
  t.true(timedOut.error.timedOut);

  server.setPlan([{ hang: true }]);
  const controller = new AbortController();
  const pending = drain(attempt(server, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 50);
  const aborted = await pending;
  t.false(aborted.error instanceof ProviderFailure);
  for (const result of [empty, cut, timedOut]) clean(t, result);
});

test('INT-M4: a pool base URL outside https or loopback http is refused before any request (M2 review rule)', async t => {
  const server = await serverFor(t);
  for (const baseUrl of [
    `${server.url}/?q=1`,
    `${server.url}#frag`,
    server.url.replace('http://', 'http://user:pw@'),
    server.url.replace('http://', 'ftp://'),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const refused = await drain(attempt(server, { spec: { baseUrl } }));
    t.is(refused.error?.message, BASE_URL_REFUSED, baseUrl);
  }
  t.is(server.requests().length, 0);
});

test('a round without its projection sends nothing: no empty-transcript fallback', async t => {
  // The pool shell refuses a round with no prepare (PREPARE_REQUIRED), so
  // the wire builder always has the projection and reads its transcript
  // directly; a missing one fails before any request.
  const server = await serverFor(t);
  server.setPlan([{ sse: 'codex-text.sse' }]);
  const result = await drain(
    codexAttempt({
      credential,
      projection: /** @type {any} */ (undefined),
      request: { modelId: MODEL, tools: [] },
      spec: { baseUrl: server.url },
      signal: new AbortController().signal,
    }),
  );
  t.true(result.error instanceof TypeError);
  t.is(server.requests().length, 0, 'nothing sent');
});
