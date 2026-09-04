// @ts-nocheck
import test from '@endo/ses-ava/test.js';

import {
  makeGracefulReader,
  defaultGracefulCodes,
} from '../graceful-reader.js';

/**
 * A reader whose `next()` yields each queued value in turn, then throws the
 * given error (simulating a socket destroyed mid-read).
 *
 * @param {Array<unknown>} values
 * @param {Error} error
 */
const makeThrowingReader = (values, error) => {
  const queue = [...values];
  const reader = {
    next: async () => {
      await null;
      if (queue.length > 0) {
        return { value: queue.shift(), done: false };
      }
      throw error;
    },
    return: async (/** @type {unknown} */ value) => ({ value, done: true }),
    throw: async (/** @type {Error} */ err) => {
      throw err;
    },
    [Symbol.asyncIterator]: () => reader,
  };
  return reader;
};

test('graceful reader converts ERR_STREAM_PREMATURE_CLOSE to done', async t => {
  const err = Error('destroyed');
  err.code = 'ERR_STREAM_PREMATURE_CLOSE';
  const reader = makeGracefulReader(makeThrowingReader([1, 2], err));

  t.deepEqual(await reader.next(), { value: 1, done: false });
  t.deepEqual(await reader.next(), { value: 2, done: false });
  t.deepEqual(await reader.next(), { value: undefined, done: true });
});

test('graceful reader propagates other errors', async t => {
  const err = Error('boom');
  err.code = 'ECONNRESET';
  const reader = makeGracefulReader(makeThrowingReader([], err));

  await t.throwsAsync(() => reader.next(), { message: 'boom' });
});

test('graceful reader propagates errors without a code', async t => {
  const reader = makeGracefulReader(makeThrowingReader([], Error('plain')));
  await t.throwsAsync(() => reader.next(), { message: 'plain' });
});

test('gracefulCodes parameterizes the handled codes', async t => {
  const err = Error('reset');
  err.code = 'ECONNRESET';
  const reader = makeGracefulReader(makeThrowingReader([], err), {
    gracefulCodes: ['ECONNRESET'],
  });
  t.deepEqual(await reader.next(), { value: undefined, done: true });
});

test('custom gracefulCodes no longer treats the default code as graceful', async t => {
  const err = Error('premature');
  err.code = 'ERR_STREAM_PREMATURE_CLOSE';
  const reader = makeGracefulReader(makeThrowingReader([], err), {
    gracefulCodes: ['ECONNRESET'],
  });
  await t.throwsAsync(() => reader.next(), { message: 'premature' });
});

test('defaultGracefulCodes is the documented default', async t => {
  t.deepEqual([...defaultGracefulCodes], ['ERR_STREAM_PREMATURE_CLOSE']);
});

test('return and throw delegate to the underlying reader', async t => {
  const reader = makeGracefulReader(makeThrowingReader([1], Error('x')));
  t.deepEqual(await reader.return('bye'), { value: 'bye', done: true });
  await t.throwsAsync(() => reader.throw(Error('thrown')), {
    message: 'thrown',
  });
});
