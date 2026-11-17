// @ts-check
// M2 W2.1a: the fake provider server (test/fixtures/fake-provider-server.mjs;
// designs/m2-interfaces.md 8.3). 127.0.0.1 only, plans, fixtures, statuses,
// slow first byte, disconnects, hangs, and what it records of a request.
import test from '@endo/ses-ava/test.js';

import {
  BODY_MARKER,
  openRouterChunks,
  sseText,
  splitSseFixture,
  startFakeProviderServer,
} from '../fixtures/fake-provider-server.mjs';

const KEY = 'not a real key';

/**
 * @param {string} url
 * @param {{ body?: object, signal?: AbortSignal }} [options]
 */
const post = (url, { body = { model: 'fake-org/fake-model' }, signal } = {}) =>
  fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

test('binds 127.0.0.1 and replays a fixture with its delays; records the request without the key', async t => {
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  t.regex(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  server.setPlan([{ sse: 'openrouter-text.sse' }]);
  const t0 = performance.now();
  const response = await post(`${server.openRouterBaseUrl}/chat/completions`);
  t.is(response.status, 200);
  t.regex(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const text = await response.text();
  t.true(performance.now() - t0 >= 30, 'the fixture waits 5 ms per event');
  t.true(text.includes('data: [DONE]'));
  t.false(text.includes('fake-delay'), 'directives are not sent');
  t.true(text.includes(': OPENROUTER PROCESSING'), 'other comments are');
  const [request] = server.requests();
  t.is(request.method, 'POST');
  t.is(request.path, '/api/v1/chat/completions');
  t.true(request.authorization);
  t.false(JSON.stringify(request).includes(KEY));
  t.deepEqual(request.json, { model: 'fake-org/fake-model' });
  t.true(request.completed);
  t.false(request.closed);
  t.is(server.pending(), 0);
});

test('statuses carry headers and a marked body; unplanned requests are recorded', async t => {
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  server.setPlan([
    { status: 429, headers: { 'retry-after': '2' } },
    { status: 401 },
    {
      status: 529,
      body: { type: 'error', error: { type: 'overloaded_error' } },
    },
  ]);
  const url = `${server.openRouterBaseUrl}/chat/completions`;
  const a = await post(url);
  t.is(a.status, 429);
  t.is(a.headers.get('retry-after'), '2');
  t.true((await a.text()).includes(BODY_MARKER));
  t.is((await post(url)).status, 401);
  const c = await post(`${server.anthropicBaseUrl}/v1/messages`);
  t.is(c.status, 529);
  t.regex(await c.text(), /overloaded_error/);
  const d = await post(url);
  t.is(d.status, 500);
  await d.text();
  t.true(server.requests()[3].unplanned);
});

test('match routes GET catalogue requests; repeat answers several', async t => {
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  server.setPlan([
    {
      match: { method: 'GET', path: '/api/v1/models' },
      body: { data: [] },
      repeat: 2,
    },
  ]);
  for (let i = 0; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(`${server.openRouterBaseUrl}/models`);
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await response.json(), { data: [] });
  }
  t.is(server.pending(), 0);
});

test('slow first byte, mid-stream disconnect, and a hang the client closes', async t => {
  const server = await startFakeProviderServer();
  t.teardown(server.close);
  const url = `${server.openRouterBaseUrl}/chat/completions`;
  server.setPlan([
    { events: openRouterChunks({ deltas: ['a'] }), firstByteDelayMs: 80 },
    {
      events: openRouterChunks({ deltas: ['a', 'b', 'c'] }),
      disconnectAfter: 3,
    },
    { hang: true },
  ]);
  const t0 = performance.now();
  const slow = await post(url);
  t.true(performance.now() - t0 >= 70);
  await slow.text();
  const cut = await post(url);
  await t.throwsAsync(() => cut.text());
  t.is(server.requests()[1].events, 3);
  t.false(server.requests()[1].completed);
  const controller = new AbortController();
  const hung = post(url, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort();
  await t.throwsAsync(() => hung);
  const t1 = performance.now();
  while (!server.requests()[2].closed && performance.now() - t1 < 2000) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  t.true(server.requests()[2].closed, 'the server saw the client close');
});

test('openRouterChunks and sseText build the streamed chat-completion shape', t => {
  const events = splitSseFixture(
    sseText(
      openRouterChunks({
        deltas: ['x'],
        toolCalls: [
          { id: 'c1', name: 'echo', args: '{"text":"y"}', pieces: 3 },
        ],
      }),
    ),
  );
  const data = events
    .map(e => /^data: (.*)$/m.exec(e.text)?.[1])
    .filter(d => d !== undefined && d !== '[DONE]')
    .map(d => JSON.parse(/** @type {string} */ (d)));
  const args = data
    .flatMap(d => d.choices?.[0]?.delta?.tool_calls ?? [])
    .map(c => c.function.arguments)
    .join('');
  t.is(args, '{"text":"y"}');
  t.is(data.at(-2).choices[0].finish_reason, 'tool_calls');
  t.truthy(data.at(-1).usage);
  t.true(events.at(-1)?.text.startsWith('data: [DONE]'));
});
