// @ts-check

import test from '@endo/ses-ava/test.js';
import { makeQueue } from '@endo/stream';
import harden from '@endo/harden';

import { cborCodec } from '@endo/ocapn/cbor';
import { getRandomValues, wasmModule } from '@endo/ocapn-noise/platform';
import { makeOcapnNoiseNetwork } from '../index.js';
import {
  makeOcapnSessionCryptography,
  PREFIXED_SYN_LENGTH,
} from '../src/bindings.js';
import { makeMockTransportPair } from '../src/transports/mock.js';
import { makeMockMeshFabric } from './_fabric.js';

/**
 * Register a freshly-minted Ed25519 key on the network and return the
 * keyId the network reports.
 *
 * @param {ReturnType<typeof makeOcapnNoiseNetwork>} network
 */
const addFreshKey = network => {
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);
  return { keyId, ...signingKeys };
};

/**
 * Build an OcapnNoiseNetwork and register an automatic
 * `t.teardown(() => net.shutdown())` so a failed assertion mid-test
 * still releases the network's transports, listeners, and WASM
 * cipher state. `network.shutdown()` is idempotent, so explicit
 * shutdown calls in the test body remain safe.
 *
 * @param {import('ava').ExecutionContext<unknown>} t
 * @param {Parameters<typeof makeOcapnNoiseNetwork>[0]} options
 */
const makeNetworkForTest = (t, options) => {
  const net = makeOcapnNoiseNetwork(options);
  t.teardown(() => net.shutdown());
  return net;
};

/**
 * Build a mock-mesh fabric with automatic teardown.
 *
 * @param {import('ava').ExecutionContext<unknown>} t
 */
const makeFabricForTest = t => {
  const fabric = makeMockMeshFabric();
  t.teardown(() => fabric.shutdown());
  return fabric;
};

test('makeOcapnNoiseNetwork exposes the np network identity without any keys', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  t.is(network.networkId, 'np');
  t.deepEqual(network.listSigningKeys(), []);
  t.deepEqual(network.listTransports(), []);
  t.deepEqual(network.locations(), []);
  network.shutdown();
});

test('addSigningKeys returns the 64-char keyId and registers a locator', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId } = addFreshKey(network);
  t.is(keyId.length, 64);
  t.deepEqual(network.listSigningKeys(), [keyId]);
  const [loc] = network.locations();
  t.is(loc.network, 'np');
  t.is(loc.designator, keyId);
  network.shutdown();
});

test('addTransport picks up transport hints in subsequent locations()', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId } = addFreshKey(network);
  t.is(network.locationFor(keyId).hints, false);

  const { transportA } = makeMockTransportPair();
  await network.addTransport(transportA);
  const loc = network.locationFor(keyId);
  t.deepEqual(loc.hints, { 'mock:to': 'default' });

  network.removeTransport(transportA);
  t.is(network.locationFor(keyId).hints, false);
  network.shutdown();
});

test('two peers handshake and exchange encrypted messages via mock transport', async t => {
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netB = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId: keyA } = addFreshKey(netA);
  const { keyId: keyB } = addFreshKey(netB);

  const { transportA, transportB } = makeMockTransportPair();
  await netA.addTransport(transportA);
  await netB.addTransport(transportB);

  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);

  t.is(sessionA.isInitiator, true);
  t.is(sessionB.isInitiator, false);
  t.is(sessionA.remoteLocation.designator, keyB);
  t.is(sessionB.remoteLocation.designator, keyA);
  t.is(sessionA.selfIdentity.keyId, keyA);
  t.is(sessionB.selfIdentity.keyId, keyB);

  // Exercise both directions.
  await sessionA.writer.next(new TextEncoder().encode('ping'));
  await sessionB.writer.next(new TextEncoder().encode('pong'));
  const recvOnB = await sessionB.reader.next(undefined);
  const recvOnA = await sessionA.reader.next(undefined);
  t.false(recvOnA.done);
  t.false(recvOnB.done);
  if (!recvOnA.done && !recvOnB.done) {
    t.is(new TextDecoder().decode(recvOnA.value), 'pong');
    t.is(new TextDecoder().decode(recvOnB.value), 'ping');
  }

  sessionA.close();
  sessionB.close();
  netA.shutdown();
  netB.shutdown();
});

