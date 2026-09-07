// @ts-check

import harden from '@endo/harden';
import { makePromiseKit } from '@endo/promise-kit';
import { makeStream } from '@endo/stream';

/** @import { AsyncQueue } from '@endo/stream' */
/** @import { Topic } from './types.js' */

// TypeScript ReadOnly semantics are not sufficiently expressive to distinguish
// a value one promises not to alter from a value one must not alter,
// making it useless.
const freeze = /** @type {<T>(v: T | Readonly<T>) => T} */ (Object.freeze);

/**
 * @template TValue TValue
 * @param {TValue} value
 * @returns {AsyncQueue<TValue, unknown>}
 */
export const makeNullQueue = value =>
  harden({
    put: () => {},
    get: async () => value,
  });

export const nullIteratorQueue = makeNullQueue(
  harden({ value: undefined, done: false }),
);

/**
 * @template TValue
 */
export const makeChangePubSub = () => {
  // Request pubsub async queue internals
  let { promise: tailPromise, resolve: tailResolve } = makePromiseKit();

  const sink = {
    /**
     * @param {TValue} value
     */
    put: value => {
      const { resolve, promise } = makePromiseKit();
      tailResolve(freeze({ value, promise }));
      tailResolve = resolve;
      // Unlike a queue, advance the read head for future subscribers.
      tailPromise = promise;
    },
  };

  const makeSpring = () => {
    // Capture the read head for the next published value.
    let cursor = tailPromise;
    return {
      get: () => {
        const promise = cursor.then(next => next.value);
        cursor = cursor.then(next => next.promise);
        return harden(promise);
      },
    };
  };

  return harden({ sink, makeSpring });
};
harden(makeChangePubSub);

/**
 * @template T
 * @param {Promise<T>} pull
 * @param {{ resolve: ((value: T | PromiseLike<T>) => void) | undefined }} cell
 */
const observePull = (pull, cell) => {
  pull.then(
    value => cell.resolve?.(value),
    error => {
      if (cell.resolve) cell.resolve(Promise.reject(error));
    },
  );
};

/**
 * @template TValue
 * @returns {Topic<TValue>}
 */
export const makeChangeTopic = () => {
  /** @typedef {IteratorResult<TValue, undefined>} Result */
  /** @type {ReturnType<makeChangePubSub<Result>>} */
  const { sink, makeSpring } = makeChangePubSub();
  return harden({
    publisher: makeStream(nullIteratorQueue, sink),
    subscribe: () => {
      /** @type {ReturnType<typeof makeSpring> | undefined} */
      let spring = makeSpring();
      /** @type {Set<{ resolve: ((result: Result | PromiseLike<Result>) => void) | undefined }>} */
      const pending = new Set();
      let closed = false;
      const cancelPending = () => {
        closed = true;
        spring = undefined;
        for (const cell of pending) {
          cell.resolve?.(harden({ value: undefined, done: true }));
          cell.resolve = undefined;
        }
        pending.clear();
      };
      const reader = harden({
        /** @returns {Promise<Result>} */
        next: async () => {
          if (closed || spring === undefined)
            return harden({ value: undefined, done: true });
          const waiter = makePromiseKit();
          /** @type {{ resolve: ((result: Result | PromiseLike<Result>) => void) | undefined }} */
          const cell = { resolve: waiter.resolve };
          pending.add(cell);
          // The shared promise tail only retains this detachable cell, never
          // the subscription or its cursor. Native reactions cannot be removed,
          // but cancellation clears their references to consumer resources.
          observePull(spring.get(), cell);
          try {
            const result = await waiter.promise;
            if (result.done) cancelPending();
            return result;
          } catch (error) {
            cancelPending();
            throw error;
          } finally {
            pending.delete(cell);
            cell.resolve = undefined;
          }
        },
        return: async value => {
          cancelPending();
          return harden({ value, done: true });
        },
        throw: async error => {
          cancelPending();
          throw error;
        },
        cancelPending,
        [Symbol.asyncIterator]: () => reader,
      });
      return reader;
    },
  });
};
harden(makeChangeTopic);
