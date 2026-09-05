// @ts-check
/// <reference types="ses"/>

/** @import { AutoBuffer } from './auto-buffer.js' */
/** @import { AsyncQueue } from './types.js' */

import harden from '@endo/harden';
import { makeQueue } from './index.js';

// TypeScript ReadOnly semantics are not sufficiently expressive to distinguish
// a value one promises not to alter from a value one must not alter,
// making it useless.
const freeze = /** @type {<T>(v: T | Readonly<T>) => T} */ (Object.freeze);

/**
 * Make an auto buffer: a one-way buffer whose storage grows automatically to
 * retain every produced value until the sink consumes it. It applies no
 * backpressure and drops nothing, in contrast to a bounded ring buffer.
 *
 * The spring is the producer-facing generator subset. Its calls enqueue
 * iterations without waiting for the sink. The sink is the consumer-facing
 * async iterator subset. Its next calls receive those iterations in order.
 *
 * @template T
 * @template [TReturn=undefined]
 * @returns {AutoBuffer<T, TReturn>}
 */
export const makeAutoBuffer = () => {
  /** @type {AsyncQueue<IteratorResult<T, TReturn>>} */
  const queue = makeQueue();

  // The buffer is fire-and-forget: the sink may pull an iteration long after
  // the spring enqueued it, so a rejected iteration promise (a throw, or a next
  // whose value promise rejects) must not float unhandled in the interim. An
  // unhandled rejection raises a process-level unhandledRejection, fatal under
  // Node's default. Attaching an inert catch marks the queued promise handled;
  // makeQueue.get chains its own then off the same promise, so the sink still
  // observes the rejection when it eventually reads.
  const enqueue = iteration => {
    iteration.catch(() => {});
    queue.put(iteration);
  };

  const spring = harden({
    /** @param {T | Promise<T>} value */
    next(value) {
      enqueue(
        Promise.resolve(value).then(resolvedValue =>
          freeze({ value: resolvedValue, done: false }),
        ),
      );
    },
    /** @param {TReturn | Promise<TReturn>} value */
    return(value) {
      enqueue(
        Promise.resolve(value).then(resolvedValue =>
          freeze({ value: resolvedValue, done: true }),
        ),
      );
    },
    /** @param {Error} error */
    throw(error) {
      enqueue(harden(Promise.reject(error)));
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
harden(makeAutoBuffer);
