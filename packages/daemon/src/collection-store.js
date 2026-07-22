// @ts-check

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { M, makeCopyMap, makeCopySet } from '@endo/patterns';
import { Fail, q } from '@endo/errors';

/** @import { FormulaIdentifier, FormulaNumber, MapStore, SetStore, WeakMapStore, WeakSetStore } from './types.js' */
/** @import { Passable } from '@endo/pass-style' */

/**
 * The interface guard for a strong `MapStore`. Mirrors the `@agoric/store`
 * `MapStore` method surface and its throw semantics. Phase 1 admits scalar
 * keys (`M.scalar()`); the follow-on broadens `keyShape` to `M.key()` so
 * nested passables and remotables at any depth may key the map.
 *
 * @param {import('@endo/patterns').Pattern} keyShape
 */
export const makeMapStoreInterface = keyShape =>
  M.interface('MapStore', {
    has: M.callWhen(keyShape).returns(M.boolean()),
    get: M.callWhen(keyShape).returns(M.any()),
    init: M.callWhen(keyShape, M.any()).returns(M.undefined()),
    set: M.callWhen(keyShape, M.any()).returns(M.undefined()),
    delete: M.callWhen(keyShape).returns(M.undefined()),
    getSize: M.callWhen().returns(M.number()),
    keys: M.callWhen().returns(M.arrayOf(M.any())),
    values: M.callWhen().returns(M.arrayOf(M.any())),
    entries: M.callWhen().returns(M.arrayOf(M.array())),
    snapshot: M.callWhen().returns(M.any()),
  });

/**
 * The interface guard for a strong `SetStore`.
 *
 * @param {import('@endo/patterns').Pattern} keyShape
 */
export const makeSetStoreInterface = keyShape =>
  M.interface('SetStore', {
    has: M.callWhen(keyShape).returns(M.boolean()),
    add: M.callWhen(keyShape).returns(M.undefined()),
    delete: M.callWhen(keyShape).returns(M.undefined()),
    getSize: M.callWhen().returns(M.number()),
    keys: M.callWhen().returns(M.arrayOf(M.any())),
    entries: M.callWhen().returns(M.arrayOf(M.any())),
    snapshot: M.callWhen().returns(M.any()),
  });

/** The deliberately non-enumerable weak MapStore surface. */
export const WeakMapStoreInterface = M.interface('WeakMapStore', {
  has: M.callWhen(M.remotable()).returns(M.boolean()),
  get: M.callWhen(M.remotable()).returns(M.any()),
  init: M.callWhen(M.remotable(), M.any()).returns(M.undefined()),
  set: M.callWhen(M.remotable(), M.any()).returns(M.undefined()),
  delete: M.callWhen(M.remotable()).returns(M.undefined()),
});

/** The deliberately non-enumerable weak SetStore surface. */
export const WeakSetStoreInterface = M.interface('WeakSetStore', {
  has: M.callWhen(M.remotable()).returns(M.boolean()),
  add: M.callWhen(M.remotable()).returns(M.undefined()),
  delete: M.callWhen(M.remotable()).returns(M.undefined()),
});

/**
 * The daemon-native persistent collection family. Phase 1 implements the
 * strong `MapStore` (`kind: 'map'`) over the daemon's own durability
 * substrate — a `collection-store` formula plus the `collection_store_entry`
 * SQLite table — reusing the daemon's marshal body+slots encoding so that
 * remotable keys and values join the formula retention graph, exactly as
 * pet-store names do.
 *
 * The factory is given only the seams it needs: the persistence row ops, the
 * daemon's marshal codec, a rank encoder for canonical keys, and the formula
 * graph edge hooks. Everything stateful about a single store (its in-memory
 * index and per-slot retention counts) lives in the returned exo.
 *
 * @param {object} powers
 * @param {import('./types.js').DaemonicPersistencePowers} powers.persistence
 * @param {(value: Passable) => { body: string, slots: string[] }} powers.marshalToCapData
 *   Serialize a passable to the daemon's durable body+slots representation.
 * @param {(capData: { body: string, slots: string[] }) => Promise<Passable>} powers.unmarshalFromCapData
 *   Reconstruct a passable, resolving each slot formula first.
 * @param {(key: Passable) => string} powers.encodeKeyRank
 *   Produce a key's canonical rank encoding (its primary key within a store).
 * @param {(ids: string[]) => FormulaIdentifier[]} powers.filterLocalIds
 * @param {(ref: object) => FormulaIdentifier} powers.getIdForRef
 * @param {(id: FormulaIdentifier) => FormulaIdentifier} powers.canonicalWeakKeyId
 * @param {(formulaNumber: FormulaNumber) => FormulaIdentifier} powers.formatStoreId
 * @param {(storeId: FormulaIdentifier, ids: FormulaIdentifier[]) => Promise<void>} powers.addStoreEdges
 * @param {(storeId: FormulaIdentifier, ids: FormulaIdentifier[]) => Promise<void>} powers.removeStoreEdges
 */
