// @ts-check
/**
 * The adapter half of the Secrets catalogue (M4 W4.4;
 * `designs/m4-interfaces.md` 4.1; R7-22, R6-67): for a batch of store keys
 * (at most `m4Limits.describeBatch`, 64), the generation, state and byte
 * count of each, or `null` for a key the store does not hold (deleted, or
 * never created because the creating call broke). Labels and descriptions
 * are not answered: the manager vat's records are the system of record for
 * them. Never a value (R7-26).
 *
 * `CredentialOps.describeSecrets(keys)` (W4.6) answers this list; one call
 * fills a whole catalogue page (one ops call per page, perf
 * `secrets.catalog`).
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { m4Limits } from '../../../../guest/lib/limits-m4.js';
/* eslint-enable import/no-relative-packages */
import { secretError } from './store.js';

/**
 * @typedef {{ key: string, generation: number, state: 'active' | 'revoked', bytes: number } | null} SecretKeyInfo
 */

/**
 * @param {object} options
 * @param {import('./store.js').SecretStore} options.store
 * @param {readonly string[]} options.keys
 * @returns {Promise<SecretKeyInfo[]>}
 */
export const describeKeys = async ({ store, keys }) => {
  if (!Array.isArray(keys) || keys.length > m4Limits.describeBatch)
    throw secretError('INVALID_LIMIT');
  await store.ready();
  /** @type {SecretKeyInfo[]} */
  const out = [];
  for (const key of keys) {
    try {
      // eslint-disable-next-line no-await-in-loop -- in memory once ready
      const { generation, state, bytes } = await store.describe(key);
      out.push(harden({ key, generation, state, bytes }));
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'UNKNOWN_SECRET') throw error;
      out.push(null);
    }
  }
  return harden(out);
};
harden(describeKeys);
