// @ts-check
/**
 * The factory vat's count of daemon starts (HR-SYN-36): one number for the
 * factory's creations, the spare pool and the delete records, which each
 * kept their own copy ("epoch") before. The start listener's recovery
 * (`factory.js` `recover`) raises it first, then the pool (`onStart`) and
 * the delete records (`resume`) read it: work stamped with an earlier start
 * was cut off by a restart.
 *
 * Guest rules; no clock (a start is counted, not timed).
 */

export const makeStartCount = () => {
  let starts = 0;
  return harden({
    /** The starts counted so far (0 before the first). */
    current: () => starts,
    /** A daemon start: count it; answers the new count. */
    next: () => {
      starts += 1;
      return starts;
    },
  });
};
harden(makeStartCount);

/** @typedef {ReturnType<typeof makeStartCount>} StartCount */
