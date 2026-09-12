// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { request as httpRequest } from 'node:http';

import { makeProviderHttpListener } from '../src/provider-http.js';
import { readHttpText, requestHttp } from './http-client.js';

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
  'HTTP admission diagnostics expose fixed checks but never request data',
  async t => {
    t.timeout(5000);
    const diagnostics = [];
    const listener = await makeProviderHttpListener({
      ...options,
      endpoint: Far('must not dispatch', {
        requestStream() {
          t.fail('must not dispatch');
        },
      }),
      onDiagnostic: diagnostic => {
        diagnostics.push(diagnostic);
        throw Error('observer-canary-secret');
      },
    });
    t.teardown(() => listener.dispose());
    const response = await requestHttp(`${listener.url}/v1/responses`, {
      method: 'POST',
      headers: { ...headers, 'content-encoding': 'encoding-canary-secret' },
      body: 'body-canary-secret',
    });
    t.is(response.statusCode, 502);
    t.is(await readHttpText(response), 'Inference request failed');
    t.deepEqual(diagnostics, [
      {
        stage: 'headers',
        checks: {
          method: true,
          path: true,
          host: true,
          origin: true,
          cookie: true,
          authorization: true,
          encoding: false,
          contentType: true,
        },
      },
    ]);
    t.false(JSON.stringify(diagnostics).includes('canary'));
  },
);

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
    const response = await requestHttp(`${listener.url}/v1/responses`, {
      method: 'POST',
      headers: { ...headers, 'x-secret': 'not-forwarded' },
      body,
    });
    t.is(response.statusCode, 200);
    t.is(response.headers['content-type'], 'text/event-stream');
    const stream = response[Symbol.asyncIterator]();
    const first = await stream.next();
    t.is(new TextDecoder().decode(first.value), 'data: first\n\n');
    finish();
    t.true((await stream.next()).done);
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
      const response = await requestHttp(
        `${listener.url}${change.path || '/v1/responses'}`,
        {
          method: 'POST',
          headers: change.headers || headers,
          body: change.body || body,
        },
      );
      t.is(response.statusCode, 502);
      // eslint-disable-next-line no-await-in-loop
      t.is(await readHttpText(response), 'Inference request failed');
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
  'HTTP listener refuses invalid path allowlists and authorization modes',
  async t => {
    const endpoint = Far('endpoint', {
      requestStream() {
        t.fail('must not dispatch');
      },
    });
    await t.throwsAsync(
      () =>
        makeProviderHttpListener({ ...options, endpoint, allowedPaths: [] }),
      { message: /Invalid inference paths/ },
    );
    await t.throwsAsync(
      () =>
        makeProviderHttpListener({
          ...options,
          endpoint,
          allowedPaths: ['/v1/responses?admin=true'],
        }),
      { message: /Invalid inference path/ },
    );
    await t.throwsAsync(
      () =>
        makeProviderHttpListener({
          ...options,
          endpoint,
          clientAuthorization: /** @type {any} */ ('forward'),
        }),
      { message: /Invalid client authorization mode/ },
    );
  },
);

test.serial(
  'strip mode admits a placeholder client credential on the configured path only',
  async t => {
    t.timeout(5000);
    const paths = [];
    const listener = await makeProviderHttpListener({
      ...options,
      clientAuthorization: 'strip',
      allowedPaths: ['/api/v1/chat/completions'],
      endpoint: Far('endpoint', {
        requestStream(request) {
          paths.push(request.path);
          return harden({
            status: 200,
            contentType: 'application/json',
            reader: Far('reader', {
              async next() {
                return harden({ done: true });
              },
            }),
          });
        },
      }),
    });
    t.teardown(() => listener.dispose());
    const admitted = await requestHttp(
      `${listener.url}/api/v1/chat/completions`,
      {
        method: 'POST',
        headers: { ...headers, authorization: 'Bearer placeholder-key' },
        body,
      },
    );
    t.is(admitted.statusCode, 200);
    await readHttpText(admitted);
    t.deepEqual(paths, ['/api/v1/chat/completions']);
    // The strip mode does not widen the path allowlist.
    const rejected = await requestHttp(`${listener.url}/v1/responses`, {
      method: 'POST',
      headers,
      body,
    });
    t.is(rejected.statusCode, 502);
    await readHttpText(rejected);
    t.deepEqual(paths, ['/api/v1/chat/completions']);
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
    const response = requestHttp(`${listener.url}/v1/responses`, {
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
  const response = await requestHttp(`${listener.url}/v1/responses`, {
    method: 'POST',
    headers,
    body,
  });
  t.is(response.statusCode, 502);
  t.is(await readHttpText(response), 'Inference request failed');
});
