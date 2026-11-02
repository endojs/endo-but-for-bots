// @ts-check

import { makePromiseKit } from '@endo/promise-kit';

/**
 * Own one source iterator shared by a pump's admitted stream invocations.
 * Stream results and resource release are separate: a failed next() is not a
 * failed close(), and a failed return() must remain available for retry.
 *
 * @template Y, R, N
 * @param {AsyncIterator<Y, R, N> | Iterator<Y, R, N>} source
 */
export const makePumpLifecycle = source => {
  let fenced = false;
  /** @type {Set<Promise<IteratorResult<Y, R>>>} */
  const pulls = new Set();
  /** @type {Map<() => Promise<unknown> | void, Promise<void>>} */
  const invocations = new Map();
  /** @type {Promise<unknown[]> | undefined} */
  let interruptions;
  /** @type {Promise<unknown[]> | undefined} */
  let drained;
  /** @type {Promise<IteratorResult<Y, R>> | undefined} */
  let releaseAttempt;
  /** @type {IteratorResult<Y, R> | undefined} */
  let released;

  const assertActive = () => {
    if (fenced) throw TypeError('Stream endpoint is closed');
  };

  /** @param {() => Promise<unknown> | void} interrupt */
  const admit = interrupt => {
    assertActive();
    const done = makePromiseKit();
    invocations.set(interrupt, done.promise);
    return () => {
      invocations.delete(interrupt);
      done.resolve(undefined);
    };
  };

  const fence = () => {
    if (fenced) return;
    fenced = true;
    drained = Promise.allSettled([...invocations.values()]);
    // Hooks interrupt; the source's return acknowledgement proves release.
    // Observe hook failures even though each stream retains its own outcome.
    interruptions = Promise.allSettled(
      [...invocations.keys()].map(interrupt => {
        try {
          return interrupt();
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
  };

  /** @param {[] | [N]} value */
  const next = (...value) => {
    assertActive();
    const { promise: pending, resolve, reject } = makePromiseKit();
    pulls.add(pending);
    void (async () => {
      try {
        // Invoke synchronously after retention so an interruption cannot
        // precede the call it must interrupt. Await uses native promise
        // adoption even if the source promise carries an own then method.
        resolve(await source.next(...value));
      } catch (error) {
        reject(error);
      }
    })();
    pending.then(
      () => pulls.delete(pending),
      () => pulls.delete(pending),
    );
    return pending;
  };

  /** @param {R} [value] */
  const release = value => {
    fence();
    if (released) return Promise.resolve(released);
    if (releaseAttempt) return releaseAttempt;
    const attempt = (async () => {
      // The fence prevents follow-up pulls. Already admitted calls still own
      // their resources until they settle.
      await Promise.allSettled([...pulls]);
      await interruptions;
      const result = source.return
        ? await source.return(value)
        : {
            done: /** @type {const} */ (true),
            value: /** @type {R} */ (value),
          };
      // Duplex stream adapters may acknowledge return() with done:false.
      // Preserve that stream result, but it is not resource-release proof.
      if (result.done === true) released = result;
      return result;
    })();
    releaseAttempt = attempt;
    void attempt.then(
      result => {
        if (result.done !== true && releaseAttempt === attempt) {
          releaseAttempt = undefined;
        }
      },
      () => {},
    );
    void attempt.catch(() => {
      if (releaseAttempt === attempt) releaseAttempt = undefined;
    });
    return attempt;
  };

  const close = async () => {
    const releasing = release(undefined);
    // Observe release rejection immediately and wait for every admitted pump,
    // including pumps that preserve an earlier I/O error on their ack chain.
    const [result] = await Promise.allSettled([releasing, drained]);
    if (result.status === 'rejected') throw result.reason;
    if (result.value.done !== true) {
      throw TypeError('Stream source return() did not finish');
    }
  };

  return harden({ admit, next, release, close });
};
harden(makePumpLifecycle);
