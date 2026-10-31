// @ts-check
import harden from '@endo/harden';

/** Deterministic same-origin Web Locks stand-in for component/unit tests. */
export const makeTestLocks = () => {
  const tails = new Map();
  return harden({
    /**
     * @template T
     * @param {string} key
     * @param {() => T} work
     * @returns {Promise<T>}
     */
    request(key, work) {
      const result = (tails.get(key) || Promise.resolve()).then(work);
      tails.set(
        key,
        result.catch(() => {}),
      );
      return result;
    },
  });
};
harden(makeTestLocks);
