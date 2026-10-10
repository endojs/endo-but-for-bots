// @ts-check

import harden from '@endo/harden';

/**
 * Invoke a local iterator's out-of-band cancellation capability, when present.
 * Ordinary generators have no such capability: their return queues behind next.
 * @param {object} iterator
 * @returns {void | Promise<void>}
 */
export const cancelPendingIterator = iterator => {
  if (
    'cancelPending' in iterator &&
    typeof iterator.cancelPending === 'function'
  ) {
    return iterator.cancelPending();
  }
  return undefined;
};
harden(cancelPendingIterator);

/**
 * Preserve a generator's protocol while exposing cancellation separately.
 * The factory registers cancellation as soon as it acquires its source, and
 * awaits registration inside try/finally so cancellation that precedes source
 * acquisition is observed, and releases the source even during snapshots.
 * @template T
 * @param {(setCancelPending: (cancel: () => void | Promise<void>) => void | Promise<void>) => AsyncGenerator<T, undefined, undefined>} generate
 * @returns {AsyncGenerator<T, undefined, undefined> & { cancelPending: () => Promise<void> }}
 */
export const makeCancelableIterator = generate => {
  /** @type {(() => void | Promise<void>) | undefined} */
  let cancelSource;
  /** @type {Promise<void> | undefined} */
  let cancellation;
  let cancellationStarted = false;
  const iterator = generate(cancel => {
    if (cancellationStarted) return cancel();
    cancelSource = cancel;
    return undefined;
  });
  const cancelPending = () => {
    cancellation ??= Promise.resolve().then(() => {
      cancellationStarted = true;
      const cancel = cancelSource;
      cancelSource = undefined;
      return cancel?.();
    });
    return cancellation;
  };
  const returnIterator = iterator.return.bind(iterator);
  const throwIterator = iterator.throw.bind(iterator);
  Object.defineProperties(iterator, {
    return: {
      value: async value => {
        const result = returnIterator(value);
        result.catch(() => undefined);
        try {
          await cancelPending();
        } catch (error) {
          await result;
          throw error;
        }
        return result;
      },
    },
    throw: {
      value: async error => {
        const result = throwIterator(error);
        result.catch(() => undefined);
        try {
          await cancelPending();
        } catch (cancelError) {
          await result;
          throw cancelError;
        }
        return result;
      },
    },
  });
  return harden(Object.assign(iterator, { cancelPending }));
};
harden(makeCancelableIterator);
