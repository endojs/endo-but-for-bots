// @ts-check
import harden from '@endo/harden';

/**
 * Work an owner must let finish before it releases what the work depends on —
 * a store lease, a socket, a child process. Registering is not a promise that
 * the work succeeds; it is a promise that the owner will not disappear from
 * under it.
 *
 * `track` returns its argument, so registering is a wrapper at the call site
 * rather than a separate bookkeeping step that a later edit can forget:
 *
 * ```js
 * const client = await openings.track(openClient());
 * ```
 *
 * `drain` settles when everything registered *so far* has settled, success or
 * failure alike — a failure is the owner's business to report, not a reason to
 * stop waiting for the rest. Work registered after `drain` is called is not
 * waited for; a caller that can still accept work must stop accepting it
 * before it drains.
 */
export const makeInFlight = () => {
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set();
  return harden({
    /**
     * @template T
     * @param {Promise<T>} promise
     * @returns {Promise<T>} the same promise
     */
    track: promise => {
      pending.add(promise);
      const settled = () => pending.delete(promise);
      void promise.then(settled, settled);
      return promise;
    },
    /** @returns {Promise<void>} */
    drain: async () => {
      await Promise.allSettled([...pending]);
    },
  });
};
harden(makeInFlight);

/**
 * The first failure of a cleanup sequence, held until the sequence finishes.
 *
 * Cleanup runs because something is being released, so it has to run to the
 * end: throwing at the first failure would skip whatever cleanup remained and
 * leak exactly what the sequence existed to reclaim. Record instead, keep
 * going, and let the caller raise it once there is nothing left to do.
 *
 * The first failure is kept rather than the last because it is the one with an
 * intact cause; later ones are often its consequences.
 */
export const makeFirstFailure = () => {
  let failed = false;
  /** @type {unknown} */
  let failure;
  return harden({
    /** @param {unknown} error */
    record: error => {
      if (failed) return;
      failed = true;
      failure = error;
    },
    /** Throw the recorded failure, if there was one. */
    assertNone: () => {
      if (failed) throw failure;
    },
  });
};
harden(makeFirstFailure);
