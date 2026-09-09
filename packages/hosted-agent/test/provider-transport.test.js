// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { isCredentialRejection } from '../src/provider-broker.js';
import { makeProviderFetchTransport } from '../src/provider-transport.js';

/** @import { ProviderTransportDiagnostic } from '../src/provider-transport.js' */

const request = harden({
  url: 'https://api.example.test/v1/responses',
  method: 'POST',
  headers: { authorization: 'Bearer canary-secret' },
  body: '{}',
  redirect: /** @type {const} */ ('error'),
  maxResponseBytes: 10n,
});

/**
 * @param {any} fetch
 * @param {(diagnostic: ProviderTransportDiagnostic) => void | Promise<void>} [onDiagnostic]
 */
const setup = (fetch, onDiagnostic = undefined) => {
  const timers = new Set();
  const transport = makeProviderFetchTransport({
    fetch,
    onDiagnostic,
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

test('ChatGPT headers are allowed only on the fixed subscription inference route', async t => {
  let dispatched = 0;
  const subject = setup(async () => {
    dispatched += 1;
    return new Response('ok');
  });
  const subscription = {
    ...request,
    url: 'https://chatgpt.com/backend-api/codex/responses',
    headers: {
      ...request.headers,
      'chatgpt-account-id': 'account-1',
      originator: 'codex_cli_rs',
    },
  };
  t.deepEqual(await E(subject.transport).request(subscription), {
    status: 200,
    body: 'ok',
  });
  await t.throwsAsync(() =>
    E(subject.transport).request({ ...subscription, url: request.url }),
  );
  await t.throwsAsync(() =>
    E(subject.transport).request({
      ...subscription,
      headers: { ...subscription.headers, originator: 'other' },
    }),
  );
  await t.throwsAsync(() =>
    E(subject.transport).request({
      ...subscription,
      headers: {
        ...subscription.headers,
        'chatgpt-account-id': 'bad\r\nheader',
      },
    }),
  );
  t.is(dispatched, 1);
  subject.dispose();
});

test('host diagnostics contain only fixed stages and bounded HTTP status', async t => {
  const diagnostics = [];
  const capture = diagnostic => {
    t.true(Object.isFrozen(diagnostic));
    diagnostics.push(diagnostic);
  };
  const denied = setup(
    async () =>
      new Response('body-canary-secret', {
        status: 429,
        headers: { 'www-authenticate': 'header-canary-secret' },
      }),
    capture,
  );
  t.teardown(denied.dispose);
  await t.throwsAsync(() => E(denied.transport).request(request), {
    message: 'Provider transport failed',
  });
  const broken = setup(async () => {
    throw Error('exception-canary-secret');
  }, capture);
  t.teardown(broken.dispose);
  await t.throwsAsync(() => E(broken.transport).request(request), {
    message: 'Provider transport failed',
  });
  const invalid = setup(async () => {
    t.fail('invalid requests must not dispatch');
  }, capture);
  t.teardown(invalid.dispose);
  await t.throwsAsync(() =>
    E(invalid.transport).request({
      ...request,
      body: 'body-canary'.repeat(20),
    }),
  );
  t.deepEqual(diagnostics, [
    { stage: 'response', status: 429 },
    { stage: 'fetch' },
    { stage: 'request' },
  ]);
  t.false(JSON.stringify(diagnostics).includes('canary'));
});

test('diagnostic observer failures cannot change provider outcomes', async t => {
  for (const observer of [
    () => {
      throw Error('observer-canary-secret');
    },
    async () => {
      throw Error('observer-canary-secret');
    },
  ]) {
    const denied = setup(
      async () => new Response('secret', { status: 401 }),
      observer,
    );
    t.teardown(denied.dispose);
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => E(denied.transport).request(request), {
      message: 'Provider credential rejected',
    });
  }
});

test('body failures and idle deadlines emit one sanitized diagnostic', async t => {
  t.timeout(1000);
  const diagnostics = [];
  const { response } = streamResponse([new Uint8Array([0xff])]);
  const invalid = setup(
    async () => response,
    value => {
      diagnostics.push(value);
    },
  );
  t.teardown(invalid.dispose);
  await t.throwsAsync(() => E(invalid.transport).request(request), {
    message: 'Provider transport failed',
  });
  const idle = setup(
    async () => new Response(new ReadableStream()),
    value => {
      diagnostics.push(value);
    },
  );
  t.teardown(idle.dispose);
  const streaming = await E(idle.transport).requestStream(request);
  idle.timeout();
  await t.throwsAsync(() => E(streaming.reader).next(), { message: /stopped/ });
  t.deepEqual(diagnostics, [
    { stage: 'body', status: 200 },
    { stage: 'timeout', status: 200 },
  ]);
});

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
  // A rejected credential is classified, because a refreshing broker has one
  // decision to make and the status class is enough to make it. That is the
  // only thing that crosses: the body and the `www-authenticate` challenge
  // stay on this side, as this assertion's exact message proves.
  const denied = setup(
    async () =>
      new Response('canary-secret', {
        status: 401,
        headers: { 'www-authenticate': 'canary-secret' },
      }),
  );
  const rejection = await t.throwsAsync(
    () => E(denied.transport).request(request),
    { message: 'Provider credential rejected' },
  );
  t.true(isCredentialRejection(rejection));
  // A 403 is the upstream refusing this request, not the credential, and a
  // refresh cannot fix it; it stays an ordinary failure.
  const forbidden = setup(
    async () => new Response('canary-secret', { status: 403 }),
  );
  await t.throwsAsync(() => E(forbidden.transport).request(request), {
    message: 'Provider transport failed',
  });
  const refused = setup(
    async () => new Response('canary-secret', { status: 500 }),
  );
  await t.throwsAsync(() => E(refused.transport).request(request), {
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
