// @ts-check
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { M } from '@endo/patterns';

import {
  makePersistenceEnv,
  definePersistentExoClass,
  definePersistentExoClassKit,
  makePersistentHeap,
  makeMemoryPortraitStore,
} from '../index.js';
import { cellEnv, makeValueCell } from '../src/cell.js';

const CounterI = M.interface('Counter', {
  increment: M.call().returns(M.number()),
  count: M.call().returns(M.number()),
});

const FriendI = M.interface('Friend', {
  befriend: M.call(M.any()).returns(),
  friend: M.call().returns(M.any()),
  name: M.call().returns(M.string()),
});

/**
 * Build a fresh env with the standard test classes registered.
 * Class definitions register into an env, so each heap "process
 * incarnation" needs a fresh env + fresh definitions, exactly as a
 * real restart re-evaluates the defining modules.
 */
const makeTestWorld = () => {
  const env = makePersistenceEnv({ extend: [cellEnv] });
  const makeCounter = definePersistentExoClass(
    env,
    'portrait-test#makeCounter',
    CounterI,
    (start = 0) => ({ count: start }),
    {
      increment() {
        this.state.count += 1;
        return this.state.count;
      },
      count() {
        return this.state.count;
      },
    },
  );
  const makeFriend = definePersistentExoClass(
    env,
    'portrait-test#makeFriend',
    FriendI,
    name => ({ name, friend: undefined }),
    {
      befriend(other) {
        this.state.friend = other;
      },
      friend() {
        return this.state.friend;
      },
      name() {
        return this.state.name;
      },
    },
  );
  return { env, makeCounter, makeFriend };
};

test('counter round trip through restart', async t => {
  const store = makeMemoryPortraitStore();

  {
    const { env, makeCounter } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({ counter: makeCounter(3) }),
    });
    const { counter } = /** @type {any} */ (heap.roots);
    t.is(counter.increment(), 4);
    t.is(counter.increment(), 5);
    await heap.flush();
    await heap.close();
  }

  {
    const { env, makeCounter } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => {
        t.fail('spawnRoots must not run when a stored graph exists');
        return harden({ counter: makeCounter(0) });
      },
    });
    const { counter } = /** @type {any} */ (heap.roots);
    t.is(counter.count(), 5);
    t.is(counter.increment(), 6);
    await heap.close();
  }
});

test('cyclic near references restore with identity preserved', async t => {
  const store = makeMemoryPortraitStore();

  {
    const { env, makeFriend } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => {
        const alice = makeFriend('alice');
        const bob = makeFriend('bob');
        alice.befriend(bob);
        bob.befriend(alice);
        return harden({ alice, bob });
      },
    });
    await heap.flush();
    await heap.close();
  }

  {
    const { env } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({}),
    });
    const { alice, bob } = /** @type {any} */ (heap.roots);
    t.is(alice.name(), 'alice');
    t.is(bob.name(), 'bob');
    t.is(alice.friend(), bob, 'cycle back-edge resolves to same instance');
    t.is(bob.friend(), alice);
    await heap.close();
  }
});

test('mutation after restore persists transitively', async t => {
  const store = makeMemoryPortraitStore();

  {
    const { env, makeFriend } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({ alice: makeFriend('alice') }),
    });
    await heap.close();
  }

  {
    const { env, makeFriend } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({}),
    });
    const { alice } = /** @type {any} */ (heap.roots);
    // A brand-new instance reachable only through a post-restore
    // mutation must be adopted and persisted transitively.
    alice.befriend(makeFriend('carol'));
    await heap.flush();
    await heap.close();
  }

  {
    const { env } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({}),
    });
    const { alice } = /** @type {any} */ (heap.roots);
    t.is(alice.friend().name(), 'carol');
    await heap.close();
  }
});

test('unresolved promises break across persistence', async t => {
  const store = makeMemoryPortraitStore();

  {
    const { env } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({ box: makeValueCell(new Promise(() => {})) }),
    });
    await heap.flush();
    await heap.close();
  }

  {
    const env = makePersistenceEnv({ extend: [cellEnv] });
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({}),
    });
    const { box } = /** @type {any} */ (heap.roots);
    await t.throwsAsync(() => box.get(), {
      message: /did not survive persistence/,
    });
    await heap.close();
  }
});

test('class version upgrade steps run on restore', async t => {
  const store = makeMemoryPortraitStore();

  {
    const env = makePersistenceEnv();
    // v0: temperature stored in fahrenheit.
    const makeThermostat = definePersistentExoClass(
      env,
      'portrait-test#makeThermostat',
      M.interface('Thermostat', { read: M.call().returns(M.number()) }),
      fahrenheit => ({ fahrenheit }),
      {
        read() {
          return this.state.fahrenheit;
        },
      },
    );
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({ thermostat: makeThermostat(212) }),
    });
    await heap.close();
  }

  {
    const env = makePersistenceEnv();
    // v1: celsius, upgraded from the v0 fahrenheit depiction.
    definePersistentExoClass(
      env,
      'portrait-test#makeThermostat',
      M.interface('Thermostat', { read: M.call().returns(M.number()) }),
      celsius => ({ celsius }),
      {
        read() {
          return this.state.celsius;
        },
      },
      {
        version: 1,
        upgrade: harden({
          0: old =>
            harden({
              celsius:
                ((/** @type {any} */ (old).fahrenheit - 32) * 5) / 9,
            }),
        }),
      },
    );
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({}),
    });
    const { thermostat } = /** @type {any} */ (heap.roots);
    t.is(thermostat.read(), 100);
    await heap.close();
  }
});

