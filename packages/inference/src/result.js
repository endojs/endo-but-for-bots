// @ts-check

/** @import { InferenceBackend, InferResult } from './types.js' */

const TYPES = new Set([
  'ok',
  'needs-auth',
  'usage-exhausted',
  'rate-limited',
  'limit-exceeded',
  'cancelled',
  'unavailable',
]);

/**
 * Enforce the seam's "infer never rejects" rule over any backend: a thrown
 * error or an unrecognized result becomes `unavailable`.
 *
 * @template G
 * @param {InferenceBackend<G>} backend
 * @returns {InferenceBackend<G>}
 */
export const withResultGuard = backend =>
  harden({
    describe: () => backend.describe(),
    infer: async request => {
      /** @type {InferResult} */
      let result;
      try {
        result = await backend.infer(request);
      } catch (error) {
        return harden({
          type: 'unavailable',
          reason: `backend threw: ${/** @type {Error} */ (error)?.message ?? error}`,
        });
      }
      if (!result || !TYPES.has(result.type)) {
        return harden({ type: 'unavailable', reason: 'unrecognized result' });
      }
      return result;
    },
  });
harden(withResultGuard);
