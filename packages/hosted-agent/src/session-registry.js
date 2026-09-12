// @ts-check

import { Fail } from '@endo/errors';

/**
 * Share per-session replacement ordering and cleanup ownership across adapters.
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
export const makeSessionRegistry = () => {
  /** @type {Map<string, () => Promise<void>>} */
  const owners = new Map();
  /** @type {Map<string, Promise<void>>} */
  const chains = new Map();
  let closing = false;
  /** @type {Promise<void> | undefined} */
  let shutdownFlight;
  const assertOpen = () => {
    !closing || Fail`Hosted backend is shutting down`;
  };

  /**
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const inOrder = (sessionId, operation) => {
    assertOpen();
    const previous = chains.get(sessionId) || Promise.resolve();
    const result = previous.then(() => {
      assertOpen();
      return operation();
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    chains.set(sessionId, settled);
    void settled.then(() => {
      if (chains.get(sessionId) === settled) chains.delete(sessionId);
    });
    return result;
  };
  /**
   * @param {string} sessionId
   * @param {() => Promise<void>} terminate
   */
  const retain = (sessionId, terminate) => {
    owners.set(sessionId, terminate);
  };
  /**
   * @param {string} sessionId
   * @param {() => Promise<void>} terminate
   */
  const release = (sessionId, terminate) => {
    if (owners.get(sessionId) === terminate) owners.delete(sessionId);
  };
  /** @param {string} sessionId */
  const stop = async sessionId => {
    const terminate = owners.get(sessionId);
    if (terminate) await terminate();
  };
  const drain = async () => {
    await Promise.all([...chains.values()]);
    const results = await Promise.allSettled([...owners.keys()].map(stop));
    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason);
    if (errors.length) {
      throw new AggregateError(errors, 'Hosted backend shutdown pending');
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
  return harden({ inOrder, retain, release, stop, shutdown });
};
harden(makeSessionRegistry);
