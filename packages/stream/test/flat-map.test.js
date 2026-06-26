// @ts-check
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';

import { flatMapReader, makePipe } from '../index.js';

/**
 * Build a reader over an array of groups that records the index of every pull,
 * so tests can assert that the upstream is read lazily (only when the current
 * group is exhausted).
 *
 * @template T
 * @param {Array<T>} groups
 */
const makeRecordingReader = groups => {
  let index = 0;
  /** @type {Array<number>} */
  const pulls = [];
  let returned = false;
  const reader = /** @type {import('../types.js').Reader<T>} */ (
    harden({
      async next() {
        await null;
        pulls.push(index);
        if (index < groups.length) {
          const value = groups[index];
          index += 1;
          return { done: false, value };
        }
        return { done: true, value: undefined };
      },
      /** @param {unknown} value */
      async return(value) {
        await null;
        returned = true;
        return { done: true, value };
      },
      /** @param {Error} error */
      async throw(error) {
        await null;
        throw error;
      },
      [Symbol.asyncIterator]() {
        return reader;
      },
    })
  );
  return { reader, pulls, wasReturned: () => returned };
};

test('flatten a reader of arrays via the identity transform', async (/** @type {import('ava').Assertions} */ t) => {
  const [reader, writer] = makePipe();
  const flat = flatMapReader(
    reader,
    (/** @type {Array<number>} */ group) => group,
  );

  const produce = async () => {
    await null;
    for (const group of [[1, 2], [3], [4, 5, 6]]) {
      // eslint-disable-next-line no-await-in-loop
      await writer.next(group);
    }
    await writer.return(undefined);
  };

  const consume = async () => {
    await null;
    /** @type {Array<number>} */
    const received = [];
    for await (const value of flat) {
      received.push(value);
    }
    return received;
  };

  const [received] = await Promise.all([consume(), produce()]);
  t.deepEqual(received, [1, 2, 3, 4, 5, 6]);
});

test('map one value to many', async (/** @type {import('ava').Assertions} */ t) => {
  const [reader, writer] = makePipe();
  const flat = flatMapReader(reader, (/** @type {number} */ n) => [n, n * 10]);

  const produce = async () => {
    await null;
    for (const n of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      await writer.next(n);
    }
    await writer.return(undefined);
  };

  const consume = async () => {
    await null;
    /** @type {Array<number>} */
    const received = [];
    for await (const value of flat) {
      received.push(value);
    }
    return received;
  };

  const [received] = await Promise.all([consume(), produce()]);
  t.deepEqual(received, [1, 10, 2, 20, 3, 30]);
});

test('empty groups advance to the next source value', async (/** @type {import('ava').Assertions} */ t) => {
  const [reader, writer] = makePipe();
  const flat = flatMapReader(
    reader,
    (/** @type {Array<number>} */ group) => group,
  );

  const produce = async () => {
    await null;
    for (const group of [[], [1], [], [], [2, 3], []]) {
      // eslint-disable-next-line no-await-in-loop
      await writer.next(group);
    }
    await writer.return(undefined);
  };

  const consume = async () => {
    await null;
    /** @type {Array<number>} */
    const received = [];
    for await (const value of flat) {
      received.push(value);
    }
    return received;
  };

  const [received] = await Promise.all([consume(), produce()]);
  t.deepEqual(received, [1, 2, 3]);
});

test('an async-iterable transform is flattened', async (/** @type {import('ava').Assertions} */ t) => {
  const [reader, writer] = makePipe();
  async function* expand(/** @type {number} */ n) {
    await null;
    yield n;
    yield n + 0.5;
  }
  const flat = flatMapReader(reader, expand);

  const produce = async () => {
    await null;
    for (const n of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop
      await writer.next(n);
    }
    await writer.return(undefined);
  };

  const consume = async () => {
    await null;
    /** @type {Array<number>} */
    const received = [];
    for await (const value of flat) {
      received.push(value);
    }
    return received;
  };

  const [received] = await Promise.all([consume(), produce()]);
  t.deepEqual(received, [1, 1.5, 2, 2.5]);
});

test('upstream throw propagates to the consumer', async (/** @type {import('ava').Assertions} */ t) => {
  const [reader, writer] = makePipe();
  const flat = flatMapReader(
    reader,
    (/** @type {Array<number>} */ group) => group,
  );

  const produce = async () => {
    await null;
    await writer.next([1, 2]);
    await writer.throw(Error('Exit early'));
  };

  const consume = async () => {
    await null;
    /** @type {Array<number>} */
    const received = [];
    try {
      for await (const value of flat) {
        received.push(value);
      }
      t.fail('expected the consumer to observe the thrown error');
    } catch (error) {
      t.is(/** @type {Error} */ (error).message, 'Exit early');
    }
    return received;
  };

  const [received] = await Promise.all([consume(), produce()]);
  t.deepEqual(received, [1, 2]);
});

test('consumer return propagates termination upstream', async (/** @type {import('ava').Assertions} */ t) => {
  const { reader, wasReturned } = makeRecordingReader([
    [1, 2],
    [3, 4],
  ]);
  const flat = flatMapReader(
    reader,
    (/** @type {Array<number>} */ group) => group,
  );

  await null;
  t.deepEqual(await flat.next(undefined), { done: false, value: 1 });
  // Returning the flattening reader while suspended mid-group must close the
  // upstream reader.
  t.deepEqual(await flat.return(undefined), { done: true, value: undefined });
  t.true(wasReturned());
});

test('the upstream is pulled lazily, one group at a time', async (/** @type {import('ava').Assertions} */ t) => {
  const { reader, pulls } = makeRecordingReader([
    [10, 20],
    [30],
  ]);
  const flat = flatMapReader(
    reader,
    (/** @type {Array<number>} */ group) => group,
  );

  await null;
  // First element of the first group: exactly one upstream pull so far.
  t.deepEqual(await flat.next(undefined), { done: false, value: 10 });
  t.is(pulls.length, 1);

  // Second element of the same group: still no further upstream pull.
  t.deepEqual(await flat.next(undefined), { done: false, value: 20 });
  t.is(pulls.length, 1);

  // The group is now exhausted, so the next read pulls the next group.
  t.deepEqual(await flat.next(undefined), { done: false, value: 30 });
  t.is(pulls.length, 2);

  // Draining the last group pulls once more and observes upstream completion.
  t.deepEqual(await flat.next(undefined), { done: true, value: undefined });
  t.is(pulls.length, 3);
});