test('provideSession rejects without any registered signing keys', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  const { transportA } = makeMockTransportPair();
  await network.addTransport(transportA);
  await t.throwsAsync(
    async () =>
      network.provideSession({
        type: 'ocapn-peer',
        network: 'np',
        transport: 'np',
        designator: '00'.repeat(32),
        hints: { 'mock:to': 'default' },
      }),
    { message: /requires at least one signing key/ },
  );
  network.shutdown();
});

test('provideSession rejects locations with a short designator', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  addFreshKey(network);
  const { transportA } = makeMockTransportPair();
  await network.addTransport(transportA);
  await t.throwsAsync(
    async () =>
      network.provideSession({
        type: 'ocapn-peer',
        network: 'np',
        transport: 'np',
        designator: 'abcd',
        hints: { 'mock:to': 'default' },
      }),
    { message: /designator must be 64 lowercase hex chars/ },
  );
  network.shutdown();
});

test('provideSession rejects a non-hex designator', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  addFreshKey(network);
  const { transportA } = makeMockTransportPair();
  await network.addTransport(transportA);
  // 64 non-hex chars: the old length-only check accepted this, and
  // `hexToBytes` turned it into 32 zero bytes (a small-order key).
  await t.throwsAsync(
    async () =>
      network.provideSession({
        type: 'ocapn-peer',
        network: 'np',
        transport: 'np',
        designator: 'z'.repeat(64),
        hints: { 'mock:to': 'default' },
      }),
    { message: /designator must be 64 lowercase hex chars/ },
  );
  network.shutdown();
});

test('provideSession rejects an uppercase spelling of a peer designator', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId } = addFreshKey(network);
  const { transportA } = makeMockTransportPair();
  await network.addTransport(transportA);
  // The raw designator string keys `active`/`inProgress`/`waiters`, so
  // an uppercase spelling of a peer we already hold would once open a
  // second, duplicate session instead of reusing the first.
  await t.throwsAsync(
    async () =>
      network.provideSession({
        type: 'ocapn-peer',
        network: 'np',
        transport: 'np',
        designator: keyId.toUpperCase(),
        hints: { 'mock:to': 'default' },
      }),
    { message: /designator must be 64 lowercase hex chars/ },
  );
  network.shutdown();
});

test('waitForInboundSession rejects a non-canonical peer key', async t => {
  const network = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId } = addFreshKey(network);
  // waitForInboundSession keys `active`/`waiters` by its argument, so it
  // must reject a non-canonical spelling rather than park a waiter that
  // never resolves. It rejects (not a sync throw) to match provideSession.
  await t.throwsAsync(
    async () => network.waitForInboundSession(keyId.toUpperCase()),
    { message: /designator must be 64 lowercase hex chars/ },
  );
  network.shutdown();
});

test('multiple keys on one network route inbound sessions to the right local key', async t => {
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netB = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId: keyA1 } = addFreshKey(netA);
  const { keyId: keyA2 } = addFreshKey(netA);
  const { keyId: keyB } = addFreshKey(netB);
  const { transportA, transportB } = makeMockTransportPair();
  await netA.addTransport(transportA);
  await netB.addTransport(transportB);

  // B initiates to A using keyA2 as the intended responder.
  const [sessionB, sessionA] = await Promise.all([
    netB.provideSession(netA.locationFor(keyA2)),
    netA.waitForInboundSession(keyB),
  ]);

  t.is(sessionA.selfIdentity.keyId, keyA2);
  t.is(sessionB.remoteLocation.designator, keyA2);
  t.not(keyA1, keyA2);

  sessionA.close();
  sessionB.close();
  netA.shutdown();
  netB.shutdown();
});

