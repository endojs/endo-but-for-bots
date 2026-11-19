// @ts-check
/**
 * The limits of mail and subagents (designs/m9-interfaces.md section 3.4;
 * spec R4-101, R4-102, R7-44, G-13). Plain data: evaluated in vats and in
 * Node alike.
 *
 * Where these go: the fold unit of the M9 merge moves every entry into
 * `limits.js` (`limits`) beside the other design settings, and the three
 * workload entries an operator may change (`maxDescendants`, `maxDepth`,
 * `askTimeoutSeconds`) also become optional `HarnessSettings` fields. Until
 * then the M9 modules import `mailLimits` from here. No entry is shared
 * with `config/defaults.js` (none is read by a Node-only module), so no
 * equality test is needed.
 *
 * Units: `...Bytes` are UTF-8 bytes, `...Units` UTF-16 code units (what a
 * guard's `stringLengthLimit` bounds), `...Seconds` seconds. Every bound is
 * on retained state or on one message, never a lifetime count.
 */

/** @type {Readonly<Record<string, number>>} */
export const mailLimits = harden({
  // ---- one session's inbox (session vat heap) ----
  /**
   * Messages an inbox holds at once, waiting, handling or kept (G-13: the
   * spec's backlog is unbounded, R4-59). One more delivery is refused with
   * `mailTextOf.inboxFull` to the sender; nothing is dropped. 256 inline
   * bodies of at most 8,192 bytes are at most 2 MiB of heap.
   */
  inboxMessages: 256,
  /**
   * A body of a message that starts no turn (a reply, a value) is kept
   * inline, cut to this many UTF-8 bytes with `postOfficeTextOf.bodyCut`, so the
   * inbox never holds a staged file that nothing else names (17.1).
   */
  strayBodyBytes: 8192,
  /** Messages one `listMessages` answer shows, newest first. */
  listMessagesPage: 32,
  /** Delivery outcomes an inbox remembers for duplicate deliveries (by seq). */
  deliveryOutcomesKept: 64,

  // ---- one message ----
  /**
   * A mail body (package text, request or form description, task, reply):
   * staged above `inlineBytes`. R4-102's task bound, used for every body.
   */
  mailBodyUnits: 1_048_576,
  /** Recipients of one `send` (Fae accepts a string or a list). */
  recipientsPerSend: 8,
  /** A request's or form's description, inline. */
  requestDescriptionUnits: 4096,
  /** Fields of one form. */
  formFields: 32,
  /** A form field's name (a label, F.2 a; a Map key in a vat, never a record key). */
  formFieldNameUnits: 64,
  /** A form field's description shown to the model. */
  formFieldDescriptionUnits: 512,
  /** A typed answer (`resolveRequest` value, a form value, a default), JSON text, inline. */
  requestAnswerBytes: 8192,
  /** A form field's default, JSON text. */
  formDefaultUnits: 256,
  /**
   * String content of one Envelope, AskAnswer or PostReceipt a vat sends
   * (keys included, units x 3 in a vat): `frameBytes` - 2,048 for the
   * envelope and up to 34 handles, as `presetRecordBytes`. The post office
   * refuses a draft whose envelope would not fit (`postOfficeTextOf.
   * envelopeTooLarge`) before it delivers; the hub's 65,536-byte ceiling
   * (CC-027) is the backstop.
   */
  envelopeBytes: 22_528,
  /** An operator's idempotency key for `request` and `form` (R3-216; F.2 e). */
  responseKeyUnits: 128,
  /** Strings and edges in one `send` or `reply` argument list. */
  mailParts: 64,

  // ---- the post office (factory vat heap) ----
  /** Deliveries posted and not yet answered by their recipient. */
  postInFlight: 1024,
  /**
   * String bytes (`messageBytes`) of the envelopes those deliveries keep
   * for a re-drive, summed: a post that would pass it is refused with
   * `postOfficeTextOf.postOfficeBusy`, as a full count is. 4 MiB of factory
   * heap, where 1,024 envelopes of `envelopeBytes` would be 23 MB (WX.0
   * X-16); a staged body is kept as its handle, never its bytes.
   */
  postInFlightBytes: 4_194_304,
  /**
   * Postmarks the post office remembers for reply correlation and the
   * forged-reply check (a ring): recipient, sender and open ask.
   */
  postmarksKept: 4096,
  /** Messages the operator's inbox holds at once (refused when full). */
  operatorInboxMessages: 256,
  /** Requests and forms the operator's mailbox keeps, open or settled (a ring of settled ones). */
  retainedRequests: 1024,
  /** Rows in one page of the operator's inbox. */
  operatorPageRows: 32,

  // ---- subagents (R4-101, R4-102, R7-44) ----
  /** Live descendants per root tree, counting spawns in flight (R4-101; 0 disables). */
  maxDescendants: 8,
  /** Depth limit: tools are offered while depth < maxDepth (R4-69; 0 removes them). */
  maxDepth: 2,
  /** `askSubagent` default timeout (R4-102). */
  askTimeoutSeconds: 86_400,
  /** Smallest `timeoutSeconds` (Fae `MIN_ASK_TIMEOUT_SECONDS`). */
  minAskTimeoutSeconds: 1,
  /** Largest `timeoutSeconds` (R4-102). */
  maxAskTimeoutSeconds: 604_800,
  /** A task (R4-102: 1 Mi characters). */
  taskUnits: 1_048_576,
  /**
   * A child's standing instructions, UTF-8 bytes: inline only (D-M9-20;
   * R3-39 allows 1 Mi characters, owner question O-M9-11).
   */
  systemPromptBytes: 8192,
  /**
   * An answer before the tool limit (R4-102: 16 Mi characters). The
   * adapter's copy cuts it to the tool limit anyway (`toolOutputUnits`), so
   * this bounds only what the child's transcript holds.
   */
  answerUnits: 16_777_216,
  /** A subagent name: `/^[a-z][a-z0-9-]{0,62}$/` (R3-39). */
  subagentNameUnits: 63,
  /** Questions in flight per subagent (Fae: one). */
  asksPerSubagent: 1,

  // ---- staged tool arguments (the exec vat's `splitArgs`) ----
  /** A string value longer than this is staged by `splitArgs`. */
  splitStringUnits: 1024,
  /** Staged strings one `splitArgs` answer may carry. */
  splitStagedStrings: 16,
});