test('roots version upgrade reshapes roots once', async t => {
  const store = makeMemoryPortraitStore();

  {
    const { env, makeCounter } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      version: 0,
      spawnRoots: () => harden({ counter: makeCounter(7) }),
    });
    await heap.close();
  }

  {
    const { env, makeCounter } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      version: 1,
      spawnRoots: () => harden({}),
      upgradeRoots: (storedVersion, roots) => {
        t.is(storedVersion, 0);
        return harden({
          counters: [/** @type {any} */ (roots).counter, makeCounter(0)],
        });
      },
    });
    const { counters } = /** @type {any} */ (heap.roots);
    t.is(counters[0].count(), 7);
    await heap.close();
  }

  {
    const { env } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      version: 1,
      spawnRoots: () => harden({}),
    });
    const { counters } = /** @type {any} */ (heap.roots);
    t.is(counters.length, 2);
    t.is(counters[0].count(), 7);
    await heap.close();
  }
});

test('restore refuses classes missing from the env', async t => {
  const store = makeMemoryPortraitStore();

  {
    const { env, makeCounter } = makeTestWorld();
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({ counter: makeCounter(1) }),
    });
    await heap.close();
  }

  const emptyEnv = makePersistenceEnv();
  await t.throwsAsync(
    () =>
      makePersistentHeap({
        env: emptyEnv,
        store,
        spawnRoots: () => harden({}),
      }),
    { message: /no class registered for "portrait-test#makeCounter"/ },
  );
});

test('takeSnapshot drops orphaned portraits', async t => {
  const store = makeMemoryPortraitStore();
  const { env, makeFriend } = makeTestWorld();
  const heap = await makePersistentHeap({
    env,
    store,
    spawnRoots: () => {
      const alice = makeFriend('alice');
      alice.befriend(makeFriend('bob'));
      return harden({ alice });
    },
  });
  const { alice } = /** @type {any} */ (heap.roots);
  const graphBefore = await store.graphAndSlots();
  t.is(
    Object.keys(/** @type {any} */ (graphBefore).portraits).length,
    2,
    'alice and bob both stored',
  );
  alice.befriend(undefined);
  await heap.takeSnapshot();
  const graphAfter = await store.graphAndSlots();
  t.is(
    Object.keys(/** @type {any} */ (graphAfter).portraits).length,
    1,
    'bob orphaned and swept',
  );
  await heap.close();
});

test('non-persistent remotables are rejected with a clear error', async t => {
  const store = makeMemoryPortraitStore();
  const { env } = makeTestWorld();
  const { makeExo } = await import('@endo/exo');
  const alien = makeExo('Alien', undefined, {});
  await t.throwsAsync(
    () =>
      makePersistentHeap({
        env,
        store,
        spawnRoots: () => harden({ alien }),
      }),
    { message: /non-persistent remotable/ },
  );
});

test('kits: facets share state and restore per-facet identity', async t => {
  const store = makeMemoryPortraitStore();

  const defineKit = env =>
    definePersistentExoClassKit(
      env,
      'portrait-test#makeCounterKit',
      harden({
        up: M.interface('Up', { incr: M.call().returns(M.number()) }),
        down: M.interface('Down', { decr: M.call().returns(M.number()) }),
      }),
      (start = 0) => ({ count: start }),
      {
        up: {
          incr() {
            this.state.count += 1;
            return this.state.count;
          },
        },
        down: {
          decr() {
            this.state.count -= 1;
            return this.state.count;
          },
        },
      },
    );

  {
    const env = makePersistenceEnv({ extend: [cellEnv] });
    const makeCounterKit = defineKit(env);
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => {
        const { up, down } = makeCounterKit(10);
        // Persist the two facets through different paths.
        return harden({ up, downBox: makeValueCell(down) });
      },
    });
    const { up } = /** @type {any} */ (heap.roots);
    t.is(up.incr(), 11);
    await heap.flush();
    await heap.close();
  }

  {
    const env = makePersistenceEnv({ extend: [cellEnv] });
    defineKit(env);
    const heap = await makePersistentHeap({
      env,
      store,
      spawnRoots: () => harden({}),
    });
    const { up, downBox } = /** @type {any} */ (heap.roots);
    const down = downBox.get();
    t.is(up.incr(), 12, 'facet state survived');
    t.is(down.decr(), 11, 'other facet shares the same cell');
    await heap.close();
  }
});

test('env composition: extended envs resolve, local shadows', async t => {
  const base = makePersistenceEnv();
  const env = makePersistenceEnv({ extend: [base, cellEnv] });
  t.true(env.has('@endo/portrait/cell.js#makeValueCell'));
  t.false(env.has('nope#nothing'));
  t.throws(
    () => {
      definePersistentExoClass(
        cellEnv,
        '@endo/portrait/cell.js#makeValueCell',
        undefined,
        () => ({}),
        {},
      );
    },
    { message: /already has a class named/ },
  );
});
