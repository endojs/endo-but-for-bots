// @ts-check

import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';
import { makeQueue } from '@endo/stream';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { equals } from '../src/cbor/diagnostic/util.js';
import { makeOcapn } from '../src/client/index.js';
import { encodeSwissnum } from '../src/client/util.js';
import { syrupCodec } from '../src/syrup/index.js';
import { makeCryptography, makeSessionId } from '../src/cryptography.js';

/**
 * @import { NetworkSession, OcapnNetwork } from '../src/client/types.js'
 * @import { OcapnLocation } from '../src/codecs/components.js'
 */

const crypto = makeCryptography(syrupCodec);

/**
 * Build a pair of keypairs and the session id that both peers would compute.
 */
const makeAuthenticatedPair = () => {
  const localKeyPair = crypto.makeOcapnKeyPair();
  const remoteKeyPair = crypto.makeOcapnKeyPair();
  const sessionId = makeSessionId(
    localKeyPair.publicKey.id,
    remoteKeyPair.publicKey.id,
  );
  return { localKeyPair, remoteKeyPair, sessionId };
};

test('makeOcapn requires codec', async t => {
  await t.throwsAsync(
    async () =>
      makeOcapn(
        /** @type {any} */ ({
          network: harden({ networkId: 'x', shutdown: () => {} }),
        }),
      ),
    { message: /`codec` is required/ },
  );
});

test('makeOcapn requires network', async t => {
  await t.throwsAsync(
    async () => makeOcapn(/** @type {any} */ ({ codec: syrupCodec })),
    { message: /`network` is required/ },
  );
});

test('makeOcapn rejects codec mismatch against network.codec', async t => {
  /** @type {OcapnNetwork} */
  const network = harden({
    networkId: 'pretend',
    // A different codec object: the identity check compares by reference.
    codec: /** @type {any} */ (harden({ ...syrupCodec })),
    shutdown: () => {},
    provideSession: async _location => {
      throw Error('not called');
    },
  });
  await t.throwsAsync(async () => makeOcapn({ codec: syrupCodec, network }), {
    message: /`network.codec` does not match `codec`/,
  });
});

/** @param {string} designator */
const peerLocation = designator =>
  /** @type {OcapnLocation} */ ({
    type: 'ocapn-peer',
    network: 'adopted',
    transport: 'adopted',
    designator,
    hints: false,
  });

test('makeOcapn rejects a location when the network has no provideSession', async t => {
  /** @type {OcapnNetwork} */
  const network = /** @type {any} */ (
    harden({
      networkId: 'broken',
      shutdown: () => {},
    })
  );

  const ocapn = await makeOcapn({ codec: syrupCodec, network });
  await t.throwsAsync(async () => ocapn.provideSession(peerLocation('peer')), {
    message: /no network accepts location/,
  });
});

test('provideSession resolving undefined rejects instead of falling back', async t => {
  let connectCalls = 0;
  const network = harden({
    networkId: 'declining',
    shutdown: () => {},
    provideSession: async () => undefined,
    connect: () => {
      connectCalls += 1;
      throw Error('connect must not be called');
    },
  });
  const ocapn = await makeOcapn({
    codec: syrupCodec,
    network: /** @type {any} */ (network),
  });
  await t.throwsAsync(async () => ocapn.provideSession(peerLocation('peer')), {
    message: /no network accepts location/,
  });
  t.is(connectCalls, 0);
});

test('makeOcapn refuses a legacy connect-only network', async t => {
  let shutdowns = 0;
  await t.throwsAsync(
    async () =>
      makeOcapn({
        codec: syrupCodec,
        network: /** @type {any} */ (
          () =>
            harden({
              networkId: 'legacy',
              location: peerLocation('self'),
              connect: () => {
                throw Error('not called');
              },
              shutdown: () => {
                shutdowns += 1;
              },
            })
        ),
      }),
    {
      message:
        /network implements connect without provideSession; wrap it with makeStartSessionNetwork/,
    },
  );
  t.is(shutdowns, 1);
});

test('makeOcapn rejects captpVersion, which moved to the start-session adapter', async t => {
  await t.throwsAsync(
    async () =>
      makeOcapn(
        /** @type {any} */ ({
          codec: syrupCodec,
          captpVersion: '1.0',
          network: harden({ networkId: 'x', shutdown: () => {} }),
        }),
      ),
    { message: /captpVersion` moved to `makeStartSessionNetwork/ },
  );
});

