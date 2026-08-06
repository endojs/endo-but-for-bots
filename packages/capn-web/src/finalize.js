import harden from '@endo/harden';

const { WeakRef, FinalizationRegistry } = globalThis;

/**
 * @template K
 * @template {object} V
 * @typedef {{
 *   get: (key: K) => V | undefined,
 *   has: (key: K) => boolean,
 *   set: (key: K, value: V) => void,
 *   delete: (key: K) => boolean,
 *   getSize: () => number,
 *   clearWithoutFinalizing: () => void,
 * }} FinalizingMap
 */

/**
 * A weak-value map: weak on values, strong on keys.  When a value is GC'd,
 * the entry disappears and the optional finalizer is invoked with the key.
 *
 * If WeakRef / FinalizationRegistry are unavailable or weakValues is false,
 * falls back to a strong Map (no GC notifications).
 *
 * @template K
 * @template {object} V
 * @param {(key: K) => void} [finalizer]
 * @param {{ weakValues?: boolean }} [options]
 * @returns {FinalizingMap<K, V>}
 */
export const makeFinalizingMap = (finalizer, options) => {
  const { weakValues = false } = options || {};
  if (!weakValues || !WeakRef || !FinalizationRegistry) {
    /** @type {Map<K, V>} */
    const keyToValue = new Map();
    return harden({
      get: key => keyToValue.get(key),
      has: key => keyToValue.has(key),
      set: (key, value) => {
        keyToValue.set(key, value);
      },
      delete: key => keyToValue.delete(key),
      getSize: () => keyToValue.size,
      clearWithoutFinalizing: () => keyToValue.clear(),
    });
  }
  /** @type {Map<K, WeakRef<any>>} */
  const keyToWeakRef = new Map();
  /** @type {FinalizationRegistry<K>} */
  const registry = new FinalizationRegistry(key => {
    finalizingMap.delete(key);
  });
  const finalizingMap = harden({
    clearWithoutFinalizing: () => {
      for (const weakRef of keyToWeakRef.values()) {
        registry.unregister(weakRef);
      }
      keyToWeakRef.clear();
    },
    get: key => {
      const weakRef = keyToWeakRef.get(key);
      if (!weakRef) return undefined;
      return weakRef.deref();
    },
    has: key => finalizingMap.get(key) !== undefined,
    set: (key, value) => {
      finalizingMap.delete(key);
      const weakRef = new WeakRef(value);
      keyToWeakRef.set(key, weakRef);
      registry.register(value, key, weakRef);
    },
    delete: key => {
      const weakRef = keyToWeakRef.get(key);
      if (!weakRef) return false;
      registry.unregister(weakRef);
      keyToWeakRef.delete(key);
      if (finalizer) {
        finalizer(key);
      }
      return true;
    },
    getSize: () => keyToWeakRef.size,
  });
  return finalizingMap;
};
