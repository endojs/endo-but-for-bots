// @ts-check
// M2 W2.1b: the streamed Anthropic Messages provider
// (resources/agent-host/impl/providers/anthropic.js; designs/m2-interfaces.md
// 8.1, 8.2) against the fake provider server (127.0.0.1, D-M2-4), through the
// Endpoint, with a guarded fake TurnSink and real blob files under H/tmp.
// One fixture test each for: text deltas, tool calls, thinking kept as
// opaque native context, usage counts, every stop reason, the overload path
// (529 and the stream's overloaded_error) and the rate-limit path (429 with
// Retry-After); plus 401 (R4-77), timeouts, cancel, and that no provider
// body or key reaches anything the round records (R4-79).
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts, textOf } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import {
  ANTHROPIC_MAX_OUTPUT_TOKENS,
  anthropicKind,
  anthropicMessages,
  anthropicToolId,
  makeAnthropicProvider,
  textDigest,
} from '../../resources/agent-host/impl/providers/anthropic.js';
import { anthropicDelay } from '../../resources/agent-host/impl/providers/retry.js';
import { NATIVE_CONTEXT_FORMAT } from '../../resources/agent-host/impl/projection.js';
import { backendKinds } from '../../resources/agent-host/impl/index.js';
import {
  anthropicEvents,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';
import {
  KEY,
  noBodyOrKey,
  runApiRound,
  timers,
  until,
} from './_m2-w21b-round.js';

const { E } = /** @type {any} */ (globalThis);

const MODEL = 'claude-fake-1';

/** @param {import('ava').ExecutionContext} t */
const serverFor = async t => {
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  return server;
};

/**
 * @param {Awaited<ReturnType<typeof startFakeProviderServer>>} server
 * @param {Parameters<typeof runApiRound>[1] extends infer O ? Partial<O> : never} [options]
 */
const run = (server, options = {}) =>
  runApiRound(makeAnthropicProvider, {
    baseUrl: server.anthropicBaseUrl,
    modelId: MODEL,
    ...options,
  });

test('the anthropic kind is in backendKinds and offers no adapter tool', t => {
  t.is(
    backendKinds.find(k => k.kind === 'anthropic'),
    anthropicKind,
  );
  t.deepEqual(anthropicKind.tools, []);
});

test('text: more than one delta per reply; usage, served-by and the request', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'anthropic-text.sse' }]);
  const r = await run(server, {
    system: 'You are terse.',
    tools: [
      {
        name: 'echo',
        description: 'Echo the text.',
        parameters: '{"type":"object","properties":{"text":{"type":"string"}}}',
      },
    ],
  });
  t.teardown(r.cleanup);
  t.deepEqual(r.failures, []);
  const [final] = r.finals;
  t.is(final.text, 'Hello, world. How can I help?');
  t.deepEqual(final.toolCalls, []);
  t.deepEqual(final.usage, {
    inputTokens: 12,
    outputTokens: 7,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    reasoningOutputTokens: 0,
    context: { usedTokens: 19, windowTokens: 0 },
  });
  t.deepEqual(final.servedBy, { label: 'api-test', modelId: MODEL });
  t.is(final.nativeContext, undefined);
  const deltas = await r.deltas();
  t.true(deltas.length > 1, `${deltas.length} deltas`);
  t.is(deltas.join(''), final.text);
  const [request] = server.requests();
  t.is(request.path, '/v1/messages');
  t.true(request.authorization, 'x-api-key sent');
  t.is(request.json.model, MODEL);
  t.is(request.json.max_tokens, ANTHROPIC_MAX_OUTPUT_TOKENS);
  t.is(request.json.stream, true);
  t.is(request.json.system, 'You are terse.');
  t.deepEqual(request.json.messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ]);
  t.deepEqual(request.json.tools, [
    {
      name: 'echo',
      description: 'Echo the text.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
      },
    },
  ]);
  t.false(JSON.stringify(request.json).includes(KEY), 'key not in the body');
  noBodyOrKey(t, r);
});

