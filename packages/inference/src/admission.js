// @ts-check

/** @import { InferenceBackend } from './types.js' */

/**
 * A per-credential slot table. Decision 7: one inference slot per credential,
 * so two credentials run concurrently while one credential never runs two
 * turns at once.
 *
 * gap: see PR body, Gap 5. The design says admission is the broker's and is
 * persisted; this table is in memory, which Decision 7 accepts only for a
 * single canary. `@endo/hosted-agent` owns the lease types, so the persisted
 * version belongs there, not here.
 *
 * @param {object} [options]
 * @param {number} [options.slotsPerCredential]
 */
export const makeSlotAdmission = ({ slotsPerCredential = 1 } = {}) => {
  /** @type {Map<string, number>} */
  const busy = new Map();
  return harden({
    /** @param {string} credentialId */
    tryAcquire: credentialId => {
      const held = busy.get(credentialId) ?? 0;
      if (held >= slotsPerCredential) return undefined;
      busy.set(credentialId, held + 1);
      let released = false;
      return harden({
        release: () => {
          if (released) return;
          released = true;
          const now = busy.get(credentialId) ?? 1;
          if (now <= 1) busy.delete(credentialId);
          else busy.set(credentialId, now - 1);
        },
      });
    },
    /** @param {string} credentialId */
    inUse: credentialId => busy.get(credentialId) ?? 0,
  });
};
harden(makeSlotAdmission);

/**
 * Admission enricher: refuse a turn before any process starts when the
 * backend's credential already holds its slot.
 *
 * @template G
 * @param {InferenceBackend<G>} backend
 * @param {object} options
 * @param {ReturnType<typeof makeSlotAdmission>} options.admission
 * @param {string} options.credentialId
 * @returns {InferenceBackend<G>}
 */
export const withAdmission = (backend, { admission, credentialId }) =>
  harden({
    describe: () => backend.describe(),
    infer: async request => {
      const lease = admission.tryAcquire(credentialId);
      if (lease === undefined) {
        return harden({ type: 'rate-limited' });
      }
      try {
        return await backend.infer(request);
      } finally {
        lease.release();
      }
    },
  });
harden(withAdmission);
