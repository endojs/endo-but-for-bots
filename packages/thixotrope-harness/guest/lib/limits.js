// @ts-check
/**
 * The guest copy of the harness limits (M1a W1a.0; architecture section 9).
 *
 * Guest bundles read only `guest/`, so they cannot import
 * `config/defaults.js`. Every name this module shares with
 * `config/defaults.js` `limits` must keep the same value; the unit test
 * `test/unit/m1a-interfaces.test.js` checks it. The other names are design
 * settings of the M1a contract (`designs/m1a-interfaces.md`); each says what
 * it bounds and where the value comes from.
 *
 * Units: `...Bytes` are UTF-8 bytes; `...Units` are UTF-16 code units (what
 * `string.length` counts and what a pattern's `stringLengthLimit` bounds);
 * `...Ms` milliseconds. A string of at most N bytes has at most N units, so a
 * guard bound in units of a byte budget never refuses a string the byte
 * budget admits.
 *
 * Plain data only: this module is evaluated in vats and in Node alike.
 */
export const limits = harden({
  // ---- shared with config/defaults.js (values must be equal) ----
  /** String content of one message into or out of a vat (J-0193, J-0194). */
  frameBytes: 24_576,
  /** All messages one crank sends (J-0142). */
  crankOutBytes: 196_608,
  /** A text field larger than this is staged as a Blob (M1b; M1a refused it). */
  inlineBytes: 8192,
  /** Distinct record keys a vat may ever receive or create (J-0191); rule 12.10. */
  vatKeyNames: 57_000,
  /** Eventual sends per crank, answered or not (guest rule 12.3; J-0143, J-0194). */
  sendsPerCrank: 100,
  /** Exec source, staged (M1b). */
  execSourceBytes: 262_144,

  // ---- M1a contract settings (guest only) ----
  /**
   * The largest text field any M1a guard admits, in units. Equal to
   * frameBytes: a text that arrived in one message of at most frameBytes
   * bytes has at most frameBytes units. The message-level byte bound is the
   * real limit and is checked by the sender (rule 12.5).
   */
  textUnits: 24_576,
  /** A submission's text (Composer, enqueueOnce, startTurn): inlineBytes in M1a (no staging). */
  submissionUnits: 8192,
  /** Ids the vat mints: session key `s<n>`, turn id `t<n>`, op id `t<n>/r<r>/c<k>`, entry key `q<n>`. */
  idUnits: 64,
  /** A client's submission request id: 13 digits, '-', a UUID (A.4 SPEC:1627). */
  requestIdUnits: 64,
  /** A provider's tool call id (may be empty; R4-42 synthesises one). */
  callIdUnits: 256,
  /** A tool name. */
  toolNameUnits: 128,
  /** A tool description shown to the model. */
  toolDescriptionUnits: 4096,
  /** A tool's JSON schema, as JSON text (rule 12.10). */
  toolParametersUnits: 8192,
  /** Session title (human label, F.2 a). */
  titleUnits: 256,
  /** Labels of presets, backends and the like (F.2 a). */
  labelUnits: 256,
  /** A provider model id (F.2 c). */
  modelIdUnits: 256,
  /** Reasoning effort names (R4-23). */
  effortUnits: 32,
  /** An error or failure reason, a note, a hold text. */
  reasonUnits: 4096,
  /** A history page cursor (text, F.2 d). */
  cursorUnits: 64,
  /** Preview of a message in pages and lists (architecture 9). */
  messagePreviewUnits: 1024,
  /** Preview of tool arguments and results in pages (architecture 9). */
  toolPreviewUnits: 256,
  /** Tool output into the model, marker included (R4-100, R4-46). */
  toolOutputUnits: 32_768,
  /** Waiting queue entries (R4-98, R4-53). */
  maxWaiting: 100,
  /** Submission receipts kept (R4-98). */
  maxReceipts: 4096,
  /** Submission request ids are valid this long (R4-98). */
  retryWindowMs: 86_400_000,
  /** Allowed clock skew of a request id's timestamp (R4-98). */
  clockSkewMs: 300_000,
  /** Tool calls run per round; extras get an error result (architecture 4.1, decision 11). */
  maxCallsPerRound: 64,
  /** Tool calls in flight at once (architecture 4.1). */
  callWindow: 16,
  /** Tool calls one model message may carry into the vat (the rest of the frame bound). */
  maxCallsPerMessage: 256,
  /** Model rounds per turn (R4-95). */
  maxToolRounds: 1024,
  /** Events in one publish batch from a vat (architecture 4.2). */
  publishBatchEvents: 64,
  /** Records in one startRound append (the frame bound applies too). */
  maxAppendRecords: 512,
  /** Turns in one history page (R4-106); the page is also bounded by frameBytes. */
  historyPageTurns: 32,
  /** Records shown for one turn in a history page; more is marked cut. */
  historyTurnRecords: 256,
  /**
   * Turn objects of settled turns a session keeps (most recently used): a
   * settled turn is a record, and its Turn is minted from it when a page or
   * a receipt hands it out (J-9152). One history page's worth, so reading a
   * page again hands out the same objects.
   */
  retainedTurnHandles: 32,
  /** Rows in one session list page (architecture 3.1). */
  sessionPageRows: 50,
  /** Tool descriptions offered in one round. */
  maxToolsPerRound: 128,
  /** A message string through the Composer (open decision 1); M1a refuses over inlineBytes. */
  messageUnits: 200_000,
  /** Text held by one fold (adapter side; never enters a vat). */
  foldTextUnits: 1_048_576,
  /** Messages held by one fold (adapter side). */
  foldMessages: 4096,
  /** Deliveries in one LiveSubscription.next() answer (adapter to client). */
  liveBatchDeliveries: 256,
  /** The bundled session program (architecture D-4, perf `session.program`). */
  sessionProgramBytes: 200_000,

  // ---- M1b contract settings (W1b.0; designs/m1b-interfaces.md) ----
  /** A piece a vat appends to a BlobWriter, bytes (architecture 6: frameBytes / 2). */
  blobPieceBytes: 12_288,
  /** Text of one Content page read into a vat, bytes (a frame less its wrapper). */
  blobPageBytes: 20_480,
  /** A ContextSource page, bytes: vat to adapter only, never into a vat (4 frames). */
  contextPageBytes: 98_304,
  /** Records in one ContextSource or Turn.getContent page. */
  pageRecords: 512,
  /**
   * A RoundResult the adapter sends, bytes: frameBytes less room for the op
   * ids and keys its tool calls gain as ToolIntents (256 x 24 bytes).
   */
  roundResultBytes: 18_432,
  /** Blob handles the manager mints per stock refill (D-15). */
  blobStockBatch: 32,
  /** Blob handles resolved per manager crank after a restart (D-15). */
  blobResolveBatch: 64,
  /** Partial text is staged after this many new bytes of a round ... */
  progressEveryBytes: 16_384,
  /** ... or this long after the last checkpoint (architecture 4.1). */
  progressEveryMs: 10_000,
  /**
   * M1b QC (J-0393): a checkpoint stages the whole text so far, so a fixed
   * cadence wrote bytes quadratic in the reply's length (34 MB for 1 MiB).
   * A round's checkpoints together stage at most this many times its text
   * so far: one is skipped while the bytes staged by the round's earlier
   * checkpoints exceed (factor - 1) x the text so far, so the bytes written
   * stay linear (about 3x the reply) and checkpoints thin out to every half
   * of the text again.
   */
  progressWriteFactor: 3,
  /** An open BlobWriter idle this long is aborted by the adapter. */
  blobWriterIdleMs: 60_000,
  /** Exec call deadline (architecture 6; open decision 10); HarnessRoot.configure changes it. */
  execDeadlineMs: 120_000,
  /** The bundled exec program (perf `exec.program`). */
  execProgramBytes: 100_000,
  /** Spare session vats, spare exec vats, creations in parallel (D-4). */
  spareSessions: 2,
  spareExec: 1,
  poolLanes: 4,
  /** Pool targets HarnessRoot.configure accepts. */
  maxSpares: 16,
  /**
   * Outside-a-turn publishes waiting behind the one in flight: one batch's
   * worth of events (and frameBytes); the oldest is dropped (J-9172).
   */
  outsidePendingEvents: 64,

  // ---- scripted provider script bounds (AH/providers/scripted.js) ----
  /** Rounds in one script. */
  scriptRounds: 256,
  /** Chunks in one scripted round. */
  scriptChunks: 1024,
  /** A chunk's repeat count (expands to at most this many copies in the adapter). */
  scriptRepeat: 1_048_576,
  /** Delays in scripts and echo calls, at most 10 minutes. */
  maxDelayMs: 600_000,
  /** Echo output size request, units (cut to toolOutputUnits by echo itself). */
  echoMaxUnits: 1_048_576,
});