test('tool calls: input fragments joined, args stay text, ids kept; cache usage counts', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'anthropic-tool-use.sse' }]);
  const r = await run(server);
  t.teardown(r.cleanup);
  const [final] = r.finals;
  t.is(final.text, 'Let me check.');
  t.deepEqual(final.toolCalls, [
    { callId: 'toolu_fake_1', name: 'exec', args: '{"code":"1 + 1"}' },
    { callId: 'toolu_fake_2', name: 'echo', args: '{"text":"hi"}' },
  ]);
  t.deepEqual(final.usage, {
    inputTokens: 40,
    outputTokens: 30,
    cachedInputTokens: 8,
    cacheWriteInputTokens: 4,
    reasoningOutputTokens: 0,
    context: { usedTokens: 82, windowTokens: 0 },
  });
  noBodyOrKey(t, r);
});

test('a tool call with no input gets {}; bad JSON input reaches the vat as sent', async t => {
  const server = await serverFor(t);
  server.setPlan([
    {
      events: anthropicEvents({
        toolCalls: [
          { id: 'toolu_a', name: 'echo', args: '' },
          { id: 'toolu_b', name: 'nope', args: '{"x":', pieces: 1 },
        ],
      }),
    },
  ]);
  const r = await run(server);
  t.teardown(r.cleanup);
  t.deepEqual(
    r.finals[0].toolCalls.map((/** @type {any} */ c) => c.args),
    ['{}', '{"x":'],
  );
});

test('thinking is kept as opaque native context: staged, never published, replayed only for its model and text', async t => {
  const server = await serverFor(t);
  server.setPlan([{ sse: 'anthropic-thinking.sse' }]);
  const r = await run(server);
  t.teardown(r.cleanup);
  t.deepEqual(r.failures, []);
  const [final] = r.finals;
  t.is(final.text, 'Hi there.');
  t.truthy(final.nativeContext, 'native context in the result');
  t.is(final.nativeContext.preview, '', 'native context has no preview');
  const payload = await r.blobs.store.read(final.nativeContext.blob);
  const native = JSON.parse(payload);
  t.is(native.model, MODEL);
  t.is(native.textDigest, textDigest('Hi there.'));
  t.deepEqual(native.blocks, [
    {
      type: 'thinking',
      thinking: 'The user greets me; answer briefly.',
      signature: 'fake signature one',
    },
    { type: 'redacted_thinking', data: 'fake redacted data' },
  ]);
  const deltas = (await r.deltas()).join('');
  t.false(deltas.includes('greets'), 'thinking is not published');
  t.false(
    JSON.stringify(r.log).includes('greets'),
    'thinking is not in the log',
  );

  // Replay (R4-31): the blocks go before the round's text only when the
  // model and the text match.
  /**
   * @param {string} model
   * @param {string} text
   */
  const assistantOf = (model, text) =>
    anthropicMessages(
      [
        { kind: 'message', role: 'user', content: 'hi' },
        {
          kind: 'message',
          role: 'assistant',
          content: text,
          providerContext: { format: NATIVE_CONTEXT_FORMAT, payload },
        },
        { kind: 'message', role: 'user', content: 'again' },
      ],
      model,
    )[1];
  t.deepEqual(
    assistantOf(MODEL, 'Hi there.').content.map(
      (/** @type {any} */ b) => b.type,
    ),
    ['thinking', 'redacted_thinking', 'text'],
  );
  t.deepEqual(assistantOf('claude-other-2', 'Hi there.').content, [
    { type: 'text', text: 'Hi there.' },
  ]);
  t.deepEqual(assistantOf(MODEL, 'Hi there!').content, [
    { type: 'text', text: 'Hi there!' },
  ]);

  // The next request replays it.
  server.setPlan([{ sse: 'anthropic-text.sse' }]);
  const again = await run(server, {
    transcript: [
      { kind: 'message', role: 'user', content: 'hi' },
      {
        kind: 'message',
        role: 'assistant',
        content: 'Hi there.',
        providerContext: { format: NATIVE_CONTEXT_FORMAT, payload },
      },
      { kind: 'message', role: 'user', content: 'again' },
    ],
  });
  t.teardown(again.cleanup);
  const sent = server.requests()[1].json.messages[1].content;
  t.is(sent[0].signature, 'fake signature one');
  t.is(sent[1].data, 'fake redacted data');
});

