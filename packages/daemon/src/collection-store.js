// @ts-check

import harden from '@endo/harden';
import { makeExo } from '@endo/exo';
import { M, makeCopyMap } from '@endo/patterns';
import { Fail, q } from '@endo/errors';

/** @import { FormulaIdentifier, FormulaNumber, MapStore } from './types.js' */
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
 * @param {(storeId: FormulaIdentifier, ids: FormulaIdentifier[]) => Promise<void>} powers.addStoreEdges
 * @param {(storeId: FormulaIdentifier, ids: FormulaIdentifier[]) => Promise<void>} powers.removeStoreEdges
 */
export const makeCollectionStoreMaker = ({
  persistence,
  marshalToCapData,
  unmarshalFromCapData,
  encodeKeyRank,
  filterLocalIds,
  addStoreEdges,
  removeStoreEdges,
}) => {
  const {
    writeCollectionEntry,
    deleteCollectionEntry,
    listCollectionEntries,
  } = persistence;

  /**
   * The distinct local slot ids retained by a store's persisted entries.
   * Used to seed formula-graph retention edges at daemon start, before the
   * store exo is lazily constructed, so a stored remotable is not swept.
   *
   * @param {FormulaNumber} formulaNumber
   * @returns {FormulaIdentifier[]}
   */
  const collectionRetentionSlots = formulaNumber => {
    /** @type {Set<string>} */
    const ids = new Set();
    for (const row of listCollectionEntries(formulaNumber)) {
      for (const slot of JSON.parse(row.keySlots)) {
        ids.add(slot);
      }
      if (row.valueSlots !== null) {
        for (const slot of JSON.parse(row.valueSlots)) {
          ids.add(slot);
        }
      }
    }
    return filterLocalIds([...ids]);
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
      const valueSlots = row.valueSlots === null ? [] : JSON.parse(row.valueSlots);
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

  return harden({ makeIdentifiedMapStore, collectionRetentionSlots });
};
harden(makeCollectionStoreMaker);
