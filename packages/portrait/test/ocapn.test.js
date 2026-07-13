// @ts-check
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { M } from '@endo/patterns';
import { makeOcapn, getSturdyRefDetails, isSturdyRef } from '@endo/ocapn';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';

import {
  makePersistenceEnv,
  definePersistentExoClass,
  makePersistentHeap,
  makeMemoryPortraitStore,
} from '../index.js';
import {
  makeOcapnSpecials,
  makeHeapLocator,
  provideSturdyRefBinding,
} from '../src/ocapn.js';

/**
 * Spawn an ocapn client whose locator resolves through a (possibly
 * still-booting) portrait heap.
 *
 * @param {string} debugLabel
 * @param {{ get: (secret: string | Uint8Array) => unknown }} locator
 */
const makeClient = async (debugLabel, locator) => {
  /** @type {{ netlayer?: any }} */
  const netlayerRef = {};
  const client = await makeOcapn({
    codec: syrupCodec,
    debugLabel,
    locator,
    network: (handlers, logger) =>
      makeTcpNetLayer({
        handlers,
        logger,
        specifiedDesignator: debugLabel,
      }).then(netlayer => {
        netlayerRef.netlayer = netlayer;
        return netlayer;
      }),
  });
  return { client, location: netlayerRef.netlayer.location };
};

const GreeterI = M.interface('Greeter', {
  greet: M.call(M.string()).returns(M.string()),
  greetCount: M.call().returns(M.number()),
});

/** @param {import('../src/types.js').PersistenceEnv} env */
const defineGreeter = env =>
  definePersistentExoClass(
    env,
    'portrait-ocapn-test#makeGreeter',
    GreeterI,
    ownName => ({ ownName, greeted: 0 }),
    {
      /** @param {string} theirName */
      greet(theirName) {
        this.state.greeted += 1;
        return `Hello ${theirName}, my name is ${this.state.ownName}`;
      },
      greetCount() {
        return this.state.greeted;
      },
    },
  );

test('sturdyref-bound object survives host restart over ocapn', async t => {
  const store = makeMemoryPortraitStore();
  const secretText = 'greeter-of-record';

  // ---- First host incarnation -------------------------------------
  /** @type {string} */
  let refExchangeSecret;
  {
    const env = makePersistenceEnv();
    const makeGreeter = defineGreeter(env);
    const specialsKit = makeOcapnSpecials();
    const heapKit = makePromiseKit();
    const { client: host, location: hostLocation } = await makeClient(
      'host',
      makeHeapLocator(/** @type {any} */ (heapKit.promise)),
    );
    specialsKit.connect(host);
    const heap = await makePersistentHeap({
      env,
      store,
      specials: specialsKit.specials,
      spawnRoots: () => harden({ greeter: makeGreeter('alice') }),
    });
    heapKit.resolve(heap);

    const sturdyRef = await provideSturdyRefBinding(
      heap,
      host,
      hostLocation,
      heap.roots.greeter,
      { secret: secretText },
    );
    t.true(isSturdyRef(sturdyRef));
    refExchangeSecret = /** @type {any} */ (
      getSturdyRefDetails(sturdyRef)
    ).secret;
    t.is(refExchangeSecret, secretText);

    // A guest fetches through the wire and calls.
    const { client: guest } = await makeClient('guest', new Map());
    const guestRef = guest.makeSturdyRef(hostLocation, secretText);
    const remoteGreeter = await guest.enlivenSturdyRef(guestRef);
    t.is(await E(remoteGreeter).greet('bob'), 'Hello bob, my name is alice');
    t.is(await E(remoteGreeter).greet('carol'), 'Hello carol, my name is alice');

    guest.shutdown();
    host.shutdown();
    await heap.close();
  }

  // ---- Second host incarnation: same store, fresh everything ------
  {
    const env = makePersistenceEnv();
    defineGreeter(env);
    const specialsKit = makeOcapnSpecials();
    const heapKit = makePromiseKit();
    const { client: host, location: hostLocation } = await makeClient(
      'host2',
      makeHeapLocator(/** @type {any} */ (heapKit.promise)),
    );
    specialsKit.connect(host);
    const heap = await makePersistentHeap({
      env,
      store,
      specials: specialsKit.specials,
      spawnRoots: () => {
        t.fail('host restart must restore, not respawn');
        return harden({});
      },
    });
    heapKit.resolve(heap);

    // The durable authority is the secret: a guest holding the same
    // secret reaches the same (revived) object with its state intact.
    const { client: guest } = await makeClient('guest2', new Map());
    const guestRef = guest.makeSturdyRef(hostLocation, secretText);
    const remoteGreeter = await guest.enlivenSturdyRef(guestRef);
    t.is(
      await E(remoteGreeter).greetCount(),
      2,
      'state mutated over ocapn in the previous incarnation survived',
    );
    t.is(await E(remoteGreeter).greet('dave'), 'Hello dave, my name is alice');

    guest.shutdown();
    host.shutdown();
    await heap.close();
  }
});

