// @ts-check

/**
 * Per-key rate limiter. Each failed attempt delays the next allowed
 * attempt by `penaltyMs`.
 *
 * @param {number} penaltyMs
 */
export const makeRateLimiter = penaltyMs => {
  /** @type {Map<string, number>} */
  const nextAllowed = new Map();
  const collectionThreshold = penaltyMs * 10;

  return harden({
    /**
     * @param {string} key
     * @returns {number} 0 if allowed, otherwise ms until allowed
     */
    check: key => {
      const now = Date.now();
      const deadline = nextAllowed.get(key);
      if (deadline !== undefined && now < deadline) {
        return deadline - now;
      }
      for (const [k, t] of nextAllowed) {
        if (now >= t + collectionThreshold) {
          nextAllowed.delete(k);
        }
      }
      return 0;
    },
    /** @param {string} key */
    recordFailure: key => {
      const now = Date.now();
      const current = nextAllowed.get(key);
      const base = current !== undefined && current > now ? current : now;
      nextAllowed.set(key, base + penaltyMs);
    },
  });
};
harden(makeRateLimiter);
