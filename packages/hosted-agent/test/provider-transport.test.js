// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import {
  isCredentialRejection,
  isSubscriptionExhaustion,
} from '../src/provider-broker.js';
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

test('any well-shaped header reaches the network; the route is not this layer\u2019s to bind', async t => {
  // The subscription headers were once admitted only for the fixed ChatGPT
  // route. The general name rule matches both of their names, so that binding
  // is gone: which route a session may reach is the broker's decision (it
  // pins the origin and the inference path per grant), and this layer's job
  // is that no header can terminate itself or begin another.
  let dispatched = 0;
  /** @type {any} */
  let sent;
  const subject = setup(async (_url, options) => {
    dispatched += 1;
    sent = options.headers;
    return new Response('ok');
  });
  t.teardown(subject.dispose);
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
  t.is(sent['chatgpt-account-id'], 'account-1');

  // The same headers on another https route are no longer refused here.
  t.deepEqual(
    await E(subject.transport).request({ ...subscription, url: request.url }),
    {
      status: 200,
      body: 'ok',
    },
  );

  // What is still refused is a value that could forge a second header.
  await t.throwsAsync(() =>
    E(subject.transport).request({
      ...subscription,
      headers: {
        ...subscription.headers,
        'chatgpt-account-id': 'bad\r\nheader',
      },
    }),
  );
  // ...and a name that could carry a separator.
  await t.throwsAsync(() =>
    E(subject.transport).request({
      ...subscription,
      headers: { ...subscription.headers, 'bad name': 'x' },
    }),
  );
  t.is(dispatched, 2, 'only the two well-shaped requests reached fetch');
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
  // A refused body's bounded prefix is the ONE response content a host
  // observer sees, and only for a response that was refused. It is what turns
  // "502, usually temporary" into a cause an operator can act on: a status
  // alone cannot distinguish an unentitled model from an undeclared beta
  // capability. `detail` names which request-stage check refused, and is a
  // fixed string, never request data.
  t.deepEqual(diagnostics, [
    { stage: 'response', status: 429, refusal: 'body-canary-secret' },
    { stage: 'fetch' },
    { stage: 'request', detail: 'request shape' },
  ]);
  // Everything else still stays out: the upstream's response HEADERS, and the
  // text of an exception thrown by fetch.
  const rendered = JSON.stringify(diagnostics);
  t.false(rendered.includes('header-canary-secret'));
  t.false(rendered.includes('exception-canary-secret'));
  // The oversized request's own body never becomes a diagnostic.
  t.false(rendered.includes('body-canary-body-canary'));
});

test('a refusal is bounded, and never echoes the credential it carried', async t => {
  const diagnostics = [];
  const echoed = setup(
    async () =>
      new Response(`denied: Bearer canary-secret ${'x'.repeat(4096)}`, {
        status: 400,
      }),
    diagnostic => {
      diagnostics.push(diagnostic);
    },
  );
  t.teardown(echoed.dispose);
  await t.throwsAsync(() => E(echoed.transport).request(request), {
    message: 'Provider transport failed',
  });
  t.is(diagnostics.length, 1);
  const [{ refusal }] = diagnostics;
  t.false(
    `${refusal}`.includes('canary-secret'),
    'a body echoing the credential is withheld entirely',
  );
  const bounded = setup(
    async () => new Response('d'.repeat(4096), { status: 400 }),
    diagnostic => {
      diagnostics.push(diagnostic);
    },
  );
  t.teardown(bounded.dispose);
  await t.throwsAsync(() => E(bounded.transport).request(request));
  t.true(`${diagnostics[1].refusal}`.length <= 1024);
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
    message: 'Provider response lost',
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
    message: 'Provider response lost',
  });
  t.true(cancelled());
  t.false(response.body?.locked);
});

