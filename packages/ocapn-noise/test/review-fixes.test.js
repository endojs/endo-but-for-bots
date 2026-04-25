// @ts-check
/* global setTimeout */

/**
 * Regression tests for the review round that landed the ship-blocker
 * fixes (active-session replacement, package missing gen/), the
 * handshake timeout, configurable TCP framing, and the medium-priority
 * ergonomics fixes.
 */

import rawNet from 'node:net';

import test from '@endo/ses-ava/test.js';
import { makeQueue } from '@endo/stream';
import harden from '@endo/harden';

import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '../index.js';
import { makeMockTransportPair } from '../src/transports/mock.js';
import { makeTcpTransport } from '../src/transports/tcp.js';
import { makeMockMeshFabric } from './_fabric.js';
import { netListenAllowed } from './_net-permission.js';

const tcpTest = netListenAllowed ? test : test.skip;

/**
 * @param {ReturnType<typeof makeOcapnNoiseNetwork>} network
 */
const addFreshKey = network => {
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);
  return { keyId, ...signingKeys };
};

// ──────────────────────────────────────────────────────────────────────
// Phase 1 — active-session replacement semantics (B1)
// ──────────────────────────────────────────────────────────────────────

test('active session is preserved when a second inbound handshake arrives', async t => {
  const fabric = makeMockMeshFabric();
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
  const keyA = addFreshKey(netA).keyId;
  const keyB = addFreshKey(netB).keyId;
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };
  const locB = { ...netB.locationFor(keyB), hints: { 'mesh:to': 'B' } };

  // First pair of sessions settles.
  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(locB),
    netB.waitForInboundSession(keyA),
  ]);

  // A's surviving session must not be disturbed by subsequent inbound
  // handshakes. Kick off a background read on the original session;
  // then trigger another B→A handshake and confirm the original read
  // still delivers the bytes B writes afterward, rather than getting
  // a premature {done: true}.
  const originalRead = sessionA.reader.next(undefined);

  // Second B→A dial (with a short handshake timeout so we don't wait
  // 30 s for it to settle on a mesh transport that drops).
  const sessionBTake2 = netB
    .provideSession(locA, { localKeyId: keyB })
    .catch(() => undefined);
  // Give the second handshake a moment to race, then send on the
  // original session and wait for it to land.
  await new Promise(resolve => setTimeout(resolve, 50));
  await sessionB.writer.next(new TextEncoder().encode('still-here'));
  const received = await originalRead;
  t.false(received.done, 'active session is still live');
  if (!received.done) {
    t.is(new TextDecoder().decode(received.value), 'still-here');
  }

  sessionA.close();
  sessionB.close();
  await sessionBTake2;
  netA.shutdown();
  netB.shutdown();
  fabric.shutdown();
});

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — handshake timeout
// ──────────────────────────────────────────────────────────────────────

/**
 * A transport whose `connect` returns a stream that never delivers
 * any bytes — the canonical slow-loris.
 *
 * @returns {import('../src/types.js').OcapnNoiseTransport}
 */