test('provideSession rejects when an active session under a different local key already exists', async t => {
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netB = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId: keyA1 } = addFreshKey(netA);
  const { keyId: keyA2 } = addFreshKey(netA);
  const { keyId: keyB } = addFreshKey(netB);
  const { transportA, transportB } = makeMockTransportPair();
  await netA.addTransport(transportA);
  await netB.addTransport(transportB);

  // First session: A reaches B as A1.
  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB), { localKeyId: keyA1 }),
    netB.waitForInboundSession(keyA1),
  ]);
  t.is(sessionA.selfIdentity.keyId, keyA1);
  t.is(sessionB.remoteLocation.designator, keyA1);

  // Second `provideSession` to the same peer under A2 must not be
  // silently aliased to the A1 session: the caller asked to be
  // authenticated as A2 and would otherwise be unwittingly speaking
  // as A1.
  await t.throwsAsync(
    netA.provideSession(netB.locationFor(keyB), { localKeyId: keyA2 }),
    { message: /already has an active session under local keyId/ },
  );

  // Same caller, same key: still returns the live session.
  const sessionAReuse = await netA.provideSession(netB.locationFor(keyB), {
    localKeyId: keyA1,
  });
  t.is(sessionAReuse, sessionA);

  sessionA.close();
  sessionB.close();
  netA.shutdown();
  netB.shutdown();
});

/**
 * A transport whose `connect` returns a stream that never delivers any
 * bytes (a slow-loris peer) used to exercise the handshake-timeout and
 * shutdown paths.
 *
 * @returns {import('../src/types.js').OcapnNoiseTransport}
 */
const makeStallingTransport = () => {
  const queue = makeQueue();
  /** @type {any} */
  const reader = harden({
    next: () => queue.get(),
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

test('active session is preserved when a second inbound handshake arrives', async t => {
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netB = makeNetworkForTest(t, { codec: cborCodec });
  const keyA = addFreshKey(netA).keyId;
  const keyB = addFreshKey(netB).keyId;
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };
  const locB = { ...netB.locationFor(keyB), hints: { 'mesh:to': 'B' } };

  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(locB),
    netB.waitForInboundSession(keyA),
  ]);

  // A's surviving session must not be disturbed by subsequent inbound
  // handshakes. Kick off a background read on the original session;
  // then trigger another B→A handshake and confirm the original read
  // still delivers the bytes B writes afterward.
  const originalRead = sessionA.reader.next(undefined);

  const sessionBTake2 = netB
    .provideSession(locA, { localKeyId: keyB })
    .catch(() => undefined);
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

test('impostor SYN claiming a peer identity cannot displace that peer session', async t => {
  t.timeout(10_000);
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netV = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId: keyA, publicKey: publicKeyA } = addFreshKey(netA);
  const { keyId: keyV, publicKey: publicKeyV } = addFreshKey(netV);
  await netA.addTransport(fabric.transportFor('A'));
  await netV.addTransport(fabric.transportFor('V'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };

  // The victim V dials A, and A settles the session.  Nothing takes it
  // from A's `inboundSessions`, so it stays unclaimed: the state in
  // which a fresh SYN from V displaces it.
  const sessionV = await netV.provideSession(locA);
  // The mock fabric settles A within microtasks of V's resolution;
  // yield a macrotask so A has queued the session as unclaimed before
  // anything claims it.
  await new Promise(resolve => setTimeout(resolve, 10));
  const sessionA = await netA.waitForInboundSession(keyV);
  const pendingRead = sessionV.reader.next(undefined);

  // The attacker completes a Noise handshake with its own keypair but
  // claims V's verifying key in the SYN payload.
  const attackerKeys = netA.generateSigningKeys();
  const impostor = makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    signingKeys: {
      privateKey: attackerKeys.privateKey,
      publicKey: publicKeyV,
    },
  }).asInitiator();
  const prefixedSyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  impostor.initiatorWriteSyn(publicKeyA, prefixedSyn);
  const attackerStream = await fabric.transportFor('M').connect({ to: 'A' });
  await attackerStream.writer.next(prefixedSyn);
  const reply = await attackerStream.reader.next(undefined);

  // V's session with A is undisturbed.
  await sessionA.writer.next(new TextEncoder().encode('still-here'));
  const received = await pendingRead;
  t.false(received.done, 'victim session is still live');
  if (!received.done) {
    t.is(new TextDecoder().decode(received.value), 'still-here');
  }
  t.true(reply.done, 'A drops the impostor without answering its SYN');
});

