// @ts-check

/**
 * A lossless change topic over a shared async promise linked list, the
 * same shape as the daemon's `makeChangeTopic`: every subscriber sees
 * every value published after it subscribed, slow subscribers accumulate
 * in their own cursor without back-pressuring the publisher, and an
 * early `break` in a `for await` settles promptly via `return`.
 */

const makeCell = () => {
  /** @type {(node: any) => void} */
  let resolve = () => {};
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
};

/**
 * @template TValue
 * @returns {{
 *   publisher: { next: (value: TValue) => void },
 *   subscribe: () => AsyncIterableIterator<TValue>,
 * }}
 */
export const makeChangeTopic = () => {
  let tail = makeCell();
  const publisher = harden({
    /** @param {TValue} value */
    next: value => {
      const next = makeCell();
      tail.resolve(harden({ value, tail: next }));
      tail = next;
    },
  });
  const subscribe = () => {
    let cursor = tail.promise;
    let returned = false;
    const iterator = harden({
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        if (returned) {
          return harden({ value: undefined, done: true });
        }
        const node = await cursor;
        cursor = node.tail.promise;
        return harden({ value: node.value, done: false });
      },
      return: async () => {
        returned = true;
        return harden({ value: undefined, done: true });
      },
      throw: async error => {
        returned = true;
        throw error;
      },
    });
    return iterator;
  };
  return harden({ publisher, subscribe });
};
harden(makeChangeTopic);
