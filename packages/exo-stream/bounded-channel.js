// @ts-check
import { makeExo } from '@endo/exo';
import { makePromiseKit } from '@endo/promise-kit';
import { mustMatch } from '@endo/patterns';

import { makeReaderPump } from './reader-pump.js';
import { BufferedReaderInterface } from './type-guards.js';

/** @import { Passable } from '@endo/pass-style' */
/** @import { BufferedReaderKit, MakeBufferedReaderOptions } from './types.js' */

/**
 * Push-fed, credit-aware reader. Bounds apply to undelivered data, not lifetime
 * traffic. The caller supplies a weight including its encoding/retention cost.
 * One separately bounded terminal event is reserved outside the data queue.
 * A producer unable to respect consumer pace gets an explicit stream failure
 * and an onClose notification, never silent loss or an unbounded ack chain.
 * Consumer-granted credit controls values delivered beyond this local queue;
 * the consumer remains responsible for its prefetch and retained values.
 *
 * @template {Passable} [T=Passable]
 * @param {MakeBufferedReaderOptions<T> & {
 *   maxItems: number, maxWeight: number, weigh: (value: T) => number
 * }} options
 * @returns {BufferedReaderKit<T>}
 */
export const makeBoundedReader = options => {
  const {
    maxItems,
    maxWeight,
    weigh,
    readPattern,
    isTerminal = value =>
      value !== null &&
      typeof value === 'object' &&
      'type' in value &&
      (value.type === 'end' || value.type === 'abort'),
  } = options;
  // This profile uses 32-bit counters for resident array slots and weights.
  for (const limit of [maxItems, maxWeight]) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 0xffff_ffff) {
      throw RangeError('Bounded reader limits must be positive uint32 values');
    }
  }
  /** @type {Array<{ value: T, weight: number }>} */
  const queue = [];
  let weight = 0;
  /** @type {{ value: T } | undefined} */
  let terminal;
  let finished = false;
  let streaming = false;
  /** @type {Error | undefined} */
  let failure;
  let onClose = options.onClose;
  let notified = false;
  let wake = makePromiseKit();
  const notify = () => {
    wake.resolve(undefined);
    wake = makePromiseKit();
  };
  const close = () => {
    const early = !finished;
    finished = true;
    queue.length = 0;
    weight = 0;
    terminal = undefined;
    notify();
    if (early && !notified) {
      notified = true;
      onClose?.();
    }
  };
  const fail = () => {
    failure = Error('Bounded reader queue capacity exceeded');
    close();
  };
  /** @param {T} value */
  const push = value => {
    if (finished) return;
    harden(value);
    if (readPattern !== undefined) mustMatch(value, readPattern);
    const size = weigh(value);
    if (!Number.isInteger(size) || size < 1 || size > maxWeight) {
      fail();
      return;
    }
    if (isTerminal(value)) {
      terminal = { value };
      finished = true;
    } else {
      if (queue.length >= maxItems || size > maxWeight - weight) {
        fail();
        return;
      }
      queue.push({ value, weight: size });
      weight += size;
    }
    notify();
  };
  const iterator = harden({
    async next() {
      await null;
      for (;;) {
        if (failure) throw failure;
        const entry = queue.shift();
        if (entry) {
          weight -= entry.weight;
          return harden({ done: false, value: entry.value });
        }
        if (terminal) {
          const { value } = terminal;
          terminal = undefined;
          return harden({ done: false, value });
        }
        if (finished) return harden({ done: true, value: undefined });
        // eslint-disable-next-line no-await-in-loop
        await wake.promise;
      }
    },
    async return() {
      close();
      return harden({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  });
  const pump = makeReaderPump(iterator, { cancelPending: close });
  const reader = makeExo('BoundedReader', BufferedReaderInterface, {
    stream(syn) {
      if (streaming)
        throw TypeError('BoundedReader stream() may be called at most once');
      streaming = true;
      return pump(syn);
    },
    readPattern: () => readPattern,
    readReturnPattern: () => undefined,
  });
  return harden({
    push,
    reader,
    close,
    isClosed: () => finished,
    setOnClose: hook => {
      onClose = hook;
    },
  });
};
harden(makeBoundedReader);
