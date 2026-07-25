// @ts-check
/// <reference types="ses"/>

/** @import { Buffer } from './buffer.js' */
/** @import { AsyncQueue } from './types.js' */

import harden from '@endo/harden';
import { makeQueue } from './index.js';

// TypeScript ReadOnly semantics are not sufficiently expressive to distinguish
// a value one promises not to alter from a value one must not alter,
// making it useless.
const freeze = /** @type {<T>(v: T | Readonly<T>) => T} */ (Object.freeze);

/**
 * Make an unbounded buffer.
 *
 * The spring is the producer-facing generator subset. Its calls enqueue
 * iterations without waiting for the sink. The sink is the consumer-facing
 * async iterator subset. Its next calls receive those iterations in order.
 *
 * @template T
 * @template [TReturn=undefined]
 * @returns {Buffer<T, TReturn>}
 */
export const makeUnboundedBuffer = () => {
  /** @type {AsyncQueue<IteratorResult<T, TReturn>>} */
  const queue = makeQueue();

  const spring = harden({
    /** @param {T | Promise<T>} value */
    next(value) {
      queue.put(
        Promise.resolve(value).then(resolvedValue =>
          freeze({ value: resolvedValue, done: false }),
        ),
      );
    },
    /** @param {TReturn | Promise<TReturn>} value */
    return(value) {
      queue.put(
        Promise.resolve(value).then(resolvedValue =>
          freeze({ value: resolvedValue, done: true }),
        ),
      );
    },
    /** @param {Error} error */
    throw(error) {
      queue.put(harden(Promise.reject(error)));
    },
  });

  const sink = harden({
    next() {
      return queue.get();
    },
    [Symbol.asyncIterator]() {
      return sink;
    },
  });

  return harden({ spring, sink });
};
harden(makeUnboundedBuffer);
