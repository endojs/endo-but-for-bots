// @ts-check

import test from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { makeOcapnNoiseNetwork } from '../index.js';
import { makeMockTransportPair } from '../src/transports/mock.js';

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

test('makeOcapnNoiseNetwork exposes the np network identity without any keys', async t => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  t.is(network.networkId, 'np');
  t.deepEqual(network.listSigningKeys(), []);
  t.deepEqual(network.listTransports(), []);
  t.deepEqual(network.locations(), []);
  network.shutdown();
});

test('addSigningKeys returns the 64-char keyId and registers a locator', async t => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
  const { keyId } = addFreshKey(network);
  t.is(keyId.length, 64);
  t.deepEqual(network.listSigningKeys(), [keyId]);
  const [loc] = network.locations();
  t.is(loc.network, 'np');
  t.is(loc.designator, keyId);
  network.shutdown();
});

test('addTransport picks up transport hints in subsequent locations()', async t => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
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
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
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
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
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
  const network = makeOcapnNoiseNetwork({ codec: cborCodec });
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
    { message: /designator must be a 32-byte Ed25519 key/ },
  );
  network.shutdown();
});

test('multiple keys on one network route inbound sessions to the right local key', async t => {
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
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
