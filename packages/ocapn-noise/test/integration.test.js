// @ts-check
// prefer-endo-primitives-exempt: these tests use the bare Far remotables of
// the @endo/ocapn suites; this package does not depend on @endo/exo.

/** @import { HeartbeatOptions } from '../src/types.js' */

import test from '@endo/ses-ava/test.js';
import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeOcapnNoiseNetwork } from '../index.js';
import { makeMockMeshFabric } from './_fabric.js';

/**
 * Spin up one `@endo/ocapn` instance backed by a noise network wired
 * to a shared mesh fabric. Each peer gets a unique routing name in
 * the fabric; the returned location carries a `mesh:to=<name>` hint
 * so others can reach it.
 *
 * @param {{
 *   fabric: ReturnType<typeof makeMockMeshFabric>,
 *   name: string,
 *   locator?: Map<string, any>,
 *   heartbeat?: HeartbeatOptions,
 * }} options
 */
const makeNoisePeer = async ({
  fabric,
  name,
  locator = new Map(),
  heartbeat,
}) => {
  const network = makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat });
  const signingKeys = network.generateSigningKeys();
  const keyId = network.addSigningKeys(signingKeys);
  await network.addTransport(fabric.transportFor(name));
  const location = network.locationFor(keyId);

  // `makeOcapn` takes the codec and network at construction; the
  // codec is also declared on the network, so construction would also
  // succeed without `codec:` (the network's codec would be adopted),
  // but passing both makes intent explicit and lets the factory
  // assert they match.
  const client = await makeOcapn({
    codec: cborCodec,
    // eslint-disable-next-line object-shorthand
    network: /** @type {any} */ (network),
    debugLabel: name,
    locator,
    debugMode: true,
  });

  return harden({ client, network, keyId, location, locator });
};

test('two noise-backed OCapN peers exchange method calls via bootstrap fetch', async t => {
  const fabric = makeMockMeshFabric();
  t.teardown(() => fabric.shutdown());

  const locatorA = new Map();
  locatorA.set(
    'Greeter',
    Far('Greeter', {
      hello: (who = 'world') => `hello, ${who}`,
    }),
  );

  const peerA = await makeNoisePeer({
    fabric,
    name: 'A',
    locator: locatorA,
  });
  t.teardown(() => peerA.client.shutdown());
  const peerB = await makeNoisePeer({ fabric, name: 'B' });
  t.teardown(() => peerB.client.shutdown());

  // B opens a session to A, fetches A's greeter via SturdyRef, and calls
  // it: a round trip of two CapTP deliveries over Noise.
  const sturdyRef = peerB.client.makeSturdyRef(peerA.location, 'Greeter');
  const greeter = await peerB.client.enlivenSturdyRef(sturdyRef);
  const reply = await E(greeter).hello('Alice');
  t.is(reply, 'hello, Alice');
});

test('heartbeats keep an idle CapTP session usable', async t => {
  const fabric = makeMockMeshFabric();
  t.teardown(() => fabric.shutdown());
  const heartbeat = { intervalMs: 20, sessionTimeoutMs: 100 };

  const locatorA = new Map();
  locatorA.set(
    'Greeter',
    Far('Greeter', {
      hello: (who = 'world') => `hello, ${who}`,
    }),
  );
  const peerA = await makeNoisePeer({
    fabric,
    name: 'A',
    locator: locatorA,
    heartbeat,
  });
  t.teardown(() => peerA.client.shutdown());
  const peerB = await makeNoisePeer({ fabric, name: 'B', heartbeat });
  t.teardown(() => peerB.client.shutdown());

  const sturdyRef = peerB.client.makeSturdyRef(peerA.location, 'Greeter');
  const greeter = await peerB.client.enlivenSturdyRef(sturdyRef);
  t.is(await E(greeter).hello('Alice'), 'hello, Alice');

  // Idle across several session timeouts: heartbeats alone keep the
  // session from being declared lost.
  await new Promise(resolve =>
    setTimeout(resolve, heartbeat.sessionTimeoutMs * 3),
  );
  t.is(await E(greeter).hello('Bob'), 'hello, Bob');
});

test('three-party handoff: A forwards a cap from B into C, and C invokes it', async t => {
  const fabric = makeMockMeshFabric();
  t.teardown(() => fabric.shutdown());

  const locatorB = new Map();
  locatorB.set(
    'ObjectMaker',
    Far('ObjectMaker', {
      makeObject: () =>
        Far('Object', {
          getNumber: () => 42,
        }),
    }),
  );

  const locatorC = new Map();
  locatorC.set(
    'ObjectUser',
    Far('ObjectUser', {
      // Receives a remote cap (from B, via A) and invokes it.
      useObject: async object => E(object).getNumber(),
    }),
  );

  const peerA = await makeNoisePeer({ fabric, name: 'A' });
  t.teardown(() => peerA.client.shutdown());
  const peerB = await makeNoisePeer({
    fabric,
    name: 'B',
    locator: locatorB,
  });
  t.teardown(() => peerB.client.shutdown());
  const peerC = await makeNoisePeer({
    fabric,
    name: 'C',
    locator: locatorC,
  });
  t.teardown(() => peerC.client.shutdown());

  // A fetches ObjectMaker from B and ObjectUser from C via SturdyRefs.
  // Asking ObjectUser to invoke an Object created on B triggers the
  // three-party handoff protocol: A emits a handoff-give into the
  // A<->C session, C establishes a session to B to withdraw the gift,
  // then calls `getNumber()` on the remote.
  const objectMaker = await peerA.client.enlivenSturdyRef(
    peerA.client.makeSturdyRef(peerB.location, 'ObjectMaker'),
  );
  const objectUser = await peerA.client.enlivenSturdyRef(
    peerA.client.makeSturdyRef(peerC.location, 'ObjectUser'),
  );

  const object = await E(objectMaker).makeObject();
  const number = await E(objectUser).useObject(object);
  t.is(number, 42, 'C invokes Object via a handoff from A and reaches B');
});
