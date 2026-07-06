// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import {
  OCAPN_CANONICAL_PATH,
  OCAPN_COMPAT_PATH,
  matchOcapnPath,
  adaptWebSocket,
  makeOcapnWebSocketEndpoint,
} from '../index.js';

/**
 * @import {
 *   ByteStream,
 *   OcapnConnectionMeta,
 *   WebSocketLike,
 * } from '../types.d.ts'
 */

/**
 * A minimal `WebSocket`-shaped double. Records `send`/`close` calls
 * and exposes emitters that drive the `on*` handlers the adapter
 * installs. Not hardened: a real `WebSocket` / Node `ws` is a
 * mutable host object the adapter installs `on*` handlers on.
 */
const makeFakeWebSocket = () => {
  /** @type {Uint8Array[]} */
  const sent = [];
  let closedCount = 0;
  /** @type {WebSocketLike} */
  const ws = {
    binaryType: 'nodebuffer',
    onmessage: null,
    onclose: null,
    onerror: null,
    send: bytes => {
      sent.push(bytes);
    },
    close: () => {
      closedCount += 1;
    },
  };
  return {
    ws,
    sent,
    closedCount: () => closedCount,
    /** @param {unknown} data */
    emitMessage: data => ws.onmessage?.({ data }),
    emitClose: () => ws.onclose?.(),
    /** @param {unknown} ev */
    emitError: ev => ws.onerror?.(ev),
  };
};

test('OCapN paths are the canonical path and the bare alias', t => {
  t.is(OCAPN_CANONICAL_PATH, '/ocapn-cbor-np');
  t.is(OCAPN_COMPAT_PATH, '/ocapn');
});

test('matchOcapnPath resolves the canonical path', t => {
  const match = matchOcapnPath('/ocapn-cbor-np');
  t.deepEqual(match, {
    canonicalPath: '/ocapn-cbor-np',
    requestedPath: '/ocapn-cbor-np',
    viaAlias: false,
  });
});

test('matchOcapnPath resolves the bare alias to the canonical path', t => {
  // If the alias stopped mapping to the canonical path, an existing
  // `/ocapn` locator would silently fail to route.
  const match = matchOcapnPath('/ocapn');
  t.deepEqual(match, {
    canonicalPath: '/ocapn-cbor-np',
    requestedPath: '/ocapn',
    viaAlias: true,
  });
});

test('matchOcapnPath strips a query string', t => {
  const match = matchOcapnPath('/ocapn-cbor-np?token=abc');
  t.truthy(match);
  t.is(match?.requestedPath, '/ocapn-cbor-np');
  t.false(match?.viaAlias);
});

test('matchOcapnPath rejects non-OCapN, sub-path, and trailing-slash', t => {
  t.is(matchOcapnPath('/'), null);
  t.is(matchOcapnPath('/chat'), null);
  t.is(matchOcapnPath('/ocapn-cbor-np/extra'), null);
  t.is(matchOcapnPath('/ocapn/'), null);
  t.is(matchOcapnPath('/ocapn-syrups-tcp'), null);
  t.is(matchOcapnPath(''), null);
  // @ts-expect-error deliberately wrong type
  t.is(matchOcapnPath(undefined), null);
});

test('adaptWebSocket sets binaryType and yields one chunk per binary frame', async t => {
  const fake = makeFakeWebSocket();
  const { reader } = adaptWebSocket(fake.ws);
  t.is(fake.ws.binaryType, 'arraybuffer');

  fake.emitMessage(new Uint8Array([1, 2, 3]));
  const first = await reader.next();
  t.deepEqual(first, { done: false, value: new Uint8Array([1, 2, 3]) });

  fake.emitMessage(new Uint8Array([4]).buffer);
  const second = await reader.next();
  t.deepEqual(second, { done: false, value: new Uint8Array([4]) });
});

test('adaptWebSocket reads a non-Uint8Array typed-array view', async t => {
  // Node `ws` in some modes delivers a Buffer/DataView-shaped view;
  // the adapter must read its bytes, not drop the frame.
  const fake = makeFakeWebSocket();
  const { reader } = adaptWebSocket(fake.ws);
  fake.emitMessage(new Int8Array([5, 6, 7]));
  const { value } = await reader.next();
  t.deepEqual(value, new Uint8Array([5, 6, 7]));
});

test('adaptWebSocket signals done on close', async t => {
  const fake = makeFakeWebSocket();
  const { reader } = adaptWebSocket(fake.ws);
  fake.emitClose();
  const closed = await reader.next();
  t.deepEqual(closed, { done: true, value: undefined });
});

