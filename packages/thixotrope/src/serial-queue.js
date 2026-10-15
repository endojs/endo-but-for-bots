// @ts-check
import harden from '@endo/harden';

/**
 * One queue of asynchronous operations run strictly one after another, each
 * starting once the previous has settled either way. The caller gets each
 * operation's own promise; a rejection is the caller's to handle and does
 * not stop the queue.
 *
 * Every manager, keeper, adapter and transport in this package needs one,
 * and the guest prelude provides it under this name, so a factory shipped
 * into a vat may import it from here.
 *
 * @returns {<T>(operation: () => Promise<T> | T) => Promise<T>} enqueue
 */
export const makeSerialQueue = () => {
  let chain = Promise.resolve();
  /**
   * @template T
   * @param {() => Promise<T> | T} operation
   * @returns {Promise<T>}
   */
  const enqueue = operation => {
    const result = chain.then(operation);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  return harden(enqueue);
};
harden(makeSerialQueue);
