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
 * path. The three-state recipe machine this replaces existed only because that
 * information lived on the ephemeral side.
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
  /**
   * What the user asked for, keyed by port.
   *
   * Three states, because a grant that has not been configured yet is not the
   * same as one that was closed: `allocated` is authority handed out and unused,
   * `open` is a handler declared, `closed` is released for good. Only `open`
   * entries are bound into an adapter.
   *
   * This is a state machine, and it survives the move into the vat — what does
   * not survive is serialising it: no metadata file, no version field, no
   * restore path, because a vat's heap is the durable record.
   *
   * @type {Map<string, {port: any, consumer: any, policy: any, state: 'allocated' | 'open' | 'closed'}>}
   */
  const desired = new Map();

  // The keeper is built here rather than passed in because restoring a fresh
  // adapter means replaying this map, and only this vat has it.
  const keeper = makeKeeper({
    vats,
    source: adapterSource,
    debugLabel: 'http-adapter',
    restore: adapter =>
      E(adapter).restore(
        [...desired.values()]
          .filter(({ state }) => state === 'open')
          .map(({ port, consumer, policy }) =>
            harden([port, consumer, policy]),
          ),
      ),
  });

  /** @type {string | undefined} */
  let lastStartError;

  /**
   * Desired and actual, reported together, because they answer different
   * questions: whether the user asked for this, and whether it is bound in the
   * host running now.
   *
   * @param {string} id
   */
  const statusOf = async id => {
    const entry = desired.get(id);
    const port =
      entry === undefined ? Number(id) : await E(entry.port).getPort();
    let bound = [];
    try {
      bound = await E(await keeper.provide()).ports();
    } catch (error) {
      return harden({
        id,
        port,
        desired: entry === undefined ? 'closed' : 'open',
        status: 'failed',
        error: String(/** @type {Error} */ (error).message ?? error),
      });
    }
    const listening = bound.includes(port);
    return harden({
      id,
      port,
      desired: entry?.state ?? 'closed',
      status: listening ? 'listening' : 'inactive',
      ...(listening ? { url: `http://127.0.0.1:${port}/` } : {}),
    });
  };

  return Far('HttpManager', {
    help: () =>
      'serve(id, port, consumer) declares a service durably and binds it; stop(id) withdraws it; list() reports the desired set; reconcile() re-states everything into the current host and is what an eager pin calls after a restart.',

    /**
     * A per-port facet for a user, shaped like the listener they are used to:
     * `listen(handler)`, `status()`, `close()`.
     *
     * Granting this rather than the raw `HttpPort` is what keeps policy here.
     * A holder can bind one port and ask about it; it cannot reach the adapter,
     * enumerate other services, or learn who else is being served.
     *
     * @param {any} port an HttpPort capability
     */
    grant: async port => {
      const number = await E(port).getPort();
      const id = `${number}`;
      if (!desired.has(id))
        desired.set(
          id,
          harden({ port, consumer: undefined, policy: {}, state: 'allocated' }),
        );
      return Far('HttpListener', {
        help: () =>
          'listen(handler) serves this port once; status() inspects it; close() releases it permanently. handler.handle({method,path,body}) must return {status,body}.',
        /**
         * @param {any} handler
         * @param {{origins?: string[]}} [policy]
         */
        listen: async (handler, policy = {}) => {
          const entry = desired.get(id);
          if (entry === undefined || entry.state !== 'allocated')
            throw Error('HTTP listener already configured');
          desired.set(
            id,
            harden({ port, consumer: handler, policy, state: 'open' }),
          );
          const adapter = await keeper.provide();
          await E(adapter).bind(port, handler, policy);
          return statusOf(id);
        },
        status: () => statusOf(id),
        close: async () => {
          const entry = desired.get(id);
          if (entry === undefined || entry.state === 'closed')
            return statusOf(id);
          desired.set(id, harden({ ...entry, state: 'closed' }));
          const adapter = await keeper.provide();
          await E(adapter)
            .unbind(number)
            .catch(() => true);
          return statusOf(id);
        },
      });
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
      // Nothing declared means nothing to rebind, and building an adapter to
      // discover that would spend a vat on an empty set.
      if (![...desired.values()].some(({ state }) => state === 'open'))
        return harden([]);
      try {
        const adapter = await keeper.provide();
        return await E(adapter).ports();
      } catch (error) {
        lastStartError = String(/** @type {Error} */ (error).message ?? error);
        throw error;
      }
    },

    list: () => Promise.all([...desired.keys()].map(statusOf)).then(harden),

    status: async () =>
      harden({
        declared: BigInt(desired.size),
        keeper: keeper.status(),
        lastStartError,
      }),
  });
};
harden(makeHttpManager);
