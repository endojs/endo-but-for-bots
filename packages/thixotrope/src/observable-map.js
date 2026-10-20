// @ts-check
import { makeExo } from '@endo/exo';
import { E } from '@endo/far';
import harden from '@endo/harden';
import { M } from '@endo/patterns';

/**
 * A string-keyed Map whose mutations are observable: `subscribe` delivers a
 * display snapshot of the whole map on every revision, at most one
 * notification outstanding per listener.
 *
 * Entries are held by ordinary heap reference, so membership here is not a
 * separate lifetime regime — the workspace inventory and the conventional
 * `contacts` address book are both just instances of this.
 *
 * Notifications carry descriptions, never the values themselves, so an
 * observer can render the map without receiving the capabilities in it.
 *
 * `keyOf(value)` is the reverse lookup, kept as an index rather than a scan
 * so that labelling a row costs nothing proportional to the map. When the
 * same value sits under several keys, the key set most recently wins, and
 * deleting it falls back to the others in reverse order of setting.
 *
 * This factory is shipped by source: the supervisor evaluates it in a guest
 * compartment, so it may import only what the guest prelude provides.
 */
export const makeObservableMap = () => {
  // Shipped by source: the guards travel with the factory, defined here.
  // Values are held as given, whatever they are: raw guards leave them alone.
  const ObservableMapI = M.interface('ObservableMap', {
    help: M.call().returns(M.string()),
    get: M.call(M.string()).returns(M.raw()),
    has: M.call(M.string()).returns(M.boolean()),
    set: M.call(M.string(), M.raw()).returns(M.remotable('map')),
    delete: M.call(M.string()).returns(M.boolean()),
    clear: M.call().returns(M.undefined()),
    keys: M.call().returns(M.arrayOf(M.string())),
    entries: M.call().returns(M.raw()),
    getSize: M.call().returns(M.number()),
    keyOf: M.call(M.raw()).returns(M.opt(M.string())),
    snapshot: M.call().returns(M.record()),
    // A listener may be a plain local object with a `changed` method, as
    // guest code writes it, or a presence from another vat: left raw.
    subscribe: M.call(M.raw())
      .optional(M.boolean())
      .returns(M.remotable('subscription')),
    disconnectEphemeral: M.call().returns(M.undefined()),
    subscriptionCounts: M.call().returns(M.record()),
  });
  const ObservableMapSubscriptionI = M.interface('ObservableMapSubscription', {
    unsubscribe: M.call().returns(M.undefined()),
  });

  /** @type {Map<string, any>} */
  const values = new Map();
  // Reverse index: value → the keys holding it, in the order they were set.
  /** @type {Map<any, Set<string>>} */
  const holders = new Map();
  /** @type {Set<any>} */
  const subscriptions = new Set();
  let revision = 0n;
  /** @param {any} value */
  const describe = value => {
    if (typeof value === 'string') return JSON.stringify(value.slice(0, 160));
    if (typeof value === 'bigint') return `${value}n`;
    if (value === null) return 'null';
    if (typeof value === 'object' || typeof value === 'function')
      return '<object / capability>';
    if (typeof value === 'symbol') return '<symbol>';
    return String(value);
  };
  const snapshot = () =>
    harden({
      revision,
      entries: [...values].map(([key, value]) =>
        harden([key, describe(value)]),
      ),
    });
  /** @param {any} state */
  const cancel = state => {
    subscriptions.delete(state);
    state.active = false;
    state.listener = undefined;
    state.pending = undefined;
  };
  /** @param {any} state */
  const pump = state => {
    if (!state.active || state.busy || state.pending === undefined) return;
    const update = state.pending;
    state.pending = undefined;
    state.busy = true;
    void E(state.listener)
      .changed(update)
      .then(
        () => {
          state.busy = false;
          pump(state);
        },
        () => cancel(state),
      );
  };
  const changed = () => {
    revision += 1n;
    if (subscriptions.size === 0) return;
    const update = snapshot();
    for (const state of subscriptions) {
      state.pending = update;
      pump(state);
    }
  };
  /**
   * @param {string} key
   * @param {any} value
   */
  const hold = (key, value) => {
    let keys = holders.get(value);
    if (keys === undefined) {
      keys = new Set();
      holders.set(value, keys);
    }
    keys.add(key);
  };
  /**
   * @param {string} key
   * @param {any} value
   */
  const release = (key, value) => {
    const keys = holders.get(value);
    if (keys === undefined) return;
    keys.delete(key);
    if (keys.size === 0) holders.delete(value);
  };
  const observableMap = makeExo('ObservableMap', ObservableMapI, {
    help: () =>
      'Observable Map: get, has, set, delete, clear, keys, entries, getSize, keyOf(value); subscribe(listener, ephemeral?) sends display snapshots to listener.changed. Subscription.unsubscribe releases it.',
    /** @param {string} key */
    get: key => values.get(key),
    /** @param {string} key */
    has: key => values.has(key),
    /**
     * @param {string} key
     * @param {any} value
     */
    set: (key, value) => {
      if (!values.has(key) || !Object.is(values.get(key), value)) {
        if (values.has(key)) release(key, values.get(key));
        values.set(key, value);
        hold(key, value);
        changed();
      }
      return observableMap;
    },
    /** @param {string} key */
    delete: key => {
      if (!values.has(key)) return false;
      release(key, values.get(key));
      values.delete(key);
      changed();
      return true;
    },
    clear: () => {
      if (values.size) {
        values.clear();
        holders.clear();
        changed();
      }
    },
    keys: () => harden([...values.keys()]),
    entries: () => harden([...values]),
    getSize: () => values.size,
    /**
     * The key most recently set to this value, or undefined if no key holds
     * it. Values compare as Map keys do (SameValueZero).
     * @param {any} value
     */
    keyOf: value => {
      const keys = holders.get(value);
      if (keys === undefined) return undefined;
      /** @type {string | undefined} */
      let last;
      for (const key of keys) last = key;
      return last;
    },
    snapshot,
    /**
     * At most one notification is outstanding per listener. While it is busy,
     * retain the newest snapshot instead of accumulating mutation history.
     * @param {any} listener
     * @param {boolean} [ephemeral]
     */
    subscribe: (listener, ephemeral = false) => {
      const state = {
        listener,
        ephemeral,
        active: true,
        busy: false,
        pending: snapshot(),
      };
      subscriptions.add(state);
      pump(state);
      return makeExo('ObservableMapSubscription', ObservableMapSubscriptionI, {
        unsubscribe: () => cancel(state),
      });
    },
    // Supervisor restart is a lifetime boundary for all old UI connections.
    disconnectEphemeral: () => {
      for (const state of subscriptions) if (state.ephemeral) cancel(state);
    },
    subscriptionCounts: () => {
      let durable = 0n;
      let ephemeral = 0n;
      for (const state of subscriptions) {
        if (state.ephemeral) ephemeral += 1n;
        else durable += 1n;
      }
      return harden({ durable, ephemeral });
    },
  });
  return observableMap;
};
harden(makeObservableMap);

/**
 * @typedef {ReturnType<typeof makeObservableMap>} ObservableMap
 */
