// @ts-check
// build-vs-buy-exempt: a VFS-backed store specific to this plugin.

/**
 * The fetch service's durable store, backed by a writable virtual-file-system
 * directory (`@endo/platform/fs/extended`). The plugin depends only on the
 * reconciled writable-tree verbs (`lookup`, `write`, `move`), so it cannot tell
 * what backs the directory. There is no `node:fs` and no daemon `filePowers`.
 *
 * The store holds one document, `policy.json`:
 *
 * ```
 * { "policy": { allowedOrigins, maxRequestsPerMinute, maxResponseBytes,
 *               policyMode, revoked },
 *   "bindings": [ { target, state, decidedAt, decidedBy, decisionMode,
 *                   note? }, ... ] }
 * ```
 *
 * Policy and bindings form one snapshot and are committed together, so a crash
 * can never pair a new policy with stale bindings. Replacement is
 * write-then-`move` within one directory; the plugin requires atomic
 * within-directory `move` of the backing as a store contract (design
 * decision 5).
 *
 * Only a missing document means first provisioning. A document that exists
 * but cannot be read, parsed, or validated makes `readSnapshot` reject, so the
 * service refuses to revive rather than fall back to broader provisioning
 * defaults.
 */

import { E } from '@endo/eventual-send';

/** @import { FetchStoreDirectory, FetchStore, PersistedSnapshot } from './types.js' */

const SNAPSHOT_NAME = 'policy.json';

/** @param {unknown} error */
const isEnoent = error => {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String(/** @type {{ message: unknown }} */ (error).message)
      : '';
  return /ENOENT/.test(message);
};

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isRecord = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Check the structure of a persisted snapshot. Field values are validated
 * again by `makeHttpClientAndControl`; this only rejects documents whose shape
 * would otherwise be misread as absent or empty state.
 *
 * @param {unknown} value
 * @returns {PersistedSnapshot}
 */
const assertSnapshotShape = value => {
  if (!isRecord(value) || !isRecord(value.policy)) {
    throw TypeError('policy.json must hold a policy record');
  }
  const { policy, bindings } = value;
  if (!Array.isArray(policy.allowedOrigins)) {
    throw TypeError('policy.json policy.allowedOrigins must be an array');
  }
  if (typeof policy.revoked !== 'boolean') {
    throw TypeError('policy.json policy.revoked must be a boolean');
  }
  if (!Array.isArray(bindings) || !bindings.every(isRecord)) {
    throw TypeError('policy.json bindings must be an array of records');
  }
  return /** @type {PersistedSnapshot} */ (value);
};

/**
 * @param {FetchStoreDirectory} root - the store-root
 *   Directory cap (or an eventual reference to one).
 * @param {() => Promise<string>} makeId - unique-suffix generator for temporary files.
 * @returns {Promise<FetchStore>}
 */
export const makeFetchStore = async (root, makeId) => {
  await null;

  return harden({
    /**
     * Read the persisted snapshot, or `undefined` if none was ever written.
     * Any other failure rejects.
     *
     * @returns {Promise<PersistedSnapshot | undefined>}
     */
    async readSnapshot() {
      await null;
      let file;
      try {
        file = await E(root).lookup(SNAPSHOT_NAME);
      } catch (error) {
        if (isEnoent(error)) {
          return undefined;
        }
        throw error;
      }
      const blob = await E(file).snapshot();
      return assertSnapshotShape(await E(blob).json());
    },

    /** @param {PersistedSnapshot} snapshot */
    async writeSnapshot(snapshot) {
      const temporaryName = `.tmp.${await makeId()}`;
      await E(root).write(temporaryName, `${JSON.stringify(snapshot)}\n`);
      await E(root).move(temporaryName, SNAPSHOT_NAME);
    },
  });
};
harden(makeFetchStore);
