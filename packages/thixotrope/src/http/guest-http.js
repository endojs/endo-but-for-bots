// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * SKETCH — see designs/manual-persistence-vats.md. Not wired into the
 * supervisor, and the eager pin it depends on does not exist yet.
 *
 * HTTP services owned by the vat that uses them.
 *
 * The durable part is the desired set below: which ports should be served, by
 * which handlers. It is an ordinary Map in an orthogonally persistent heap, so
 * there is no metadata file, no recipe encoding, no version field, and no
 * restore path — the three-state recipe machine in `http-services.js` exists
 * only because that information lives on the ephemeral side.
 *
 * The handler is held directly. There is no secret and no publication, because
 * nothing has to find it again after a restart: this vat re-offers it.
 *
 * Self-contained, because the supervisor ships this factory's source into a
 * vat where only E, Far and harden are in scope.
 *
 * @param {any} listeners a HostListeners facet, granted by the user
 */
export const makeGuestHttpServices = listeners => {
  /** @type {Map<string, {port: number, handler: any}>} */
  const desired = new Map();
  /**
   * Bindings from the current host incarnation. Cached only to close them; a
   * binding from a dead incarnation is inert, and `reconcile` replaces it
   * rather than trying to detect that.
   * @type {Map<string, any>}
   */
  const live = new Map();

  /** @param {string} id */
  const assertId = id => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128)
      throw Error('Service id must be 1 to 128 characters');
  };

  /** @param {string} id */
  const establish = async id => {
    const entry = desired.get(id);
    if (entry === undefined) return undefined;
    const { binding } = await E(listeners).listen(harden({ ...entry }));
    live.set(id, binding);
    return binding;
  };

  return Far('HttpServices', {
    help: () =>
      'serve(id, port, handler) declares a service durably and binds it; stop(id) withdraws it; list() reports desired state; reconcile() re-establishes every service against the current host, and is what an eager pin calls after a restart.',

    /**
     * @param {string} id
     * @param {number} port
     * @param {any} handler
     */
    serve: async (id, port, handler) => {
      assertId(id);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536)
        throw Error('Expected a port number');
      const existing = desired.get(id);
      if (existing !== undefined && existing.port !== port)
        throw Error('Service is already declared on another port');
      // The declaration commits before the binding is attempted. A failure to
      // bind now is a condition to retry, not a reason to forget what the user
      // asked for — which is the whole difference between desired and actual.
      desired.set(id, harden({ port, handler }));
      await establish(id);
      return harden({ id, port });
    },

    /** @param {string} id */
    stop: async id => {
      const binding = live.get(id);
      desired.delete(id);
      live.delete(id);
      if (binding === undefined) return false;
      // A binding from a previous host incarnation rejects or reports false;
      // either way the port is not ours to release any more.
      return E(binding)
        .close()
        .catch(() => false);
    },

    /**
     * Re-offer every declared service to the host as it is now.
     *
     * Idempotent, and safe to call on any wake: the host returns the standing
     * binding when a port is already bound to the same handler. The vat does
     * not try to work out whether the host restarted, because it does not need
     * to know.
     */
    reconcile: async () => {
      /** @type {Array<{id: string, error?: string}>} */
      const results = [];
      for (const id of [...desired.keys()]) {
        results.push(
          // eslint-disable-next-line no-await-in-loop
          await establish(id).then(
            () => harden({ id }),
            error => harden({ id, error: String(error && error.message) }),
          ),
        );
      }
      return harden(results);
    },

    list: () =>
      harden(
        [...desired].map(([id, { port }]) =>
          harden({ id, port, url: `http://127.0.0.1:${port}/` }),
        ),
      ),
  });
};
harden(makeGuestHttpServices);