const makeStallingTransport = () => {
  const queue = makeQueue();
  /** @type {any} */
  const reader = harden({
    next: () => queue.get(), // will never resolve
    return: async () => harden({ done: true, value: undefined }),
    throw: async () => harden({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return reader;
    },
  });
  /** @type {any} */
  const writer = harden({
    next: async () => harden({ done: false, value: undefined }),
    return: async () => harden({ done: true, value: undefined }),
    throw: async () => harden({ done: true, value: undefined }),
    [Symbol.asyncIterator]() {
      return writer;
    },
  });
  return harden({
    scheme: 'stall',
    connect: async () => harden({ reader, writer }),
    shutdown: () => {},
  });
};

test('provideSession rejects after handshake timeout', async t => {
  const net = makeOcapnNoiseNetwork({
    codec: cborCodec,
    handshakeTimeoutMs: 50,
  });
  addFreshKey(net);
  await net.addTransport(makeStallingTransport());

  const peerKey = '11'.repeat(32);
  await t.throwsAsync(
    async () =>
      net.provideSession({
        type: 'ocapn-peer',
        network: 'np',
        transport: 'np',
        designator: peerKey,
        hints: { 'stall:to': 'anywhere' },
      }),
    { message: /timed out/ },
  );
  net.shutdown();
});

// ──────────────────────────────────────────────────────────────────────
// Phase 3 — configurable TCP framing (`framing: 'none'`)
// ──────────────────────────────────────────────────────────────────────

tcpTest(
  'tcp transport with framing:none delivers raw socket bytes',
  async t => {
    const transport = makeTcpTransport({ framing: 'none' });
    /** @type {(s: import('../src/types.js').ByteStream) => void} */
    let resolveStream = () => {};
    /** @type {Promise<import('../src/types.js').ByteStream>} */
    const serverStreamPromise = new Promise(resolve => {
      resolveStream = resolve;
    });
    /* eslint-disable-next-line no-use-before-define -- we capture the listen handler into a promise */
    const listen = transport.listen;
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
    sock.write(Uint8Array.of(0x48, 0x49)); // raw 'HI' — not a netstring

    const serverStream = await serverStreamPromise;
    const first = await serverStream.reader.next(undefined);
    t.false(first.done);
    if (!first.done) {
      t.deepEqual(Array.from(first.value), [0x48, 0x49]);
    }

    sock.destroy();
    transport.shutdown();
  },
);

test('tcp transport rejects an invalid framing option', t => {
  t.throws(
    () =>
      makeTcpTransport(
        /** @type {any} */ ({ framing: 'definitely-not-a-thing' }),
      ),
    { message: /framing.*must be 'netstring' or 'none'/ },
  );
});

// ──────────────────────────────────────────────────────────────────────
// Phase 4 — ergonomic fixes
// ──────────────────────────────────────────────────────────────────────

test('provideSession with multiple keys demands an explicit localKeyId', async t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  addFreshKey(net);
  addFreshKey(net);
  const { transportA } = makeMockTransportPair();
  await net.addTransport(transportA);
  await t.throwsAsync(
    async () =>
      net.provideSession({
        type: 'ocapn-peer',
        network: 'np',
        transport: 'np',
        designator: '00'.repeat(32),
        hints: { 'mock:to': 'default' },
      }),
    { message: /requires `localKeyId`/ },
  );
  net.shutdown();
});

test('provideSession rejects an unknown localKeyId', async t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  addFreshKey(net);
  const { transportA } = makeMockTransportPair();
  await net.addTransport(transportA);
  await t.throwsAsync(
    async () =>
      net.provideSession(
        {
          type: 'ocapn-peer',
          network: 'np',
          transport: 'np',
          designator: '00'.repeat(32),
          hints: { 'mock:to': 'default' },
        },
        { localKeyId: 'ff'.repeat(32) },
      ),
    { message: /unknown local keyId/ },
  );
  net.shutdown();
});

test('addTransport rolls back when listen fails', async t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  addFreshKey(net);
  const broken = harden({
    scheme: 'broken',
    connect: async () => {
      throw Error('not used');
    },
    listen: async () => {
      throw Error('synthetic listen failure');
    },
    shutdown: () => {},
  });
  await t.throwsAsync(
    async () => net.addTransport(/** @type {any} */ (broken)),
    { message: /synthetic listen failure/ },
  );
  t.deepEqual(net.listTransports(), []);
  net.shutdown();
});

test('shutdown rejects pending provideSession waiters', async t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  addFreshKey(net);
  await net.addTransport(makeStallingTransport());
  // Start a handshake that will never complete, then shutdown.
  const pending = net.provideSession({
    type: 'ocapn-peer',
    network: 'np',
    transport: 'np',
    designator: '22'.repeat(32),
    hints: { 'stall:to': 'x' },
  });
  const rejected = t.throwsAsync(pending, { message: /network shutdown/ });
  net.shutdown();
  await rejected;
});

test('generateSigningKeys produces a valid 32-byte keypair without booting WASM', t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  const { privateKey, publicKey } = net.generateSigningKeys();
  t.is(privateKey.length, 32);
  t.is(publicKey.length, 32);
  // Round-trip through addSigningKeys to prove the public half is
  // consistent with the private half under the codec's cryptography.
  const keyId = net.addSigningKeys({ privateKey, publicKey });
  t.is(keyId.length, 64);
  net.shutdown();
});

// ──────────────────────────────────────────────────────────────────────
// Phase 7 — new coverage
// ──────────────────────────────────────────────────────────────────────

