// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { request as httpRequest } from 'node:http';

import { makeProviderHttpListener } from '../src/provider-http.js';

/** @import { IncomingMessage } from 'node:http' */

const body = JSON.stringify({ model: 'test', stream: true });
const headers = harden({ 'content-type': 'application/json' });
const options = harden({
  maxConnections: 2,
  maxRequestBytes: 1024n,
  maxResponseBytes: 1024n,
  timeoutMs: 1000,
});

test.serial(
  'HTTP listener forwards incremental chunks and strips caller headers',
  async t => {
    t.timeout(5000);
    /** @type {() => void} */
    let finish = () => {
      throw Error('uninitialized');
    };
    /** @type {Promise<void>} */
    const finished = new Promise(resolve => {
      finish = resolve;
    });
    let calls = 0;
    let returned = false;
    const reader = Far('reader', {
      async next() {
        calls += 1;
        if (calls === 1)
          return harden({ done: false, value: 'data: first\n\n' });
        await finished;
        return harden({ done: true });
      },
      return() {
        returned = true;
        finish();
      },
    });
    const listener = await makeProviderHttpListener({
      ...options,
      endpoint: Far('endpoint', {
        requestStream(request) {
          t.deepEqual(request, { method: 'POST', path: '/v1/responses', body });
          return harden({
            status: 200,
            contentType: 'text/event-stream',
            reader,
          });
        },
      }),
    });
    t.teardown(() => listener.dispose());
    const response = await fetch(`${listener.url}/v1/responses`, {
      method: 'POST',
      headers: { ...headers, 'x-secret': 'not-forwarded' },
      body,
    });
    t.is(response.status, 200);
    t.is(response.headers.get('content-type'), 'text/event-stream');
    if (!response.body) throw Error('missing response body');
    const stream = response.body.getReader();
    const first = await stream.read();
    t.is(new TextDecoder().decode(first.value), 'data: first\n\n');
    finish();
    t.true((await stream.read()).done);
    t.true(returned);
  },
);

test.serial(
  'HTTP rejects alternate routes, authority, browser origin, credentials and oversized bodies',
  async t => {
    t.timeout(5000);
    let calls = 0;
    const listener = await makeProviderHttpListener({
      ...options,
      endpoint: Far('endpoint', {
        requestStream() {
          calls += 1;
          throw Error('must not run');
        },
      }),
    });
    t.teardown(() => listener.dispose());
    for (const change of [
      { path: '/v1/responses?admin=true' },
      { headers: { ...headers, origin: 'https://evil.example' } },
      { headers: { ...headers, authorization: 'Bearer should-not-be-here' } },
      { headers: { ...headers, 'content-encoding': 'gzip' } },
      { body: 'x'.repeat(1025) },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const response = await fetch(
        `${listener.url}${change.path || '/v1/responses'}`,
        {
          method: 'POST',
          headers: change.headers || headers,
          body: change.body || body,
        },
      );
      t.is(response.status, 502);
      // eslint-disable-next-line no-await-in-loop
      t.is(await response.text(), 'Inference request failed');
    }
    const rejectedHost = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${listener.url}/v1/responses`,
        {
          method: 'POST',
          headers: { ...headers, host: 'evil.example' },
        },
        response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        },
      );
      request.once('error', reject);
      request.end(body);
    });
    t.is(rejectedHost, 502);
    t.is(calls, 0);
  },
);

test.serial(
  'HTTP disposal cancels an active stream and is idempotent',
  async t => {
    t.timeout(5000);
    let resolveRead;
    const read = new Promise(resolve => {
      resolveRead = resolve;
    });
    let cancelled;
    const cancellation = new Promise(resolve => {
      cancelled = resolve;
    });
    const listener = await makeProviderHttpListener({
      ...options,
      endpoint: Far('endpoint', {
        requestStream: () =>
          harden({
            status: 200,
            contentType: 'text/event-stream',
            reader: Far('reader', {
              next: () => read,
              return: () => {
                resolveRead(harden({ done: true }));
                cancelled();
              },
            }),
          }),
      }),
    });
    t.teardown(() => listener.dispose());
    // Node fetch treats an interrupted response with zero data chunks as an
    // empty body on this runtime. Check wire completeness using the raw client.
    /** @type {IncomingMessage} */
    const response = await new Promise((resolve, reject) => {
      const request = httpRequest(
        `${listener.url}/v1/responses`,
        {
          method: 'POST',
          headers,
        },
        resolve,
      );
      request.once('error', reject);
      request.end(body);
    });
    t.is(response.statusCode, 200);
    const interrupted = new Promise(resolve => {
      response.once('aborted', () => resolve('aborted'));
      response.once('end', () => resolve('end'));
      response.on('error', () => {});
      response.resume();
    });
    await listener.dispose();
    await listener.dispose();
    await cancellation;
    t.is(await interrupted, 'aborted');
    t.false(response.complete);
  },
);

test.serial(
  'HTTP deadline releases late readers and does not leak provider errors',
  async t => {
    t.timeout(5000);
    /** @type {((value: any) => void) | undefined} */
    let release;
    const result = new Promise(resolve => {
      release = resolve;
    });
    let entered;
    const entering = new Promise(resolve => {
      entered = resolve;
    });
    const listener = await makeProviderHttpListener({
      ...options,
      timeoutMs: 100,
      endpoint: Far('endpoint', {
        requestStream() {
          entered();
          return result;
        },
      }),
    });
    t.teardown(() => listener.dispose());
    const response = fetch(`${listener.url}/v1/responses`, {
      method: 'POST',
      headers,
      body,
    });
    const rejected = t.throwsAsync(response);
    await entering;
    await rejected;
    let cancelled;
    const cancellation = new Promise(resolve => {
      cancelled = resolve;
    });
    if (!release) throw Error('missing resolver');
    release(
      harden({
        status: 200,
        contentType: 'text/event-stream',
        reader: Far('late reader', {
          next() {
            throw Error('must not read');
          },
          return() {
            cancelled();
          },
        }),
      }),
    );
    await cancellation;
    t.pass();
  },
);

test.serial('HTTP masks upstream exceptions', async t => {
  const listener = await makeProviderHttpListener({
    ...options,
    endpoint: Far('endpoint', {
      requestStream() {
        throw Error('canary-secret');
      },
    }),
  });
  t.teardown(() => listener.dispose());
  const response = await fetch(`${listener.url}/v1/responses`, {
    method: 'POST',
    headers,
    body,
  });
  t.is(response.status, 502);
  t.is(await response.text(), 'Inference request failed');
});