test('replayed genuine SYN cannot displace the peer unclaimed session', async t => {
  t.timeout(10_000);
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, {
    codec: cborCodec,
    handshakeTimeoutMs: 1000,
  });
  const netV = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId: keyA, publicKey: publicKeyA } = addFreshKey(netA);
  const victim = addFreshKey(netV);
  await netA.addTransport(fabric.transportFor('A'));
  await netV.addTransport(fabric.transportFor('V'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };

  // V dials A; A settles an unclaimed inbound session (nothing takes it
  // from `inboundSessions`).
  const sessionV = await netV.provideSession(locA);
  // The mock fabric settles A within microtasks of V's resolution;
  // yield a macrotask so A has queued the session as unclaimed before
  // anything claims it.
  await new Promise(resolve => setTimeout(resolve, 10));
  const sessionA = await netA.waitForInboundSession(victim.keyId);
  const pendingRead = sessionV.reader.next(undefined);

  // A third party replays a valid SYN that claims V. IK message 1 is
  // replayable, so a capture off the wire yields exactly these bytes;
  // building it from V's keypair is the same thing. The replayer does
  // not hold V's signing key, so it can never produce the
  // op:start-session that `exchangeIdentity` demands.
  const replaySyn = new Uint8Array(PREFIXED_SYN_LENGTH);
  makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    signingKeys: {
      privateKey: victim.privateKey,
      publicKey: victim.publicKey,
    },
  })
    .asInitiator()
    .initiatorWriteSyn(publicKeyA, replaySyn);
  const replayStream = await fabric.transportFor('M').connect({ to: 'A' });
  await replayStream.writer.next(replaySyn);
  // A answers the SYN — it cannot know the peer is stale until
  // exchangeIdentity — but must not touch V's session before then.
  const replyFrame = await replayStream.reader.next(undefined);
  t.false(replyFrame.done, 'A answered the replay with a SYNACK');

  // V's unclaimed session is still live.
  await sessionA.writer.next(new TextEncoder().encode('still-here'));
  const received = await pendingRead;
  t.false(received.done, 'victim session survived the replay');
  if (!received.done) {
    t.is(new TextDecoder().decode(received.value), 'still-here');
  }
});

/**
 * Build a genuine prefixed SYN from `keys` to the responder `publicKey`:
 * exactly the bytes an on-path observer captures and can replay.
 *
 * @param {{ privateKey: Uint8Array, publicKey: Uint8Array }} keys
 * @param {Uint8Array} responderPublicKey
 */
const makeSynFrom = (keys, responderPublicKey) => {
  const syn = new Uint8Array(PREFIXED_SYN_LENGTH);
  makeOcapnSessionCryptography({
    wasmModule,
    getRandomValues,
    signingKeys: { privateKey: keys.privateKey, publicKey: keys.publicKey },
  })
    .asInitiator()
    .initiatorWriteSyn(responderPublicKey, syn);
  return syn;
};

/**
 * Re-send `syn` to the mesh listener `to` every `intervalMs`, holding each
 * stream open (the replayer can never produce `op:start-session`), until
 * the test tears down.
 *
 * @param {import('ava').ExecutionContext<unknown>} t
 * @param {ReturnType<typeof makeMockMeshFabric>} fabric
 * @param {string} to
 * @param {Uint8Array} syn
 * @param {number} intervalMs
 */
