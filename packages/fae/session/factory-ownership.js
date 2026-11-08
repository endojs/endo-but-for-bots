// @ts-check

/**
 * One formula incarnation's admission fence and outstanding-call drain.
 * Not an exclusion mechanism for distinct formulas over the same host.
 */
export const makeFactoryOwnership = () => {
  let closed = false;
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  /** @type {unknown[]} */
  const failures = [];
  const assertOpen = () => {
    if (closed) throw Error('Floot factory incarnation is closed');
  };
  /** @template T @param {T} result @returns {T} */
  const track = result => {
    const flight = Promise.resolve(result);
    pending.add(flight);
    void flight.then(
      () => pending.delete(flight),
      error => {
        pending.delete(flight);
        if (closed) failures.push(error);
      },
    );
    return result;
  };
  return harden({
    assertOpen,
    isClosed: () => closed,
    fence: () => {
      closed = true;
    },
    track,
    /** @param {Record<string, (...args: any[]) => any>} methods */
    methods: methods =>
      Object.fromEntries(
        Object.entries(methods).map(([name, method]) => [
          name,
          /** @this {unknown} */
          function ownedMethod(...args) {
            assertOpen();
            return track(method.apply(this, args));
          },
        ]),
      ),
    drain: async () => {
      while (pending.size > 0) {
        // Continuations can register more work while an admitted call settles.
        // eslint-disable-next-line no-await-in-loop
        await Promise.allSettled([...pending]);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          'Floot factory admitted work failed during disposal',
        );
    },
  });
};
harden(makeFactoryOwnership);
