// @ts-check
/**
 * Throwaway native resource for spikes S2, S4, S7 and S9 (milestones.md M0,
 * W0.6): the durable (manager vat) half of the attach pattern of
 * architecture.md D-7.
 *
 * - One registration under the key 'service' whose spec carries a
 *   manager-owned AttachSink. The adapter's bind calls
 *   `E(spec.sink).attach(ops, incarnation)`, so after every restart the
 *   manager's restore hands this vat a fresh ops facet.
 * - `open()` forwards to the current ops facet and returns the adapter-side
 *   endpoint, which callers then use directly (the manager is on the path
 *   once per open, not per operation).
 * - `subscribe(listener)` registers a spec that carries a foreign remotable
 *   (the caller's listener), for S7.
 *
 * Only the guest prelude is available here (shipped by source).
 */
const { E, Far, harden } = /** @type {any} */ (globalThis);

/**
 * @param {{ makeManager: (options: any) => any }} powers
 */
export const make = ({ makeManager }) => {
  /** The ops facet of the adapter incarnation that attached last. */
  let ops;
  let attaches = 0;
  /** @type {string | undefined} */
  let incarnation;
  /** Opens that found a retired ops facet and re-attached. */
  let staleOpens = 0;
  let subscriptions = 0;

  const manager = makeManager({
    label: 'SpikeService',
    // A key is registered again only to reconcile it; nothing replaces it.
    same: () => true,
  });

  const sink = Far('AttachSink', {
    /**
     * @param {any} opsFacet
     * @param {string} which
     */
    attach: (opsFacet, which) => {
      ops = opsFacet;
      attaches += 1;
      incarnation = which;
      return attaches;
    },
  });

  /**
   * Desire the service registration and reconcile it: on a fresh manager
   * this builds the adapter (which attaches); after a restart it waits
   * behind the restore that re-attaches.
   */
  const reconcile = async () => {
    const { status } = await manager.register('service', harden({ sink }));
    if (status.status !== 'bound')
      throw Error(`spike service not bound: ${status.error ?? status.status}`);
  };

  /**
   * Call the current ops facet; a retired one is replaced by reconciling
   * once and the call is made again.
   * @param {(current: any) => Promise<any>} fn
   */
  const withOps = async fn => {
    if (ops === undefined) await reconcile();
    try {
      return await fn(ops);
    } catch (error) {
      if (!String(/** @type {any} */ (error)?.message).includes('retired'))
        throw error;
      staleOpens += 1;
      await reconcile();
      return fn(ops);
    }
  };

  const facet = Far('SpikeService', {
    open: () => withOps(current => E(current).open()),
    /** @param {any} obj a vat object, forwarded to the adapter (S2 d) */
    relay: obj => withOps(current => E(current).see(obj)),
    attachInfo: () => harden({ attaches, incarnation, staleOpens }),
    /** @param {any} listener a remotable of another vat (S7) */
    subscribe: async listener => {
      subscriptions += 1;
      const { status } = await manager.register(
        `sub${subscriptions}`,
        harden({ listener }),
      );
      return harden({ key: `sub${subscriptions}`, status: status.status });
    },
    /** @param {string} text */
    broadcast: text => withOps(current => E(current).broadcast(text)),
    keys: () => manager.keys(),
  });
  return harden({ facet, lifecycle: manager.lifecycle });
};
harden(make);
