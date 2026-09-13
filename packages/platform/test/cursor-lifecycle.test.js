// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeCursorExo } from '../src/fs/extended/shared/cursor-exo.js';

/** @import { DirEntry } from '../src/fs/extended/backend-types.js' */

const makeGate = () => {
  /** @type {(value?: void) => void} */
  let resolve;
  /** @type {Promise<void>} */
  const promise = new Promise(res => {
    resolve = res;
  });
  return { promise, resolve: () => resolve() };
};

const done = harden({ done: /** @type {const} */ (true), value: undefined });
const entry = harden({ name: 'file', kind: /** @type {const} */ ('file') });
const tick = () => new Promise(resolve => setImmediate(resolve));

/** @param {() => AsyncIterator<DirEntry>} makeIterator */
const makeCursor = makeIterator =>
  makeCursorExo({
    backend: { list: () => ({ [Symbol.asyncIterator]: makeIterator }) },
    dirPath: [],
  });

test('close fences queued and new reads while draining an admitted backend pull', async t => {
  t.timeout(5000);
  const entered = makeGate();
  const resumed = makeGate();
  let pulls = 0;
  let returns = 0;
  const cursor = makeCursor(() => ({
    next: async () => {
      pulls += 1;
      entered.resolve();
      await resumed.promise;
      return { done: false, value: entry };
    },
    return: async () => {
      returns += 1;
      return done;
    },
  }));
  t.teardown(async () => {
    resumed.resolve();
    await E(cursor).close();
  });
  const first = E(cursor).read(1n);
  await entered.promise;
  const queued = E(cursor).toArray();
  const closing = E(cursor).close();
  let closed = false;
  void closing.then(() => {
    closed = true;
  });
  await tick();
  t.false(closed);
  t.is(returns, 0);
  await E(cursor).skip(2n);
  await E(cursor).rewind();
  resumed.resolve();
  await closing;
  t.deepEqual(await first, { entries: [], atEnd: true });
  t.deepEqual(await queued, []);
  t.deepEqual(await E(cursor).read(1n), { entries: [], atEnd: true });
  t.is(pulls, 1);
  t.is(returns, 1);
});

test('concurrent cursor consumers serialize backend pulls', async t => {
  t.timeout(5000);
  let active = 0;
  let maxActive = 0;
  let count = 0;
  const cursor = makeCursor(() => ({
    next: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick();
      active -= 1;
      count += 1;
      return { done: false, value: { ...entry, name: String(count) } };
    },
    return: async () => done,
  }));
  t.teardown(() => E(cursor).close());
  const reader = iterateReader(await E(cursor).stream());
  const [page, step] = await Promise.all([E(cursor).read(1n), reader.next()]);
  t.is(maxActive, 1);
  t.is(count, 2);
  t.false(step.done);
  t.notDeepEqual(page.entries[0], step.value);
  await reader.return();
});

test('failed listing release remains owned and close retries it', async t => {
  let returns = 0;
  const cursor = makeCursor(() => ({
    next: async () => ({ done: false, value: entry }),
    return: async () => {
      returns += 1;
      if (returns === 1) throw Error('Directory release failed');
      return done;
    },
  }));
  t.teardown(() => E(cursor).close());
  await E(cursor).read(1n);
  await t.throwsAsync(E(cursor).close(), {
    message: /Directory release failed/,
  });
  await E(cursor).close();
  await E(cursor).close();
  t.is(returns, 2);
});

test('stream return before its first pull releases an already opened listing', async t => {
  let returns = 0;
  const cursor = makeCursor(() => ({
    next: async () => ({ done: false, value: entry }),
    return: async () => {
      returns += 1;
      return done;
    },
  }));
  t.teardown(() => E(cursor).close());
  await E(cursor).read(1n);
  const reader = iterateReader(await E(cursor).stream());
  await reader.return();
  t.is(returns, 1);
  t.deepEqual(await E(cursor).read(1n), { entries: [], atEnd: true });
});

test('failed stream termination can be retried through cursor close', async t => {
  let returns = 0;
  const cursor = makeCursor(() => ({
    next: async () => ({ done: false, value: entry }),
    return: async () => {
      returns += 1;
      if (returns === 1) throw Error('Stream release failed');
      return done;
    },
  }));
  t.teardown(() => E(cursor).close());
  const reader = iterateReader(await E(cursor).stream());
  await reader.next();
  await t.throwsAsync(reader.return(), { message: /Stream release failed/ });
  await E(cursor).close();
  t.is(returns, 2);
});

test('rewind retains failed cleanup and stale streams cannot reach its successor', async t => {
  let listings = 0;
  const returns = [0, 0];
  const pulls = [0, 0];
  const cursor = makeCursor(() => {
    const index = listings;
    listings += 1;
    return {
      next: async () => {
        pulls[index] += 1;
        return { done: false, value: entry };
      },
      return: async () => {
        returns[index] += 1;
        if (index === 0 && returns[index] === 1)
          throw Error('Rewind release failed');
        return done;
      },
    };
  });
  t.teardown(() => E(cursor).close());
  const stale = iterateReader(await E(cursor).stream());
  await stale.next();
  await t.throwsAsync(E(cursor).rewind(), { message: /Rewind release failed/ });
  t.deepEqual(await E(cursor).read(1n), { entries: [], atEnd: true });
  t.is(listings, 1);
  await E(cursor).rewind();
  await E(cursor).read(1n);
  await stale.return();
  t.deepEqual(await stale.next(), done);
  t.deepEqual(pulls, [1, 1]);
  t.deepEqual(returns, [2, 0]);
});

test('close during rewind does not publish another listing', async t => {
  t.timeout(5000);
  const entered = makeGate();
  const released = makeGate();
  let listings = 0;
  let returns = 0;
  const cursor = makeCursor(() => {
    listings += 1;
    return {
      next: async () => ({ done: false, value: entry }),
      return: async () => {
        returns += 1;
        entered.resolve();
        await released.promise;
        return done;
      },
    };
  });
  t.teardown(async () => {
    released.resolve();
    await E(cursor).close();
  });
  await E(cursor).read(1n);
  const rewinding = E(cursor).rewind();
  await entered.promise;
  const closing = E(cursor).close();
  released.resolve();
  await Promise.all([rewinding, closing]);
  t.deepEqual(await E(cursor).toArray(), []);
  t.is(listings, 1);
  t.is(returns, 1);
});

test('unfinished backend return keeps rewind owned until a completed retry', async t => {
  let listings = 0;
  const returns = [0, 0];
  const pulls = [0, 0];
  const cursor = makeCursor(() => {
    const index = listings;
    listings += 1;
    return {
      next: async () => {
        pulls[index] += 1;
        return { done: false, value: entry };
      },
      return: async () => {
        returns[index] += 1;
        if (index === 0 && returns[index] === 1) {
          return { done: false, value: entry };
        }
        return done;
      },
    };
  });
  t.teardown(() => E(cursor).close());
  const stale = iterateReader(await E(cursor).stream());
  await stale.next();
  await t.throwsAsync(E(cursor).rewind(), {
    message: /listing cleanup has not completed/,
  });
  t.is(listings, 1);
  t.deepEqual(await E(cursor).read(1n), { entries: [], atEnd: true });
  t.deepEqual(pulls, [1, 0]);
  await E(cursor).rewind();
  await E(cursor).read(1n);
  await stale.return();
  t.deepEqual(await stale.next(), done);
  t.is(listings, 2);
  t.deepEqual(pulls, [1, 1]);
  t.deepEqual(returns, [2, 0]);
});
