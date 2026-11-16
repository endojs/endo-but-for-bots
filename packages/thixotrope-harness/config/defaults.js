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
   * String content of one message into or out of a vat. S1 chose it when
   * every byte of a hardened inbound frame interned a key in the vat's
   * 16-bit key table, so a fresh vat halted near 51-59 KB (J-0140, J-0141).
   * Since d0fd6b1138 frames intern no keys, the halt point no longer
   * depends on the vat's history, and a vat with a full key table takes
   * 2 x frameBytes (QC, J-0190..J-0194). Kept at 24,576: the inbound
   * budget (ping floor + 300 ms) is met here with little room (J-0193),
   * and the core's evaluate-source STAGING_FRAME_BYTES is a copy of it
   * (test/limits.test.js keeps them equal).
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
   * Distinct property names a vat can still intern after boot, about
   * 57,000 of its 65,535 ids (J-0191); names are never released. Every
   * fresh record key a vat receives or creates takes one for the vat's
   * life, and when they run out the vat halts and is retired. Guest code
   * and every peer or adapter talking to a vat must not use data-dependent
   * record keys: send lists of entries, keep Maps.
   */
  vatKeyNames: 57_000,
  /**
   * Daemon crank budget (THIXOTROPE_CRANK_BUDGET). A runaway loop ends in
   * about 270 ms at 50 M (100 ms at 10 M, 470 ms at 100 M); 100 M buys no
   * larger frame and no more sends (heap-bound above 50 M) (J-0141, J-0143).
   */
  crankBudget: 50_000_000n,
  /**
   * Crashes in a row without progress after which the supervisor gives a
   * vat up and records its failure (THIXOTROPE_MAX_DELIVERY_ATTEMPTS, 2..100;
   * PR 1667, merge 3f2b90954e). Kept at the upstream default of 5: four
   * retries over about fifteen seconds of doubling backoff, and a starting
   * supervisor waits out a crashing vat's retries before it serves
   * (pkg README; pkg src/control/supervisor.js readMaxDeliveryAttempts).
   */
  maxDeliveryAttempts: 5,
  /**
   * Eventual sends per crank (guest rule). Answered sends halt at 250 in one
   * crank at every budget, sendOnly at 450 (10 M) / 600 (50 M, 100 M), on
   * an empty probe vat (J-0143). On a vat with a staged 250 k program and a
   * full key table, answered sends pass at 250 and halt at 300
   * (HeapExhausted, 50 M, after d0fd6b1138; J-0194).
   */
  sendsPerCrank: 100,
  /**
   * Exec program source, staged in frameBytes messages and evaluated in one
   * crank (spike S3, J-0146, J-0195: 262 k staged in 3.9 s, a 175 ms
   * evaluating crank); one message of it halts the vat (HeapExhausted
   * above about 94 KB inbound at 50 M).
   */
  execSourceBytes: 262_144,
});