test('stop reasons: max_tokens with text gets the note; without text, refusal and a mismatch fail (R4-42, R4-78)', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'anthropic-max-tokens.sse' },
    { sse: 'anthropic-max-tokens-empty.sse' },
    { sse: 'anthropic-refusal.sse' },
    { sse: 'anthropic-stop-mismatch.sse' },
    {
      events: anthropicEvents({ deltas: ['x'], stopReason: 'tool_use' }),
    },
    {
      events: anthropicEvents({ deltas: ['x'], stopReason: 'pause_turn' }),
    },
    {
      events: anthropicEvents({
        deltas: ['x'],
        stopReason: 'Not An Identifier 42',
      }),
    },
  ]);
  const cut = await run(server);
  t.teardown(cut.cleanup);
  const note = `\n\n${texts.outputLimitNote}`;
  t.is(cut.finals[0].text, `A reply cut at its limit${note}`);
  t.is((await cut.deltas()).join(''), cut.finals[0].text);

  const expect = [
    [textOf.anthropicStopped('max_tokens'), ''],
    [textOf.anthropicStopped('refusal'), 'I can'],
    [textOf.anthropicStopMismatch('end_turn', 1), ''],
    [textOf.anthropicStopMismatch('tool_use', 0), 'x'],
    [textOf.anthropicStopped('pause_turn'), 'x'],
    [textOf.anthropicStopped('unknown'), 'x'],
  ];
  for (const [reason, partial] of expect) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run(server);
    t.teardown(r.cleanup);
    t.deepEqual(r.finals, []);
    t.is(r.failures[0].reason, reason);
    t.is(r.failures[0].partial ?? '', partial);
    t.truthy(r.failures[0].usage, 'tokens consumed are reported');
    noBodyOrKey(t, r);
  }
  t.is(server.requests().length, 7, 'none of them is retried');
});

test('max_tokens comes from the round, then the spec, else 4,096 (R4-92)', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'anthropic-text.sse' },
    { sse: 'anthropic-text.sse' },
  ]);
  const a = await run(server, { requestOptions: { maxOutputTokens: 333 } });
  t.teardown(a.cleanup);
  const b = await run(server, { spec: { maxOutputTokens: 222 } });
  t.teardown(b.cleanup);
  t.deepEqual(
    server.requests().map(request => request.json.max_tokens),
    [333, 222],
  );
});

test('401 fails with the R4-77 text, once, and its body is never read', async t => {
  const server = await serverFor(t);
  server.setPlan([{ status: 401 }, { status: 403 }, { status: 400 }]);
  const auth = await run(server);
  t.teardown(auth.cleanup);
  t.is(auth.failures[0].reason, texts.anthropicAuthFailed);
  noBodyOrKey(t, auth);
  for (const status of [403, 400]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await run(server);
    t.teardown(r.cleanup);
    t.is(r.failures[0].reason, textOf.anthropicHttp(status));
    noBodyOrKey(t, r);
  }
  t.is(server.requests().length, 3, 'not retried');
});

test('rate limit: a 429 with Retry-After is retried after the wait, before any delta', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { status: 429, headers: { 'retry-after': '1' } },
    { sse: 'anthropic-text.sse' },
  ]);
  const r = await run(server, { waitMs: 10_000 });
  t.teardown(r.cleanup);
  t.is(r.finals[0].text, 'Hello, world. How can I help?');
  t.is(server.requests().length, 2);
  t.true(r.elapsedMs >= 1000, `waited ${r.elapsedMs} ms`);
  const retries = r.log.filter(line => line.kind === 'retry');
  t.deepEqual(retries, [
    {
      kind: 'retry',
      turnId: 't1',
      round: 0,
      attempt: 1,
      waitMs: anthropicDelay(1, 1000),
      status: 429,
      timedOut: false,
    },
  ]);
  // The API's own millisecond header is preferred.
  server.setPlan([
    { status: 429, headers: { 'retry-after-ms': '700', 'retry-after': '5' } },
    { sse: 'anthropic-text.sse' },
  ]);
  const ms = await run(server, { waitMs: 10_000 });
  t.teardown(ms.cleanup);
  t.is(
    ms.log.find(line => line.kind === 'retry').waitMs,
    anthropicDelay(1, 700),
  );
  noBodyOrKey(t, r);
});