test('adopted sessions reach bootstrap with no op:start-session on the wire', async t => {
  const { localKeyPair, remoteKeyPair, sessionId } = makeAuthenticatedPair();
  const locationA = peerLocation('A');
  const locationB = peerLocation('B');
  /** @type {Uint8Array[]} */
  const wire = [];
  /** @type {Record<string, any>} */
  const handlers = {};
  /** @type {Record<string, any>} */
  const adopted = {};
  /** @type {Record<string, any>} */
  const adoptable = {};

  /**
   * @param {'A' | 'B'} self
   * @param {OcapnLocation} location
   */
  const makeNetwork = (self, location) => sessionHandlers => {
    handlers[self] = sessionHandlers;
    return harden({
      networkId: 'adopted',
      codec: syrupCodec,
      location,
      locationId: `adopted:${self}`,
      shutdown: () => {},
      provideSession: async () => adoptable[self],
    });
  };

  const locator = new Map([
    ['greeter', Far('greeter', { greet: () => 'hello' })],
  ]);
  const clientA = await makeOcapn({
    codec: syrupCodec,
    network: /** @type {any} */ (makeNetwork('A', locationA)),
  });
  const clientB = await makeOcapn({
    codec: syrupCodec,
    locator,
    network: /** @type {any} */ (makeNetwork('B', locationB)),
  });

  /**
   * @param {'A' | 'B'} self
   * @param {'A' | 'B'} peer
   * @param {any} selfKeyPair
   * @param {any} peerKeyPair
   * @param {OcapnLocation} selfLocation
   * @param {OcapnLocation} remoteLocation
   */
  const makeAdoptable = (
    self,
    peer,
    selfKeyPair,
    peerKeyPair,
    selfLocation,
    remoteLocation,
  ) =>
    harden({
      sessionId,
      selfIdentity: {
        keyPair: selfKeyPair,
        location: selfLocation,
        locationSignature: crypto.signLocation(
          selfLocation,
          selfKeyPair,
          new ArrayBuffer(0),
        ),
      },
      remotePublicKeyBytes: peerKeyPair.publicKey.descriptor.q,
      remoteLocation,
      remoteLocationSignature: crypto.signLocation(
        remoteLocation,
        peerKeyPair,
        new ArrayBuffer(0),
      ),
      isInitiator: self === 'A',
      write: (/** @type {Uint8Array} */ bytes) => {
        wire.push(bytes);
        Promise.resolve().then(() => adopted[peer].dispatch(bytes));
      },
      close: () => {},
    });
  adoptable.A = makeAdoptable(
    'A',
    'B',
    localKeyPair,
    remoteKeyPair,
    locationA,
    locationB,
  );
  adoptable.B = makeAdoptable(
    'B',
    'A',
    remoteKeyPair,
    localKeyPair,
    locationB,
    locationA,
  );
  adopted.A = handlers.A.adoptSession(adoptable.A);
  adopted.B = handlers.B.adoptSession(adoptable.B);
  t.throws(() => handlers.A.adoptSession(adoptable.A), {
    message: /already adopted/,
  });

  const sessionA = await clientA.provideSession(locationB);
  const again = await clientA.provideSession(locationB);
  const bootstrap = sessionA.getBootstrap();
  t.is(again.getBootstrap(), bootstrap);
  const greeter = await E(/** @type {any} */ (bootstrap)).fetch(
    encodeSwissnum('greeter'),
  );
  t.is(await E(greeter).greet(), 'hello');
  const text = wire.map(bytes => new TextDecoder().decode(bytes)).join('');
  t.false(text.includes('op:start-session'));
  t.true(text.includes('op:deliver'));
  clientA.shutdown();
  clientB.shutdown();
});

test('provideSession routes through OcapnNetwork.provideSession and adopts its identity', async t => {
  /** @type {OcapnLocation} */
  const localLocation = {
    type: 'ocapn-peer',
    network: 'fake-noise',
    transport: 'fake-noise',
    designator: 'local',
    hints: false,
  };

  /** @type {OcapnLocation} */
  const remoteLocation = {
    type: 'ocapn-peer',
    network: 'fake-noise',
    transport: 'fake-noise',
    designator: 'remote',
    hints: false,
  };

  const { localKeyPair, remoteKeyPair, sessionId } = makeAuthenticatedPair();
  const localSelfIdentity = {
    keyPair: localKeyPair,
    location: localLocation,
    locationSignature: crypto.signLocation(
      localLocation,
      localKeyPair,
      new ArrayBuffer(0),
    ),
  };
  const remoteLocationSignature = crypto.signLocation(
    remoteLocation,
    remoteKeyPair,
    new ArrayBuffer(0),
  );

  let provideSessionCalls = 0;
  let writesFromClient = 0;
  let closed = false;

  /** @type {OcapnNetwork} */
  const network = harden({
    networkId: 'fake-noise',
    location: localLocation,
    shutdown: () => {},
    provideSession: async location => {
      provideSessionCalls += 1;
      t.deepEqual(location, remoteLocation);
      const inbound = makeQueue();
      const writer = /** @type {any} */ (
        harden({
          async next(_value) {
            writesFromClient += 1;
            return harden({ done: false, value: undefined });
          },
          async return() {
            return harden({ done: true, value: undefined });
          },
          async throw(err) {
            throw err;
          },
          [Symbol.asyncIterator]() {
            return writer;
          },
        })
      );
      const reader = /** @type {any} */ (
        harden({
          next: () => inbound.get(),
          async return() {
            inbound.put(harden({ done: true, value: undefined }));
            return harden({ done: true, value: undefined });
          },
          async throw(err) {
            throw err;
          },
          [Symbol.asyncIterator]() {
            return reader;
          },
        })
      );
      /** @type {NetworkSession} */
      const networkSession = harden({
        sessionId,
        selfIdentity: localSelfIdentity,
        remotePublicKeyBytes: remoteKeyPair.publicKey.bytes,
        remoteLocation,
        remoteLocationSignature,
        isInitiator: true,
        reader,
        writer,
        close: () => {
          closed = true;
          inbound.put(harden({ done: true, value: undefined }));
        },
      });
      return networkSession;
    },
  });

  const ocapn = await makeOcapn({
    codec: syrupCodec,
    network,
    debugMode: true,
  });

  const session = await ocapn.provideSession(remoteLocation);
  t.is(provideSessionCalls, 1);
  t.truthy(session.getBootstrap());

  // eslint-disable-next-line no-underscore-dangle
  const debug = ocapn._debug;
  if (!debug) throw Error('ocapn._debug missing despite debugMode');
  const peerKey = debug.sessionManager.getPeerPublicKeyForSessionId(sessionId);
  if (!peerKey) throw Error('expected peer public key registered for session');
  t.is(peerKey.bytes.byteLength, 32);
  t.true(equals(peerKey.id, remoteKeyPair.publicKey.id));

  session.abort();
  t.true(closed, 'NetworkSession.close runs when the session aborts');
  t.is(
    writesFromClient,
    0,
    'No writes flow for a session with no peer interaction',
  );
});
