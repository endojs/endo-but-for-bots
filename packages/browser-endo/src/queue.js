// @ts-check
/** @import { Reader } from '@endo/stream' */
import { makePromiseKit } from '@endo/promise-kit';

/**
 * A bounded local byte/event queue whose cancellation interrupts pending reads.
 * @template T
 * @param {number} [limit]
 */
export const makeQueue = (limit = 1024) => {
  /** @type {T[]} */
  const values = [];
  /** @type {ReturnType<typeof makePromiseKit<IteratorResult<T>>> | undefined} */
  let pending;
  let ended = false;
  /** @type {Error | undefined} */
  let failure;
  /** @param {Error} [error] */
  const close = (error = undefined) => {
    ended = true;
    failure = error;
    values.length = 0;
    if (pending) {
      if (failure) pending.reject(failure);
      else pending.resolve({ done: true, value: undefined });
      pending = undefined;
    }
  };
  /** @type {Reader<T>} */
  const iterator = harden({
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (failure) return Promise.reject(failure);
      if (values.length)
        return Promise.resolve({
          done: false,
          value: /** @type {T} */ (values.shift()),
        });
      if (ended) return Promise.resolve({ done: true, value: undefined });
      if (pending)
        return Promise.reject(new Error('Concurrent reads are not supported'));
      pending = makePromiseKit();
      return pending.promise;
    },
    async return() {
      close();
      return { done: true, value: undefined };
    },
    async throw(error) {
      close(error);
      throw error;
    },
  });
  return harden({
    iterator,
    close,
    /** @param {T} value */
    push(value) {
      if (ended) throw failure || new Error('Stream is closed');
      if (pending) {
        pending.resolve({ done: false, value });
        pending = undefined;
      } else if (values.length < limit) values.push(value);
      else {
        const error = new Error('Stream buffer limit exceeded');
        close(error);
        throw error;
      }
    },
  });
};
harden(makeQueue);