const startReplayLoop = (t, fabric, to, syn, intervalMs) => {
  const replayer = fabric.transportFor(`replayer-${to}`);
  /** @type {import('../src/types.js').ByteStream[]} */
  const streams = [];
  let stopped = false;
  const send = async () => {
    if (stopped) return;
    const stream = await replayer.connect({ to });
    streams.push(stream);
    await stream.writer.next(syn);
  };
  send().catch(() => {});
  const timer = setInterval(() => send().catch(() => {}), intervalMs);
  t.teardown(() => {
    stopped = true;
    clearInterval(timer);
    return Promise.all(streams.map(s => s.writer.return(undefined)));
  });
};

/**
 * Reject if `promise` has not settled within `ms`.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
const within = (promise, ms, label) => {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(Error(`${label} did not settle within ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

test('a sustained SYN replay cannot block settlement of an outbound dial', async t => {
  t.timeout(15_000);
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, {
    codec: cborCodec,
    handshakeTimeoutMs: 400,
  });
  const netV = makeNetworkForTest(t, { codec: cborCodec });
  const { publicKey: publicKeyA } = addFreshKey(netA);
  const victim = addFreshKey(netV);
  await netA.addTransport(fabric.transportFor('A'));
  await netV.addTransport(fabric.transportFor('V'));
  const locV = { ...netV.locationFor(victim.keyId), hints: { 'mesh:to': 'V' } };

  // A captured genuine SYN from V to A, re-sent faster than A's handshake
  // timeout, so some replay claiming V is always in flight at A. Each one
  // holds a crossed-hello settlement slot for V until it times out.
  startReplayLoop(t, fabric, 'A', makeSynFrom(victim, publicKeyA), 150);
  await new Promise(resolve => setTimeout(resolve, 50));

  const session = await within(
    netA.provideSession(locV),
    3000,
    'provideSession',
  );
  t.is(session.remoteLocation.designator, victim.keyId);
});

test('a sustained SYN replay cannot block settlement of an inbound dial', async t => {
  t.timeout(15_000);
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, {
    codec: cborCodec,
    handshakeTimeoutMs: 400,
  });
  const netV = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId: keyA, publicKey: publicKeyA } = addFreshKey(netA);
  const victim = addFreshKey(netV);
  await netA.addTransport(fabric.transportFor('A'));
  await netV.addTransport(fabric.transportFor('V'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };

  startReplayLoop(t, fabric, 'A', makeSynFrom(victim, publicKeyA), 150);
  await new Promise(resolve => setTimeout(resolve, 50));

  // V dials A genuinely. V's side settles at once; A's side must settle
  // too, rather than leave V's adopted session stranded at A.
  await within(netV.provideSession(locA), 3000, 'V provideSession');
  const sessionA = await within(
    netA.waitForInboundSession(victim.keyId),
    3000,
    'A waitForInboundSession',
  );
  t.is(sessionA.remoteLocation.designator, victim.keyId);
});

test('when the per-identity cap is full, the oldest unproven handshake is evicted', async t => {
  t.timeout(10_000);
  const fabric = makeFabricForTest(t);
  const cap = 3;
  const netA = makeNetworkForTest(t, {
    codec: cborCodec,
    handshakeTimeoutMs: 5000,
    maxInProgressPerLocalKey: cap,
  });
  const { publicKey: publicKeyA } = addFreshKey(netA);
  const { publicKey: publicKeyA2 } = addFreshKey(netA);
  await netA.addTransport(fabric.transportFor('A'));
  const dialer = fabric.transportFor('dialer');
  /** @type {import('../src/types.js').ByteStream[]} */
  const streams = [];
  t.teardown(() =>
    Promise.all(streams.map(stream => stream.writer.return(undefined))),
  );

  /**
   * Send a SYN from a fresh (distinct, keyless-attacker) initiator to
   * responder `pub` and return the raw stream, stalled at the
   * post-handshake identity exchange (no op:start-session is ever sent).
   * @param {Uint8Array} pub
   */
  const stalledSynTo = async pub => {
    const syn = new Uint8Array(PREFIXED_SYN_LENGTH);
    makeOcapnSessionCryptography({ wasmModule, getRandomValues })
      .asInitiator()
      .initiatorWriteSyn(pub, syn);
    const stream = await dialer.connect({ to: 'A' });
    streams.push(stream);
    await stream.writer.next(syn);
    return stream;
  };

  // Fill keyA's cap with handshakes from distinct claimed peers.
  const held = [];
  for (let i = 0; i < cap; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const stream = await stalledSynTo(publicKeyA);
    // eslint-disable-next-line no-await-in-loop
    const reply = await stream.reader.next(undefined);
    t.false(reply.done, `held handshake ${i} got a SYNACK`);
    held.push(stream);
  }

  // One more is still answered: the cap evicts the oldest unproven
  // handshake instead of refusing the newest, so a flood cannot hold
  // every slot against later (possibly genuine) peers.
  const overStream = await stalledSynTo(publicKeyA);
  const overReply = await overStream.reader.next(undefined);
  t.false(overReply.done, 'over-cap handshake is still answered');
  // The evicted stream ends well before the 5s handshake timeout could
  // have closed it (A's greeting frame may precede the close).
  const readUntilDone = async () => {
    await null;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const { done } = await held[0].reader.next(undefined);
      if (done) return true;
    }
  };
  t.true(
    await within(readUntilDone(), 2000, 'evicted stream close'),
    'the oldest unproven handshake was evicted',
  );

  // A second local identity has its own budget.
  const otherStream = await stalledSynTo(publicKeyA2);
  const otherReply = await otherStream.reader.next(undefined);
  t.false(otherReply.done, 'a different local identity still answers');
});

