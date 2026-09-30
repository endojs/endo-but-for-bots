// @ts-check
import harden from '@endo/harden';

/** @import { NativeDurablePowers, NativeDurableKit } from '../../src/native/contract.js' */

/**
 * What this side registers under a port and the adapter binds; the adapter
 * imports the type from here.
 * @typedef {object} HttpRegistrationSpec
 * @property {any} handler the application's `handle({method, path, body})`
 * @property {{ origins: string[] }} policy the sorted set of allowed origins
 */

/**
 * Synchronous installation in the user's durable workspace. The public facet
 * registers handlers on ports; process creation and restart are the manager
 * kit's, and everything HTTP is the adapter's. This module has no native
 * imports.
 * @param {NativeDurablePowers} powers
 * @returns {NativeDurableKit}
 */
export const make = ({ Far, makeManager }) => {
  /**
   * Origins are a set: sorted, so the same allowance in another order is
   * the same policy and does not rebind the listener.
   * @param {unknown} policy
   * @returns {{ origins: string[] }}
   */
  const normalizePolicy = policy => {
    const origins = /** @type {any} */ (policy)?.origins ?? [];
    if (
      !Array.isArray(origins) ||
      origins.some(origin => typeof origin !== 'string')
    )
      throw Error('HTTP origins must be an array of strings');
    return harden({ origins: harden([...origins].sort()) });
  };
  /**
   * @param {HttpRegistrationSpec} a
   * @param {HttpRegistrationSpec} b
   */
  const samePolicy = (a, b) =>
    a.policy.origins.length === b.policy.origins.length &&
    a.policy.origins.every(
      (origin, index) => origin === b.policy.origins[index],
    );
  /** @type {ReturnType<typeof makeManager>} */
  const manager = makeManager({
    label: 'Port',
    /**
     * @param {HttpRegistrationSpec} existing
     * @param {HttpRegistrationSpec} wanted
     */
    same: (existing, wanted) =>
      existing.handler === wanted.handler && samePolicy(existing, wanted),
    // Same handler, new policy: the listener is rebound with the new origins.
    /**
     * @param {HttpRegistrationSpec} existing
     * @param {HttpRegistrationSpec} wanted
     */
    replaces: (existing, wanted) => existing.handler === wanted.handler,
    /**
     * @param {unknown} port
     * @param {HttpRegistrationSpec} _spec
     * @param {'bound' | 'inactive' | 'closed'} state
     * @param {string} [error]
     */
    describe: (port, _spec, state, error) =>
      harden({
        port,
        status: state === 'bound' ? 'listening' : state,
        ...(state === 'bound' ? { url: `http://127.0.0.1:${port}/` } : {}),
        ...(error === undefined ? {} : { error }),
      }),
  });
  const registration = Far('HttpRegistration', {
    help: () =>
      'register(port, handler, policy?) serves handler.handle({method,path,body}) and returns status()/close().',
    /**
     * @param {number} port
     * @param {any} handler
     * @param {{origins?: string[]}} [policy]
     */
    register: (port, handler, policy = {}) => {
      if (!Number.isInteger(port) || port < 1024 || port > 65_535)
        throw Error('Expected HTTP port 1024–65535');
      if (handler?.[Symbol.for('passStyle')] !== 'remotable')
        throw Error('Expected a remotable HTTP handler');
      return manager.register(
        port,
        harden({ handler, policy: normalizePolicy(policy) }),
      );
    },
  });
  return harden({ registration, lifecycle: manager.lifecycle });
};
harden(make);