export const makeCollectionStoreMaker = ({
  persistence,
  marshalToCapData,
  unmarshalFromCapData,
  encodeKeyRank,
  filterLocalIds,
  getIdForRef,
  canonicalWeakKeyId,
  formatStoreId,
  addStoreEdges,
  removeStoreEdges,
}) => {
  const { writeCollectionEntry, deleteCollectionEntry, listCollectionEntries } =
    persistence;

  /**
   * The distinct local slot ids retained by a store's persisted entries.
   * Used to seed formula-graph retention edges at daemon start, before the
   * store exo is lazily constructed, so a stored remotable is not swept.
   *
   * @param {FormulaNumber} formulaNumber
   * @returns {FormulaIdentifier[]}
   */
  const collectionRetentionSlots = (formulaNumber, kind = 'map') => {
    /** @type {Set<string>} */
    const ids = new Set();
    for (const row of listCollectionEntries(formulaNumber)) {
      if (kind !== 'weak-map' && kind !== 'weak-set') {
        for (const slot of JSON.parse(row.keySlots)) {
          ids.add(slot);
        }
      }
      if (row.valueSlots !== null) {
        for (const slot of JSON.parse(row.valueSlots)) {
          ids.add(slot);
        }
      }
    }
    return filterLocalIds([...ids]);
  };

  /** @type {Map<string, { delete: (rank: string) => void }>} */
  const liveWeakEntries = new Map();

  /** @param {FormulaNumber} formulaNumber */
  const rebuildWeakKeyIndex = formulaNumber => {
    persistence.clearCollectionWeakKeys(formulaNumber);
    for (const row of listCollectionEntries(formulaNumber)) {
      const slots = JSON.parse(row.keySlots);
      if (slots.length === 1) {
        persistence.writeCollectionWeakKey(
          canonicalWeakKeyId(slots[0]),
          formulaNumber,
          row.keyRank,
        );
      }
    }
  };

  /**
   * Synchronously remove every weak entry whose key was just collected. The
   * database operation is transactional, and returning edge removals lets the
   * manager update the formula graph before the collection turn completes.
   *
   * @param {FormulaIdentifier[]} collectedKeyIds
   */
  const collectWeakEntries = collectedKeyIds => {
    /** @type {Map<FormulaNumber, Set<FormulaIdentifier>>} */
    const candidatesByStore = new Map();
    for (const keyId of collectedKeyIds) {
      for (const row of persistence.deleteWeakCollectionEntriesForKey(keyId)) {
        liveWeakEntries
          .get(/** @type {FormulaNumber} */ (row.storeNumber))
          ?.delete(row.keyRank);
        if (row.valueSlots !== null) {
          const storeNumber = /** @type {FormulaNumber} */ (row.storeNumber);
          const candidates = candidatesByStore.get(storeNumber) ?? new Set();
          for (const id of filterLocalIds(JSON.parse(row.valueSlots))) {
            candidates.add(id);
          }
          candidatesByStore.set(storeNumber, candidates);
        }
      }
    }
    return [...candidatesByStore.entries()].map(([storeNumber, candidates]) => {
      const remaining = new Set(
        collectionRetentionSlots(
          /** @type {FormulaNumber} */ (storeNumber),
          'weak-map',
        ),
      );
      return harden({
        storeId: formatStoreId(/** @type {FormulaNumber} */ (storeNumber)),
        ids: harden([...candidates].filter(id => !remaining.has(id))),
      });
    });
  };

  /**
   * Construct (or reconstruct, after a restart) the strong `MapStore` exo
   * backed by the `collection-store` formula `storeId` / `formulaNumber`.
   *
   * @param {FormulaIdentifier} storeId
   * @param {FormulaNumber} formulaNumber
   * @returns {MapStore}
   */
  const makeIdentifiedMapStore = (storeId, formulaNumber) => {
    /**
     * key rank encoding -> the durable representation of one entry, plus the
     * local slot ids the entry retains (so overwrite/delete can release them).
     *
     * @typedef {object} Entry
     * @property {string} keyBody
     * @property {string[]} keySlots
     * @property {string} valueBody
     * @property {string[]} valueSlots
     * @property {FormulaIdentifier[]} slotIds - local ids this entry retains
     */
    /** @type {Map<string, Entry>} */
    const entriesByRank = new Map();

    /** slot id -> number of entries referencing it (retention refcount) */
    /** @type {Map<FormulaIdentifier, number>} */
    const slotCounts = new Map();

    /**
     * Apply a retention delta: bump/drop per-slot refcounts and add/remove the
     * store's formula-graph edge only on the 0<->1 boundary, so a strong store
     * retains a remotable exactly as long as some entry references it.
     *
     * @param {FormulaIdentifier[]} add
     * @param {FormulaIdentifier[]} remove
     */
    const applyRetentionDelta = async (add, remove) => {
      await null;
      /** @type {FormulaIdentifier[]} */
      const edgesToAdd = [];
      /** @type {FormulaIdentifier[]} */
      const edgesToRemove = [];
      for (const id of add) {
        const count = slotCounts.get(id) ?? 0;
        slotCounts.set(id, count + 1);
        if (count === 0) {
          edgesToAdd.push(id);
        }
      }
      for (const id of remove) {
        const count = slotCounts.get(id) ?? 0;
        if (count <= 1) {
          slotCounts.delete(id);
          if (count === 1) {
            edgesToRemove.push(id);
          }
        } else {
          slotCounts.set(id, count - 1);
        }
      }
      if (edgesToAdd.length > 0) {
        await addStoreEdges(storeId, edgesToAdd);
      }
      if (edgesToRemove.length > 0) {
        await removeStoreEdges(storeId, edgesToRemove);
      }
    };

    // Rebuild the in-memory index and retention refcounts from persistence.
    // On first formulation there are no rows; after a restart these carry the
    // durable entries forward.
    for (const row of listCollectionEntries(formulaNumber)) {
      const keySlots = JSON.parse(row.keySlots);
      const valueSlots =
        row.valueSlots === null ? [] : JSON.parse(row.valueSlots);
      const slotIds = filterLocalIds([...keySlots, ...valueSlots]);
      entriesByRank.set(row.keyRank, {
        keyBody: row.keyBody,
        keySlots,
        valueBody: /** @type {string} */ (row.valueBody),
        valueSlots,
        slotIds,
      });
      for (const id of slotIds) {
        slotCounts.set(id, (slotCounts.get(id) ?? 0) + 1);
      }
    }

    /**
     * The rank encodings of all entries, in passable rank order. `key_rank`
     * is the order-preserving encoding, so sorting the strings sorts the keys.
     *
     * @returns {string[]}
     */
    const sortedRanks = () => [...entriesByRank.keys()].sort();

    /** @param {Passable} key */
    const rankOf = key => encodeKeyRank(harden(key));

    /** @param {Entry} entry */
    const readKey = entry =>
      unmarshalFromCapData({ body: entry.keyBody, slots: entry.keySlots });

    /** @param {Entry} entry */
    const readValue = entry =>
      unmarshalFromCapData({ body: entry.valueBody, slots: entry.valueSlots });

    /**
     * Persist a new or replacement entry, updating the durable row, the
     * in-memory index, and the retention edges in the same turn.
     *
     * @param {string} rank
     * @param {Passable} key
     * @param {Passable} value
     */
    const putEntry = async (rank, key, value) => {
      const keyCapData = marshalToCapData(key);
      const valueCapData = marshalToCapData(value);
      const newSlotIds = filterLocalIds([
        ...keyCapData.slots,
        ...valueCapData.slots,
      ]);
      const previous = entriesByRank.get(rank);
      const oldSlotIds = previous ? previous.slotIds : [];

      writeCollectionEntry(
        formulaNumber,
        rank,
        keyCapData.body,
        JSON.stringify(keyCapData.slots),
        valueCapData.body,
        JSON.stringify(valueCapData.slots),
      );
      entriesByRank.set(rank, {
        keyBody: keyCapData.body,
        keySlots: keyCapData.slots,
        valueBody: valueCapData.body,
        valueSlots: valueCapData.slots,
        slotIds: newSlotIds,
      });
      await applyRetentionDelta(newSlotIds, oldSlotIds);
    };

    const mapStore = {
      /** @param {Passable} key */
      has: async key => entriesByRank.has(rankOf(key)),

      /** @param {Passable} key */
      get: async key => {
        const entry = entriesByRank.get(rankOf(key));
        entry !== undefined || Fail`key ${q(key)} not found`;
        return readValue(/** @type {Entry} */ (entry));
      },

      /**
       * @param {Passable} key
       * @param {Passable} value
       */
      init: async (key, value) => {
        const rank = rankOf(key);
        !entriesByRank.has(rank) || Fail`key ${q(key)} already registered`;
        await putEntry(rank, key, value);
      },

      /**
       * @param {Passable} key
       * @param {Passable} value
       */
      set: async (key, value) => {
        const rank = rankOf(key);
        entriesByRank.has(rank) || Fail`key ${q(key)} not found`;
        await putEntry(rank, key, value);
      },

      /** @param {Passable} key */
      delete: async key => {
        const rank = rankOf(key);
        const entry = entriesByRank.get(rank);
        entry !== undefined || Fail`key ${q(key)} not found`;
        deleteCollectionEntry(formulaNumber, rank);
        entriesByRank.delete(rank);
        await applyRetentionDelta([], /** @type {Entry} */ (entry).slotIds);
      },

      getSize: async () => entriesByRank.size,

      keys: async () => {
        const ranks = sortedRanks();
        const result = await Promise.all(
          ranks.map(rank =>
            readKey(/** @type {Entry} */ (entriesByRank.get(rank))),
          ),
        );
        return harden(result);
      },

      values: async () => {
        const ranks = sortedRanks();
        const result = await Promise.all(
          ranks.map(rank =>
            readValue(/** @type {Entry} */ (entriesByRank.get(rank))),
          ),
        );
        return harden(result);
      },

      entries: async () => {
        const ranks = sortedRanks();
        const result = await Promise.all(
          ranks.map(async rank => {
            const entry = /** @type {Entry} */ (entriesByRank.get(rank));
            const [key, value] = await Promise.all([
              readKey(entry),
              readValue(entry),
            ]);
            return [key, value];
          }),
        );
        return harden(result);
      },

      snapshot: async () => {
        const ranks = sortedRanks();
        /** @type {Array<[Passable, Passable]>} */
        const pairs = await Promise.all(
          ranks.map(async rank => {
            const entry = /** @type {Entry} */ (entriesByRank.get(rank));
            const [key, value] = await Promise.all([
              readKey(entry),
              readValue(entry),
            ]);
            return [key, value];
          }),
        );
        return makeCopyMap(/** @type {any} */ (pairs));
      },
    };

    return /** @type {MapStore} */ (
      /** @type {unknown} */ (
        // Full `M.key()` keys: primitives, nested copy-collections, and
        // remotables at any depth. Each remotable — top-level or nested — is
        // encoded by its stable formula id (for the canonical rank key) and
        // serialized to a slot (for durable reconstruction and retention).
        makeExo('MapStore', makeMapStoreInterface(M.key()), mapStore)
      )
    );
  };

  /**
   * Construct (or reconstruct, after a restart) the strong `SetStore` exo
   * backed by the `collection-store` formula `storeId` / `formulaNumber`.
   * A set entry uses the same key body+slots and retention accounting as a
   * map entry, but deliberately stores no value body or slots.
   *
   * @param {FormulaIdentifier} storeId
   * @param {FormulaNumber} formulaNumber
   * @returns {SetStore}
   */
  const makeIdentifiedSetStore = (storeId, formulaNumber) => {
    /**
     * @typedef {object} Entry
     * @property {string} keyBody
     * @property {string[]} keySlots
     * @property {FormulaIdentifier[]} slotIds
     */
    /** @type {Map<string, Entry>} */
    const entriesByRank = new Map();
    /** @type {Map<FormulaIdentifier, number>} */
    const slotCounts = new Map();

    /**
     * @param {FormulaIdentifier[]} add
     * @param {FormulaIdentifier[]} remove
     */
    const applyRetentionDelta = async (add, remove) => {
      await null;
      /** @type {FormulaIdentifier[]} */
      const edgesToAdd = [];
      /** @type {FormulaIdentifier[]} */
      const edgesToRemove = [];
      for (const id of add) {
        const count = slotCounts.get(id) ?? 0;
        slotCounts.set(id, count + 1);
        if (count === 0) {
          edgesToAdd.push(id);
        }
      }
      for (const id of remove) {
        const count = slotCounts.get(id) ?? 0;
        if (count <= 1) {
          slotCounts.delete(id);
          if (count === 1) {
            edgesToRemove.push(id);
          }
        } else {
          slotCounts.set(id, count - 1);
        }
      }
      if (edgesToAdd.length > 0) {
        await addStoreEdges(storeId, edgesToAdd);
      }
      if (edgesToRemove.length > 0) {
        await removeStoreEdges(storeId, edgesToRemove);
      }
    };

    for (const row of listCollectionEntries(formulaNumber)) {
      const keySlots = JSON.parse(row.keySlots);
      const slotIds = filterLocalIds(keySlots);
      entriesByRank.set(row.keyRank, {
        keyBody: row.keyBody,
        keySlots,
        slotIds,
      });
      for (const id of slotIds) {
        slotCounts.set(id, (slotCounts.get(id) ?? 0) + 1);
      }
    }

    const sortedRanks = () => [...entriesByRank.keys()].sort();
    /** @param {Passable} key */
    const rankOf = key => encodeKeyRank(harden(key));
    /** @param {Entry} entry */
    const readKey = entry =>
      unmarshalFromCapData({ body: entry.keyBody, slots: entry.keySlots });

    /** @param {string} rank @param {Passable} key */
    const putEntry = async (rank, key) => {
      const keyCapData = marshalToCapData(key);
      const slotIds = filterLocalIds(keyCapData.slots);
      writeCollectionEntry(
        formulaNumber,
        rank,
        keyCapData.body,
        JSON.stringify(keyCapData.slots),
        null,
        null,
      );
      entriesByRank.set(rank, {
        keyBody: keyCapData.body,
        keySlots: keyCapData.slots,
        slotIds,
      });
      await applyRetentionDelta(slotIds, []);
    };

    const setStore = {
      /** @param {Passable} key */
      has: async key => entriesByRank.has(rankOf(key)),

      /** @param {Passable} key */
      add: async key => {
        const rank = rankOf(key);
        !entriesByRank.has(rank) || Fail`key ${q(key)} already registered`;
        await putEntry(rank, key);
      },

      /** @param {Passable} key */
      delete: async key => {
        const rank = rankOf(key);
        const entry = entriesByRank.get(rank);
        entry !== undefined || Fail`key ${q(key)} not found`;
        deleteCollectionEntry(formulaNumber, rank);
        entriesByRank.delete(rank);
        await applyRetentionDelta([], /** @type {Entry} */ (entry).slotIds);
      },

      getSize: async () => entriesByRank.size,

      keys: async () => {
        const result = await Promise.all(
          sortedRanks().map(rank =>
            readKey(/** @type {Entry} */ (entriesByRank.get(rank))),
          ),
        );
        return harden(result);
      },

      entries: async () => {
        const result = await Promise.all(
          sortedRanks().map(rank =>
            readKey(/** @type {Entry} */ (entriesByRank.get(rank))),
          ),
        );
        return harden(result);
      },

      snapshot: async () => {
        const keys = await Promise.all(
          sortedRanks().map(rank =>
            readKey(/** @type {Entry} */ (entriesByRank.get(rank))),
          ),
        );
        return makeCopySet(keys);
      },
    };

    return /** @type {SetStore} */ (
      /** @type {unknown} */ (
        makeExo('SetStore', makeSetStoreInterface(M.key()), setStore)
      )
    );
  };

  /**
   * A weak collection key is one daemon remotable formula identity. We persist
   * it for lookup but never retain it. Values are reference counted exactly as
   * strong-map values, and are released either by delete or by key collection.
   *
   * @param {FormulaIdentifier} storeId
   * @param {FormulaNumber} formulaNumber
   * @returns {WeakMapStore}
   */
  const makeIdentifiedWeakMapStore = (storeId, formulaNumber) => {
    /** @typedef {{valueBody: string, valueSlots: string[], valueIds: FormulaIdentifier[]}} WeakMapEntry */
    /** @type {Map<string, WeakMapEntry>} */
    const entriesByRank = new Map();
    /** @type {Map<FormulaIdentifier, number>} */
    const valueCounts = new Map();

    for (const row of listCollectionEntries(formulaNumber)) {
      const valueSlots = JSON.parse(/** @type {string} */ (row.valueSlots));
      const valueIds = filterLocalIds(valueSlots);
      entriesByRank.set(row.keyRank, {
        valueBody: /** @type {string} */ (row.valueBody),
        valueSlots,
        valueIds,
      });
      for (const id of valueIds) {
        valueCounts.set(id, (valueCounts.get(id) ?? 0) + 1);
      }
    }

    liveWeakEntries.set(formulaNumber, {
      delete: rank => {
        const entry = entriesByRank.get(rank);
        if (entry !== undefined) {
          entriesByRank.delete(rank);
          for (const id of entry.valueIds) {
            const count = valueCounts.get(id) ?? 0;
            if (count <= 1) {
              valueCounts.delete(id);
            } else {
              valueCounts.set(id, count - 1);
            }
          }
        }
      },
    });

    /** @param {FormulaIdentifier[]} add @param {FormulaIdentifier[]} remove */
    const applyValueDelta = async (add, remove) => {
      /** @type {FormulaIdentifier[]} */
      const edgesToAdd = [];
      /** @type {FormulaIdentifier[]} */
      const edgesToRemove = [];
      for (const id of add) {
        const count = valueCounts.get(id) ?? 0;
        valueCounts.set(id, count + 1);
        if (count === 0) edgesToAdd.push(id);
      }
      for (const id of remove) {
        const count = valueCounts.get(id) ?? 0;
        if (count <= 1) {
          valueCounts.delete(id);
          if (count === 1) edgesToRemove.push(id);
        } else {
          valueCounts.set(id, count - 1);
        }
      }
      if (edgesToAdd.length > 0) await addStoreEdges(storeId, edgesToAdd);
      if (edgesToRemove.length > 0)
        await removeStoreEdges(storeId, edgesToRemove);
    };

    /** @param {Passable} key */
    const keyInfo = key => {
      const keyId = canonicalWeakKeyId(
        getIdForRef(/** @type {object} */ (key)),
      );
      const keySlots = filterLocalIds([keyId]);
      keySlots.length === 1 ||
        Fail`weak key ${q(key)} is not a local remotable`;
      return harden({
        rank: `r${keyId}`,
        keyId,
      });
    };

    /** @param {string} rank @param {FormulaIdentifier} keyId @param {Passable} key @param {Passable} value */
    const put = async (rank, keyId, key, value) => {
      const keyCapData = marshalToCapData(key);
      const valueCapData = marshalToCapData(value);
      const valueIds = filterLocalIds(valueCapData.slots);
      const old = entriesByRank.get(rank);
      writeCollectionEntry(
        formulaNumber,
        rank,
        keyCapData.body,
        JSON.stringify(keyCapData.slots),
        valueCapData.body,
        JSON.stringify(valueCapData.slots),
      );
      persistence.writeCollectionWeakKey(keyId, formulaNumber, rank);
      entriesByRank.set(rank, {
        valueBody: valueCapData.body,
        valueSlots: valueCapData.slots,
        valueIds,
      });
      await applyValueDelta(valueIds, old?.valueIds ?? []);
    };

    const weakMapStore = {
      /** @param {Passable} key */
      has: async key => entriesByRank.has(keyInfo(key).rank),
      /** @param {Passable} key */
      get: async key => {
        const entry = entriesByRank.get(keyInfo(key).rank);
        entry !== undefined || Fail`key ${q(key)} not found`;
        return unmarshalFromCapData({
          body: /** @type {WeakMapEntry} */ (entry).valueBody,
          slots: /** @type {WeakMapEntry} */ (entry).valueSlots,
        });
      },
      /** @param {Passable} key @param {Passable} value */
      init: async (key, value) => {
        const { rank, keyId } = keyInfo(key);
        !entriesByRank.has(rank) || Fail`key ${q(key)} already registered`;
        await put(rank, keyId, key, value);
      },
      /** @param {Passable} key @param {Passable} value */
      set: async (key, value) => {
        const { rank, keyId } = keyInfo(key);
        entriesByRank.has(rank) || Fail`key ${q(key)} not found`;
        await put(rank, keyId, key, value);
      },
      /** @param {Passable} key */
      delete: async key => {
        const { rank } = keyInfo(key);
        const entry = entriesByRank.get(rank);
        entry !== undefined || Fail`key ${q(key)} not found`;
        deleteCollectionEntry(formulaNumber, rank);
        entriesByRank.delete(rank);
        await applyValueDelta([], /** @type {WeakMapEntry} */ (entry).valueIds);
      },
    };
    return /** @type {WeakMapStore} */ (
      /** @type {unknown} */ (
        makeExo('WeakMapStore', WeakMapStoreInterface, weakMapStore)
      )
    );
  };

  /** @param {FormulaIdentifier} storeId @param {FormulaNumber} formulaNumber @returns {WeakSetStore} */
  const makeIdentifiedWeakSetStore = (storeId, formulaNumber) => {
    /** @type {Map<string, unknown>} */
    const entriesByRank = new Map();
    liveWeakEntries.set(formulaNumber, {
      delete: rank => entriesByRank.delete(rank),
    });
    for (const row of listCollectionEntries(formulaNumber)) {
      entriesByRank.set(row.keyRank, undefined);
    }
    /** @param {Passable} key */
    const keyInfo = key => {
      const keyId = canonicalWeakKeyId(
        getIdForRef(/** @type {object} */ (key)),
      );
      filterLocalIds([keyId]).length === 1 ||
        Fail`weak key ${q(key)} is not a local remotable`;
      return harden({
        rank: `r${keyId}`,
        keyId,
      });
    };
    const weakSetStore = {
      /** @param {Passable} key */
      has: async key => entriesByRank.has(keyInfo(key).rank),
      /** @param {Passable} key */
      add: async key => {
        const { rank, keyId } = keyInfo(key);
        !entriesByRank.has(rank) || Fail`key ${q(key)} already registered`;
        const capData = marshalToCapData(key);
        writeCollectionEntry(
          formulaNumber,
          rank,
          capData.body,
          JSON.stringify(capData.slots),
          null,
          null,
        );
        persistence.writeCollectionWeakKey(keyId, formulaNumber, rank);
        entriesByRank.set(rank, undefined);
      },
      /** @param {Passable} key */
      delete: async key => {
        const { rank } = keyInfo(key);
        entriesByRank.has(rank) || Fail`key ${q(key)} not found`;
        deleteCollectionEntry(formulaNumber, rank);
        entriesByRank.delete(rank);
      },
    };
    return /** @type {WeakSetStore} */ (
      /** @type {unknown} */ (
        makeExo('WeakSetStore', WeakSetStoreInterface, weakSetStore)
      )
    );
  };

  return harden({
    makeIdentifiedMapStore,
    makeIdentifiedSetStore,
    makeIdentifiedWeakMapStore,
    makeIdentifiedWeakSetStore,
    collectionRetentionSlots,
    rebuildWeakKeyIndex,
    collectWeakEntries,
  });
};
harden(makeCollectionStoreMaker);