test('a flood of stalled handshakes cannot lock a genuine peer out', async t => {
  t.timeout(10_000);
  const fabric = makeFabricForTest(t);
  const cap = 3;
  const netA = makeNetworkForTest(t, {
    codec: cborCodec,
    handshakeTimeoutMs: 5000,
    maxInProgressPerLocalKey: cap,
  });
  const netV = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId: keyA, publicKey: publicKeyA } = addFreshKey(netA);
  addFreshKey(netV);
  await netA.addTransport(fabric.transportFor('A'));
  await netV.addTransport(fabric.transportFor('V'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };
  const dialer = fabric.transportFor('dialer');
  /** @type {import('../src/types.js').ByteStream[]} */
  const streams = [];
  t.teardown(() =>
    Promise.all(streams.map(stream => stream.writer.return(undefined))),
  );

  // A keyless attacker fills keyA's cap with stalled handshakes.
  for (let i = 0; i < cap; i += 1) {
    const syn = new Uint8Array(PREFIXED_SYN_LENGTH);
    makeOcapnSessionCryptography({ wasmModule, getRandomValues })
      .asInitiator()
      .initiatorWriteSyn(publicKeyA, syn);
    // eslint-disable-next-line no-await-in-loop
    const stream = await dialer.connect({ to: 'A' });
    streams.push(stream);
    // eslint-disable-next-line no-await-in-loop
    await stream.writer.next(syn);
    // eslint-disable-next-line no-await-in-loop
    await stream.reader.next(undefined);
  }

  // A genuine peer still gets through.
  const session = await within(
    netV.provideSession(locA),
    3000,
    'genuine provideSession',
  );
  t.is(session.remoteLocation.designator, keyA);
});

