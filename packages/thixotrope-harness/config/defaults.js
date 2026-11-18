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
   * The hub's ceiling on one encoded frame into a vat
   * (THIXOTROPE_VAT_FRAME_BYTES; core CC-027, whose default is 32,768).
   * `frameBytes` bounds a message's string content only; its encoding adds
   * the framing of every record, number and reference, up to 0.8 x on many
   * small records: an import chunk of short turns (`scripts/export.mjs`, at
   * most `pageRecords` records and `frameBytes` of strings) encodes to
   * 40,040 bytes (J-10125). 65,536 is below the 94,208-byte halt at the 50 M
   * budget (J-0194) and is what M5's CC-070 asked for. `scripts/serve.mjs`
   * sets it only at a crank budget of at least `crankBudget`; below that the
   * core default stands (the meter halts near 51 KB at 10 M).
   */
  vatFrameBytes: 65_536,
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
   * Slots a vat's heap may hold (THIXOTROPE_SLOT_CEILING; 24 bytes each).
   * The engine collects garbage only between cranks, so the ceiling bounds
   * a vat's live heap plus everything one crank allocates, and going over
   * halts the vat (`HeapExhausted`). At Thixotrope's default (1,000,000) a
   * session vat (a spare's slot capacity is about 280,000) halted in the
   * crank that records a round of 100 tool calls (J-0362), and a 1,000-turn
   * session in its first context page crank (J-0368). M1b QC (J-0392) raised it for every vat: 4,000,000
   * slots (96 MB; the chunk ceiling is 256 MiB) admit the 256-call round
   * `maxCallsPerMessage` allows. The worker accepts up to 44,739,242. A state
   * persists the ceiling it was served with and Thixotrope refuses to serve
   * it at a lower one ("slotCeiling cannot decrease below persisted value"),
   * so raising it is one-way per state directory (test templates key on it).
   */
  slotCeiling: 4_000_000,
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

/**
 * Bounds of the agent host's session channels (adapter side; M1a follow-ups
 * J-0296 (5), QC advisory 4; JOURNAL J-9170..J-9189). The adapter process,
 * not a vat, holds this state, so the values are adapter settings, not
 * contract limits; `resources/agent-host/impl/channels.js` reads them.
 */
export const channelLimits = Object.freeze({
  /**
   * Undelivered deliveries one subscriber may have queued before it is
   * dropped (m1a-interfaces.md section 3.2, `LiveSubscription`).
   */
  subscriberQueueDeliveries: 4096,
  /**
   * UTF-8 bytes of string content one subscriber may have queued (the
   * deliveries published after its snapshot) before it is dropped. A
   * delivery count alone allowed 4,096 frame-sized events, about 100 MB per
   * subscriber; 2 MiB is about 85 frame-sized events or 60,000 typical text
   * deltas.
   */
  subscriberQueueBytes: 2 * 1024 * 1024,
  /**
   * Subscribers attached to one session's channel. Fan-out cost grows with
   * the count (0.7 ms per delta for 10 waiting subscribers, J-0230); when a
   * new subscriber would exceed it, the subscriber with the most queued
   * bytes is dropped.
   */
  subscribersPerSession: 32,
  /**
   * Vat batches a channel holds while it waits for a missing older rev. A
   * held batch is delivered after the missing one arrives; when the window
   * is full the channel gives up on the missing revs (a gap).
   */
  reorderWindowBatches: 32,
  /**
   * Deliveries (held batches' events and the deltas that arrived behind
   * them) a channel holds while it waits for a missing rev.
   */
  reorderBacklogDeliveries: 4096,
  /**
   * How long a channel waits for a missing rev before it gives up on it and
   * delivers what it holds (a gap; viewers see the rev jump and re-watch).
   * The late batch is an outside-a-turn publish whose session first fetched
   * a publisher through the manager vat; one manager round trip costs about
   * 0.1-0.5 s (J-0272).
   */
  reorderWaitMs: 1000,
});

/**
 * Disk quotas of staged text (M1b follow-ups, JOURNAL J-9361; contract
 * `designs/m1b-interfaces.md` 17.1). Adapter settings: the blob store in the
 * agent-host adapter (`resources/agent-host/impl/blobs.js`) refuses a
 * staging that would go over either quota, with `textOf.blobSessionQuota`
 * or `textOf.blobDaemonQuota` as the message of the staging failure (the
 * submission, round or tool call fails; nothing is written).
 */
export const blobLimits = Object.freeze({
  /**
   * UTF-8 bytes of staged text one session may hold on disk: what was
   * staged for it in this adapter incarnation, and the files of its handles
   * the adapter resolved since it started (a restart starts the count from
   * what the session's context and reads touch). 1 GiB is about 1,000
   * 1 MiB replies; a 1,000-turn session of mixed sizes holds about 80 MB
   * (J-9361).
   */
  sessionBytes: 1024 * 1024 * 1024,
  /**
   * UTF-8 bytes of staged text on this daemon's disk, all sessions: the
   * files in `<state>/agent-host/blobs` (counted at adapter start) plus
   * every staging since. 16 GiB, a sixth of the 98 GB data volume the
   * specification's host has (Appendix C).
   */
  daemonBytes: 16 * 1024 * 1024 * 1024,
});

// M4 (W4.1, H-11): the subscription settings.
export { subscriptionDefaults } from './subscription-defaults.js';
