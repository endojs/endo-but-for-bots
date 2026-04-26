// @ts-check
/* global setImmediate */

/**
 * Behavioural coverage for `packages/ocapn-noise/src/transports/ws.js`.
 *
 * The hardening fixes shipped under PR #49 (non-binary rejection,
 * double-listen guard, connect-failure cleanup, wildcard-host
 * substitution) were tsc-validated only; this file exercises each on a
 * real `WebSocketServer` from the `ws` library so a regression in any
 * one path fails loud.
 */

import baseTest from '@endo/ses-ava/test.js';
import * as wsModule from 'ws';

import { makeWebSocketTransport } from '../src/transports/ws.js';
import { netListenAllowed } from './_net-permission.js';

// `ws`'s `WebSocket` and `WebSocketServer` are server-flavoured: they
// are constructor-compatible with the browser interfaces our transport
// expects, but their static-method shapes differ slightly.  Treat
// them as `any` for the purposes of these tests.
const WebSocket = /** @type {any} */ (wsModule.WebSocket);
const WebSocketServer = /** @type {any} */ (wsModule.WebSocketServer);

const test = netListenAllowed ? baseTest : baseTest.skip;

const noopHandler = () => {};

const drainEventLoop = async () => {
  // Drain enough microtasks + macrotasks that any close/error handlers
  // queued by the `ws` library have had a chance to fire.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
};

test('ws transport: peer round-trip exchanges binary frames in both directions', async t => {
  /** @type {(s: import('../src/types.js').ByteStream) => void} */
  let resolveServerStream = () => {};
  /** @type {Promise<import('../src/types.js').ByteStream>} */
  const serverStream = new Promise(resolve => {
    resolveServerStream = resolve;
  });

  const serverTransport = makeWebSocketTransport({
    WebSocket,
    WebSocketServer,
    host: '127.0.0.1',
    port: 0,
  });
  const listen = serverTransport.listen;
  if (!listen) throw Error('ws transport must expose listen');
  const listener = await listen(stream => resolveServerStream(stream));

  const clientTransport = makeWebSocketTransport({
    WebSocket,
    WebSocketServer,
  });
  const clientStream = await clientTransport.connect(listener.hints);
  const sStream = await serverStream;

  // Client → server.
  await clientStream.writer.next(Uint8Array.of(0x48, 0x49)); // 'HI'
  const c2s = await sStream.reader.next(undefined);
  t.false(c2s.done);
  if (!c2s.done) t.deepEqual(Array.from(c2s.value), [0x48, 0x49]);

  // Server → client.
  await sStream.writer.next(Uint8Array.of(0x59, 0x4f)); // 'YO'
  const s2c = await clientStream.reader.next(undefined);
  t.false(s2c.done);
  if (!s2c.done) t.deepEqual(Array.from(s2c.value), [0x59, 0x4f]);

  await clientStream.writer.return(undefined);
  await drainEventLoop();
  listener.close();
  serverTransport.shutdown();
});

test('ws transport: receiving a non-binary frame rejects the next reader.next()', async t => {
  /** @type {(ws: any) => void} */
  let resolveServerWs = () => {};
  /** @type {Promise<any>} */
  const serverWsPromise = new Promise(resolve => {
    resolveServerWs = resolve;
  });

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => {
    wss.on('listening', () => resolve(undefined));
  });
  wss.on('connection', ws => resolveServerWs(ws));

  const addr = wss.address();
  if (!addr || typeof addr === 'string') {
    throw Error(`ws transport test: unexpected address ${addr}`);
  }

  const clientTransport = makeWebSocketTransport({ WebSocket });
  const clientStream = await clientTransport.connect({
    url: `ws://${addr.address}:${addr.port}`,
  });
  const serverWs = await serverWsPromise;

  // The server sends a text (non-binary) message. The transport's
  // adapter should reject the next reader.next() with the
  // protocol-error message rather than hanging forever.
  serverWs.send('plain-text-message');

  await t.throwsAsync(() => clientStream.reader.next(undefined), {
    message: /non-binary message/,
  });

  serverWs.close();
  wss.close();
});

test('ws transport: calling listen twice throws', async t => {
  const transport = makeWebSocketTransport({
    WebSocket,
    WebSocketServer,
    host: '127.0.0.1',
    port: 0,
  });
  const listen = transport.listen;
  if (!listen) throw Error('ws transport must expose listen');

  const listener = await listen(noopHandler);
  await t.throwsAsync(() => listen(noopHandler), {
    message: /listen called more than once/,
  });
  listener.close();
  transport.shutdown();
});

test('ws transport: listening on 0.0.0.0 advertises 127.0.0.1 in the url hint', async t => {
  const transport = makeWebSocketTransport({
    WebSocket,
    WebSocketServer,
    host: '0.0.0.0',
    port: 0,
  });
  const listen = transport.listen;
  if (!listen) throw Error('ws transport must expose listen');
  const listener = await listen(noopHandler);
  const url = new URL(listener.hints.url);
  t.is(url.hostname, '127.0.0.1', 'wildcard host substituted with loopback');
  t.not(url.port, '', 'port is populated');
  listener.close();
  transport.shutdown();
});

test('ws transport: connect to a closed port rejects without hanging', async t => {
  // Spin up a server, capture its port, close it, and then attempt to
  // dial that port. The transport's connect path should reject the
  // promise rather than leaving a half-open socket.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => {
    wss.on('listening', () => resolve(undefined));
  });
  const addr = wss.address();
  if (!addr || typeof addr === 'string') {
    throw Error(`ws transport test: unexpected address ${addr}`);
  }
  const port = addr.port;
  wss.close();
  await new Promise(resolve => {
    wss.on('close', resolve);
  });

  const transport = makeWebSocketTransport({ WebSocket });
  // The `ws` library rejects with a raw ErrorEvent (not an Error), so
  // pass `any: true` — we only care that the connect path settles
  // rather than hanging.
  await t.throwsAsync(
    () => transport.connect({ url: `ws://127.0.0.1:${port}` }),
    { any: true },
  );

  // After the connect rejection settles, `transport.shutdown()` must
  // be a no-op (no leaked socket, no double-close throw).
  await drainEventLoop();
  t.notThrows(() => transport.shutdown());
});
