// @ts-check
// M3 W3.1: the gateway's HTTP server, static files, CSP and WebSocket
// upgrade (designs/m3-interfaces.md 4.1, 4.2, 8): the shell for every path,
// assets with their types and cache headers, 400 on configuration in the
// query, 403 on a foreign Origin, 404 off `/ws`, connection caps per client
// address and in all, extension routes, and the WebSocket framing (binary
// only, size bound, ping, fragments, close codes). No supervisor: a real
// server on an ephemeral loopback port and a raw client.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

import {
  closeCodes,
  cspDirectives,
  gatewayTexts,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { cspHeader } from '../../resources/agent-host/impl/gateway/csp.js';
import {
  makeGatewayServer,
  sendBufferBytes,
} from '../../resources/agent-host/impl/gateway/server.js';
import { makeStaticHandler } from '../../resources/agent-host/impl/gateway/static.js';

const harnessRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHELL =
  '<!doctype html><title>Familiar</title><script src="/assets/app-3f2a9c.js"></script>';

/**
 * An assets directory under H/tmp; `built: false` leaves out the shell.
 * @param {boolean} [built]
 */
const makeAssets = (built = true) => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const dir = mkdtempSync(join(harnessRoot, 'tmp', 'w31h-'));
  if (built) writeFileSync(join(dir, 'index.html'), SHELL);
  writeFileSync(join(dir, 'app-3f2a9c.js'), 'console.log(1);\n');
  writeFileSync(join(dir, 'app-3f2a9c.css'), 'body{}\n');
  writeFileSync(join(dir, 'blob-77.bin'), Buffer.from([1, 2, 3]));
  return dir;
};

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Partial<Parameters<typeof makeGatewayServer>[0]> & { built?: boolean }} [options]
 */
const serve = async (t, options = {}) => {
  const { built = true, ...rest } = options;
  const assetsDir = makeAssets(built);
  /** @type {Record<string, unknown>[]} */
  const logs = [];
  /** @type {import('../../resources/agent-host/impl/gateway/server.js').GatewaySocket[]} */
  const sockets = [];
  const csp = cspHeader();
  const server = await makeGatewayServer({
    port: 0,
    staticHandler: makeStaticHandler({ assetsDir, csp }),
    onSocket: socket => {
      sockets.push(socket);
      socket.onMessage(bytes => socket.send(bytes));
    },
    log: event => {
      logs.push(event);
    },
    csp,
    ...rest,
  });
  t.teardown(async () => {
    await server.close();
    rmSync(assetsDir, { recursive: true, force: true });
  });
  return { server, assetsDir, logs, sockets, csp };
};

/**
 * @param {number} port
 * @param {{ method?: string, path?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
const get = (port, { method = 'GET', path = '/', headers = {} } = {}) =>
  new Promise((resolvePromise, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      res => {
        /** @type {Buffer[]} */
        const parts = [];
        res.on('data', d => parts.push(d));
        res.on('end', () =>
          resolvePromise({
            status: /** @type {number} */ (res.statusCode),
            headers: res.headers,
            body: Buffer.concat(parts).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });

/**
 * A client frame (masked unless `mask: false`).
 * @param {number} opcode
 * @param {Uint8Array} payload
 * @param {{ fin?: boolean, mask?: boolean, length?: bigint }} [options]
 */
const frame = (opcode, payload, { fin = true, mask = true, length } = {}) => {
  const n = payload.length;
  const declared = length ?? BigInt(n);
  /** @type {number[]} */
  const head = [(fin ? 0x80 : 0) + opcode];
  const maskBit = mask ? 0x80 : 0;
  if (declared < 126n) head.push(maskBit + Number(declared));
  else if (declared < 65_536n) {
    head.push(maskBit + 126, Number(declared / 256n), Number(declared % 256n));
  } else {
    head.push(maskBit + 127);
    for (let i = 7; i >= 0; i -= 1) {
      head.push(Number((declared / 256n ** BigInt(i)) % 256n));
    }
  }
  if (!mask) return Buffer.concat([Buffer.from(head), payload]);
  const key = randomBytes(4);
  const body = Buffer.from(payload);
  // eslint-disable-next-line no-bitwise
  for (let i = 0; i < body.length; i += 1) body[i] ^= key[i % 4];
  return Buffer.concat([Buffer.from(head), key, body]);
};

/**
 * A raw WebSocket client over an upgraded socket: parses server frames.
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 */
const makeRawClient = (socket, head) => {
  /** @type {{ opcode: number, payload: Buffer }[]} */
  const frames = [];
  /** @type {Array<() => void>} */
  const waiters = [];
  let pending = head;
  let ended = false;
  const parse = () => {
    for (;;) {
      if (pending.length < 2) return;
      const opcode = pending[0] % 16;
      let length = pending[1] % 128;
      let offset = 2;
      if (length === 126) {
        if (pending.length < 4) return;
        length = pending.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (pending.length < 10) return;
        length = Number(pending.readBigUInt64BE(2));
        offset = 10;
      }
      if (pending.length < offset + length) return;
      frames.push({
        opcode,
        payload: pending.subarray(offset, offset + length),
      });
      pending = pending.subarray(offset + length);
      for (const wake of waiters.splice(0)) wake();
    }
  };
  socket.on('data', d => {
    pending = Buffer.concat([pending, /** @type {Buffer} */ (d)]);
    parse();
  });
  socket.on('close', () => {
    ended = true;
    for (const wake of waiters.splice(0)) wake();
  });
  parse();
  /** @returns {Promise<{ opcode: number, payload: Buffer } | undefined>} */
  const next = async () => {
    await null;
    while (frames.length === 0 && !ended) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => waiters.push(() => r(undefined)));
    }
    return frames.shift();
  };
  /** The close frame's code and reason, skipping data frames. */
  const closeFrame = async () => {
    await null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const f = await next();
      if (f === undefined) return undefined;
      if (f.opcode === 8) {
        return {
          code: f.payload.readUInt16BE(0),
          reason: f.payload.subarray(2).toString('utf8'),
        };
      }
    }
  };
  return {
    /** @param {Buffer} bytes */
    write: bytes => socket.write(bytes),
    next,
    closeFrame,
    closed: () => (ended ? Promise.resolve() : once(socket, 'close')),
    socket,
  };
};

