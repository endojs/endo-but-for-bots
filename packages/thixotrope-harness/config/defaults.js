// @ts-check
/**
 * Harness limit settings (architecture.md section 9; the plan names no file
 * for them, so they live here). Chosen by spikes S1 and S3 (W0.5,
 * test/spikes/s1.test.js and s3.test.js; JOURNAL J-0140..J-0147) with the
 * CORE-1a/CORE-1 worker. Sizes are UTF-8 bytes.
 *
 * Guest code cannot import this module (guest bundles read only guest/);
 * guest modules get these values as arguments or a copy in guest/lib.
 */
export const limits = Object.freeze({
  /**
   * String content of one message into or out of a vat. Inbound is the
   * ceiling: a fresh vat halts at 51,200-52,224 bytes at 10 M (MeterAbort)
   * and 58,368-59,392 at 50 M and 100 M ("property key space exhausted":
   * every byte of a hardened inbound frame interns an index key in the vat's
   * 16-bit key table, J-0140). 24,576 is at most half the smallest halt
   * point at every measured budget (half of 51,200 is 25,600), so a budget
   * lowered to 10 M stays safe, and it leaves the key table about 34 k keys
   * for the vat's own names.
   */
  frameBytes: 24_576,
  /**
   * All messages one crank sends. Outbound is cheap: 8 x 256 KiB in one
   * crank and single 4 MiB results pass at 10-100 M (J-0142); 8 frames.
   */
  crankOutBytes: 196_608,
  /** Larger text fields are Blobs. */
  inlineBytes: 8192,
  /**
   * Daemon crank budget (THIXOTROPE_CRANK_BUDGET). A runaway loop ends in
   * about 270 ms at 50 M (100 ms at 10 M, 470 ms at 100 M); 100 M buys no
   * larger frame and no more sends (heap-bound above 50 M) (J-0141, J-0143).
   */
  crankBudget: 50_000_000n,
  /**
   * Eventual sends per crank (guest rule). Answered sends halt at 250 in one
   * crank at every budget, sendOnly at 450 (10 M) / 600 (50 M, 100 M).
   */
  sendsPerCrank: 100,
  /**
   * Exec program source, staged in frameBytes messages and evaluated in one
   * crank (spike S3, J-0146); one message of it would halt the vat.
   */
  execSourceBytes: 262_144,
});