test('overload: 529 and an overloaded_error event before any text are retried; after text they are not', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { status: 529 },
    { sse: 'anthropic-overloaded.sse' },
    { sse: 'anthropic-text.sse' },
  ]);
  const r = await run(server, { waitMs: 10_000 });
  t.teardown(r.cleanup);
  t.is(r.finals[0].text, 'Hello, world. How can I help?');
  t.is(server.requests().length, 3);
  t.deepEqual(
    r.log.filter(line => line.kind === 'retry').map(line => line.waitMs),
    [anthropicDelay(1), anthropicDelay(2)],
  );
  // The failed attempts' input counts are not added (not consumed).
  t.is(r.finals[0].usage.inputTokens, 12);
  noBodyOrKey(t, r);

  server.setPlan([{ sse: 'anthropic-overloaded-late.sse' }]);
  const late = await run(server);
  t.teardown(late.cleanup);
  t.is(
    late.failures[0].reason,
    textOf.anthropicApiError(' (type overloaded_error)'),
  );
  t.is(late.failures[0].partial, 'Partial text');
  t.is(late.failures[0].usage.inputTokens, 12);
  t.is(server.requests().length, 4, 'not retried after a delta');
  noBodyOrKey(t, late);
});

test('5xx three times fails after 3 attempts; an invalid_request error event is not retried', async t => {
  const server = await serverFor(t);
  server.setPlan([{ status: 503, repeat: 3 }]);
  const r = await run(server, { waitMs: 10_000 });
  t.teardown(r.cleanup);
  t.is(
    r.failures[0].reason,
    textOf.afterAttempts(textOf.anthropicHttp(503), 3),
  );
  t.is(server.requests().length, 3);
  noBodyOrKey(t, r);
  server.setPlan([
    {
      events: anthropicEvents({ error: { type: 'invalid_request_error' } }),
    },
  ]);
  const bad = await run(server);
  t.teardown(bad.cleanup);
  t.is(
    bad.failures[0].reason,
    textOf.anthropicApiError(' (type invalid_request_error)'),
  );
  t.is(server.requests().length, 4);
});

test('a stream cut before message_stop: retried while nothing was delivered, else failed with the partial text', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'anthropic-text.sse', disconnectAfter: 2 },
    { sse: 'anthropic-text.sse' },
  ]);
  const early = await run(server, { waitMs: 10_000 });
  t.teardown(early.cleanup);
  t.is(early.finals[0].text, 'Hello, world. How can I help?');
  t.is(server.requests().length, 2);
  server.setPlan([{ sse: 'anthropic-truncated.sse' }]);
  const late = await run(server);
  t.teardown(late.cleanup);
  t.is(late.failures[0].reason, texts.anthropicUnreachable);
  t.is(late.failures[0].partial, 'Cut short');
  t.is(server.requests().length, 3);
});

test('timeouts: configurable per backend, retried once, then failed with the timeout text', async t => {
  const server = await serverFor(t);
  server.setPlan([{ hang: true, repeat: 2 }]);
  const r = await run(server, { spec: { timeoutMs: 150 }, waitMs: 10_000 });
  t.teardown(r.cleanup);
  t.is(
    r.failures[0].reason,
    textOf.afterAttempts(textOf.anthropicTimeout(0), 2),
  );
  t.is(server.requests().length, 2, 'one timeout retry');
  await until(() => server.requests().every(request => request.closed));
  // A slow first byte within the timeout is fine.
  server.setPlan([{ sse: 'anthropic-text.sse', firstByteDelayMs: 100 }]);
  const slow = await run(server, { spec: { timeoutMs: 2000 } });
  t.teardown(slow.cleanup);
  t.is(slow.finals.length, 1);
});

