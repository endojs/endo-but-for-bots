// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';

import { describeError } from '../describe-error.js';
import { makeSerialQueue } from '../serial-queue.js';

/**
 * What a durable native manager has to do that is not about its resource:
 * keep the desired registrations in its heap, hold one disposable adapter
 * incarnation through a keeper, reconcile each registration against the
 * adapter, hand out a per-registration handle that reports status and closes
 * only its own generation, withdraw a registration durably before telling
 * the adapter, retire an incarnation whose unbinding is uncertain, and rebuild
 * the adapter at startup and after its own exit when there is anything to
 * restore. This factory writes all of that once. A resource author supplies
 * a label and, optionally, which registrations are the same, which may
 * replace one another and what a status carries; the adapter side, built
 * with `makeAdapter`, supplies the verbs.
 *
 * The manager and the adapter speak one protocol: `bind(key, spec, epoch)`,
 * `unbind(key)` and `restore([[key, spec, epoch], ...])`, where `spec` is
 * whatever passable record the author registers under a key and `epoch`
 * names the registration, new for each one made or replaced, so the adapter
 * tells the same registration from its replacement without asking the
 * author. A bind or a restore may answer a resolved spec, what the
 * registration became once bound; the manager adopts it as the desired
 * spec, so `same`, `decorate` and the next restore all see the resolved
 * form.
 *
 * Shipped by source: this factory is evaluated in the manager vat, so it
 * may import only what the guest prelude provides, under those names.
 *
 * @template Spec
 * @param {{ adapters: any, makeKeeper: any }} powers the adapter launcher
 *   the host installed the manager with, and the keeper factory; bound by
 *   the native manager, so a durable module receives `makeManager` alone
 * @param {object} options
 * @param {string} options.label what a key names, for messages
 * @param {(existing: Spec, wanted: Spec) => boolean} [options.same]
 *   whether a registration already in place is the one wanted, so that
 *   registering it again changes nothing; never by default, for keys that
 *   are never registered twice. A spec is usually a record built for each
 *   registration, so identity would refuse the same registration made
 *   twice; the author says what sameness is. Once a registration has
 *   resolved, `existing` is the resolved form while a consumer may well
 *   register the unresolved one again, so `same` must accept a wanted spec
 *   that leaves open what the existing one settled.
 * @param {(existing: Spec, wanted: Spec) => boolean} [options.replaces]
 *   whether a differing registration may take the place of the existing one
 *   under the same key, in which case it takes a new epoch and the adapter
 *   rebinds; never by default, so the key is refused as already registered
 * @param {(key: unknown, spec: Spec, status: 'bound' | 'inactive') => Record<string, unknown>} [options.decorate]
 *   fields a status record carries beside the kit's own `key`, `status`
 *   and `error`, from what the registration is (the URL a listener serves,
 *   the deadline an alarm keeps); a field under one of the kit's names is
 *   dropped. The answer is hardened, so it must be a fresh record of
 *   passable fields, and anything else, a promise included, adds nothing.
 *   Never asked of a closed registration, which no longer names what it
 *   was made with
 */
