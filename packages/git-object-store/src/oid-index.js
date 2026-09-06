// @ts-check

import harden from '@endo/harden';

import { assertHashAlgorithm, assertOid } from './hash.js';
import { assertObjectType } from './frame.js';

/** @import { GitHashAlgorithm, GitObjectId, GitObjectType, OidIndex, OidIndexEntry } from './types.js' */

/**
 * @param {GitHashAlgorithm} algorithm
 * @param {GitObjectId} oid
 * @returns {string}
 */
const keyOf = (algorithm, oid) => `${algorithm}:${assertOid(algorithm, oid)}`;

/**
 * In-memory oid index suitable for tests and isolate-local caches.
 *
 * @returns {OidIndex}
 */
export const makeMemoryOidIndex = () => {
  /** @type {Map<string, OidIndexEntry>} */
  const map = new Map();

  return harden({
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId} oid
     */
    async get(algorithm, oid) {
      assertHashAlgorithm(algorithm);
      return map.get(keyOf(algorithm, oid));
    },
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId[]} oids
     */
    async getMany(algorithm, oids) {
      assertHashAlgorithm(algorithm);
      return oids.map(oid => map.get(keyOf(algorithm, oid)));
    },
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId} oid
     * @param {GitObjectType} type
     * @param {string} casHash
     */
    async put(algorithm, oid, type, casHash) {
      assertHashAlgorithm(algorithm);
      assertObjectType(type);
      const normalized = assertOid(algorithm, oid);
      map.set(keyOf(algorithm, normalized), harden({ type, casHash }));
    },
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId} oid
     */
    async has(algorithm, oid) {
      assertHashAlgorithm(algorithm);
      return map.has(keyOf(algorithm, oid));
    },
  });
};
harden(makeMemoryOidIndex);
