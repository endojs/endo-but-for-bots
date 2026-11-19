// @ts-check
/**
 * The manager half of the attach pattern (architecture D-7, spike S2), once
 * for every native resource whose manager forwards to its adapter's ops
 * facet (`designs/m6-interfaces.md` D-M6-13, X-16).
 *
 * A manager registers one service key whose spec carries its sink; the
 * adapter's `bind` calls `sink.attach(ops, incarnation)`, and the sink hands
 * that ops facet to `attach` here. `withOps(fn, { write })` calls the
 * current ops facet:
 *
 * - no ops facet yet (a fresh manager, or one whose facet broke): reconcile
 *   first (the kit builds or restores the adapter, which attaches);
 * - a retired break (the adapter restarted): the facet is dropped, so the
 *   next call reconciles before it sends anything; a read (`write` false)
 *   reconciles now and is called once more; a write is never sent twice
 *   (a retired break does not say whether it was applied, HR-SYN-8) and
 *   rejects with `writeBroken(error)`;
 * - any other failure passes through unchanged.
 *
 * Concurrent reconciles share one: a burst of calls after a restart makes
 * one registration, not one per call.
 *
 * Runs in a manager vat (prelude globals only; no clock, timers or
 * randomness) and in Node tests. The agent host's own copy (`withOps` in
 * `resources/agent-host/durable.js`) adopts this module at its next manager
 * reinstall (contract section 14).
 */

/**
 * @typedef {object} AttachedOps
 * @property {<T>(fn: (ops: any) => Promise<T>, options?: { write?: boolean }) => Promise<T>} withOps
 * @property {(ops: any) => void} attach the sink's attach: this incarnation's ops facet
 * @property {() => any} current the ops facet attached last, or `undefined`
 */

/**
 * @param {object} powers
 * @param {() => Promise<unknown>} powers.reconcile desire the service
 *   registration again and wait for it (the adapter attaches during it)
 * @param {(error: unknown) => boolean} powers.isRetired whether a failure is
 *   the hub's retired break (`guest/lib/retired.js`)
 * @param {(error: unknown) => Error} [powers.writeBroken] what a write whose
 *   call broke rejects with; the break itself by default
 * @returns {AttachedOps}
 */
export const makeAttachedOps = ({
  reconcile,
  isRetired,
  writeBroken = error => /** @type {Error} */ (error),
}) => {
  /** @type {any} */
  let ops;
  /** @type {Promise<void> | undefined} */
  let reconciling;

  /** One reconcile at a time; the callers waiting share it. */
  const reattach = () => {
    if (reconciling === undefined) {
      reconciling = (async () => {
        try {
          await reconcile();
        } finally {
          reconciling = undefined;
        }
      })();
    }
    return reconciling;
  };

  /** The facet after a reconcile, or a plain failure saying none attached. */
  const attached = async () => {
    if (ops === undefined) await reattach();
    if (ops === undefined) throw Error('the adapter did not attach');
    return ops;
  };

  return harden({
    withOps: async (fn, { write = false } = {}) => {
      const first = await attached();
      try {
        return await fn(first);
      } catch (error) {
        if (!isRetired(error)) throw error;
        // Only the facet that broke is dropped: an attach that raced this
        // call keeps its fresh facet.
        if (ops === first) ops = undefined;
        if (write) throw writeBroken(error);
        return fn(await attached());
      }
    },
    attach: facet => {
      ops = facet;
    },
    current: () => ops,
  });
};
harden(makeAttachedOps);