test('invalid UTF8 and HTTP errors never expose raw payload or headers', async t => {
  const { response } = streamResponse([new Uint8Array([0xff])]);
  const lease = setup(async () => response);
  await t.throwsAsync(() => E(lease.transport).request(request), {
    message: 'Provider response lost',
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
  await t.throwsAsync(pending, { message: 'Provider response lost' });
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

test('owner close waits for late response body cancellation and retains uncertainty', async t => {
  let returnFetch;
  let releaseCancel;
  let entered;
  const began = new Promise(resolve => {
    entered = resolve;
  });
  const fetching = new Promise(resolve => {
    returnFetch = resolve;
  });
  const cancelling = new Promise(resolve => {
    releaseCancel = resolve;
  });
  const lease = setup(async () => {
    entered();
    return fetching;
  });
  const response = E(lease.transport).request(request);
  const failedRequest = t.throwsAsync(response);
  await began;
  let closed = false;
  const closing = lease.close().then(() => {
    closed = true;
  });
  returnFetch(new Response(new ReadableStream({ cancel: () => cancelling })));
  await failedRequest;
  await null;
  t.false(closed);
  releaseCancel();
  await closing;
  t.true(closed);
  const uncertain = setup(
    async () =>
      new Response(
        new ReadableStream({
          cancel: async () => {
            throw Error('lost cancel ack');
          },
        }),
      ),
  );
  await E(uncertain.transport).requestStream(request);
  await t.throwsAsync(uncertain.close(), { message: /cleanup uncertain/ });
  await t.throwsAsync(uncertain.close(), { message: /cleanup uncertain/ });
});

for (let delay = 0; delay <= 8; delay += 1) {
  test(`close drains the fetch-to-reader handoff at microtask ${delay}`, async t => {
    let cancellations = 0;
    let release;
    const paused = new Promise(resolve => {
      release = resolve;
    });
    const response = new Response(
      new ReadableStream({
        cancel: () => {
          cancellations += 1;
          return paused;
        },
      }),
    );
    let closing;
    let acknowledged = false;
    const lease = setup(() => {
      closing = (async () => {
        for (let index = 0; index < delay; index += 1) {
          // eslint-disable-next-line no-await-in-loop
          await null;
        }
        await lease.close();
        acknowledged = true;
      })();
      return Promise.resolve(response);
    });
    const pending = E(lease.transport).requestStream(request);
    const settled = pending.then(
      () => 'stream',
      () => 'refused',
    );
    // Advance beyond the tested handoff without wall-clock assumptions.
    for (let index = 0; index < 30; index += 1) {
      // eslint-disable-next-line no-await-in-loop
      await null;
    }
    t.is(cancellations, 1);
    t.false(acknowledged, 'body cleanup must finish before acknowledgement');
    release();
    await closing;
    await settled;
    t.false(response.body.locked);
    t.true(acknowledged);
  });
}

test('request bounds, header smuggling and redirects are rejected', async t => {
  const lease = setup(async () => {
    t.fail('must not fetch');
    return new Response('');
  });
  for (const bad of [
    { ...request, url: 'http://api.example.test' },
    { ...request, body: 'x'.repeat(101) },
    { ...request, headers: { authorization: 'token\r\nInjected: yes' } },
    { ...request, headers: { 'in valid': 'x' } },
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

const tapped = (fetch, onReading) =>
  makeProviderFetchTransport({
    fetch,
    onReading,
    timeoutMs: 1000,
    maxRequestBytes: 100n,
    maxResponseBytes: 100n,
  });

test('a served response’s rate-limit headers are read, and no header crosses', async t => {
  const readings = [];
  const { transport } = tapped(
    async () =>
      new Response('ok', {
        status: 200,
        headers: {
          'x-codex-primary-used-percent': '12',
          'x-codex-primary-window-minutes': '300',
          'x-codex-secondary-used-percent': '64',
          'set-cookie': 'canary-secret',
        },
      }),
    reading => readings.push(reading),
  );
  const response = await E(transport).request(request);
  t.deepEqual(Object.keys(response).sort(), ['body', 'status']);
  t.is(readings.length, 1);
  t.is(readings[0].status, 200);
  t.false(readings[0].exhausted);
  t.deepEqual(
    readings[0].rateLimits.windows.map(window => window.usedPercent),
    [12, 64],
  );
  t.false(JSON.stringify(readings).includes('canary-secret'));
  t.true(Object.isFrozen(readings[0]));
});

test('a drained subscription is classified, after its reading is delivered', async t => {
  const order = [];
  const { transport } = tapped(
    async () =>
      new Response('{"error":{"type":"usage_limit_reached"}}', {
        status: 429,
        headers: {
          'x-codex-primary-used-percent': '100',
          'x-codex-primary-reset-at': '1790000000',
          'x-codex-rate-limit-reached-type': 'rate_limit_reached',
        },
      }),
    reading => order.push(['reading', reading.exhausted, reading.status]),
  );
  const refusal = await t.throwsAsync(
    () =>
      E(transport)
        .request(request)
        .finally(() => order.push(['settled'])),
    { message: 'Provider subscription exhausted' },
  );
  t.true(isSubscriptionExhaustion(refusal));
  t.false(isCredentialRejection(refusal));
  // The observer heard before the caller did, so whoever handles the refusal
  // already knows until when the subscription is blocked.
  t.deepEqual(order, [['reading', true, 429], ['settled']]);

  // Throttling — a 429 with room left — stays an ordinary failure, and is
  // still read.
  const throttledReadings = [];
  const throttled = tapped(
    async () =>
      new Response('slow down', {
        status: 429,
        headers: { 'x-codex-primary-used-percent': '40' },
      }),
    reading => throttledReadings.push(reading),
  );
  const failure = await t.throwsAsync(() =>
    E(throttled.transport).request(request),
  );
  t.false(isSubscriptionExhaustion(failure));
  t.is(throttledReadings[0].exhausted, false);
});

test('an observer that throws, or headers that say nothing, change nothing', async t => {
  const throwing = tapped(
    async () =>
      new Response('ok', {
        status: 200,
        headers: { 'x-codex-primary-used-percent': '12' },
      }),
    () => {
      throw Error('observer bug');
    },
  );
  t.is((await E(throwing.transport).request(request)).body, 'ok');
  const silent = [];
  const plain = tapped(
    async () => new Response('ok', { status: 200 }),
    reading => silent.push(reading),
  );
  t.is((await E(plain.transport).request(request)).body, 'ok');
  t.deepEqual(silent, []);
});
