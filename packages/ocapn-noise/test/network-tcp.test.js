// @ts-check

/** @import { ByteStream } from '../src/types.js' */

import rawNet from 'node:net';

import baseTest from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '../index.js';
import {
  makeTcpCborTransport,
  makeTcpTransport,
} from '../src/transports/tcp.js';
import { netListenAllowed } from './_net-permission.js';

// `test.serial` because every test in this file binds an OS port via
// `makeTcpTransport()` and shares filesystem and socket state. A
// failure mid-test would otherwise leak the listener into the next
// concurrent test.
const test = netListenAllowed ? baseTest.serial : baseTest.serial.skip;

/**
 * @param {ReturnType<typeof makeOcapnNoiseNetwork>} network
 */
const addFreshKey = network => {
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);
  return { keyId, ...signingKeys };
};

test('two noise peers exchange encrypted messages over TCP', async t => {
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.teardown(() => netA.shutdown());
  t.teardown(() => netB.shutdown());
  const { keyId: keyA } = addFreshKey(netA);
  const { keyId: keyB } = addFreshKey(netB);
  await netA.addTransport(makeTcpTransport());
  await netB.addTransport(makeTcpTransport());

  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);

  t.is(sessionA.remoteLocation.designator, keyB);
  t.is(sessionB.remoteLocation.designator, keyA);

  await sessionA.writer.next(new TextEncoder().encode('hello-tcp-A'));
  await sessionB.writer.next(new TextEncoder().encode('hello-tcp-B'));
  const a = await sessionA.reader.next(undefined);
  const b = await sessionB.reader.next(undefined);
  t.false(a.done);
  t.false(b.done);
  if (!a.done && !b.done) {
    t.is(new TextDecoder().decode(a.value), 'hello-tcp-B');
    t.is(new TextDecoder().decode(b.value), 'hello-tcp-A');
  }

  sessionA.close();
  sessionB.close();
});

test('noise network rejects a tcp-testing-only location that has no tcp-scheme hints', async t => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.teardown(() => network.shutdown());
  addFreshKey(network);
  await network.addTransport(makeTcpTransport());
  await t.throwsAsync(
    async () =>
      network.provideSession({
        type: 'ocapn-peer',
        network: 'tcp-testing-only',
        transport: 'tcp-testing-only',
        designator: '00'.repeat(32),
        hints: { host: '127.0.0.1', port: '1' },
      }),
    { message: /no registered transport matches hints/ },
  );
});

test('tcp transport with framing:none delivers raw socket bytes', async t => {
  const transport = makeTcpTransport({ framing: 'none' });
  t.teardown(() => transport.shutdown());
  /** @type {(s: ByteStream) => void} */
  let resolveStream = () => {};
  /** @type {Promise<ByteStream>} */
  const serverStreamPromise = new Promise(resolve => {
    resolveStream = resolve;
  });
  /* eslint-disable-next-line no-use-before-define -- we capture the listen handler into a promise */
  const { listen } = transport;
  if (!listen) throw Error('tcp transport must expose listen');
  const listener = await listen(stream => {
    resolveStream(stream);
  });

  // Connect a raw Node socket (not through the transport) so we
  // control bytes on the wire exactly.
  const sock = rawNet.createConnection({
    host: listener.hints.host,
    port: Number.parseInt(listener.hints.port, 10),
  });
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  sock.write(Uint8Array.of(0x48, 0x49)); // raw 'HI', not a netstring

  const serverStream = await serverStreamPromise;
  const first = await serverStream.reader.next(undefined);
  t.false(first.done);
  if (!first.done) {
    t.deepEqual(Array.from(first.value), [0x48, 0x49]);
  }

  sock.destroy();
});

// `makeTcpTransport` validates options synchronously, so this case
// doesn't actually need the listen permission gate that wraps the
// rest of this file, but keeping it under the same `test` keeps the
// file uniform.
test('tcp transport rejects an invalid framing option', t => {
  t.throws(
    () =>
      makeTcpTransport(
        /** @type {any} */ ({ framing: 'definitely-not-a-thing' }),
      ),
    { message: /framing.*must be 'netstring', 'cbor', or 'none'/ },
  );
});

test('two noise peers exchange encrypted messages over tcp+cbor', async t => {
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.teardown(() => netA.shutdown());
  t.teardown(() => netB.shutdown());
  const { keyId: keyA } = addFreshKey(netA);
  const { keyId: keyB } = addFreshKey(netB);
  await netA.addTransport(makeTcpCborTransport());
  await netB.addTransport(makeTcpCborTransport());

  const locationB = netB.locationFor(keyB);
  t.truthy(locationB.hints);
  if (locationB.hints) {
    t.deepEqual(Object.keys(locationB.hints).sort(), [
      'tcp+cbor:host',
      'tcp+cbor:port',
    ]);
  }

  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(locationB),
    netB.waitForInboundSession(keyA),
  ]);
  t.is(sessionA.remoteLocation.designator, keyB);
  t.is(sessionB.remoteLocation.designator, keyA);

  await sessionA.writer.next(Uint8Array.of(0x41, 0x01, 0x02));
  await sessionB.writer.next(Uint8Array.of(0x42, 0x03, 0x04));
  const a = await sessionA.reader.next(undefined);
  const b = await sessionB.reader.next(undefined);
  t.false(a.done);
  t.false(b.done);
  if (!a.done && !b.done) {
    t.deepEqual(Array.from(a.value), [0x42, 0x03, 0x04]);
    t.deepEqual(Array.from(b.value), [0x41, 0x01, 0x02]);
  }

  sessionA.close();
  sessionB.close();
});

