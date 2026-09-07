// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { makeProviderFetchTransport } from '../src/provider-transport.js';

const request = harden({
  url: 'https://api.example.test/v1/responses',
  method: 'POST',
  headers: { authorization: 'Bearer canary-secret' },
  body: '{}',
  redirect: /** @type {const} */ ('error'),
  maxResponseBytes: 10n,
});

/** @param {any} fetch */
const setup = fetch => {
  const timers = new Set();
  const transport = makeProviderFetchTransport({
    fetch,
    timeoutMs: 100,
    maxRequestBytes: 100n,
    maxResponseBytes: 10n,
    setTimer: callback => {
      timers.add(callback);
      return callback;
    },
    clearTimer: timer => {
      timers.delete(timer);
    },
  });
  return {
    ...transport,
    timers,
    timeout: () => {
      for (const timer of timers) timer();
    },
  };
};

/**
 * @param {Uint8Array[]} chunks
 * @param {Record<string, string>} [headers]
 */
const streamResponse = (chunks, headers = {}) => {
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body, { status: 200, headers }),
    cancelled: () => cancelled,
  };
};

test('transport omits ambient credentials, disables redirects and reads bounded UTF8', async t => {
  const calls = [];
  const { response } = streamResponse([
    new Uint8Array([0xe2]),
    new Uint8Array([0x82, 0xac]),
  ]);
  const { transport, timers } = setup(async (...args) => {
    calls.push(args);
    return response;
  });
  t.deepEqual(await E(transport).request(request), { status: 200, body: '€' });
  t.like(calls[0][1], {
    credentials: 'omit',
    redirect: /** @type {const} */ ('error'),
    cache: 'no-store',
    referrerPolicy: 'no-referrer',
  });
  t.is(timers.size, 0);
  t.false(response.body?.locked);
});

test('oversized declared body is cancelled before reading', async t => {
  const { response, cancelled } = streamResponse([new Uint8Array(1)], {
    'content-length': '11',
  });
  const { transport } = setup(async () => response);
  await t.throwsAsync(() => E(transport).request(request), {
    message: 'Provider transport failed',
  });
  t.true(cancelled());
  t.false(response.body?.locked);
});

test('streamed overflow cancels a response without content length', async t => {
  const { response, cancelled } = streamResponse([
    new Uint8Array(6),
    new Uint8Array(6),
    new Uint8Array(6),
  ]);
  const { transport } = setup(async () => response);
  await t.throwsAsync(() => E(transport).request(request), {
    message: 'Provider transport failed',
  });
  t.true(cancelled());
  t.false(response.body?.locked);
});

test('invalid UTF8 and HTTP errors never expose raw payload or headers', async t => {
  const { response } = streamResponse([new Uint8Array([0xff])]);
  const lease = setup(async () => response);
  await t.throwsAsync(() => E(lease.transport).request(request), {
    message: 'Provider transport failed',
  });
  const denied = setup(
    async () =>
      new Response('canary-secret', {
        status: 401,
        headers: { 'www-authenticate': 'canary-secret' },
      }),
  );
  await t.throwsAsync(() => E(denied.transport).request(request), {
    message: 'Provider transport failed',
  });
  const broken = setup(async () => {
    throw Error('canary-secret');
  });
  await t.throwsAsync(() => E(broken.transport).request(request), {
    message: 'Provider transport failed',
  });
});

test('timeout settles even when fetch ignores abort and cancels a late response', async t => {
  t.timeout(5000);
  let deliver = _value => {};
  let began = () => {};
  const started = new Promise(resolve => {
    began = () => resolve(undefined);
  });
  const held = new Promise(resolve => {
    deliver = resolve;
  });
  const { transport, timeout, timers, dispose } = setup(async () => {
    began();
    return held;
  });
  t.teardown(dispose);
  const pending = E(transport).request(request);
  await started;
  timeout();
  await t.throwsAsync(pending, { message: 'Provider transport failed' });
  const { response, cancelled } = streamResponse([new Uint8Array(1)]);
  deliver(response);
  await held;
  await Promise.resolve();
  t.true(cancelled());
  t.is(timers.size, 0);
});

test('dispose aborts a pending body read and refuses subsequent dispatch', async t => {
  t.timeout(5000);
  /** @type {AbortSignal | undefined} */
  let signal;
  let began = () => {};
  const started = new Promise(resolve => {
    began = () => resolve(undefined);
  });
  let cancelled = false;
  const body = new ReadableStream({
    pull() {},
    cancel() {
      cancelled = true;
    },
  });
  const lease = setup(async (_url, options) => {
    signal = options.signal;
    began();
    return new Response(body);
  });
  t.teardown(lease.dispose);
  const pending = E(lease.transport).request(request);
  await started;
  lease.dispose();
  await t.throwsAsync(pending, { message: 'Provider transport failed' });
  t.true(signal?.aborted);
  t.true(cancelled);
  await t.throwsAsync(() => E(lease.transport).request(request), {
    message: /disposed/,
  });
  t.is(lease.timers.size, 0);
});

test('request bounds, header smuggling and redirects are rejected', async t => {
  const lease = setup(async () => {
    t.fail('must not fetch');
    return new Response('');
  });
  for (const bad of [
    { ...request, url: 'http://api.example.test' },
    { ...request, body: 'x'.repeat(101) },
    { ...request, headers: { authorization: 'token\r\nInjected: yes' } },
    { ...request, headers: { cookie: 'ambient' } },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(lease.transport).request(harden(bad)), {
      message: 'Provider transport failed',
    });
  }
  const redirected = setup(async () => new Response('', { status: 302 }));
  await t.throwsAsync(() => E(redirected.transport).request(request), {
    message: 'Provider transport failed',
  });
});

test('incremental reader delivers before EOF and retains deadline while idle', async t => {
  t.timeout(1000);
  let closed = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hello'));
    },
    cancel() {
      closed = true;
    },
  });
  const lease = setup(async () => new Response(body));
  t.teardown(lease.dispose);
  const response = await E(lease.transport).requestStream(request);
  t.deepEqual(await E(response.reader).next(), { done: false, value: 'hello' });
  t.is(lease.timers.size, 1);
  lease.timeout();
  await t.throwsAsync(() => E(response.reader).next(), { message: /stopped/ });
  t.true(closed);
  t.is(lease.timers.size, 0);
});

test('incremental cancellation settles an outstanding pull', async t => {
  t.timeout(1000);
  const lease = setup(async () => new Response(new ReadableStream()));
  t.teardown(lease.dispose);
  const response = await E(lease.transport).requestStream(request);
  const pull = E(response.reader).next();
  await E(response.reader).return();
  await t.throwsAsync(pull, { message: /failed/ });
  t.is(lease.timers.size, 0);
});