test('adaptWebSocket fails the stream on a non-binary frame', async t => {
  // A text frame on the OCapN-Noise wire is a protocol violation.
  // Dropping it would hang a pending reader.next(); it must reject
  // and close the socket.
  const fake = makeFakeWebSocket();
  const { reader } = adaptWebSocket(fake.ws);
  fake.emitMessage('a text frame');
  await t.throwsAsync(() => reader.next(), {
    message: /non-binary WebSocket frame/,
  });
  t.is(fake.closedCount(), 1);
});

test('adaptWebSocket rejects a pending read on a mid-session error', async t => {
  const fake = makeFakeWebSocket();
  const { reader } = adaptWebSocket(fake.ws);
  const boom = Error('socket exploded');
  fake.emitError({ error: boom });
  await t.throwsAsync(() => reader.next(), { is: boom });
});

test('adaptWebSocket writer sends binary frames and stops after close', async t => {
  const fake = makeFakeWebSocket();
  const { writer } = adaptWebSocket(fake.ws);
  const wrote = writer.next(new Uint8Array([9, 9]));
  await wrote;
  t.deepEqual(fake.sent, [new Uint8Array([9, 9])]);

  fake.emitClose();
  await writer.next(new Uint8Array([8]));
  // The frame after close is dropped rather than sent to a dead socket.
  t.deepEqual(fake.sent, [new Uint8Array([9, 9])]);
});

test('makeOcapnWebSocketEndpoint exposes both paths, canonical first', t => {
  const endpoint = makeOcapnWebSocketEndpoint({ onConnection: () => {} });
  t.is(endpoint.canonicalPath, '/ocapn-cbor-np');
  t.is(endpoint.aliasPath, '/ocapn');
  t.deepEqual([...endpoint.paths], ['/ocapn-cbor-np', '/ocapn']);
});

test('endpoint.accept hands a framed byte-stream to the sink', async t => {
  /** @type {Array<{ connection: ByteStream, meta: OcapnConnectionMeta }>} */
  const received = [];
  const endpoint = makeOcapnWebSocketEndpoint({
    onConnection: (connection, meta) => received.push({ connection, meta }),
  });
  const fake = makeFakeWebSocket();
  endpoint.accept('/ocapn-cbor-np', fake.ws);

  t.is(received.length, 1);
  t.deepEqual(received[0].meta, {
    canonicalPath: '/ocapn-cbor-np',
    requestedPath: '/ocapn-cbor-np',
    viaAlias: false,
  });

  // The handed-off stream is live: a frame flows through to the sink's
  // reader, and a write reaches the socket.
  const { reader, writer } = received[0].connection;
  fake.emitMessage(new Uint8Array([1, 2]));
  const framed = await reader.next();
  t.deepEqual(framed, {
    done: false,
    value: new Uint8Array([1, 2]),
  });
  await writer.next(new Uint8Array([3]));
  t.deepEqual(fake.sent, [new Uint8Array([3])]);
});

test('endpoint.accept marks the bare alias in the meta', t => {
  /** @type {OcapnConnectionMeta | undefined} */
  let meta;
  const endpoint = makeOcapnWebSocketEndpoint({
    onConnection: (_conn, m) => {
      meta = m;
    },
  });
  endpoint.accept('/ocapn', makeFakeWebSocket().ws);
  t.true(meta?.viaAlias);
  t.is(meta?.canonicalPath, '/ocapn-cbor-np');
});

test('endpoint.accept throws on a non-OCapN path', t => {
  const endpoint = makeOcapnWebSocketEndpoint({ onConnection: () => {} });
  t.throws(() => endpoint.accept('/chat', makeFakeWebSocket().ws), {
    message: /Not an OCapN endpoint path/,
  });
});

test('an unwired endpoint throws when a connection arrives', t => {
  // Feature enabled but no netlayer sink injected: a stray upgrade
  // must fail loudly, not be silently accepted and dropped.
  const endpoint = makeOcapnWebSocketEndpoint();
  t.throws(() => endpoint.accept('/ocapn-cbor-np', makeFakeWebSocket().ws), {
    message: /no connection sink is wired/,
  });
});

test('makeOcapnWebSocketEndpoint rejects a non-function sink', t => {
  t.throws(
    // @ts-expect-error deliberately wrong type
    () => makeOcapnWebSocketEndpoint({ onConnection: 42 }),
    { message: /must be a function/ },
  );
});
