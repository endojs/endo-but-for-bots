// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

/**
 * An inventory with ordinary heap reachability and observable mutations.
 * This self-contained factory also runs in a guest compartment with E/Far/harden.
 * Notifications contain display summaries; get()/entries() retain actual values.
 */
export const makeObservableInventory = () => {
  /** @type {Map<string, any>} */
  const values = new Map();
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
  /** @param {string} key */
  const assertKey = key => {
    if (typeof key !== 'string') throw Error('Inventory keys must be strings');
  };
  const inventory = Far('ObservableInventory', {
    help: () =>
      'Map-like inventory: get, has, set, delete, clear, keys, entries, getSize; subscribe(listener, ephemeral?) sends display snapshots to listener.changed. Subscription.unsubscribe releases it.',
    /** @param {string} key */
    get: key => {
      assertKey(key);
      return values.get(key);
    },
    /** @param {string} key */
    has: key => {
      assertKey(key);
      return values.has(key);
    },
    /**
     * @param {string} key @param {any} value
     * @param value
     */
    set: (key, value) => {
      assertKey(key);
      if (!values.has(key) || !Object.is(values.get(key), value)) {
        values.set(key, value);
        changed();
      }
      return inventory;
    },
    /** @param {string} key */
    delete: key => {
      assertKey(key);
      const deleted = values.delete(key);
      if (deleted) changed();
      return deleted;
    },
    clear: () => {
      if (values.size) {
        values.clear();
        changed();
      }
    },
    keys: () => harden([...values.keys()]),
    entries: () => harden([...values]),
    getSize: () => values.size,
    snapshot,
    /**
     * At most one notification is outstanding per listener. While it is busy,
     * retain the newest snapshot instead of accumulating mutation history.
     * @param {any} listener
     * @param {boolean} [ephemeral]
     */
    subscribe: (listener, ephemeral = false) => {
      if (typeof ephemeral !== 'boolean')
        throw Error('Expected ephemeral boolean');
      const state = {
        listener,
        ephemeral,
        active: true,
        busy: false,
        pending: snapshot(),
      };
      subscriptions.add(state);
      pump(state);
      return Far('InventorySubscription', { unsubscribe: () => cancel(state) });
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
  return inventory;
};
harden(makeObservableInventory);

/**
 * The observable, Map-like inventory a guest exposes to its user.
 * Consumers that only need the Map surface still take the whole
 * inventory so that reads and writes remain observable.
 * @typedef {ReturnType<typeof makeObservableInventory>} ObservableInventory
 */
