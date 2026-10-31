// @ts-check

import { Fail } from '@endo/errors';

/**
 * Order resource acquisition and retain cleanup ownership until release succeeds.
 * Callers serialize create/destroy with inOrder(), stop a predecessor before
 * acquisition, and retain its termination callback until cleanup succeeds.
 * A stale owner may release only its own entry.
 *
 * Shutdown fences queued and future operations, waits for acquisitions already
 * running, then attempts every retained owner. An acquisition finishing during
 * shutdown must still retain its cleanup callback. Failed owners remain for
 * retry; this registry does not implement emergency revocation or cancel a hung
 * acquisition. Resource dependency ordering belongs to each owner's cleanup.
 */
export const makeResourceRegistry = () => {
  /** @type {Map<string, () => Promise<void>>} */
  const owners = new Map();
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();
  let closing = false;
  /** @type {Promise<void> | undefined} */
  let shutdownFlight;
  const assertOpen = () => {
    !closing || Fail`Resource owner is shutting down`;
  };

  /**
   * @template T
   * @param {string} resourceId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const inOrder = (resourceId, operation) => {
    assertOpen();
    const previous = chains.get(resourceId) || Promise.resolve();
    const result = previous.then(() => {
      assertOpen();
      return operation();
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    chains.set(resourceId, settled);
    void settled.then(() => {
      if (chains.get(resourceId) === settled) chains.delete(resourceId);
    });
    return result;
  };
  /**
   * @param {string} resourceId
   * @param {() => Promise<void>} terminate
   */
  const retain = (resourceId, terminate) => {
    owners.set(resourceId, terminate);
  };
  /**
   * @param {string} resourceId
   * @param {() => Promise<void>} terminate
   */
  const release = (resourceId, terminate) => {
    if (owners.get(resourceId) === terminate) owners.delete(resourceId);
  };
  /**
   * @param {string} resourceId
   * @returns {Promise<boolean>} Whether a retained owner was stopped.
   */
  const stop = async resourceId => {
    const terminate = owners.get(resourceId);
    if (!terminate) return false;
    await terminate();
    return true;
  };
  const drain = async () => {
    await Promise.all([...chains.values()]);
    const results = await Promise.allSettled([...owners.keys()].map(stop));
    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (errors.length) {
      throw new AggregateError(errors, 'Resource owner shutdown pending');
    }
  };
  const shutdown = () => {
    closing = true;
    if (!shutdownFlight) {
      shutdownFlight = drain().finally(() => {
        shutdownFlight = undefined;
      });
    }
    return shutdownFlight;
  };
  return harden({ assertOpen, inOrder, retain, release, stop, shutdown });
};
harden(makeResourceRegistry);
