// @ts-check
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { M } from '@endo/patterns';

import {
  makePersistenceEnv,
  definePersistentExoClass,
  makePersistentHeap,
  makeMemoryPortraitStore,
} from '../index.js';

const AccountI = M.interface('Account', {
  balance: M.call().returns(M.number()),
  deposit: M.call(M.number()).returns(),
  transferTo: M.call(M.remotable(), M.number()).returns(),
});

const makeWorld = () => {
  const env = makePersistenceEnv();
  const makeAccount = definePersistentExoClass(
    env,
    'rollback-test#makeAccount',
    AccountI,
    (start = 0) => ({ balance: start }),
    {
      balance() {
        return this.state.balance;
      },
      /** @param {number} amount */
      deposit(amount) {
        this.state.balance += amount;
      },
      /**
       * Deliberately mutates self before validating, so a failed
       * transfer tears state without turn rollback.
       *
       * @param {any} other
       * @param {number} amount
       */
      transferTo(other, amount) {
        this.state.balance -= amount;
        const balance = /** @type {number} */ (this.state.balance);
        if (balance < 0) {
          throw RangeError('insufficient funds');
        }
        other.deposit(amount);
      },
    },
  );
  return { env, makeAccount };
};

test('turn: throw rolls back all persistent mutations', async t => {
  const { env, makeAccount } = makeWorld();
  const store = makeMemoryPortraitStore();
  const heap = await makePersistentHeap({
    env,
    store,
    persistOn: 'manual',
    spawnRoots: () => harden({ a: makeAccount(10), b: makeAccount(0) }),
  });
  const { a, b } = heap.roots;

  // Success path commits.
  heap.turn(() => a.transferTo(b, 4));
  t.is(a.balance(), 6);
  t.is(b.balance(), 4);

  // Failure path: the tearing mutation (balance already debited)
  // reverts, on both parties.
  t.throws(() => heap.turn(() => a.transferTo(b, 100)), {
    instanceOf: RangeError,
    message: /insufficient funds/,
  });
  t.is(a.balance(), 6, 'debit rolled back');
  t.is(b.balance(), 4, 'credit rolled back');
  await heap.close();
});

test('turn: nesting rolls back inner without disturbing outer', async t => {
  const { env, makeAccount } = makeWorld();
  const store = makeMemoryPortraitStore();
  const heap = await makePersistentHeap({
    env,
    store,
    persistOn: 'manual',
    spawnRoots: () => harden({ a: makeAccount(0) }),
  });
  const { a } = heap.roots;

  heap.turn(() => {
    a.deposit(1);
    t.throws(() =>
      heap.turn(() => {
        a.deposit(100);
        throw Error('inner fails');
      }),
    );
    t.is(a.balance(), 1, 'inner rollback preserves outer write');
    a.deposit(2);
  });
  t.is(a.balance(), 3, 'outer commits');

  t.throws(() =>
    heap.turn(() => {
      a.deposit(10);
      heap.turn(() => a.deposit(20));
      throw Error('outer fails after inner commit');
    }),
  );
  t.is(a.balance(), 3, 'outer rollback also reverts inner-committed writes');
  await heap.close();
});

test('turn: async bodies are rejected and rolled back', async t => {
  const { env, makeAccount } = makeWorld();
  const store = makeMemoryPortraitStore();
  const heap = await makePersistentHeap({
    env,
    store,
    persistOn: 'manual',
    spawnRoots: () => harden({ a: makeAccount(0) }),
  });
  const { a } = heap.roots;
  t.throws(
    () =>
      heap.turn(async () => {
        a.deposit(5);
      }),
    { message: /requires a synchronous fn/ },
  );
  t.is(a.balance(), 0, 'mutations before the rejection rolled back');
  await heap.close();
});

test('steady state persists as deltas, not full graphs', async t => {
  const { env, makeAccount } = makeWorld();
  const store = makeMemoryPortraitStore();
  const heap = await makePersistentHeap({
    env,
    store,
    persistOn: 'manual',
    spawnRoots: () => harden({ a: makeAccount(0), b: makeAccount(0) }),
  });
  const { a } = heap.roots;
  a.deposit(1);
  await heap.flush();
  a.deposit(1);
  await heap.flush();

  const generations = store.getGenerations();
  t.deepEqual(
    generations.map(g => g.type),
    ['graph', 'delta', 'delta'],
  );
  const lastDelta = /** @type {any} */ (generations[2]);
  t.is(
    Object.keys(lastDelta.delta.portraits).length,
    1,
    'only the dirty account is re-portrayed',
  );
  await heap.close();
});

test('persistOn auto flushes at a microtask boundary', async t => {
  const { env, makeAccount } = makeWorld();
  const store = makeMemoryPortraitStore();
  const heap = await makePersistentHeap({
    env,
    store,
    spawnRoots: () => harden({ a: makeAccount(0) }),
  });
  heap.roots.a.deposit(42);
  t.is(store.getGenerations().length, 1, 'not yet flushed synchronously');
  // Drain microtasks and the write chain.
  await heap.flush();
  const generations = store.getGenerations();
  t.true(generations.length >= 2, 'auto flush appended a delta');
  const merged = await store.graphAndSlots();
  t.regex(
    JSON.stringify(merged),
    /42/,
    'the mutation reached the store without an explicit flush',
  );
  await heap.close();
});

test('flush during a turn is refused', async t => {
  const { env, makeAccount } = makeWorld();
  const store = makeMemoryPortraitStore();
  const heap = await makePersistentHeap({
    env,
    store,
    persistOn: 'manual',
    spawnRoots: () => harden({ a: makeAccount(0) }),
  });
  t.throws(
    () =>
      heap.turn(() => {
        heap.roots.a.deposit(1);
        heap.flush();
      }),
    { message: /cannot flush during a turn/ },
  );
  t.is(heap.roots.a.balance(), 0, 'refused flush still rolled back');
  await heap.close();
});