test('provideSession rejects a weak designator before opening a connection', async t => {
  const fabric = makeFabricForTest(t);
  const net = makeNetworkForTest(t, { codec: cborCodec });
  addFreshKey(net);
  let connects = 0;
  const base = fabric.transportFor('A');
  await net.addTransport(
    harden({
      ...base,
      connect: async hints => {
        connects += 1;
        return base.connect(hints);
      },
    }),
  );
  // 32 zero bytes is canonical lowercase hex but a small-order key.
  await t.throwsAsync(
    () =>
      net.provideSession({
        type: 'ocapn-peer',
        network: 'np',
        transport: 'np',
        designator: '00'.repeat(32),
        hints: { 'mesh:to': 'nowhere' },
      }),
    { message: /not a valid, strong ed25519 verifying key/ },
  );
  t.is(connects, 0, 'no outbound connection was opened');
});
test('provideSession rejects after handshake timeout', async t => {
  const net = makeNetworkForTest(t, {
    codec: cborCodec,
    handshakeTimeoutMs: 50,
  });
  addFreshKey(net);
  await net.addTransport(makeStallingTransport());

  // A real, strong peer key so the dial reaches the stalling transport
  // and times out, rather than being rejected up front by the weak-key
  // guard.
  const peerKey = addFreshKey(
    makeNetworkForTest(t, { codec: cborCodec }),
  ).keyId;
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

test('provideSession with multiple keys demands an explicit localKeyId', async t => {
  const net = makeNetworkForTest(t, { codec: cborCodec });
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
  const net = makeNetworkForTest(t, { codec: cborCodec });
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
  const net = makeNetworkForTest(t, { codec: cborCodec });
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
  const net = makeNetworkForTest(t, { codec: cborCodec });
  addFreshKey(net);
  await net.addTransport(makeStallingTransport());
  // A real, strong peer key (a fresh keyId is a valid prime-order
  // Ed25519 point) so the dial reaches the stalling transport rather
  // than being rejected up front by the weak-key guard.
  const peerKey = addFreshKey(
    makeNetworkForTest(t, { codec: cborCodec }),
  ).keyId;
  const pending = net.provideSession({
    type: 'ocapn-peer',
    network: 'np',
    transport: 'np',
    designator: peerKey,
    hints: { 'stall:to': 'x' },
  });
  const rejected = t.throwsAsync(pending, { message: /network shutdown/ });
  net.shutdown();
  await rejected;
});

test('generateSigningKeys produces a valid 32-byte keypair without booting WASM', t => {
  const net = makeNetworkForTest(t, { codec: cborCodec });
  const { privateKey, publicKey } = net.generateSigningKeys();
  t.is(privateKey.length, 32);
  t.is(publicKey.length, 32);
  // Round-trip through addSigningKeys to prove the public half is
  // consistent with the private half under the codec's cryptography.
  const keyId = net.addSigningKeys({ privateKey, publicKey });
  t.is(keyId.length, 64);
  net.shutdown();
});

test('SYN addressed to an unknown local key is silently dropped', async t => {
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netB = makeNetworkForTest(t, { codec: cborCodec });
  const keyA = addFreshKey(netA).keyId;
  addFreshKey(netB);
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };

  // Remove A's key before B dials. B's SYN will be addressed to a
  // designator that A no longer recognizes; A must drop the stream
  // (not spin, not throw on A's side). B's initiate sees a closed
  // stream and its provideSession rejects; that's the observable
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
  const net = makeNetworkForTest(t, { codec: cborCodec });
  const { keyId } = addFreshKey(net);
  t.deepEqual(net.listSigningKeys(), [keyId]);
  net.removeSigningKeys(keyId);
  t.deepEqual(net.listSigningKeys(), []);
  net.shutdown();
});

test('addSigningKeys rejects wrong-length keys', t => {
  const net = makeNetworkForTest(t, { codec: cborCodec });
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

test('addSigningKeys rejects mismatched (privateKey, publicKey) pair', t => {
  const net = makeNetworkForTest(t, { codec: cborCodec });
  const { privateKey, publicKey } = net.generateSigningKeys();
  // Replace the first byte with a different value so the tampered
  // key no longer matches the one derived from privateKey.
  const tamperedPublicKey = new Uint8Array(publicKey);
  tamperedPublicKey[0] = tamperedPublicKey[0] === 0 ? 1 : 0;
  t.throws(
    () => net.addSigningKeys({ privateKey, publicKey: tamperedPublicKey }),
    { message: /publicKey does not match privateKey/ },
  );
  // Sanity: omitting publicKey is fine; it's derived from privateKey.
  const keyId = net.addSigningKeys({
    privateKey,
    publicKey: /** @type {any} */ (undefined),
  });
  t.is(keyId.length, 64);
  net.shutdown();
});

test('addTransport rejects a second transport with the same scheme', async t => {
  const net = makeNetworkForTest(t, { codec: cborCodec });
  const fabric = makeFabricForTest(t);
  await net.addTransport(fabric.transportFor('A'));
  await t.throwsAsync(async () => net.addTransport(fabric.transportFor('B')), {
    message: /scheme.*already registered/,
  });
  net.shutdown();
  fabric.shutdown();
});

test('inboundSessions.return closes queued sessions that nobody consumed', async t => {
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netB = makeNetworkForTest(t, { codec: cborCodec });
  const keyA = addFreshKey(netA).keyId;
  addFreshKey(netB);
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locA = { ...netA.locationFor(keyA), hints: { 'mesh:to': 'A' } };

  // B initiates; A should buffer the session in its inboundSessions
  // queue because A hasn't started consuming.
  const sessionB = await netB.provideSession(locA);
  // Let A finish settling (microtasks on the mock fabric) so the session
  // is queued before the iterator returns.
  await new Promise(resolve => setTimeout(resolve, 10));
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
  const fabric = makeFabricForTest(t);
  const netA = makeNetworkForTest(t, { codec: cborCodec });
  const netB = makeNetworkForTest(t, { codec: cborCodec });
  addFreshKey(netA);
  const keyB = addFreshKey(netB).keyId;
  await netA.addTransport(fabric.transportFor('A'));
  await netB.addTransport(fabric.transportFor('B'));
  const locB = { ...netB.locationFor(keyB), hints: { 'mesh:to': 'B' } };

  const first = await netA.provideSession(locB);
  // A second call before close returns the same session (cache hit).
  const cached = await netA.provideSession(locB);
  t.is(cached, first, 'cache hits return the same session');

  // Close: the network should forget the entry; otherwise a third
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

test('location signature is bound to the Noise handshake hash', async t => {
  const { makeCryptography } = await import('@endo/ocapn/cryptography');
  const { syrupCodec } = await import('@endo/ocapn/syrup');
  const crypto = makeCryptography(syrupCodec);
  const keyPair = crypto.makeOcapnKeyPair();
  /** @type {import('@endo/ocapn/components').OcapnLocation} */
  const location = harden({
    type: 'ocapn-peer',
    network: 'np',
    transport: 'np',
    designator: keyPair.publicKey.id ? '00'.repeat(32) : '00'.repeat(32),
    hints: false,
  });
  const bindingA = new Uint8Array(32);
  bindingA.fill(0xaa);
  const bindingB = new Uint8Array(32);
  bindingB.fill(0xbb);

  const sig = crypto.signLocation(location, keyPair, bindingA.buffer);

  // Same binding → verifies.
  t.notThrows(() =>
    crypto.assertLocationSignatureValid(
      location,
      sig,
      keyPair.publicKey,
      bindingA.buffer,
    ),
  );

  // Different binding → fails. Captures the deferred replay-resistance
  // property: a signature minted under one Noise handshake hash cannot
  // be replayed into a different session. Pin to the signature error
  // message so a regression that downgrades the failure to e.g. a
  // generic codec error is caught.
  t.throws(
    () =>
      crypto.assertLocationSignatureValid(
        location,
        sig,
        keyPair.publicKey,
        bindingB.buffer,
      ),
    { message: /signature/i },
  );

  // Empty binding (the tcp-testing-only convention) is also a distinct
  // domain.
  t.throws(
    () =>
      crypto.assertLocationSignatureValid(
        location,
        sig,
        keyPair.publicKey,
        new ArrayBuffer(0),
      ),
    { message: /signature/i },
  );
});
