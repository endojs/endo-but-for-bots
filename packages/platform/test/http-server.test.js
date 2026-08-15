// @ts-nocheck
/* eslint-disable import/order, no-await-in-loop */
/* global setTimeout, Buffer */

// Exercises the platform-agnostic HTTP server (`@endo/platform/http/server`)
// over its Node backend (`@endo/platform/http/node`): lifecycle (start /
// whenBound / stop), request decoding, and both buffered and streamed
// response bodies with backpressure.

import '@endo/init/debug.js';

import http from 'node:http';

import test from 'ava';
import { E } from '@endo/far';

import { makeHttpServer } from '../src/http/server.js';
import { makeNodeHttpBackend } from '../src/http-node/index.js';

const utf8 = s => new TextEncoder().encode(s);

const backend = makeNodeHttpBackend();

// node:http GET client with keep-alive disabled, so closing the server in
// teardown does not strand pooled sockets (see endo-fs-asset-server tests).
const httpGet = url =>
  new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
  });

const request = (url, method) =>
  new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });

const start = async (t, handler) => {
  const server = makeHttpServer({
    backend,
    handler,
    address: { host: '127.0.0.1', port: 0 },
  });
  await E(server).start();
  const bound = await E(server).whenBound();
  t.teardown(() => E(server).stop());
  return { server, origin: `http://127.0.0.1:${bound.port}` };
};

test.serial('whenBound resolves to the OS-assigned address', async t => {
  const { server, origin } = await start(t, () => ({
    status: 204,
    headers: [],
  }));
  const addr = await E(server).getAddress();
  t.is(typeof addr.port, 'number');
  const port = Number(addr.port);
  t.true(port > 0);
  t.is(origin, `http://127.0.0.1:${port}`);
});

test.serial('decodes the request and returns a buffered body', async t => {
  const seen = [];
  const { origin } = await start(t, req => {
    seen.push(req);
    return {
      status: 200,
      headers: [['Content-Type', 'text/plain']],
      body: utf8(`method=${req.method} url=${req.url}`),
    };
  });
  const res = await httpGet(`${origin}/a/b?c=1`);
  t.is(res.status, 200);
  t.is(res.headers['content-type'], 'text/plain');
  t.is(res.body.toString('utf-8'), 'method=GET url=/a/b?c=1');
  t.is(seen[0].method, 'GET');
  // Headers arrive as raw [name, value] pairs.
  t.true(seen[0].headers.some(([k]) => k.toLowerCase() === 'host'));
});

test.serial('streams an async-iterable body with backpressure', async t => {
  const { origin } = await start(t, () => ({
    status: 200,
    headers: [['Content-Type', 'application/octet-stream']],
    body: (async function* streamBody() {
      for (let i = 0; i < 5; i += 1) {
        yield utf8(`chunk${i};`);
        // yield to the event loop so writes actually interleave
        await new Promise(resolve => setTimeout(resolve, 1));
      }
    })(),
  }));
  const res = await httpGet(`${origin}/stream`);
  t.is(res.status, 200);
  t.is(res.body.toString('utf-8'), 'chunk0;chunk1;chunk2;chunk3;chunk4;');
});

test.serial('an empty body ends the response', async t => {
  const { origin } = await start(t, () => ({ status: 204, headers: [] }));
  const res = await httpGet(`${origin}/`);
  t.is(res.status, 204);
  t.is(res.body.length, 0);
});

test.serial('HEAD gets headers but no body', async t => {
  const { origin } = await start(t, () => ({
    status: 200,
    headers: [['Content-Length', '5']],
    // A well-behaved handler omits the body for HEAD; the server would
    // stream it otherwise. Here we omit it.
  }));
  const res = await request(`${origin}/`, 'HEAD');
  t.is(res.status, 200);
  t.is(res.headers['content-length'], '5');
  t.is(res.body.length, 0);
});

test.serial('a throwing handler becomes a 500', async t => {
  const { origin } = await start(t, () => {
    throw new Error('boom');
  });
  const res = await httpGet(`${origin}/`);
  t.is(res.status, 500);
});

test.serial('start and stop are idempotent', async t => {
  const { server } = await start(t, () => ({ status: 204, headers: [] }));
  await E(server).start(); // second start is a no-op
  await E(server).stop();
  await E(server).stop(); // second stop is a no-op
  t.pass();
});
