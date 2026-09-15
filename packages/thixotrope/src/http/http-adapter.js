// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * SKETCH — see designs/manual-persistence-vats.md.
 *
 * The ephemeral half: a web server's working state, in a vat that is expected
 * to die.
 *
 * Everything here is per-host-incarnation — which ports are bound, the host
 * binding handles, and the routing from a port to the consumer serving it.
 * None of it should survive, and in an ephemeral vat none of it can, so there
 * is nothing to decide and nothing to version. The durable manager re-states
 * it into a fresh incarnation through `restore`.
 *
 * This vat is also the only guest reference the host holds. Consumers are
 * reached through it, so the host's retention surface is one ephemeral vat
 * rather than one durable vat per service, and consumers are retained by their
 * manager — which is where that responsibility belongs.
 *
 * Self-contained: a manager ships this source into the vat it creates, where
 * only E, Far and harden are in scope.
 */
export const makeHttpAdapter = () => {
  /** @type {Map<number, {consumer: any, binding: any, handler: any}>} */
  const routes = new Map();

  /**
   * @param {any} port an HttpPort capability
   * @param {any} consumer the guest handler this port should reach
   */
  const bind = async (port, consumer) => {
    const number = await E(port).getPort();
    const standing = routes.get(number);
    if (standing !== undefined) {
      // Idempotent for the same consumer, because the manager cannot know
      // whether building this incarnation already restored the entry it is
      // about to bind — and either order has to reach the same place.
      if (standing.consumer === consumer) return number;
      throw Error('Port is already bound to another consumer');
    }
    // The host calls this, not the consumer directly: one reference into this
    // vat stands for every service it fronts.
    const handler = Far('PortHandler', {
      /** @param {any} request */
      handle: request => E(routes.get(number)?.consumer).handle(request),
    });
    const { binding } = await E(port).listen(handler);
    routes.set(number, { consumer, binding, handler });
    return number;
  };

  return Far('HttpAdapter', {
    help: () =>
      'bind(port, consumer) serves a consumer on an HttpPort capability; unbind(port) releases it; restore(entries) re-states a whole desired set into this incarnation; ports() lists what is bound.',

    bind,

    /** @param {number} number */
    unbind: async number => {
      const route = routes.get(number);
      if (route === undefined) return false;
      routes.delete(number);
      return E(route.binding).close();
    },

    /**
     * Re-state a desired set. Called once on a fresh incarnation, before the
     * manager hands this vat's reference to anyone.
     *
     * Partial failure is reported rather than thrown: one port already taken by
     * something outside this workspace should not stop the rest from binding.
     *
     * @param {Array<[any, any]>} entries `[port, consumer]` pairs
     */
    restore: async entries => {
      /** @type {Array<{port?: number, error?: string}>} */
      const results = [];
      for (const [port, consumer] of entries) {
        results.push(
          // eslint-disable-next-line no-await-in-loop
          await bind(port, consumer).then(
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
