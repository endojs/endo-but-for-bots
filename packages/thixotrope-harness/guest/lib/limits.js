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

/** The entries the session-object entries below are derived from. */
const core = {
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
  /**
   * The bundled session program (architecture D-4, perf `session.program`);
   * 200,000 until M5's merge raised it (M5 contract O-1, W5.9), 240,000
   * until the group of M6, M8, M9 and M11 (owner question G-1, the PM's
   * working default until the owner rules; WX.1): 270,336. 236,583 bytes
   * after the M3-M5 merge; 213,712 since X1 split the interface tables per
   * vat program (`guards/`, O-1's alternative); 212,484 after step 3. The
   * per-lane caps over that base are in `milestones.md` (the group's
   * section); `test/unit/m1a-session-program.test.js` prints the base.
   * The factory's program store keeps at least this much
   * (`guest/factory/root.js` `maxProgramBytes`).
   */
  sessionProgramBytes: 270_336,

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
  /**
   * The bundled exec program (perf `exec.program`); 100,000 before M5 (O-1).
   * 105,414 bytes after the M3-M5 merge; 62,196 since X1 (`guards/base.js`).
   */
  execProgramBytes: 120_000,
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

  // ---- M2 contract settings (W2.0; designs/m2-interfaces.md) ----
  /**
   * Records in one history page a session vat answers (W2.5; section 6):
   * a page crank marshals about 3 ms per record (J-0370, J-9387); at 48
   * the newest page missed the 300 ms `history.page` budget, so 40 (J-9488).
   */
  historyPageRecords: 40,
  /**
   * The record archive (D-M2-1; section 4): settled turns the session vat
   * keeps after a seal, the most turns one segment takes, and the record
   * and byte bounds of a segment (whole turns; at least one). A session
   * seals when it holds `archiveKeepTurns + archiveSegmentTurns` settled
   * turns, so it keeps between 128 and 159 of them (section 4.13).
   */
  archiveKeepTurns: 128,
  archiveSegmentTurns: 32,
  archiveSegmentRecords: 4096,
  /** Record bytes of one segment (`plainBytes`, staged fields as stubs). */
  archiveSegmentBytes: 4_194_304,
  /** Segments one session may seal (4,096 x 32 = 131,072 turns). */
  archiveMaxSegments: 4096,
  /** Segment entries in one `ContextSource.segments` page or export page. */
  segmentPageEntries: 64,
  /**
   * Outcome-unknown turns the session keeps resolvable after their records
   * were sealed (section 4.6); beyond it the oldest is no longer resolvable.
   */
  maxUnresolvedTurns: 64,
  /** Backends `SessionFactory.listBackends` offers. */
  maxBackends: 16,
  /** Rows in one model catalogue page (a page fits frameBytes). */
  modelPageRows: 50,
  /** A model selection id (`<backend>:<model>`) or catalogue cursor. */
  modelCursorUnits: 320,
  /** A model's description in a catalogue row (cut by the adapter). */
  modelDescriptionUnits: 2048,
  /** Reasoning efforts one model row lists (R4-23). */
  maxEfforts: 8,
  /** A provider base URL in a backend spec (F.2 c; tests: the fake server). */
  urlUnits: 2048,
  /** The largest turn deadline HarnessRoot.configure accepts (1 day). */
  maxTurnDeadlineMs: 86_400_000,
  /** A secret description (R7-25: 1-200 characters, no newline). */
  secretDescriptionUnits: 200,
  /** A secret value (R7-25: at most 1 MiB), adapter-local only. */
  secretValueBytes: 1_048_576,
  /** A key sent as a provider credential (R7-25, contract 9.2), bytes. */
  providerTokenBytes: 8192,
  /** Secrets one daemon holds (contract 9.1). */
  secretsMax: 1024,
  /** Audit events kept in `secrets.audit` (contract 9.1). */
  auditKeepEvents: 10_000,
  /** A provider round's whole streamed body, bytes (adapter memory bound). */
  roundStreamBytes: 67_108_864,
  /** A sealed box: base64 of a 1 MiB value plus its envelope. */
  sealedBoxUnits: 1_400_000,
  /** Secrets in one `SecretsAdmin.list` page. */
  secretPageEntries: 64,
  /** A fixed Secrets code (`secretCodes`). */
  secretCodeUnits: 32,
  /** Audit events in one answer (A.2 default 100; the pages fit a frame). */
  auditPageEvents: 100,

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
};

/**
 * Every guest limit: the entries above and the presets, operator inventory,
 * label map, granted tools, mentions, exec membrane and inspector settings
 * (M5's, `designs/m5-interfaces.md` section 1.3; once `limits-m5.js`
 * `limitsM5`, folded here by HR-SYN-1).
 */