/**
 * @param {number} port
 * @param {{ path?: string, origin?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, body?: string,
 *   headers?: import('node:http').IncomingHttpHeaders,
 *   client?: ReturnType<typeof makeRawClient> }>}
 */
const upgrade = (port, { path = '/ws', origin, headers = {} } = {}) =>
  new Promise((resolvePromise, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin === undefined ? {} : { Origin: origin }),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket, head) =>
      resolvePromise({
        status: /** @type {number} */ (res.statusCode),
        headers: res.headers,
        client: makeRawClient(socket, head),
      }),
    );
    req.on('response', res => {
      /** @type {Buffer[]} */
      const parts = [];
      res.on('data', d => parts.push(d));
      res.on('end', () =>
        resolvePromise({
          status: /** @type {number} */ (res.statusCode),
          headers: res.headers,
          body: Buffer.concat(parts).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });

/** @param {import('node:http').IncomingHttpHeaders | undefined} headers */
const securityHeadersOf = headers => ({
  csp: headers?.['content-security-policy'],
  nosniff: headers?.['x-content-type-options'],
  referrer: headers?.['referrer-policy'],
});

// ---------------------------------------------------------------- CSP

test('cspHeader: strict directives, extension sources added never removed', t => {
  const base = cspHeader();
  t.is(
    base,
    Object.entries(cspDirectives)
      .map(([name, sources]) => `${name} ${sources.join(' ')}`)
      .join('; '),
  );
  t.true(base.includes("default-src 'none'"));
  t.true(base.includes("frame-ancestors 'none'"));
  const extended = cspHeader({
    'img-src': ['https://img.example', "'self'"],
    'frame-src': ['blob:'],
    'base-uri': ["'self'"],
  });
  t.true(extended.includes("img-src 'self' data: https://img.example"));
  t.true(extended.endsWith('frame-src blob:'));
  t.true(
    extended.includes("base-uri 'self'"),
    "'none' dropped once a source is added",
  );
  t.throws(() => cspHeader({ 'img-src': ['x; script-src *'] }));
  t.throws(() => cspHeader({ 'img-src': ['a,b'] }));
  t.throws(() => cspHeader({ 'script-src x': ['a'] }));
  t.throws(() => cspHeader({ 'img-src': /** @type {any} */ ('a') }));
});

// ---------------------------------------------------------------- HTTP

test('every non-upgrade GET answers the shell, with the security headers', async t => {
  const { server, csp } = await serve(t);
  t.is(server.origin, `http://127.0.0.1:${server.port}`);
  for (const path of ['/', '/sessions/abc', '/ws', '/assetsx', '/a/b/c.html']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(server.port, { path });
    t.is(res.status, 200, path);
    t.is(res.body, SHELL, path);
    t.is(res.headers['content-type'], 'text/html; charset=utf-8');
    t.is(res.headers['cache-control'], 'no-cache');
    t.deepEqual(securityHeadersOf(res.headers), {
      csp,
      nosniff: 'nosniff',
      referrer: 'no-referrer',
    });
  }
  const head = await get(server.port, { method: 'HEAD', path: '/x' });
  t.is(head.status, 200);
  t.is(head.body, '');
  t.is(head.headers['content-length'], String(Buffer.byteLength(SHELL)));
});

test('assets: content type, immutable cache, 404 for anything else', async t => {
  const { server, csp } = await serve(t);
  const js = await get(server.port, { path: '/assets/app-3f2a9c.js' });
  t.is(js.status, 200);
  t.is(js.body, 'console.log(1);\n');
  t.is(js.headers['content-type'], 'text/javascript; charset=utf-8');
  t.is(js.headers['cache-control'], 'public, max-age=31536000, immutable');
  t.is(js.headers['content-security-policy'], csp);
  const css = await get(server.port, { path: '/assets/app-3f2a9c.css?v=1' });
  t.is(css.headers['content-type'], 'text/css; charset=utf-8');
  const bin = await get(server.port, { path: '/assets/blob-77.bin' });
  t.is(bin.headers['content-type'], 'application/octet-stream');
  for (const path of [
    '/assets/missing.js',
    '/assets/index.html',
    '/assets/../index.html',
    '/assets/%2e%2e%2findex.html',
    '/assets/.hidden',
    '/assets/a/b.js',
    '/assets/',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(server.port, { path });
    t.is(res.status, 404, path);
    t.is(res.body, gatewayTexts.notFound, path);
    t.is(res.headers['content-security-policy'], csp, path);
  }
});

test('the shell is 503 until built, then served without a restart', async t => {
  const { server, assetsDir } = await serve(t, { built: false });
  const before = await get(server.port, { path: '/' });
  t.is(before.status, 503);
  t.is(before.body, gatewayTexts.uiNotBuilt);
  t.truthy(before.headers['content-security-policy']);
  writeFileSync(join(assetsDir, 'index.html'), SHELL);
  const after = await get(server.port, { path: '/' });
  t.is(after.status, 200);
  t.is(after.body, SHELL);
});

test('configuration in the query string is refused 400 and never logged', async t => {
  const { server, logs } = await serve(t);
  for (const path of [
    '/?agent=deadbeef',
    '/?gateway=127.0.0.1:1',
    '/x?a=1&gateway=',
    '/?%61gent=deadbeef',
    '/assets/app-3f2a9c.js?agent=deadbeef',
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await get(server.port, { path });
    t.is(res.status, 400, path);
    t.is(res.body, gatewayTexts.queryConfig, path);
    t.truthy(res.headers['content-security-policy']);
  }
  t.is((await get(server.port, { path: '/?other=1' })).status, 200);
  const ws = await upgrade(server.port, {
    path: '/ws?agent=deadbeef',
    origin: server.origin,
  });
  t.is(ws.status, 400);
  t.is(ws.body, gatewayTexts.queryConfig);
  const text = JSON.stringify(logs);
  t.false(text.includes('deadbeef'));
  t.false(text.includes('agent'));
});

test('other methods 405; long paths 414; oversize headers 431', async t => {
  const { server } = await serve(t);
  const post = await get(server.port, { method: 'POST', path: '/' });
  t.is(post.status, 405);
  t.is(post.headers.allow, 'GET, HEAD');
  t.truthy(post.headers['content-security-policy']);
  const long = await get(server.port, { path: `/${'a'.repeat(2048)}` });
  t.is(long.status, 414);
  const fits = await get(server.port, { path: `/${'a'.repeat(2047)}` });
  t.is(fits.status, 200);
  const big = await get(server.port, {
    path: '/',
    headers: { 'X-Big': 'b'.repeat(20_000) },
  });
  t.is(big.status, 431);
});

test('extension routes: exact paths, reserved ones refused, failures 500', async t => {
  /** @type {any[]} */
  const upgraded = [];
  const { server, logs } = await serve(t, {
    routes: [
      {
        kind: 'http',
        path: '/ext/hello',
        handle: (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('hello');
        },
      },
      {
        kind: 'http',
        path: '/ext/fail',
        handle: async () => {
          throw Error('boom');
        },
      },
      {
        kind: 'upgrade',
        path: '/audio',
        handle: (_req, socket) => {
          upgraded.push(socket);
          socket.end('HTTP/1.1 418 Teapot\r\nContent-Length: 0\r\n\r\n');
        },
      },
      { kind: 'http', path: '/', handle: () => {} },
      { kind: 'http', path: '/ws', handle: () => {} },
      { kind: 'http', path: '/assets/x.js', handle: () => {} },
      { kind: 'upgrade', path: '/ws', handle: () => {} },
      { kind: 'http', path: '/ext/hello', handle: () => {} },
      { kind: /** @type {any} */ ('other'), path: '/z', handle: () => {} },
    ],
  });
  t.is(logs.filter(e => e.event === 'route-refused').length, 6);
  const hello = await get(server.port, { path: '/ext/hello' });
  t.is(hello.status, 200);
  t.is(hello.body, 'hello');
  t.truthy(hello.headers['content-security-policy']);
  t.is((await get(server.port, { path: '/ext/hello/x' })).body, SHELL);
  t.is((await get(server.port, { path: '/ext/fail' })).status, 500);
  t.is((await get(server.port, { path: '/assets/x.js' })).status, 404);

  const foreign = await upgrade(server.port, {
    path: '/audio',
    origin: 'http://evil.test',
  });
  t.is(foreign.status, 403);
  t.is(upgraded.length, 0);
  const audio = await upgrade(server.port, {
    path: '/audio',
    origin: server.origin,
  });
  t.is(audio.status, 418);
  t.is(upgraded.length, 1);
});

// ---------------------------------------------------------------- upgrade

test('upgrade: /ws with the right Origin; 403 foreign; 404 elsewhere', async t => {
  const { server, sockets } = await serve(t);
  const ok = await upgrade(server.port, { origin: server.origin });
  t.is(ok.status, 101);
  const local = await upgrade(server.port, {
    origin: `http://localhost:${server.port}`,
  });
  t.is(local.status, 101, 'localhost names the same loopback origin');
  t.is(sockets.length, 2);
  t.is(server.connections(), 2);
  t.is(sockets[0].address, '127.0.0.1');

  for (const origin of [
    undefined,
    'null',
    'http://evil.test',
    `https://127.0.0.1:${server.port}`,
    `http://127.0.0.1:${server.port + 1}`,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const res = await upgrade(server.port, { origin });
    t.is(res.status, 403, String(origin));
    t.is(res.body, gatewayTexts.originRefused);
    t.truthy(res.headers?.['content-security-policy']);
  }
  for (const path of ['/', '/ws/', '/wss', '/assets/app-3f2a9c.js']) {
    // eslint-disable-next-line no-await-in-loop
    const res = await upgrade(server.port, { path, origin: server.origin });
    t.is(res.status, 404, path);
    t.is(res.body, gatewayTexts.notFound);
  }
  const bad = await upgrade(server.port, {
    origin: server.origin,
    headers: { 'Sec-WebSocket-Version': '8' },
  });
  t.is(bad.status, 400);
  t.is(server.connections(), 2);
  ok.client?.socket.destroy();
  local.client?.socket.destroy();
});

test('upgrade: a configured publicOrigin is the only one accepted', async t => {
  const { server } = await serve(t, {
    publicOrigin: 'https://chat.example.test/',
  });
  t.is(server.origin, 'https://chat.example.test');
  const own = await upgrade(server.port, { origin: server.origin });
  t.is(own.status, 101);
  own.client?.socket.destroy();
  const loopback = await upgrade(server.port, {
    origin: `http://127.0.0.1:${server.port}`,
  });
  t.is(loopback.status, 403);
  await t.throwsAsync(() =>
    makeGatewayServer({
      port: 0,
      publicOrigin: 'not an origin',
      staticHandler: () => false,
      onSocket: () => {},
    }),
  );
});

test('connection caps: per client address (trusted proxy) and in all', async t => {
  const { server, sockets, logs } = await serve(t, {
    trustedProxies: ['127.0.0.1'],
    limits: { maxConnections: 3, connectionsPerAddress: 2 },
  });
  /** @param {string} forwarded */
  const open = forwarded =>
    upgrade(server.port, {
      origin: server.origin,
      headers: { 'X-Forwarded-For': forwarded },
    });
  const a1 = await open('127.51.100.1');
  const a2 = await open('127.0.113.66, 127.51.100.1');
  t.is(a1.status, 101);
  t.is(a2.status, 101);
  t.deepEqual(
    sockets.map(s => s.address),
    ['127.51.100.1', '127.51.100.1'],
  );
  const a3 = await open('127.51.100.1');
  t.is(a3.status, 503, 'per address');
  const b1 = await open('127.51.100.2');
  t.is(b1.status, 101, 'another address is not limited by the first');
  const c1 = await open('127.51.100.3');
  t.is(c1.status, 503, 'in all');
  t.is(server.connections(), 3);

  a1.client?.socket.destroy();
  await a1.client?.closed();
  // The server sees the close shortly after the client.
  for (let i = 0; i < 50 && server.connections() > 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(r => setTimeout(r, 10));
  }
  t.is(server.connections(), 2);
  const a4 = await open('127.51.100.1');
  t.is(a4.status, 101, 'a closed connection frees its place');
  t.true(logs.some(e => e.event === 'ws-refused' && e.rule === 'connections'));
  for (const res of [a2, b1, a4]) res.client?.socket.destroy();
});

test('connection caps: an untrusted peer X-Forwarded-For is ignored', async t => {
  const { server, sockets } = await serve(t, {
    limits: { maxConnections: 8, connectionsPerAddress: 1 },
  });
  const first = await upgrade(server.port, {
    origin: server.origin,
    headers: { 'X-Forwarded-For': '127.51.100.1' },
  });
  t.is(first.status, 101);
  t.is(sockets[0].address, '127.0.0.1');
  const second = await upgrade(server.port, {
    origin: server.origin,
    headers: { 'X-Forwarded-For': '127.51.100.2' },
  });
  t.is(second.status, 503);
  first.client?.socket.destroy();
});

// ---------------------------------------------------------------- framing

/**
 * @param {import('ava').ExecutionContext} t
 * @param {Partial<Record<keyof typeof import('../../resources/agent-host/impl/gateway/contract-m3.js').gatewayLimits, number>>} [limits]
 */
const openEcho = async (t, limits = {}) => {
  const served = await serve(t, { limits });
  const res = await upgrade(served.server.port, {
    origin: served.server.origin,
  });
  t.is(res.status, 101);
  const client = /** @type {ReturnType<typeof makeRawClient>} */ (res.client);
  t.teardown(() => client.socket.destroy());
  return { ...served, client };
};

test('frames: binary messages echo, of every length encoding', async t => {
  const { client } = await openEcho(t);
  for (const size of [0, 5, 125, 126, 65_535, 65_536, 300_000]) {
    const payload = randomBytes(size);
    client.write(frame(2, payload));
    // eslint-disable-next-line no-await-in-loop
    const echoed = await client.next();
    t.is(echoed?.opcode, 2, String(size));
    t.true(echoed?.payload.equals(payload), String(size));
  }
});

test('frames: fragments join; a ping is answered; pongs are ignored', async t => {
  const { client } = await openEcho(t);
  client.write(
    Buffer.concat([
      frame(2, Buffer.from('ab'), { fin: false }),
      frame(9, Buffer.from('p1')),
      frame(0, Buffer.from('cd'), { fin: false }),
      frame(10, Buffer.from('ignored')),
      frame(0, Buffer.from('ef')),
    ]),
  );
  const pong = await client.next();
  t.is(pong?.opcode, 10);
  t.is(pong?.payload.toString(), 'p1');
  const joined = await client.next();
  t.is(joined?.opcode, 2);
  t.is(joined?.payload.toString(), 'abcdef');
  // Byte by byte: the parser waits for whole frames.
  const one = frame(2, Buffer.from('slow'));
  for (const byte of one) client.write(Buffer.from([byte]));
  t.is((await client.next())?.payload.toString(), 'slow');
});

test('frames: a text frame closes with closeCodes.protocol', async t => {
  const { client, sockets } = await openEcho(t);
  /** @type {number[]} */
  const seen = [];
  sockets[0].onClose(code => seen.push(code));
  client.write(frame(1, Buffer.from('{"type":"CTP_BOOTSTRAP"}')));
  const closing = await client.closeFrame();
  t.is(closing?.code, closeCodes.protocol);
  await client.closed();
  t.deepEqual(seen, [closeCodes.protocol]);
});

test('frames: a message over wsMessageBytes closes with 1009', async t => {
  const { client } = await openEcho(t, { wsMessageBytes: 1024 });
  client.write(frame(2, randomBytes(1024)));
  t.is((await client.next())?.payload.length, 1024, 'at the bound: kept');
  client.write(frame(2, randomBytes(600), { fin: false }));
  client.write(frame(0, randomBytes(600)));
  t.is((await client.closeFrame())?.code, 1009, 'fragments summed');
});

test('frames: a declared huge length closes before buffering', async t => {
  const { client } = await openEcho(t);
  client.write(frame(2, Buffer.alloc(0), { length: 2n ** 40n }));
  t.is((await client.closeFrame())?.code, 1009);
});

test('frames: unmasked, reserved bits or bad sequence close with 1002', async t => {
  const cases = [
    frame(2, Buffer.from('x'), { mask: false }),
    Buffer.from([0x80 + 0x40 + 2, 0x80, 0, 0, 0, 0]),
    frame(0, Buffer.from('x')),
    frame(3, Buffer.from('x')),
    frame(9, Buffer.from('x'), { fin: false }),
    Buffer.concat([
      frame(2, Buffer.from('a'), { fin: false }),
      frame(2, Buffer.from('b')),
    ]),
  ];
  await null;
  for (const bytes of cases) {
    // eslint-disable-next-line no-await-in-loop
    const { client } = await openEcho(t);
    client.write(bytes);
    // eslint-disable-next-line no-await-in-loop
    const closing = await client.closeFrame();
    t.is(closing?.code, 1002);
  }
});

test('close: a client close is echoed and reported once', async t => {
  const { client, sockets, server, logs } = await openEcho(t);
  /** @type {[number, string][]} */
  const seen = [];
  sockets[0].onClose((code, reason) => seen.push([code, reason]));
  const body = Buffer.alloc(2 + 3);
  body.writeUInt16BE(1000, 0);
  body.write('bye', 2);
  client.write(frame(8, body));
  t.is((await client.closeFrame())?.code, 1000);
  await client.closed();
  t.deepEqual(seen, [[1000, 'bye']]);
  t.is(server.connections(), 0);
  t.true(logs.some(e => e.event === 'ws-close' && e.code === 1000));
  // Sending after close is dropped, not thrown.
  t.notThrows(() => sockets[0].send(Buffer.from('late')));
});

test('close: the server closes with a code and reason; close() stops all', async t => {
  const served = await serve(t);
  const one = await upgrade(served.server.port, {
    origin: served.server.origin,
  });
  const two = await upgrade(served.server.port, {
    origin: served.server.origin,
  });
  served.sockets[0].close(closeCodes.signInRotated, gatewayTexts.signInRotated);
  t.deepEqual(await one.client?.closeFrame(), {
    code: closeCodes.signInRotated,
    reason: gatewayTexts.signInRotated,
  });
  served.sockets[1].send(Buffer.from('still open'));
  t.is((await two.client?.next())?.payload.toString(), 'still open');
  await served.server.close();
  t.deepEqual(await two.client?.closeFrame(), {
    code: closeCodes.gatewayStopped,
    reason: gatewayTexts.gatewayStopped,
  });
  await two.client?.closed();
  t.is(served.server.connections(), 0);
  await t.throwsAsync(() => get(served.server.port));
});

test('send: over wsMessageBytes throws', async t => {
  const { sockets } = await openEcho(t, { wsMessageBytes: 1024 });
  t.throws(() => sockets[0].send(Buffer.alloc(1025)), {
    instanceOf: RangeError,
  });
  t.notThrows(() => sockets[0].send(Buffer.alloc(1024)));
});

test('send: a reader that lets the send buffer pass its bound is closed 1008', async t => {
  const { client, sockets } = await openEcho(t);
  /** @type {number[]} */
  const seen = [];
  sockets[0].onClose(code => seen.push(code));
  client.socket.pause();
  const chunk = Buffer.alloc(1_048_576);
  for (let i = 0; i < 64 && seen.length === 0; i += 1) sockets[0].send(chunk);
  t.deepEqual(seen, [1008]);
  t.true(sendBufferBytes >= 8 * 1_048_576);
});

test('interop: the Node WebSocket client (binary frames, Origin header)', async t => {
  const { server } = await serve(t);
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
    // @ts-expect-error undici's WebSocketInit accepts headers
    headers: { Origin: server.origin },
  });
  ws.binaryType = 'arraybuffer';
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(Error('no open'));
  });
  const reply = new Promise(r => {
    ws.onmessage = event => r(Buffer.from(event.data).toString());
  });
  ws.send(Buffer.from('{"type":"CTP_BOOTSTRAP"}'));
  t.is(await reply, '{"type":"CTP_BOOTSTRAP"}');
  const closed = new Promise(r => {
    ws.onclose = event => r(event.code);
  });
  ws.close(1000);
  t.is(await closed, 1000);
});
