// @ts-check
import harden from '@endo/harden';

/**
 * Synchronous installation in the user's durable workspace.
 * The public facet can register handlers; process creation and restart remain
 * private to this manager. This module has no native imports.
 * @param {{E: any, Far: any, makeKeeper: any, adapters: any}} powers
 */
export const make = ({ E, Far, makeKeeper, adapters }) => {
  /** @type {Map<number, {handler: any, policy: any, registration: any}>} */
  const desired = new Map();
  let chain = Promise.resolve();
  /** @param {() => Promise<any>} operation */
  const enqueue = operation => {
    const result = chain.then(operation);
    chain = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const keeper = makeKeeper({
    create: async () => {
      const incarnation = await E(adapters).create();
      return harden({
        adapter: await E(incarnation).getRoot(),
        retire: () => E(incarnation).retire(),
      });
    },
    /** @param {any} adapter */
    restore: adapter =>
      E(adapter).restore(
        harden(
          [...desired].map(([port, { handler, policy }]) =>
            harden([port, handler, policy]),
          ),
        ),
      ),
  });
  /**
   * A failed bind retains desired state, but must not withhold its close handle.
   * Status retries reconciliation and reports the current binding outcome.
   * @param {number} port
   * @param {{handler: any, policy: any}} entry
   */
  const reconcile = async (port, entry) => {
    try {
      const adapter = await keeper.provide();
      await E(adapter).bind(port, entry.handler, entry.policy);
      return harden({
        port,
        status: 'listening',
        url: `http://127.0.0.1:${port}/`,
      });
    } catch (error) {
      return harden({
        port,
        status: 'inactive',
        error: String(/** @type {Error} */ (error)?.message ?? error),
      });
    }
  };
  const registration = Far('HttpRegistration', {
    help: () =>
      'register(port, handler, policy?) serves handler.handle({method,path,body}) and returns status()/close().',
    /**
     * @param {number} port
     * @param {any} handler
     * @param {{origins?: string[]}} [policy]
     */
    register: (port, handler, policy = {}) =>
      enqueue(async () => {
        await null;
        if (!Number.isInteger(port) || port < 1024 || port > 65_535)
          throw Error('Expected HTTP port 1024–65535');
        if (handler?.[Symbol.for('passStyle')] !== 'remotable')
          throw Error('Expected a remotable HTTP handler');
        const origins = policy.origins ?? [];
        if (
          !Array.isArray(origins) ||
          origins.some(origin => typeof origin !== 'string')
        )
          throw Error('HTTP origins must be an array of strings');
        let entry = desired.get(port);
        if (entry && entry.handler !== handler)
          throw Error('Port is already registered');
        if (!entry) {
          /** @type {{handler: any, policy: any, registration: any}} */
          const created = {
            handler,
            policy: harden({ ...policy }),
            registration: undefined,
          };
          created.registration = Far('HttpRegistrationHandle', {
            status: () =>
              enqueue(async () => {
                if (desired.get(port) !== created)
                  return harden({ port, status: 'closed' });
                return reconcile(port, created);
              }),
            close: () =>
              enqueue(async () => {
                if (desired.get(port) !== created) return false;
                desired.delete(port);
                const adapter = await keeper.provide();
                try {
                  await E(adapter).unbind(port);
                } catch (error) {
                  // Closing an uncertain binding retires all native state; the
                  // remaining desired registrations will rebuild on next use.
                  await keeper.retire();
                  throw error;
                }
                return true;
              }),
          });
          entry = harden(created);
          desired.set(port, entry);
        }
        await reconcile(port, entry);
        return entry.registration;
      }),
  });
  return harden({
    registration,
    lifecycle: Far('HttpLifecycle', {
      started: () =>
        enqueue(async () => {
          if (desired.size > 0) await keeper.provide();
        }),
    }),
  });
};
harden(make);