export const limits = harden({
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

  ...core,

  // ---- presets (factory vat; R3-17, R3-22, R4-4, R6-55) ----
  /** Presets in the catalogue, built-in ones included (Fae: 58 + built-ins). */
  maxPresets: 64,
  /** A preset's label (Fae `title`: 120 characters). */
  presetLabelUnits: 120,
  /**
   * A preset's description. Fae allows 1,000 characters; here 500 units, so
   * that a preset with long instructions and 32 endowments still fits
   * `presetRecordBytes` (W5.0-settle; the preset record's frame margin).
   */
  presetDescriptionUnits: 500,
  /**
   * A preset's free-text instructions (R4-26 part 7). Fae allows 32,768
   * characters; here 4,096 units (12,288 bytes at three bytes a unit), so
   * that one preset fits one frame. Open decision O-4 in `m5-interfaces.md`.
   */
  presetInstructionsUnits: 4096,
  /**
   * The string content bytes (UTF-8, keys included; contract rule 4) of one
   * `PresetRecord` the catalogue accepts, checked with `fitsFrame(record,
   * presetRecordBytes)` by the editor before sending and by the catalogue's
   * validation (`texts.presetTooLarge`). The per-field bounds alone allow
   * about 31.6 KB at three bytes a unit (measured in W5.0-settle with the
   * smallcaps encoding, 16 template objects); this whole-record bound keeps
   * 2,048 bytes of `frameBytes` for the CapTP or OCapN envelope, the handles
   * and the fields `describe()` adds (`builtIn`, `revision`, `available`,
   * `unavailableReason`), so every saved preset's `PresetView` fits a frame.
   */
  presetRecordBytes: core.frameBytes - 2048,
  /** An endowment's or an inventory entry's label (Fae: 80 characters). */
  endowmentLabelUnits: 80,
  /** Endowments a preset adds (R3-22 default 32). */
  maxEndowments: 32,
  /** Template objects a preset selects (Fae: 16). */
  maxTemplateObjects: 16,
  /** A template object's kind (`git-workspace`, `development-environment`, ...). */
  templateKindUnits: 64,

  // ---- operator inventory (factory vat; P-52 mapping, R6-40) ----
  /** Entries the operator inventory keeps (M12 Home watches 1,000). */
  maxInventoryEntries: 1024,
  /** Entries in one `Inventory.list` page, and in one `addAll` batch. */
  inventoryPageEntries: 50,

  // ---- the session's label map (session vat; R3-1, R3-31) ----
  /**
   * Labels one session holds at once: preset objects, endowments, adopted
   * attachments, stored values. A bound on retained state (owner's PR 1248
   * rule), not on how many were ever made: `remove` frees a slot.
   */
  maxLabels: 256,
  /** One stored JSON value (model text, never parsed in the session vat). */
  labelValueBytes: core.inlineBytes,
  /** All stored JSON values of one session together. */
  labelJsonBytes: 262_144,
  /** A method name rendered for a remote capability. */
  methodNameUnits: 128,
  /** Method names rendered for a remote capability (exec/render.js keeps 128). */
  maxMethodNames: 128,

  // ---- granted tools (session vat; R3-6, P-65) ----
  /** Grants a session keeps, offered or not (withdrawn ones are dropped). */
  maxGrantedTools: 32,
  /**
   * A granted tool's description as offered to the model (R3-27 allows
   * 16,384; cut here with the R4-46 marker so that the round request stays
   * within a frame). Open decision O-6.
   */
  grantedDescriptionUnits: 1024,
  /** A granted tool's JSON Schema text; a longer one is refused. */
  grantedParametersUnits: 2048,
  /**
   * UTF-8 bytes of granted tools' descriptions in one round request; tools
   * past it are not offered that round (`refused-budget`), newest first.
   */
  roundGrantedToolBytes: 12_288,

  // ---- mentions and packages (session vat; R3-8, R3-9, R4-29, R4-99) ----
  /** Attachments one message carries (R3-9, R4-99). */
  maxAttachments: 32,
  /** Message text of a message with attachments (R3-9: 64,000 characters). */
  packageTextUnits: 64_000,

  // ---- the inspector (exec vat answers for the session; D-M5-2) ----
  /** Inspector calls a session has in flight at once (callWindow). */
  inspectWindow: core.callWindow,
  /** `describeCapability` documentation (Fae: 8,000 characters). */
  describeDocumentationUnits: 8000,
  /** `describeCapability` and `readSources` JSON results (Fae: 48,000). */
  inspectResultUnits: 48_000,
  /** `readSources` items per call (Fae: 1-8). */
  readSourcesItems: 8,
  /** `readSources` lines per item (Fae: 1-200, default 80). */
  readSourcesLineCount: 200,
  /** `readSources` default line count. */
  readSourcesDefaultLines: 80,
  /** `readSources` largest start line (Fae: 1,000,000). */
  readSourcesMaxStartLine: 1_000_000,
  /** `readSources` text per item (Fae: 8,000 characters). */
  readSourcesItemUnits: 8000,
  /** `readSources` path segments (Fae: 1-64) and segment length (1-255). */
  readSourcesPathSegments: 64,
  pathSegmentUnits: 255,
  /** `readSources` literal search text (Fae: 1-256). */
  searchUnits: 256,

  // ---- the exec membrane (exec vat; D-M5-3, open decision O-9) ----
  /**
   * Estimated bytes (units x 3) of one message model code sends to an
   * object outside its exec vat: half a frame, so a receiving vat never
   * meets a message near the 94 KB halt point (fact 2).
   */
  membraneArgBytes: 12_288,
  /** Keys of one record in such a message. */
  membraneRecordKeys: 32,
  /** Record keys of one message, counted over every record in it. */
  membraneMessageKeys: 256,
  /** Nesting depth of one such message. */
  membraneDepth: 32,
});
