// @ts-check
/**
 * The store accessor of one key (M4 W4.4; `designs/m4-interfaces.md` 4.2,
 * 7; W-5): what a pool member's renewal holds instead of the store or the
 * Secrets manager. It reads that one key (audited, as every read) and
 * replaces its value conditioned on a generation; it cannot create,
 * describe, revoke or delete, and it cannot reach any other key.
 *
 * Failures are the store's: `textOf.secretFailed(code)` with a fixed code
 * (`GENERATION_CONFLICT`, `REVOKED`, `UNKNOWN_SECRET`, `READ_FAILED`, ...),
 * never a value.
 *
 * Node only (adapter).
 */
import { secretError } from './store.js';

/**
 * @param {object} options
 * @param {import('./store.js').SecretStore} options.store
 * @param {string} options.key the member credential's store key `k<n>`
 * @returns {import('../subscriptions/types.js').CredentialAccess}
 */
export const makeCredentialAccess = ({ store, key }) =>
  harden({
    read: () => store.read(key),
    /**
     * @param {string} value
     * @param {number} expectedGeneration
     */
    replace: async (value, expectedGeneration) => {
      // Always conditioned: an unconditional write would let a renewal
      // overwrite an operator's replacement (R7-30).
      if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0)
        throw secretError('INVALID_GENERATION');
      return store.replace(key, value, expectedGeneration);
    },
  });
harden(makeCredentialAccess);