export const makeManager = (
  { adapters, makeKeeper },
  { label, same = () => false, replaces = () => false, decorate = undefined },
) => {
  if (typeof label !== 'string') throw Error('makeManager needs a label');
  for (const [name, option] of [
    ['same', same],
    ['replaces', replaces],
    ['decorate', decorate],
  ]) {
    if (option !== undefined && typeof option !== 'function')
      throw Error(`makeManager ${name} must be a function`);
  }
  /**
   * The status record a handle reports: one shape and one word for each
   * state across every resource, `bound`, `inactive` or `closed`, with
   * what the author adds beside it.
   * @param {unknown} key
   * @param {Spec | undefined} spec
   * @param {'bound' | 'inactive' | 'closed'} status
   * @param {string} [error]
   */
  const report = (key, spec, status, error = undefined) => {
    /** @type {Array<[string, unknown]>} */
    let fields = [];
    if (spec !== undefined && status !== 'closed' && decorate !== undefined) {
      try {
        // Only a record of passable fields decorates a status, which may
        // cross to another vat.
        const extra = harden(decorate(key, spec, status));
        const style = passStyleOf(extra);
        if (style === 'copyRecord') fields = Object.entries(extra);
        // A promise is no record, and its rejection is no one's to report.
        else if (style === 'promise')
          void Promise.resolve(extra).catch(() => {});
      } catch (_error) {
        // What the author adds is decoration: a status is reported, and a
        // registration kept closable, whatever it threw.
      }
    }
    return harden({
      ...Object.fromEntries(
        fields.filter(([field]) => !['key', 'status', 'error'].includes(field)),
      ),
      key,
      status,
      ...(error === undefined ? {} : { error }),
    });
  };
  /**
   * Desired state, one mutable record per key. The handle a caller holds is
   * bound to its record, so a later registration under the same key cannot
   * be closed through a handle from an earlier one. A desired record always
   * has its spec; a closed one has dropped it. Its epoch names the
   * registration to the adapter.
   * @type {Map<unknown, {spec: Spec | undefined, epoch: bigint, handle: any}>}
   */
  const desired = new Map();
  /** The epoch last given; each registration made or replaced takes the next. */
  let epochs = 0n;
  const nextEpoch = () => {
    epochs += 1n;
    return epochs;
  };
  const enqueue = makeSerialQueue();
  /**
   * Adopt what the adapter says a registration became, if it is still the
   * desired registration under its key.
   * @param {unknown} key
   * @param {{spec: Spec | undefined}} entry
   * @param {Spec | undefined} resolved
   */
  const adopt = (key, entry, resolved) => {
    if (resolved === undefined || desired.get(key) !== entry) return;
    entry.spec = harden(resolved);
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
    restore: async adapter => {
      const entries = [...desired];
      /** @type {Array<{ key: unknown, spec?: Spec, error?: string }>} */
      const results = await E(adapter).restore(
        harden(
          entries.map(([key, { spec, epoch }]) => harden([key, spec, epoch])),
        ),
      );
      // An adapter that reports nothing resolved nothing; one that answers
      // out of shape is the author's problem to see in status, not a reason
      // for the manager to lose its restore.
      if (!Array.isArray(results)) return;
      for (const result of results) {
        const entry =
          typeof result === 'object' && result !== null
            ? desired.get(result.key)
            : undefined;
        if (entry !== undefined) adopt(result.key, entry, result.spec);
      }
    },
  });
  const rebuildIfDesired = () =>
    enqueue(async () => {
      if (desired.size > 0) await keeper.provide();
    });
  /**
   * A failed bind retains the desired state but must not withhold the close
   * handle; status retries reconciliation and reports the current outcome.
   * @param {unknown} key
   * @param {{spec: Spec | undefined, epoch: bigint}} entry a desired
   *   record, so its spec is present
   */
  const reconcile = async (key, entry) => {
    try {
      const adapter = await keeper.provide();
      // Providing may have built an incarnation and restored this very
      // registration, adopting what it resolved to; bind the desired spec
      // as it is now, not as it was when the operation began.
      adopt(
        key,
        entry,
        await E(adapter).bind(
          key,
          /** @type {Spec} */ (entry.spec),
          entry.epoch,
        ),
      );
      return report(key, entry.spec, 'bound');
    } catch (error) {
      return report(key, entry.spec, 'inactive', describeError(error));
    }
  };
  return harden({
    /**
     * Desire a registration under a key and reconcile it now. Returns the
     * handle for it, the same handle for the same registration, with the
     * status the reconciliation reported, so a caller that cannot use an
     * inactive registration learns so without binding it again. The spec is
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
          /** @type {{spec: Spec | undefined, epoch: bigint, handle: any}} */
          const created = { spec, epoch: nextEpoch(), handle: undefined };
          created.handle = Far('RegistrationHandle', {
            status: () =>
              enqueue(async () => {
                if (desired.get(key) !== created)
                  return report(key, undefined, 'closed');
                return reconcile(key, created);
              }),
            close: () =>
              enqueue(async () => {
                if (desired.get(key) !== created) return false;
                // Withdrawing desired state is the durable part and is done
                // first; a future incarnation restores without this key. The
                // spec goes with it: a closed handle a consumer keeps must
                // not keep naming the consumer's own objects, or the manager
                // would retain that consumer's vat for as long as the handle
                // lives.
                desired.delete(key);
                created.spec = undefined;
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
        } else {
          // A desired record has its spec.
          const existing = /** @type {Spec} */ (entry.spec);
          if (!same(existing, spec)) {
            if (!replaces(existing, spec))
              throw Error(`${label} is already registered`);
            // The desired state changes, under a new epoch, so the adapter
            // rebinds.
            entry.spec = spec;
            entry.epoch = nextEpoch();
            let status = await reconcile(key, entry);
            // A replacement the adapter did not take may have left the
            // replaced binding in place, its release having failed. The
            // adapter is asked to let it go, as a close does; only if that is
            // uncertain is the incarnation retired, so the binding goes with
            // its process, and the replacement reconciled on a fresh one,
            // which restores every desired registration.
            const adapter = keeper.current();
            if (status.status === 'inactive' && adapter !== undefined) {
              try {
                // A release that succeeds now leaves the key free, so the
                // replacement is bound again rather than left inactive.
                if (await E(adapter).unbind(key))
                  status = await reconcile(key, entry);
              } catch (_error) {
                await keeper.retire().catch(() => {});
                status = await reconcile(key, entry);
              }
            }
            return harden({ handle: entry.handle, status });
          }
        }
        const status = await reconcile(key, entry);
        return harden({ handle: entry.handle, status });
      }),
    /** The keys currently desired, for a public facet that lists them. */
    keys: () => harden([...desired.keys()]),
    /**
     * The facet the host notifies at every daemon start, and whenever an
     * adapter of this manager exits on its own: rebuild the adapter if
     * anything is desired, so restored registrations are in place before the
     * start is reported, and come back between starts without waiting for
     * the next operation that needs them.
     */
    lifecycle: Far('ManagerLifecycle', {
      started: () => rebuildIfDesired(),
      exited: () => rebuildIfDesired(),
    }),
  });
};
harden(makeManager);
