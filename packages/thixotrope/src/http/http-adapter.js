// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * SKETCH — see designs/manual-persistence-vats.md.
 *
 * A web server's working state, in a vat that is expected to die.
 *
 * Everything here is per-host-incarnation: which ports are bound, the host
 * binding handles, the routing from a port to the consumer serving it, and the
 * admission policy in force on each. None of it should survive, and in an
 * ephemeral worker none of it can, so there is nothing to decide and nothing to
 * version. The durable manager re-states it through `restore`.
 *
 * Admission lives here rather than in the host. The host cannot judge a request
 * — it does not know what is being served, or by whom — and a user who wants a
 * different policy should be able to change it without changing the daemon.
 * What the host keeps is the part a guest cannot enforce: the byte and time
 * ceilings applied while bytes are arriving.
 *
 * Refusing here is cheap in the way that matters: this vat answers, and the
 * consumer behind it is never consulted. Since this vat is the one that stays
 * warm, a refused request costs a call into something already running rather
 * than waking a sleeping workspace.
 *
 * This adapter is also the only guest reference the host holds. Consumers are
 * reached through it, so the host's retention surface is one adapter and
 * consumers are retained by their manager, which is where that belongs.
 *
 * Self-contained: a manager ships this source into the vat it creates, where
 * only E, Far and harden are in scope.
 */
export const makeHttpAdapter = () => {
  /** @type {Map<number, {consumer: any, binding: any, origins: string[]}>} */
  const routes = new Map();

  /**
   * Loopback is reachable by any page in the user's browser, so a listener
   * that answered cross-site requests would hand every site a capability the
   * user meant for themselves. Same-origin only, unless a caller names the
   * origins it is willing to serve.
   *
   * @param {number} port
   * @param {string[]} origins
   * @param {any} request
   */
  const admitRequest = (port, origins, request) => {
    const authority = `127.0.0.1:${port}`;
    const allowed = origins.length === 0 ? [`http://${authority}`] : origins;
    const origin = request.headers.origin;
    const site = request.headers['sec-fetch-site'];
    if (
      request.headers.host !== authority ||
      (origin !== undefined && !allowed.includes(origin)) ||
      (site !== undefined && site !== 'same-origin' && site !== 'none')
    ) {
      return harden({
        allowed: false,
        status: 403,
        body: 'Request origin is not permitted',
      });
    }
    return harden({ allowed: true });
  };

  /**
   * @param {any} port an HttpPort capability
   * @param {any} consumer the guest handler this port should reach
   * @param {{origins?: string[]}} [policy]
   */
  const bind = async (port, consumer, policy = {}) => {
    const number = await E(port).getPort();
    const standing = routes.get(number);
    if (standing !== undefined) {
      // Idempotent for the same consumer, because the manager cannot know
      // whether building this incarnation already restored the entry it is
      // about to bind — and either order has to reach the same place.
      if (standing.consumer === consumer) return number;
      throw Error('Port is already bound to another consumer');
    }
    const origins = harden([...(policy.origins ?? [])]);
    // One facet per port, so the host holds a reference that names the port it
    // was given for and nothing else.
    const listener = Far('PortListener', {
      /** @param {any} request */
      admit: request => admitRequest(number, origins, request),
      /** @param {any} request */
      handle: request => E(routes.get(number)?.consumer).handle(request),
    });
    const { binding } = await E(port).listen(listener);
    routes.set(number, { consumer, binding, origins });
    return number;
  };

  return Far('HttpAdapter', {
    help: () =>
      'bind(port, consumer, policy?) serves a consumer on an HttpPort capability; unbind(port) releases it; restore(entries) re-states a whole desired set; ports() lists what is bound.',

    bind,

    /** @param {number} number */
    unbind: async number => {
      const route = routes.get(number);
      if (route === undefined) return false;
      routes.delete(number);
      return E(route.binding).close();
    },

    /**
     * Re-state a desired set into this incarnation, before the manager hands
     * this vat's reference to anyone.
     *
     * Partial failure is reported rather than thrown: one port already taken
     * from outside this workspace should not stop the rest from binding.
     *
     * @param {Array<[any, any, any]>} entries `[port, consumer, policy]`
     */
    restore: async entries => {
      /** @type {Array<{port?: number, error?: string}>} */
      const results = [];
      for (const [port, consumer, policy] of entries) {
        results.push(
          // eslint-disable-next-line no-await-in-loop
          await bind(port, consumer, policy).then(
            number => harden({ port: number }),
            error =>
              harden({ error: String((error && error.message) || error) }),
          ),
        );
      }
      return harden(results);
    },

    ports: () => harden([...routes.keys()]),
  });
};
harden(makeHttpAdapter);