test('sturdyrefs held in persistent state portray and revive', async t => {
  const store = makeMemoryPortraitStore();
  const BoxI = M.interface('RefBox', {
    put: M.call(M.any()).returns(),
    take: M.call().returns(M.any()),
  });
  /** @param {import('../src/types.js').PersistenceEnv} env */
  const defineBox = env =>
    definePersistentExoClass(
      env,
      'portrait-ocapn-test#makeRefBox',
      BoxI,
      () => ({ ref: undefined }),
      {
        put(ref) {
          this.state.ref = ref;
        },
        take() {
          return this.state.ref;
        },
      },
    );

  /** @type {any} */
  let peerLocation;
  {
    const env = makePersistenceEnv();
    const makeBox = defineBox(env);
    const specialsKit = makeOcapnSpecials();
    const { client } = await makeClient('holder', new Map());
    specialsKit.connect(client);
    const heap = await makePersistentHeap({
      env,
      store,
      specials: specialsKit.specials,
      spawnRoots: () => harden({ box: makeBox() }),
    });
    const { client: peer, location } = await makeClient('peer', new Map());
    peerLocation = location;
    // Store a sturdyref to some third-party object in persistent state.
    heap.roots.box.put(client.makeSturdyRef(location, 'some-far-object'));
    await heap.flush();
    peer.shutdown();
    client.shutdown();
    await heap.close();
  }

  {
    const env = makePersistenceEnv();
    defineBox(env);
    const specialsKit = makeOcapnSpecials();
    const { client } = await makeClient('holder2', new Map());
    specialsKit.connect(client);
    const heap = await makePersistentHeap({
      env,
      store,
      specials: specialsKit.specials,
      spawnRoots: () => harden({}),
    });
    const revived = heap.roots.box.take();
    t.true(isSturdyRef(revived), 'revived as a live sturdyref');
    const details = /** @type {any} */ (getSturdyRefDetails(revived));
    t.is(details.secret, 'some-far-object');
    t.is(details.location.designator, peerLocation.designator);
    client.shutdown();
    await heap.close();
  }
});

test('live remote presences in state are rejected at capture', async t => {
  const store = makeMemoryPortraitStore();
  const env = makePersistenceEnv();
  const BoxI = M.interface('RefBox', {
    put: M.call(M.any()).returns(),
  });
  const makeBox = definePersistentExoClass(
    env,
    'portrait-ocapn-test#makeLeakBox',
    BoxI,
    () => ({ ref: undefined }),
    {
      put(ref) {
        this.state.ref = ref;
      },
    },
  );

  const objects = new Map();
  const { makeExo } = await import('@endo/exo');
  objects.set('thing', makeExo('Thing', undefined, {}));
  const { client: server, location } = await makeClient('server', objects);
  const { client: caller } = await makeClient('caller', new Map());

  const heap = await makePersistentHeap({
    env,
    store,
    persistOn: 'manual',
    spawnRoots: () => harden({ box: makeBox() }),
  });
  const ref = caller.makeSturdyRef(location, 'thing');
  const presence = await caller.enlivenSturdyRef(ref);
  heap.roots.box.put(presence);
  await t.throwsAsync(async () => heap.flush(), {
    message: /non-persistent remotable/,
  });

  caller.shutdown();
  server.shutdown();
  await heap.close().catch(() => {});
});