test('netstring tcp and tcp+cbor are distinct, coexisting transports', async t => {
  const dual = makeOcapnNoiseNetwork({ codec: cborCodec });
  const cborOnly = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netstringOnly = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.teardown(() => dual.shutdown());
  t.teardown(() => cborOnly.shutdown());
  t.teardown(() => netstringOnly.shutdown());
  const { keyId: keyDual } = addFreshKey(dual);
  addFreshKey(cborOnly);
  addFreshKey(netstringOnly);
  await dual.addTransport(makeTcpTransport());
  await dual.addTransport(makeTcpCborTransport());
  await cborOnly.addTransport(makeTcpCborTransport());
  await netstringOnly.addTransport(makeTcpTransport());

  const location = dual.locationFor(keyDual);
  t.truthy(location.hints);
  if (!location.hints) return;
  const hints = location.hints;
  t.not(hints['tcp:port'], hints['tcp+cbor:port']);

  // A tcp+cbor-only peer dials the dual peer's tcp+cbor listener, and a
  // netstring-only peer dials its netstring listener: each selects only
  // the hints of the transport it has registered.
  const viaCbor = await cborOnly.provideSession(location);
  t.is(viaCbor.remoteLocation.designator, keyDual);
  viaCbor.close();
  const viaNetstring = await netstringOnly.provideSession(location);
  t.is(viaNetstring.remoteLocation.designator, keyDual);
  viaNetstring.close();

  // A tcp+cbor peer handed only netstring hints has no matching
  // transport, rather than speaking CBOR frames at a netstring port.
  const netstringHints = Object.fromEntries(
    Object.entries(hints).filter(([key]) => key.startsWith('tcp:')),
  );
  await t.throwsAsync(
    async () => cborOnly.provideSession({ ...location, hints: netstringHints }),
    { message: /no registered transport matches hints/ },
  );
});

test('tcp+cbor frames each message as one CBOR byte string', async t => {
  const transport = makeTcpCborTransport();
  t.teardown(() => transport.shutdown());
  t.is(transport.scheme, 'tcp+cbor');
  /** @type {(s: ByteStream) => void} */
  let resolveStream = () => {};
  /** @type {Promise<ByteStream>} */
  const serverStreamPromise = new Promise(resolve => {
    resolveStream = resolve;
  });
  const { listen } = transport;
  if (!listen) throw Error('tcp+cbor transport must expose listen');
  const listener = await listen(stream => {
    resolveStream(stream);
  });

  const sock = rawNet.createConnection({
    host: listener.hints.host,
    port: Number.parseInt(listener.hints.port, 10),
  });
  t.teardown(() => sock.destroy());
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  // Two tag-24-wrapped byte strings (major type 2), split across writes
  // mid-payload and mid-head: 'HI' then 'YO'.
  sock.write(Uint8Array.of(0xd8, 0x18, 0x42, 0x48));
  sock.write(Uint8Array.of(0x49, 0xd8));
  sock.write(Uint8Array.of(0x18, 0x42, 0x59, 0x4f));

  const serverStream = await serverStreamPromise;
  const first = await serverStream.reader.next(undefined);
  const second = await serverStream.reader.next(undefined);
  t.false(first.done);
  t.false(second.done);
  if (!first.done && !second.done) {
    t.deepEqual(Array.from(first.value), [0x48, 0x49]);
    t.deepEqual(Array.from(second.value), [0x59, 0x4f]);
  }
});

test('tcp+cbor rejects an oversized declared length before allocation', async t => {
  const transport = makeTcpCborTransport();
  t.teardown(() => transport.shutdown());
  /** @type {(s: ByteStream) => void} */
  let resolveStream = () => {};
  /** @type {Promise<ByteStream>} */
  const serverStreamPromise = new Promise(resolve => {
    resolveStream = resolve;
  });
  const { listen } = transport;
  if (!listen) throw Error('tcp+cbor transport must expose listen');
  const listener = await listen(stream => {
    resolveStream(stream);
  });

  const sock = rawNet.createConnection({
    host: listener.hints.host,
    port: Number.parseInt(listener.hints.port, 10),
  });
  t.teardown(() => sock.destroy());
  await new Promise((resolve, reject) => {
    sock.once('connect', resolve);
    sock.once('error', reject);
  });
  // A tag-24 byte-string head declaring 2^32 - 1 bytes, with no payload.
  sock.write(Uint8Array.of(0xd8, 0x18, 0x5a, 0xff, 0xff, 0xff, 0xff));

  const serverStream = await serverStreamPromise;
  await t.throwsAsync(() => serverStream.reader.next(undefined), {
    message: /CBOR message too big/,
  });
  // The framing error tears down the socket; a consumer then closes its
  // writer, which settles (here, rejects with the teardown) rather than
  // hanging.
  await t.throwsAsync(() => serverStream.writer.return(undefined));
});

test('tcp+cbor connect rejects a missing port hint', async t => {
  const transport = makeTcpCborTransport();
  t.teardown(() => transport.shutdown());
  await t.throwsAsync(() => transport.connect({ host: '127.0.0.1' }), {
    message: /tcp\+cbor transport: missing 'port' hint/,
  });
});

test('tcp+cbor connect rejects a non-numeric port hint', async t => {
  const transport = makeTcpCborTransport();
  t.teardown(() => transport.shutdown());
  await t.throwsAsync(
    () => transport.connect({ host: '127.0.0.1', port: 'x' }),
    { message: /tcp\+cbor transport: invalid 'port' hint x/ },
  );
});
