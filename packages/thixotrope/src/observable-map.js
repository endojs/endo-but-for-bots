// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';

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
 * This factory is self-contained: the supervisor also ships its source into
 * a guest compartment, where only E, Far, and harden are in scope.
 */
export const makeObservableMap = () => {
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
    if (typeof key !== 'string') throw Error('Keys must be strings');
  };
  const observableMap = Far('ObservableMap', {
    help: () =>
      'Observable Map: get, has, set, delete, clear, keys, entries, getSize; subscribe(listener, ephemeral?) sends display snapshots to listener.changed. Subscription.unsubscribe releases it.',
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
      return observableMap;
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
      return Far('ObservableMapSubscription', {
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