test('cancel mid-stream closes the connection; cancel during a retry wait sends no second request', async t => {
  const server = await serverFor(t);
  server.setPlan([
    {
      events: anthropicEvents({
        deltas: Array.from({ length: 200 }, (_, i) => `d${i} `),
      }),
      delayMs: 10,
    },
  ]);
  const r = await run(server, { wait: false });
  t.teardown(r.cleanup);
  await until(
    () => server.requests().length === 1 && server.requests()[0].events > 8,
  );
  E.sendOnly(r.endpoint).cancelRound(r.turn);
  await until(() => server.requests()[0].closed);
  await timers.delay(100);
  t.deepEqual(r.finals, []);
  t.deepEqual(r.failures, []);
  t.true(r.log.some(line => line.kind === 'cancelled'));

  server.setPlan([
    { status: 503, headers: { 'retry-after': '5' } },
    { sse: 'anthropic-text.sse' },
  ]);
  const waiting = await run(server, { wait: false });
  t.teardown(waiting.cleanup);
  await until(() =>
    waiting.log.some(line => line.kind === 'retry'),
  );
  E.sendOnly(waiting.endpoint).cancelRound(waiting.turn);
  await timers.delay(200);
  t.is(server.requests().length, 2, 'no request after the cancel');
  t.deepEqual(waiting.finals, []);
  t.deepEqual(waiting.failures, []);
});

test('the key is read at every round, and a read failure sends no request (R4-82)', async t => {
  const server = await serverFor(t);
  server.setPlan([
    { sse: 'anthropic-text.sse' },
    { sse: 'anthropic-text.sse' },
  ]);
  let reads = 0;
  const readKey = async () => {
    reads += 1;
    return KEY;
  };
  const a = await run(server, { readKey });
  t.teardown(a.cleanup);
  const b = await run(server, { readKey });
  t.teardown(b.cleanup);
  t.is(reads, 2);
  const revoked = await run(server, {
    readKey: async () => {
      throw Error(textOf.secretFailed('REVOKED'));
    },
  });
  t.teardown(revoked.cleanup);
  t.is(revoked.failures[0].reason, textOf.secretFailed('REVOKED'));
  t.is(server.requests().length, 2);
});

test('messages: tool ids mapped injectively, results follow their calls, a missing result is outcome-unknown', t => {
  t.is(anthropicToolId('t1/r0/c0'), 't1_2fr0_2fc0');
  t.is(anthropicToolId('toolu_01'), 'toolu_5f01');
  t.is(anthropicToolId('plain-id9'), 'plain-id9');
  const ids = ['a/b', 'a_b', 'a_2fb', 'a b', 'aé', 'a一', 'a_u4e00'];
  t.is(new Set(ids.map(anthropicToolId)).size, ids.length, 'injective');
  for (const id of ids)
    t.regex(anthropicToolId(id), /^[a-zA-Z0-9_-]+$/, `${id} in the alphabet`);
  const messages = anthropicMessages(
    [
      { kind: 'message', role: 'user', content: 'go' },
      { kind: 'message', role: 'assistant', content: '' },
      { kind: 'tool-call', id: 't1/r0/c0', name: 'echo', args: '{"a":1}' },
      { kind: 'tool-call', id: 't1/r0/c1', name: 'echo', args: 'not json' },
      { kind: 'tool-result', id: 't1/r0/c0', content: 'one' },
      { kind: 'tool-result', id: 't9/r0/c9', content: 'stray' },
      { kind: 'message', role: 'assistant', content: 'done' },
      { kind: 'message', role: 'user', content: 'next' },
      { kind: 'tool-call', id: 't2/r0/c0', name: 'echo', args: '{}' },
      {
        kind: 'tool-result',
        id: 't2/r0/c0',
        content: 'boom',
        failed: true,
      },
    ],
    MODEL,
  );
  t.deepEqual(messages, [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1_2fr0_2fc0', name: 'echo', input: { a: 1 } },
        { type: 'tool_use', id: 't1_2fr0_2fc1', name: 'echo', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't1_2fr0_2fc0', content: 'one' },
        {
          type: 'tool_result',
          tool_use_id: 't1_2fr0_2fc1',
          content: texts.toolOutcomeUnknown,
          is_error: true,
        },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    {
      role: 'user',
      content: [{ type: 'text', text: 'next' }],
    },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't2_2fr0_2fc0', name: 'echo', input: {} },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't2_2fr0_2fc0',
          content: 'boom',
          is_error: true,
        },
      ],
    },
  ]);
});