test('SYN addressed to an unknown local key is silently dropped', async t => {
  const fabric = makeMockMeshFabric();
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
  const keyA = addFreshKey(netA).keyId;
  addFreshKey(netB);
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };

  // Remove A's key before B dials. B's SYN will be addressed to a
  // designator that A no longer recognizes; A must drop the stream
  // (not spin, not throw on A's side). B's initiate sees a closed
  // stream and its provideSession rejects — that's the observable
  // consequence.
  netA.removeSigningKeys(keyA);
  t.deepEqual(netA.listSigningKeys(), [], 'A has no keys left');

  await t.throwsAsync(async () => netB.provideSession(locA), {
    // Either stream-closed (A dropped SYN) or timeout.
    message: /stream closed before expected|timed out/,
  });

  netA.shutdown();
  netB.shutdown();
  fabric.shutdown();
});

test('removeSigningKeys forgets a previously registered identity', t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  const { keyId } = addFreshKey(net);
  t.deepEqual(net.listSigningKeys(), [keyId]);
  net.removeSigningKeys(keyId);
  t.deepEqual(net.listSigningKeys(), []);
  net.shutdown();
});

test('addSigningKeys rejects wrong-length keys', t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.throws(
    () =>
      net.addSigningKeys({
        privateKey: new Uint8Array(31),
        publicKey: new Uint8Array(31),
      }),
    { message: /must be 32 bytes/ },
  );
  net.shutdown();
});

// ──────────────────────────────────────────────────────────────────────
// Phase 8 — security/correctness regressions from the 10-agent review
// ──────────────────────────────────────────────────────────────────────

test('addSigningKeys rejects mismatched (privateKey, publicKey) pair', t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  const { privateKey, publicKey } = net.generateSigningKeys();
  // Replace the first byte with a different value so the tampered
  // key no longer matches the one derived from privateKey.
  const tamperedPublicKey = new Uint8Array(publicKey);
  tamperedPublicKey[0] = tamperedPublicKey[0] === 0 ? 1 : 0;
  t.throws(
    () => net.addSigningKeys({ privateKey, publicKey: tamperedPublicKey }),
    { message: /publicKey does not match privateKey/ },
  );
  // Sanity: omitting publicKey is fine — it's derived from privateKey.
  const keyId = net.addSigningKeys({
    privateKey,
    publicKey: /** @type {any} */ (undefined),
  });
  t.is(keyId.length, 64);
  net.shutdown();
});

test('addTransport rejects a second transport with the same scheme', async t => {
  const net = makeOcapnNoiseNetwork({ codec: cborCodec });
  const fabric = makeMockMeshFabric();
  await net.addTransport(fabric.transportFor('A'));
  await t.throwsAsync(async () => net.addTransport(fabric.transportFor('B')), {
    message: /scheme.*already registered/,
  });
  net.shutdown();
  fabric.shutdown();
});

test('inboundSessions.return closes queued sessions that nobody consumed', async t => {
  const fabric = makeMockMeshFabric();
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
  const keyA = addFreshKey(netA).keyId;
  addFreshKey(netB);
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };

  // B initiates; A should buffer the session in its inboundSessions
  // queue because A hasn't started consuming.
  const sessionB = await netB.provideSession(locA);
  // Close A's iterator without ever pulling. The implementation
  // should close any buffered inbound session, which means our
  // outbound `sessionB` reader returns {done:true}.
  const it = netA.inboundSessions[Symbol.asyncIterator]();
  await it.return?.();

  const result = await sessionB.reader.next(undefined);
  t.true(result.done, 'inbound session was closed by iterator return');

  sessionB.close();
  netA.shutdown();
  netB.shutdown();
  fabric.shutdown();
});

test('active session is forgotten after close so a fresh dial starts new', async t => {
  const fabric = makeMockMeshFabric();
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
  addFreshKey(netA);
  const keyB = addFreshKey(netB).keyId;
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locB = { ...netB.locationFor(keyB), hints: { 'mesh:to': 'B' } };

  const first = await netA.provideSession(locB);
  // A second call before close returns the same session (cache hit).
  const cached = await netA.provideSession(locB);
  t.is(cached, first, 'cache hits return the same session');

  // Close — the network should forget the entry; otherwise a third
  // call would resurrect a dead session and the read below would
  // observe {done:true} immediately.
  first.close();
  // Microtask boundary so close() finalization completes before we
  // ask for a new session.
  await Promise.resolve();
  await Promise.resolve();

  const refreshed = await netA.provideSession(locB);
  t.not(refreshed, first, 'fresh dial after close is a new session');

  refreshed.close();
  netA.shutdown();
  netB.shutdown();
  fabric.shutdown();
});
