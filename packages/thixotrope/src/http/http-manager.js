// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * SKETCH — see designs/manual-persistence-vats.md.
 *
 * The durable half: what the user asked for, and who is allowed to ask.
 *
 * This vat holds the desired set — which consumer should be served on which
 * port capability — in an ordinary Map, because its heap is the durable
 * record. No metadata file, no recipe encoding, no version field, no restore
 * path. The three-state recipe machine in `http-services.js` exists only
 * because that information currently lives on the ephemeral side.
 *
 * It holds policy; the adapter holds mechanism. Consumers never receive the
 * adapter's reference, so the vat carrying the host port capabilities has no
 * memory of who asked for what, and this one — which does — survives to keep
 * enforcing it.
 *
 * Holding a consumer's handler retains that consumer's vat. That is correct: a
 * vat being served is reachable, and `stop` is how it is released.
 *
 * Self-contained: the supervisor ships this source into the manager vat,
 * along with `makeAdapterKeeper` and the adapter's source.
 *
 * @param {object} options
 * @param {any} options.makeKeeper `makeAdapterKeeper`
 * @param {any} options.vats a ThixotropeWorkerController
 * @param {string} options.adapterSource `makeHttpAdapter`, as source
 */
export const makeHttpManager = ({ makeKeeper, vats, adapterSource }) => {
  /** @type {Map<string, {port: any, consumer: any, policy: any}>} */
  const desired = new Map();

  // The keeper is built here rather than passed in because restoring a fresh
  // adapter means replaying this map, and only this vat has it.
  const keeper = makeKeeper({
    vats,
    source: adapterSource,
    debugLabel: 'http-adapter',
    restore: adapter =>
      E(adapter).restore(
        [...desired.values()].map(({ port, consumer, policy }) =>
          harden([port, consumer, policy]),
        ),
      ),
  });

  /** @type {string | undefined} */
  let lastStartError;

  /** @param {string} id */
  const assertId = id => {
    if (typeof id !== 'string' || id.length === 0 || id.length > 128)
      throw Error('Service id must be 1 to 128 characters');
  };

  return Far('HttpManager', {
    help: () =>
      'serve(id, port, consumer) declares a service durably and binds it; stop(id) withdraws it; list() reports the desired set; reconcile() re-states everything into the current host and is what an eager pin calls after a restart.',

    /**
     * @param {string} id
     * @param {any} port an HttpPort capability, granted by the user
     * @param {any} consumer the handler to serve there
     * @param {{origins?: string[]}} [policy] admission policy for this port;
     *   same-origin only when omitted
     */
    serve: async (id, port, consumer, policy = {}) => {
      assertId(id);
      if (desired.has(id)) throw Error('Service id is already declared');
      // The declaration commits before the binding is attempted: a port that
      // cannot be bound right now is a condition to retry, not a reason to
      // forget what was asked for. That difference is the whole of desired
      // versus actual.
      desired.set(
        id,
        harden({ port, consumer, policy: harden({ ...policy }) }),
      );
      const adapter = await keeper.provide();
      const number = await E(adapter).bind(port, consumer, policy);
      return harden({ id, port: number });
    },

    /** @param {string} id */
    stop: async id => {
      const entry = desired.get(id);
      if (entry === undefined) return false;
      desired.delete(id);
      const number = await E(entry.port).getPort();
      const adapter = await keeper.provide();
      // A rejection here means the incarnation that held the binding is gone,
      // which released the port already.
      return E(adapter)
        .unbind(number)
        .catch(() => true);
    },

    /**
     * Re-state the desired set into whatever adapter is current, building one
     * if the last is gone.
     *
     * Idempotent and safe on any wake, because `provide` reuses a live adapter
     * and only rebuilds when it cannot reach one. The manager never tries to
     * work out whether the host restarted: being unable to reach the adapter is
     * the only evidence of that which exists, and `provide` already acts on it.
     */
    reconcile: async () => {
      const adapter = await keeper.provide();
      return E(adapter).ports();
    },

    /**
     * What the host calls after honouring an eager pin.
     *
     * Waking a vat runs none of its code, so without this a restored manager
     * would sit there remembering a service nobody had rebound. Send-only from
     * the host's side, so a failure is reported here rather than thrown at a
     * caller that does not exist.
     */
    started: async () => {
      try {
        const adapter = await keeper.provide();
        return await E(adapter).ports();
      } catch (error) {
        lastStartError = String(/** @type {Error} */ (error).message ?? error);
        throw error;
      }
    },

    list: () => harden([...desired.keys()]),

    status: async () =>
      harden({
        declared: BigInt(desired.size),
        keeper: keeper.status(),
        lastStartError,
      }),
  });
};
harden(makeHttpManager);
