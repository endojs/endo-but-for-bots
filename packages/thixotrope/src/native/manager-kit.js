// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * What a durable native manager has to do that is not about its resource:
 * keep the desired registrations in its heap, hold one disposable adapter
 * incarnation through a keeper, reconcile each registration against the
 * adapter, hand out a per-registration handle that reports status and closes
 * only its own generation, withdraw a registration durably before telling
 * the adapter, retire an incarnation whose unbinding is uncertain, and rebuild
 * the adapter at startup when there is anything to restore. This factory
 * writes all of that once. A resource author supplies the identity of a
 * registration and how to describe its state; the adapter side, built with
 * `makeAdapter`, supplies the verbs.
 *
 * The manager and the adapter speak one protocol: `bind(key, spec)`,
 * `unbind(key)`, `restore([[key, spec], ...])` and `keys()`, where `spec` is
 * whatever passable record the author registers under a key.
 *
 * Self-contained: this factory's source is evaluated in the manager vat,
 * where only E, Far and harden are in scope.
 *
 * @template Spec
 * @param {{ adapters: any, makeKeeper: any }} powers the adapter launcher
 *   the host installed the manager with, and the keeper factory
 * @param {object} options
 * @param {string} options.label what a key names, for messages
 * @param {(existing: Spec, wanted: Spec) => boolean} options.same
 *   whether a registration already in place is the one wanted, so that
 *   registering it again changes nothing. A spec is usually a record built
 *   for each registration, so identity would refuse the same registration
 *   made twice; the author says what sameness is.
 * @param {(existing: Spec, wanted: Spec) => boolean} [options.replaces]
 *   whether a differing registration may take the place of the existing one
 *   under the same key, in which case the adapter is told to rebind; never by
 *   default, so the key is refused as already registered
 * @param {(key: unknown, spec: Spec, state: 'bound' | 'inactive' | 'closed', error?: string) => unknown} options.describe
 *   the status record a handle reports
 */
export const makeManager = (
  { adapters, makeKeeper },
  { label, same, replaces = () => false, describe },
) => {
  if (typeof label !== 'string') throw Error('makeManager needs a label');
  if (typeof same !== 'function') throw Error('makeManager needs same()');
  if (typeof describe !== 'function')
    throw Error('makeManager needs describe()');
  /**
   * Desired state, one mutable record per key. The handle a caller holds is
   * bound to its record, so a later registration under the same key cannot
   * be closed through a handle from an earlier one.
   * @type {Map<unknown, {spec: Spec, handle: any}>}
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
        harden([...desired].map(([key, { spec }]) => harden([key, spec]))),
      ),
  });
  /** @param {unknown} reason */
  const describeError = reason =>
    String(/** @type {Error} */ (reason)?.message ?? reason).slice(0, 512);
  /**
   * A failed bind retains the desired state but must not withhold the close
   * handle; status retries reconciliation and reports the current outcome.
   * @param {unknown} key
   * @param {{spec: Spec}} entry
   */
  const reconcile = async (key, entry) => {
    try {
      const adapter = await keeper.provide();
      await E(adapter).bind(key, entry.spec);
      return harden(describe(key, entry.spec, 'bound'));
    } catch (error) {
      return harden(
        describe(key, entry.spec, 'inactive', describeError(error)),
      );
    }
  };
  return harden({
    /**
     * Desire a registration under a key and reconcile it now. Returns the
     * handle for it, the same handle for the same registration. The spec is
     * hardened here, since it is kept and sent as it is.
     * @param {unknown} key
     * @param {Spec} spec
     */
    register: (key, spec) =>
      enqueue(async () => {
        await null;
        harden(spec);
        let entry = desired.get(key);
        if (entry === undefined) {
          /** @type {{spec: Spec, handle: any}} */
          const created = { spec, handle: undefined };
          created.handle = Far('RegistrationHandle', {
            status: () =>
              enqueue(async () => {
                if (desired.get(key) !== created)
                  return harden(describe(key, created.spec, 'closed'));
                return reconcile(key, created);
              }),
            close: () =>
              enqueue(async () => {
                if (desired.get(key) !== created) return false;
                // Withdrawing desired state is the durable part and is done
                // first; a future incarnation restores without this key.
                desired.delete(key);
                // Only a live adapter has anything to unbind. Building one
                // just to tell it about a key it never bound would restore
                // every other registration as a side effect.
                const adapter = keeper.current();
                if (adapter === undefined) return true;
                try {
                  await E(adapter).unbind(key);
                } catch (_error) {
                  // The binding is uncertain: retire the whole incarnation so
                  // the resource is released with its process, and the
                  // remaining registrations rebuild on next use. Retirement
                  // kills the process before reporting any failure it
                  // recorded; the one case retirement cannot reach the host
                  // at all is one where unbind could not have reached the
                  // adapter either.
                  await keeper.retire().catch(() => {});
                }
                return true;
              }),
          });
          entry = created;
          desired.set(key, entry);
        } else if (!same(entry.spec, spec)) {
          if (!replaces(entry.spec, spec))
            throw Error(`${label} is already registered`);
          // The desired state changes and the adapter is told to rebind.
          entry.spec = spec;
        }
        await reconcile(key, entry);
        return entry.handle;
      }),
    /** The keys currently desired, for a public facet that lists them. */
    keys: () => harden([...desired.keys()]),
    /**
     * The facet the host notifies at every daemon start: rebuild the adapter
     * if anything is desired, so restored registrations are in place before
     * the start is reported.
     */
    lifecycle: Far('ManagerLifecycle', {
      started: () =>
        enqueue(async () => {
          if (desired.size > 0) await keeper.provide();
        }),
    }),
  });
};
harden(makeManager);
