// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { Buffer } from 'node:buffer';
import http from 'node:http';

import { makeNodeFetch } from '../src/node-fetch.js';

/** @import { UpstreamResponse } from '../src/node-fetch.js' */
/** @import { AddressInfo } from 'node:net' */
/** @import { ExecutionContext } from 'ava' */

/**
 * @param {ExecutionContext} t
 * @param {http.RequestListener} listener
 */
const serve = async (t, listener) => {
  const server = http.createServer(listener);
  await new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  t.teardown(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = /** @type {AddressInfo} */ (server.address());
  return `http://127.0.0.1:${port}`;
};

/** @param {UpstreamResponse} response */
const readText = async response => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
    response.body
  )) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

test('makeNodeFetch GETs with the given headers and streams the body', async t => {
  /** @type {http.IncomingMessage[]} */
  const seen = [];
  const origin = await serve(t, (request, response) => {
    seen.push(request);
    response.setHeader('set-cookie', ['a=1', 'b=2']);
    response.setHeader('etag', '"x"');
    response.end('payload');
  });
  const fetch = makeNodeFetch();
  const response = await fetch(`${origin}/pkg`, {
    headers: { accept: 'application/json' },
  });
  t.is(response.status, 200);
  t.true(response.ok);
  t.is(response.headers.get('ETag'), '"x"', 'header names are case-folded');
  t.is(response.headers.get('set-cookie'), 'a=1, b=2', 'arrays are joined');
  t.is(response.headers.get('x-absent'), null);
  t.is(await readText(response), 'payload');
  t.is(seen[0].method, 'GET');
  t.is(seen[0].url, '/pkg');
  t.is(seen[0].headers.accept, 'application/json');
});

test('makeNodeFetch returns a redirect as a non-ok status without following it', async t => {
  let followed = false;
  const origin = await serve(t, (request, response) => {
    if (request.url === '/elsewhere') {
      followed = true;
      response.end('moved');
      return;
    }
    response.writeHead(302, { location: '/elsewhere' });
    response.end();
  });
  const response = await makeNodeFetch()(`${origin}/pkg`, {
    redirect: 'error',
  });
  t.is(response.status, 302);
  t.false(response.ok);
  t.is(response.headers.get('location'), '/elsewhere');
  await readText(response);
  t.false(followed);
});

test('makeNodeFetch refuses an unsupported protocol', async t => {
  await t.throwsAsync(() => makeNodeFetch()('ftp://registry.invalid/pkg'), {
    message: /Unsupported upstream protocol ftp:/,
  });
});

test('makeNodeFetch rejects with the signal reason on timeout', async t => {
  const origin = await serve(t, () => {
    // Never respond.
  });
  const error = await t.throwsAsync(() =>
    makeNodeFetch()(`${origin}/pkg`, { signal: AbortSignal.timeout(50) }),
  );
  t.is(error?.name, 'TimeoutError');
});

test('makeNodeFetch surfaces a timeout after the headers as the signal reason', async t => {
  const origin = await serve(t, (_request, response) => {
    // Send the headers and one byte of a longer body, then stall.
    response.writeHead(200, { 'content-length': '100' });
    response.write('x');
  });
  // Fire the timeout only once the headers are in hand, so a slow runner
  // cannot turn this into a request-phase timeout.
  const controller = new AbortController();
  const response = await makeNodeFetch()(`${origin}/pkg`, {
    signal: controller.signal,
  });
  t.true(response.ok);
  controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
  const error = await t.throwsAsync(async () => {
    /** @type {Uint8Array[]} */
    const chunks = [];
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (
      response.body
    )) {
      chunks.push(chunk);
    }
  });
  t.is(error?.name, 'TimeoutError');
});

test('makeNodeFetch rejects with the transport error otherwise', async t => {
  const origin = await serve(t, request => {
    request.socket.destroy();
  });
  const error = await t.throwsAsync(() => makeNodeFetch()(`${origin}/pkg`));
  t.not(error?.name, 'TimeoutError');
});
