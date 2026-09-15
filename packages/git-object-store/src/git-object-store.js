// @ts-check

import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

import { fetchBytes, storeBytes } from './content-bytes.js';
import { assertObjectType, hashObject } from './frame.js';
import { assertHashAlgorithm, assertOid } from './hash.js';

/** @import { ContentStoreLike, GitDigest, GitHashAlgorithm, GitObject, GitObjectId, GitObjectStore, GitObjectType, OidIndex } from './types.js' */

/**
 * Default number of objects carried by one index/content read batch.
 *
 * @type {number}
 */
export const DEFAULT_READ_BATCH_SIZE = 64;
harden(DEFAULT_READ_BATCH_SIZE);

/**
 * Maximum number of objects carried by one index/content read batch.
 * This keeps a single capability call from becoming an unbounded message.
 *
 * @type {number}
 */
export const MAX_READ_BATCH_SIZE = 1024;
harden(MAX_READ_BATCH_SIZE);

/**
 * @param {number | undefined} batchSize
 * @returns {number}
 */
const clampReadBatchSize = batchSize => {
  if (batchSize === undefined) {
    return DEFAULT_READ_BATCH_SIZE;
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    return 1;
  }
  return Math.min(batchSize, MAX_READ_BATCH_SIZE);
};

/**
 * @typedef {object} MakeGitObjectStoreOptions
 * @property {ContentStoreLike} contentStore
 * @property {OidIndex} oidIndex
 * @property {GitHashAlgorithm} hashAlgorithm
 * @property {GitDigest} digest
 * @property {number} [maxBatchSize] maximum objects in one read batch
 */

/**
 * Build a CAS-backed git object store.
 *
 * Content bytes are stored *without* the framing header. The oid is the
 * hash of the reconstructed canonical bytes.
 *
 * @param {MakeGitObjectStoreOptions} options
 * @returns {GitObjectStore}
 */
export const makeGitObjectStore = options => {
  const {
    contentStore,
    oidIndex,
    hashAlgorithm,
    digest,
    maxBatchSize: requestedBatchSize,
  } = options;
  const maxBatchSize = clampReadBatchSize(requestedBatchSize);
  assertHashAlgorithm(hashAlgorithm);
  contentStore || Fail`makeGitObjectStore requires contentStore`;
  oidIndex || Fail`makeGitObjectStore requires oidIndex`;
  typeof digest === 'function' ||
    Fail`makeGitObjectStore requires a digest power`;

  /**
   * @param {GitObjectId} oid
   * @param {{ type: GitObjectType, casHash: string }} entry
   * @returns {Promise<GitObject>}
   */
  const materialize = async (oid, entry) => {
    const content = await fetchBytes(contentStore, entry.casHash);
    // Verify oid against reconstructed canonical bytes.
    const recomputed = hashObject(hashAlgorithm, digest, entry.type, content);
    recomputed === oid ||
      Fail`oid mismatch for ${q(oid)}: content hashes to ${q(recomputed)}`;
    return harden({
      type: entry.type,
      content,
      oid,
    });
  };

  return harden({
    getHashAlgorithm: () => hashAlgorithm,

    /**
     * @param {GitObjectId} oid
     */
    async hasObject(oid) {
      const normalized = assertOid(hashAlgorithm, oid);
      return oidIndex.has(hashAlgorithm, normalized);
    },

    /**
     * @param {GitObjectId} oid
     */
    async readObject(oid) {
      const normalized = assertOid(hashAlgorithm, oid);
      const entry = await oidIndex.get(hashAlgorithm, normalized);
      if (entry === undefined) {
        throw Fail`git object not found: ${q(normalized)}`;
      }
      return materialize(normalized, entry);
    },

    /**
     * @param {GitObjectId[]} oids
     */
    async readObjects(oids) {
      await null;
      const normalized = oids.map(oid => assertOid(hashAlgorithm, oid));
      /** @type {(GitObject | undefined)[]} */
      const objects = [];
      for (let start = 0; start < normalized.length; start += maxBatchSize) {
        const batchOids = normalized.slice(start, start + maxBatchSize);
        // eslint-disable-next-line no-await-in-loop
        const entries = await oidIndex.getMany(hashAlgorithm, batchOids);
        // eslint-disable-next-line no-await-in-loop
        const batchObjects = await Promise.all(
          batchOids.map(async (oid, i) => {
            const entry = entries[i];
            if (entry === undefined) {
              return undefined;
            }
            return materialize(oid, entry);
          }),
        );
        objects.push(...batchObjects);
      }
      return objects;
    },

    /**
     * @param {GitObjectType} type
     * @param {Uint8Array} content
     */
    async writeObject(type, content) {
      assertObjectType(type);
      content instanceof Uint8Array ||
        Fail`writeObject content must be a Uint8Array`;
      const oid = hashObject(hashAlgorithm, digest, type, content);
      const existing = await oidIndex.get(hashAlgorithm, oid);
      if (existing !== undefined) {
        // Idempotent: same oid already indexed.
        return oid;
      }
      const casHash = await storeBytes(contentStore, content);
      await oidIndex.put(hashAlgorithm, oid, type, casHash);
      return oid;
    },
  });
};
harden(makeGitObjectStore);
