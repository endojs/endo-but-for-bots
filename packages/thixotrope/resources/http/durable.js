// @ts-check
import harden from '@endo/harden';

/**
 * Synchronous installation in the user's durable workspace.
 * The public facet can register handlers; process creation and restart remain
 * private to this manager. This module has no native imports.
 * @param {{E: any, Far: any, makeKeeper: any, adapters: any}} powers
 */
export const make = ({ E, Far, makeKeeper, adapters }) => {
  /**
   * Desired state, one mutable record per port. The handle a caller holds is
   * bound to its record, so a later registration on the same port cannot be
   * closed through a handle from an earlier one.
   * @type {Map<number, {handler: any, policy: {origins: string[]}, handle: any}>}
   */
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
  /** @param {unknown} policy @returns {{origins: string[]}} */
  const normalizePolicy = policy => {
    const origins = /** @type {any} */ (policy)?.origins ?? [];
    if (
      !Array.isArray(origins) ||
      origins.some(origin => typeof origin !== 'string')
    )
      throw Error('HTTP origins must be an array of strings');
    // Origins are a set: sorted, so the same allowance in another order is
    // the same policy and does not rebind the listener.
    return harden({ origins: harden([...origins].sort()) });
  };
  /** @param {{origins: string[]}} a @param {{origins: string[]}} b */
  const samePolicy = (a, b) =>
    a.origins.length === b.origins.length &&
    a.origins.every((origin, index) => origin === b.origins[index]);
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
        const wanted = normalizePolicy(policy);
        let entry = desired.get(port);
        if (entry && entry.handler !== handler)
          throw Error('Port is already registered');
        if (!entry) {
          /** @type {{handler: any, policy: {origins: string[]}, handle: any}} */
          const created = { handler, policy: wanted, handle: undefined };
          created.handle = Far('HttpRegistrationHandle', {
            status: () =>
              enqueue(async () => {
                if (desired.get(port) !== created)
                  return harden({ port, status: 'closed' });
                return reconcile(port, created);
              }),
            close: () =>
              enqueue(async () => {
                if (desired.get(port) !== created) return false;
                // Withdrawing desired state is the durable part and is done
                // first; a future incarnation restores without this port.
                desired.delete(port);
                // Only a live adapter has anything to unbind. Building one
                // just to tell it about a port it never bound would restore
                // every other registration as a side effect.
                const adapter = keeper.current();
                if (adapter === undefined) return true;
                try {
                  await E(adapter).unbind(port);
                } catch (_error) {
                  // The binding is uncertain: retire the whole incarnation so
                  // the port is released with its process, and the remaining
                  // registrations rebuild on next use. Retirement kills the
                  // process before reporting any failure it recorded, so the
                  // port is released either way; the one case retirement
                  // cannot reach the host at all is one where unbind could
                  // not have reached the adapter either.
                  await keeper.retire().catch(() => {});
                }
                return true;
              }),
          });
          entry = created;
          desired.set(port, entry);
        } else if (!samePolicy(entry.policy, wanted)) {
          // Same handler, new policy: the desired state changes and the
          // adapter is told to rebind, so the new origins take effect.
          entry.policy = wanted;
        }
        await reconcile(port, entry);
        return entry.handle;
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
