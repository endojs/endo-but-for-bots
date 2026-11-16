// @ts-check
/**
 * The M1a interface contract (milestones.md M1a W1a.0; architecture.md
 * sections 3, 4 and 9; `designs/m1a-interfaces.md` says who calls each method,
 * in which crank, answered or sendOnly, the largest message, and what a
 * retired break from it means).
 *
 * Every object that crosses between M1a's units has its `M.interface` guard
 * here; every record that crosses has a closed `M.splitRecord` shape with a
 * fixed key vocabulary (rule 12.10: a fresh record key costs a vat one of its
 * ~57,000 names for life); every string and array is bounded from
 * `limits.js`. Model and tool JSON crosses as text, never as a record.
 *
 * A guard does not protect a vat from an oversize frame or from fresh record
 * keys (decoding happens before the guard runs); senders check sizes first
 * (`bounded.js`, rule 12.5) and the gateway checks keys against these shapes
 * (architecture section 7).
 *
 * Runs in vats (prelude globals) and in Node: a Node process must install the
 * guest prelude on `globalThis` before importing this module
 * (`scripts/guest-prelude.js` `installGuestPrelude()`; tests import
 * `test/unit/_m1a-prelude.js` first).
 *
 * Changing an existing guard is a contract change (commit subject
 * `contract(thixotrope-harness): ...`, m1a-interfaces.md updated in the same
 * commit). Later milestones add methods and optional record keys; they never
 * remove or narrow one another unit relies on.
 */
import { limits } from './limits.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);
if (M === undefined) {
  throw TypeError(
    'guest/lib/interfaces.js needs the guest prelude on globalThis; in Node call installGuestPrelude() from scripts/guest-prelude.js before importing it',
  );
}

// ---------------------------------------------------------------- helpers

/** @type {Map<number, any>} */
const textShapes = new Map();
/**
 * A string of at most `units` UTF-16 units (one matcher per bound).
 * @param {number} units
 */
const text = units => {
  if (!textShapes.has(units)) {
    textShapes.set(units, M.string({ stringLengthLimit: units }));
  }
  return textShapes.get(units);
};
/**
 * @param {any} shape
 * @param {number} length
 */
const list = (shape, length) => M.arrayOf(shape, { arrayLengthLimit: length });
/**
 * A closed record: these keys and no others. `M.splitRecord` admits any
 * further keys unless its rest pattern is given; the empty record as rest
 * refuses them (rule 12.10).
 * @param {Record<string, any>} required
 * @param {Record<string, any>} [optional]
 */
const record = (required, optional = {}) =>
  M.splitRecord(required, optional, {});

/** Non-negative number: times in ms, counts, rounds, revisions. */
const count = M.and(M.number(), M.gte(0));

/**
 * A hardened record whose properties are built on first read and then kept.
 * Building every guard eagerly costs a vat about 0.55-0.7 s in its loading
 * crank (each `M.interface` about 25 ms, each `M.string` or `M.splitRecord`
 * about 1-1.5 ms; W1a.0 vat probe, JOURNAL J-0201), and most vats use a few.
 * @template {Record<string, () => any>} T
 * @param {T} builders
 * @returns {{ readonly [K in keyof T]: ReturnType<T[K]> }}
 */
const lazyTable = builders => {
  /** @type {Map<string, any>} */
  const built = new Map();
  /** @type {any} */
  const table = {};
  for (const [name, build] of Object.entries(builders)) {
    Object.defineProperty(table, name, {
      enumerable: true,
      get: () => {
        if (!built.has(name)) built.set(name, build());
        return built.get(name);
      },
    });
  }
  return harden(table);
};

// ---------------------------------------------------------------- texts

/**
 * Fixed texts the spec requires (Part I section 4, Appendix A.4), word for
 * word, and the harness's own fixed texts. Builders use these constants and
 * functions; tests compare against them.
 */
export const texts = harden({
  /** R4-10 (SPEC:463, A.4 startTurn). */
  activeTurn: 'Session already has an active turn; observe or cancel it first',
  /** R4-47: the turn ends normally with this final text at the round limit. */
  roundLimit:
    "I wasn't able to finish that within my tool-step limit. Could you narrow it down or try again?",
  /** R4-66: a turn provably never sent to a backend. */
  interruptedBeforeDispatch:
    'Interrupted before dispatch; no backend execution was started.',
  /** R4-32 / R4-66: the result of a tool intent whose outcome a restart hid. */
  toolOutcomeUnknown: 'Tool outcome unknown; do not automatically retry.',
  /**
   * Harness (M1a W1a.2): a message into a vat would exceed frameBytes; the
   * round or tool call fails with this reason before anything is sent.
   */
  frameLimit: "round output exceeds this build's frame limit",
  /** R4-42: a provider tool call without a name, or a non-string id. */
  invalidToolCall: 'Invalid provider tool call',
  /** R4-42: two calls with the same id in one model response. */
  duplicateToolCallId:
    'Provider returned a duplicate tool call ID within one response',
  /** A.4 queue holds (SPEC:1621-1625). */
  holdRestart:
    'These messages were queued before the service restarted. Nothing is sent until you send one.',
  holdStopped:
    'The session was stopped with messages queued. Nothing is sent until you send one.',
  holdInterrupted:
    'The service restarted while this message was being sent, so it may or may not have reached the agent. Check the conversation, then send it again or delete it.',
  /** A.4 hold `refused` when the turn gave no error. */
  holdRefusedDefault: 'Not sent: the turn ended before it started',
  /** R4-55 / A.4 request ids (Fae pending-queue.js:301-334). */
  invalidRequestId: 'Invalid submission request ID',
  requestIdExpired:
    'Submission retry window expired or device clock is incorrect',
  requestIdReused: 'Submission request ID already used for different text',
  receiptLimit:
    'Submission receipt limit reached; wait for the retry window to expire',
  /** R4-6, adapted to object passing (Endo: "use backendId and modelId"). */
  modelOption:
    'createSession option "model" is unsupported; use backend and modelId',
  /** Turn.resolve on a turn whose outcome is known. */
  resolveNotUnknown: 'Only a turn whose outcome is unknown can be resolved',
  /** A history cursor this session did not issue. */
  badCursor: 'Unknown history cursor',
  /** findSession with a key the factory does not know. */
  unknownSession: 'Unknown session',
  /** createSession without a backend (M1a has no factory default). */
  noBackend: 'No backend given and no default backend is configured',
  /** createSession with a blank systemPrompt (R4-27). */
  blankSystemPrompt: 'createSession systemPrompt must be a nonblank string',
  /** QueueEntry.describe on an entry that was claimed or cancelled. */
  entryGone: 'This message is no longer waiting',
  /** Backend.open with a SessionHostFacet the manager did not mint or never bound. */
  unknownSessionHost: 'Unknown session host',
});

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  /**
   * R4-43 (Fae src/tools.js:160).
   * @param {string} name
   * @param {readonly string[]} available
   */
  unknownTool: (name, available) =>
    `Unknown tool: "${name}". Available tools: ${available.join(', ')}`,
  /**
   * R4-43 (Fae src/tool-arguments.js:20).
   * @param {string} key
   * @param {string} tool
   * @param {readonly string[]} allowed
   */
  unexpectedArgument: (key, tool, allowed) =>
    `Unexpected argument ${JSON.stringify(key)} for ${tool}; allowed arguments: ${allowed.join(', ') || '(none)'}`,
  /**
   * R4-45 (Fae session-factory.js:1091).
   * @param {string} parseError the parser's message
   */
  argumentsNotJson: parseError =>
    `could not parse tool arguments as JSON (${parseError}). Re-send this tool call with valid JSON arguments.`,
  /**
   * R4-45: a thrown error becomes this result, marked failed.
   * @param {string} message
   */
  errorResult: message => `Error: ${message}`,
  /**
   * R4-46: appended to a cut tool output (Fae session/tool-output.js:18).
   * @param {number} originalUnits the untruncated length in UTF-16 units
   */
  truncationMarker: originalUnits =>
    `\n[Tool output truncated from ${originalUnits} characters. Only a prefix is shown; use filtering or pagination for more.]`,
  /**
   * Architecture 4.1: calls beyond maxCallsPerRound get this failed result.
   * @param {number} calls
   * @param {number} limit
   */
  tooManyCalls: (calls, limit) =>
    `Too many tool calls in one round (${calls}); only the first ${limit} were run.`,
  /**
   * R4-53 / A.4 capacity.
   * @param {number} limit
   */
  queueFull: limit =>
    `This session already has ${limit} messages waiting; send or delete some first`,
  /**
   * A.4 hold `refused`.
   * @param {string} error
   */
  holdRefused: error => `Not sent: ${error}`,
  /**
   * A.4 hold `unavailable`.
   * @param {string} error
   */
  holdUnavailable: error => `Queued messages cannot be read: ${error}`,
  /**
   * R4-42: the id given to a provider tool call that has none.
   * @param {number} round
   * @param {number} index
   */
  synthesizedCallId: (round, index) => `floot-synth-${round}-${index}`,
  /**
   * Composer (M1a, no staging): a submission over inlineBytes.
   * @param {number} bytes
   * @param {number} limit
   */
  submissionTooLarge: (bytes, limit) =>
    `message too large (${bytes} bytes; this build accepts at most ${limit})`,
  /**
   * createSession options M1a does not implement yet.
   * @param {string} name
   */
  optionNotSupported: name =>
    `createSession option "${name}" is not supported yet`,
  /**
   * Backend.open failed (any error, including a retired break from the
   * manager vat, which is a guest vat: that vat is lost, not a restart).
   * @param {string} message
   */
  openFailed: message => `Could not open the backend: ${message}`,
  /**
   * The scripted provider has no round with this index for the turn.
   * @param {number} round
   */
  scriptExhausted: round => `Script has no round ${round} for this turn`,
  /**
   * A built-in tool argument of the wrong type (adapter tools, e.g. echo).
   * @param {string} name
   * @param {string} tool
   * @param {string} expected e.g. 'a string', 'a non-negative number'
   */
  invalidArgument: (name, tool, expected) =>
    `Invalid argument ${JSON.stringify(name)} for ${tool}: expected ${expected}`,
  /**
   * Op ids (architecture 8): turn id, round, call ordinal within the round.
   * @param {string} turnId
   * @param {number} round
   * @param {number} ordinal
   */
  opId: (turnId, round, ordinal) => `${turnId}/r${round}/c${ordinal}`,
});

// ---------------------------------------------------------------- shapes

/**
 * Every shape, by name, built on first use and kept (see `lazyTable`).
 * Senders' checks, tests and the gateway key guard read these.
 */
export const shapes = lazyTable({
  Id: () => text(limits.idUnits),
  Label: () => text(limits.labelUnits),
  Reason: () => text(limits.reasonUnits),
  Text: () => text(limits.textUnits),
  SubmissionText: () => text(limits.submissionUnits),
  ToolName: () => text(limits.toolNameUnits),
  ModelId: () => text(limits.modelIdUnits),
  Cursor: () => text(limits.cursorUnits),
  /** Turn states. `running` and `cancelling` are live; the rest are settled. */
  TurnState: () =>
    M.or(
      'running',
      'cancelling',
      'completed',
      'failed',
      'cancelled',
      'outcome-unknown',
      'interrupted',
    ),
  /** Statuses a TurnSettled record can carry. */
  SettledStatus: () =>
    M.or('completed', 'failed', 'cancelled', 'outcome-unknown', 'interrupted'),
  Phase: () =>
    M.or('thinking', 'using tools', 'compacting context', 'cancelling'),
  Activity: () => M.or('passive', 'working', 'error'),
  Lifecycle: () => M.or('creating', 'ready', 'error', 'lost'),
  HoldReason: () =>
    M.or('restart', 'stopped', 'refused', 'interrupted', 'unavailable'),
  ContextReading: () => record({ usedTokens: count, windowTokens: count }),
  /** One model request's token counts (hosted-agent token-usage.js; R4-33). */
  Usage: () =>
    record(
      {
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        cacheWriteInputTokens: count,
        reasoningOutputTokens: count,
      },
      { context: S.ContextReading },
    ),
  /** Session totals (A.4 getUsage, event `usage`; R4-83). */
  UsageTotals: () =>
    record(
      {
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        cacheWriteInputTokens: count,
        reasoningOutputTokens: count,
        context: S.ContextReading,
        turns: count,
        incompleteTurns: count,
      },
      {},
    ),
  /** A user submission. M1a: inline text only; M1b adds `{ blob, preview, bytes }`. */
  Submission: () => record({ text: S.SubmissionText }),
  /** A tool call as the model returned it; `args` is the model's JSON text. */
  ToolCall: () =>
    record({
      callId: text(limits.callIdUnits),
      name: S.ToolName,
      args: S.Text,
    }),
  /** One tool intent: a ToolCall with the op id the session assigned. */
  ToolIntent: () =>
    record({
      opId: S.Id,
      callId: text(limits.callIdUnits),
      name: S.ToolName,
      args: S.Text,
    }),
  /** A tool as offered to the model; `parameters` is JSON Schema as text. */
  ToolDescription: () =>
    record({
      name: S.ToolName,
      description: text(limits.toolDescriptionUnits),
      parameters: text(limits.toolParametersUnits),
    }),
  /** Who served a round (R4-50, R4-108). */
  ServedBy: () => record({ label: S.Label, modelId: S.ModelId }),
  TurnStarted: () =>
    record({
      kind: 'turn-started',
      turnId: S.Id,
      input: S.SubmissionText,
      at: count,
    }),
  Dispatched: () => record({ kind: 'dispatched', turnId: S.Id, round: count }),
  Partial: () =>
    record({
      kind: 'partial',
      turnId: S.Id,
      round: count,
      text: S.Text,
    }),
  RoundSettled: () =>
    record(
      {
        kind: 'round-settled',
        turnId: S.Id,
        round: count,
        text: S.Text,
        callCount: count,
        usage: S.Usage,
        at: count,
      },
      { servedBy: S.ServedBy },
    ),
  ToolIntents: () =>
    record({
      kind: 'tool-intents',
      turnId: S.Id,
      round: count,
      intents: list(S.ToolIntent, limits.maxCallsPerMessage),
    }),
  ToolResult: () =>
    record(
      {
        kind: 'tool-result',
        turnId: S.Id,
        opId: S.Id,
        name: S.ToolName,
        result: text(limits.toolOutputUnits),
        failed: M.boolean(),
      },
      { outcome: 'unknown' },
    ),
  TurnSettled: () =>
    record(
      {
        kind: 'turn-settled',
        turnId: S.Id,
        status: S.SettledStatus,
        at: count,
      },
      { error: S.Reason, final: S.Text, usage: S.Usage },
    ),
  TurnResolved: () =>
    record({
      kind: 'turn-resolved',
      turnId: S.Id,
      note: S.Reason,
      at: count,
    }),
  /** Any turn record. */
  TurnRecord: () =>
    M.or(
      S.TurnStarted,
      S.Dispatched,
      S.Partial,
      S.RoundSettled,
      S.ToolIntents,
      S.ToolResult,
      S.TurnSettled,
      S.TurnResolved,
    ),
  // ---- adapter <-> session turn traffic ----

  /** `Endpoint.startRound` argument (architecture 4.1, D-9). */
  RoundRequest: () =>
    record(
      {
        turn: M.remotable('Turn'),
        sink: M.remotable('TurnSink'),
        turnId: S.Id,
        round: count,
        base: record({ count, epoch: count }),
        append: list(S.TurnRecord, limits.maxAppendRecords),
        tools: list(S.ToolDescription, limits.maxToolsPerRound),
        options: record(
          { modelId: S.ModelId },
          { reasoningEffort: text(limits.effortUnits), maxOutputTokens: count },
        ),
      },
      { context: M.remotable('ContextSource'), system: S.Text },
    ),
  /** `TurnSink.roundFinal` argument. */
  RoundResult: () =>
    record(
      {
        round: count,
        text: S.Text,
        toolCalls: list(S.ToolCall, limits.maxCallsPerMessage),
        usage: S.Usage,
        at: count,
      },
      { servedBy: S.ServedBy },
    ),
  /** `TurnSink.roundFailed` argument; `partial` is the text streamed so far. */
  RoundFailure: () =>
    record(
      { round: count, reason: S.Reason, at: count },
      { partial: S.Text, usage: S.Usage },
    ),
  /** What `Backend.open(host)` returns: one adapter incarnation's turn ports. */
  AdapterToolEntry: () =>
    record({
      name: S.ToolName,
      tool: M.remotable('AdapterTool'),
    }),
  TurnPorts: () =>
    record({
      endpoint: M.remotable('Endpoint'),
      publisher: M.remotable('LivePublisher'),
      tools: list(S.AdapterToolEntry, limits.maxToolsPerRound),
    }),
  /** `AdapterTool.execute` argument. */
  ToolRequest: () => record({ opId: S.Id, args: S.Text }),
  /**
   * A tool outcome (adapter tools and the vat's tool-table entries alike).
   * `failed`: `text` is the error message (the session writes `Error: <text>`).
   * `frame-limit`: `text` is `texts.frameLimit`; the round fails after its
   * other calls settle.
   */
  ToolOutcome: () =>
    record({
      status: M.or('ok', 'failed', 'frame-limit'),
      text: text(limits.toolOutputUnits),
    }),
  Hold: () => record({ reason: S.HoldReason, message: S.Reason }),
  PendingRow: () =>
    record({
      entry: M.remotable('QueueEntry'),
      key: S.Id,
      preview: text(limits.messagePreviewUnits),
      state: 'queued',
      at: count,
    }),
  PendingView: () =>
    record(
      { entries: list(S.PendingRow, limits.maxWaiting) },
      { hold: S.Hold },
    ),
  EntryInfo: () =>
    record({
      key: S.Id,
      preview: text(limits.messagePreviewUnits),
      state: 'queued',
      at: count,
    }),
  Receipt: () =>
    record(
      {
        requestId: text(limits.requestIdUnits),
        duplicate: M.boolean(),
        state: M.or('queued', 'started'),
      },
      { entry: M.remotable('QueueEntry'), turn: M.remotable('Turn') },
    ),
  PresetSnapshot: () => record({ label: S.Label }),
  SessionInfo: () =>
    record(
      {
        key: S.Id,
        title: text(limits.titleUnits),
        backendTitle: S.Label,
        modelId: S.ModelId,
        presetLabel: S.Label,
        createdAt: count,
      },
      { reasoningEffort: text(limits.effortUnits) },
    ),
  TurnStatus: () =>
    record(
      { turnId: S.Id, state: S.TurnState, round: count, at: count },
      { error: S.Reason, resolution: S.Reason },
    ),
  /** A turn in a history page: its records in order, text fields cut to previews. */
  TurnPreview: () =>
    record(
      {
        turn: M.remotable('Turn'),
        turnId: S.Id,
        state: S.TurnState,
        at: count,
        records: list(S.TurnRecord, limits.historyTurnRecords),
      },
      { cut: M.boolean() },
    ),
  HistoryPage: () =>
    record(
      { turns: list(S.TurnPreview, limits.historyPageTurns) },
      { next: S.Cursor },
    ),
  CurrentTurn: () =>
    record({
      input: S.SubmissionText,
      turn: M.remotable('Turn'),
      history: S.TurnPreview,
    }),
  WatchSnapshot: () =>
    record(
      {
        rev: count,
        info: S.SessionInfo,
        pending: S.PendingView,
        usage: S.UsageTotals,
      },
      { current: S.TurnStatus },
    ),
  // ---- live channel events ----

  /** Events a session vat publishes (architecture 4.2). */
  VatEvent: () =>
    M.or(
      record({
        type: 'turn-start',
        turnId: S.Id,
        input: S.SubmissionText,
        at: count,
      }),
      record({ type: 'phase', turnId: S.Id, phase: S.Phase }),
      record({
        type: 'tool_call',
        turnId: S.Id,
        id: S.Id,
        name: S.ToolName,
        args: S.Text,
      }),
      record({
        type: 'tool_result',
        turnId: S.Id,
        id: S.Id,
        name: S.ToolName,
        result: text(limits.toolOutputUnits),
        failed: M.boolean(),
      }),
      record({ type: 'final', turnId: S.Id, text: S.Text }),
      record({
        type: 'usage',
        turnId: S.Id,
        inputTokens: count,
        outputTokens: count,
        cachedInputTokens: count,
        cacheWriteInputTokens: count,
        reasoningOutputTokens: count,
        context: S.ContextReading,
        turns: count,
        incompleteTurns: count,
      }),
      record({ type: 'end', turnId: S.Id, status: S.SettledStatus }),
      record({ type: 'abort', turnId: S.Id, reason: S.Reason }),
      record({ type: 'pending', pending: S.PendingView }),
    ),
  /** `LivePublisher.publish` argument: one batch per crank. */
  PublishBatch: () =>
    record({
      rev: count,
      events: list(S.VatEvent, limits.publishBatchEvents),
    }),
  /** The adapter's text delta (published in-process, never through a vat). */
  DeltaEvent: () =>
    record({
      type: 'delta',
      turnId: S.Id,
      round: count,
      text: M.string({ stringLengthLimit: limits.scriptRepeat }),
    }),
  FoldedMessage: () =>
    record(
      { role: M.or('assistant', 'tool', 'thinking') },
      {
        text: M.string({ stringLengthLimit: limits.foldTextUnits }),
        id: S.Id,
        name: S.ToolName,
        args: S.Text,
        result: M.or(null, text(limits.toolOutputUnits)),
        failed: M.boolean(),
      },
    ),
  /** reply-fold's FoldableStatus. */
  FoldableStatus: () =>
    record({
      phase: text(limits.labelUnits),
      streamingText: M.string({ stringLengthLimit: limits.foldTextUnits }),
      messages: list(S.FoldedMessage, limits.foldMessages),
      error: M.or(null, S.Reason),
      usage: M.or(null, S.UsageTotals),
    }),
  /** First event of every subscription: the current (or last) turn's fold. */
  SnapshotEvent: () =>
    record(
      { type: 'snapshot' },
      {
        turn: record({
          turnId: S.Id,
          settled: M.boolean(),
          status: S.FoldableStatus,
        }),
      },
    ),
  /** What a subscriber receives: every event numbered by the channel. */
  Delivery: () =>
    record({
      seq: count,
      rev: count,
      event: M.or(S.SnapshotEvent, S.DeltaEvent, S.VatEvent),
    }),
  LiveBatch: () =>
    record(
      { deliveries: list(S.Delivery, limits.liveBatchDeliveries) },
      { closed: M.boolean() },
    ),
  RowPatch: () =>
    record(
      {},
      {
        title: text(limits.titleUnits),
        activity: S.Activity,
        messageCount: count,
        queuedCount: count,
      },
    ),
  SessionRow: () =>
    record(
      {
        session: M.remotable('Session'),
        key: S.Id,
        title: text(limits.titleUnits),
        state: S.Lifecycle,
        activity: S.Activity,
        backendTitle: S.Label,
        modelId: S.ModelId,
        messageCount: count,
        queuedCount: count,
      },
      { effort: text(limits.effortUnits) },
    ),
  SessionPage: () =>
    record(
      { rows: list(S.SessionRow, limits.sessionPageRows), rev: count },
      { next: S.Id },
    ),
  CreateOptions: () =>
    record(
      {},
      {
        title: text(limits.titleUnits),
        preset: M.remotable('Preset'),
        backend: M.remotable('Backend'),
        modelId: S.ModelId,
        reasoningEffort: text(limits.effortUnits),
        systemPrompt: S.Text,
        networkPolicy: M.any(),
        userInitiated: M.boolean(),
        spoken: M.boolean(),
        // Admitted only so the factory can refuse it with the R4-6 text.
        model: M.any(),
      },
    ),
  SessionConfig: () =>
    record(
      {
        key: S.Id,
        title: text(limits.titleUnits),
        backendTitle: S.Label,
        modelId: S.ModelId,
        preset: S.PresetSnapshot,
        createdAt: count,
        userInitiated: M.boolean(),
      },
      { reasoningEffort: text(limits.effortUnits) },
    ),
  SessionServices: () =>
    record({
      backend: M.remotable('Backend'),
      host: M.remotable('SessionHostFacet'),
    }),
  MakeArgs: () =>
    record({
      config: S.SessionConfig,
      services: S.SessionServices,
      rowReporter: M.remotable('RowReporter'),
    }),
  MadeSession: () =>
    record({
      session: M.remotable('Session'),
      internal: M.remotable('SessionInternal'),
    }),
  ProgramPiece: () =>
    record({
      digest: text(64),
      index: count,
      count,
      text: text(limits.frameBytes),
    }),
  ScriptChunk: () =>
    record({ text: S.Text }, { repeat: count, delayMs: count }),
  ScriptToolCall: () =>
    record(
      { name: S.ToolName },
      { callId: text(limits.callIdUnits), args: S.Text, argsKeys: count },
    ),
  ScriptRound: () =>
    record(
      {},
      {
        chunks: list(S.ScriptChunk, limits.scriptChunks),
        chunkDelayMs: count,
        dispatchDelayMs: count,
        toolCalls: list(S.ScriptToolCall, limits.maxCallsPerMessage),
        usage: S.Usage,
        error: S.Reason,
        stall: 'untilCancel',
      },
    ),
  ScriptTurn: () =>
    record(
      { rounds: list(S.ScriptRound, limits.scriptRounds) },
      { input: S.SubmissionText },
    ),
  Script: () => record({ turns: list(S.ScriptTurn, limits.scriptRounds) }),
  BackendSpec: () =>
    record(
      { kind: 'scripted', label: S.Label, script: S.Script },
      { logPath: text(4096) },
    ),
  BackendInfo: () => record({ kind: 'scripted', label: S.Label }),
});
/** Shorthand inside this module. */
const S = shapes;

export const echoArgumentNames = harden(['text', 'delayMs', 'bytes', 'data']);

/** echo as offered to the model (AH/tools/echo.js and the vat's tool table). */
export const echoDescription = harden({
  name: 'echo',
  description:
    'Test tool: returns `text` (repeated or cut to `bytes` characters when given) after `delayMs` milliseconds. `data` is accepted and ignored.',
  parameters: JSON.stringify({
    type: 'object',
    properties: {
      text: { type: 'string' },
      delayMs: { type: 'number', minimum: 0 },
      bytes: { type: 'number', minimum: 0 },
      data: {},
    },
    additionalProperties: false,
  }),
});

// ---------------------------------------------------------------- interfaces

/** @param {string} label */
const R = label => M.remotable(label);
const done = M.undefined();

/**
 * Every interface guard by its interface name, built on first use and kept:
 * `makeExo('Session', interfaces.Session, methods)`.
 */
export const interfaces = lazyTable({
  // ---- session vat (W1a.4, W1a.5) ----

  /** The session's public facet (architecture 3.2; A.4 session facet). */
  Session: () =>
    M.interface('Session', {
      getInfo: M.call().returns(S.SessionInfo),
      rename: M.call(text(limits.titleUnits)).returns(done),
      watch: M.call().returns(S.WatchSnapshot),
      enqueueOnce: M.call(
        S.Submission,
        text(limits.requestIdUnits),
        count,
      ).returns(S.Receipt),
      getSubmissionReceipt: M.call(text(limits.requestIdUnits)).returns(
        M.or(done, S.Receipt),
      ),
      listPending: M.call().returns(S.PendingView),
      startTurn: M.call(S.Submission).optional(count).returns(R('Turn')),
      getCurrentTurn: M.call().returns(M.or(done, S.CurrentTurn)),
      getHistoryPage: M.call().optional(S.Cursor).returns(S.HistoryPage),
      getUsage: M.call().returns(S.UsageTotals),
    }),

  /** Held only by the factory (architecture 3.2). */
  SessionInternal: () =>
    M.interface('SessionInternal', {
      rowSnapshot: M.call().returns(S.RowPatch),
    }),

  /** One turn (A.4 turn handle, object style). */
  Turn: () =>
    M.interface('Turn', {
      getStatus: M.call().returns(S.TurnStatus),
      cancel: M.call().returns(done),
      whenFinished: M.callWhen().returns(S.TurnStatus),
      resolve: M.call(S.Reason).returns(done),
    }),

  /** One waiting queue entry (A.4 queue; edit and sendNow arrive in M2). */
  QueueEntry: () =>
    M.interface('QueueEntry', {
      describe: M.call().returns(S.EntryInfo),
      cancel: M.call().returns(M.boolean()),
    }),

  /** Passed in every startRound; the adapter reports the round through it. */
  TurnSink: () =>
    M.interface('TurnSink', {
      dispatching: M.call(count).returns(M.boolean()),
      roundFinal: M.call(S.RoundResult).returns(done),
      roundFailed: M.call(S.RoundFailure).returns(done),
      deadline: M.call(record({ opId: S.Id })).returns(done),
    }),

  /** Shape only in M1a; built in M1b (architecture 4.5, D-9). */
  ContextSource: () =>
    M.interface('ContextSource', {
      page: M.call()
        .optional(S.Cursor)
        .returns(
          record(
            { records: list(S.TurnRecord, limits.maxAppendRecords) },
            { next: S.Cursor },
          ),
        ),
    }),

  /** What the evaluating crank of the session program returns (M1a cold create; M1b pool). */
  SpareMaker: () =>
    M.interface('SpareMaker', {
      make: M.call(S.MakeArgs).returns(S.MadeSession),
    }),

  // ---- agent-host adapter objects (W1a.2, W1a.3); transient ----

  /** One turn's connection to the backend (architecture 3.3, D-5). */
  Endpoint: () =>
    M.interface('Endpoint', {
      holdTurn: M.callWhen(R('Turn')).returns(done),
      releaseTurn: M.call(R('Turn')).returns(done),
      startRound: M.call(S.RoundRequest).returns(done),
      cancelRound: M.call(R('Turn')).returns(done),
      armDeadline: M.call(
        record({ turn: R('Turn'), opId: S.Id, ms: count }),
      ).returns(done),
      disarm: M.call(record({ turn: R('Turn'), opId: S.Id })).returns(done),
    }),

  /** A session channel's publisher facet (D-8). */
  LivePublisher: () =>
    M.interface('LivePublisher', {
      publish: M.call(S.PublishBatch).returns(done),
    }),

  /** A tool that runs in the agent-host adapter (M1a: echo). */
  AdapterTool: () =>
    M.interface('AdapterTool', {
      execute: M.callWhen(S.ToolRequest).returns(S.ToolOutcome),
    }),

  /** Gateway-local subscription service (D-8); tests reach it through AgentHostAdmin.live(). */
  Live: () =>
    M.interface('Live', {
      subscribe: M.callWhen(R('Session'))
        .optional(count)
        .returns(R('LiveSubscription')),
    }),

  /** A channel's subscriber facet, one per subscriber. */
  LiveSubscription: () =>
    M.interface('LiveSubscription', {
      next: M.callWhen().returns(S.LiveBatch),
      close: M.call().returns(done),
    }),

  /** Gateway-local submissions (D-12); stamps `at`. */
  Composer: () =>
    M.interface('Composer', {
      submit: M.callWhen(
        R('Session'),
        M.string({ stringLengthLimit: limits.messageUnits }),
        text(limits.requestIdUnits),
      ).returns(S.Receipt),
    }),

  // ---- agent-host manager vat objects (W1a.2); durable ----

  /** A configured backend (architecture 3.3); held by the factory and sessions. */
  Backend: () =>
    M.interface('Backend', {
      describe: M.call().returns(S.BackendInfo),
      open: M.callWhen(R('SessionHostFacet')).returns(S.TurnPorts),
    }),

  /** Minted per session by forSession(); given only to that session's vat. */
  SessionHostFacet: () =>
    M.interface('SessionHostFacet', {
      liveChannel: M.callWhen().returns(R('LivePublisher')),
    }),

  /** A start-notice registration. */
  Registration: () =>
    M.interface('Registration', {
      cancel: M.call().returns(done),
    }),

  /** The manager's admin facet, installed as `agentHostAdmin`; held by the factory and the operator. */
  AgentHostAdmin: () =>
    M.interface('AgentHostAdmin', {
      makeBackend: M.callWhen(S.BackendSpec).returns(R('Backend')),
      forSession: M.call().returns(R('SessionHostFacet')),
      bindSession: M.call(R('SessionHostFacet'), R('Session')).returns(done),
      onStart: M.call(R('StartListener')).returns(R('Registration')),
      live: M.callWhen().returns(R('Live')),
      composer: M.callWhen().returns(R('Composer')),
    }),

  // ---- factory vat (W1a.6) ----

  /** Per-session row reporter, held by that session only (architecture 3.1). */
  RowReporter: () =>
    M.interface('RowReporter', {
      changed: M.call(S.RowPatch).returns(done),
    }),

  /** The factory's start listener, registered with AgentHostAdmin.onStart. */
  StartListener: () =>
    M.interface('StartListener', {
      started: M.call().returns(done),
    }),

  /** A preset (M1a: the built-in `chat-only`). */
  Preset: () =>
    M.interface('Preset', {
      describe: M.call().returns(
        record({ label: S.Label, builtIn: M.boolean() }),
      ),
      snapshot: M.call().returns(S.PresetSnapshot),
    }),

  /** The session factory (architecture 3.1; A.4 factory, object style). */
  SessionFactory: () =>
    M.interface('SessionFactory', {
      createSession: M.callWhen(S.CreateOptions).returns(R('Session')),
      listSessions: M.call()
        .optional(record({}, { after: S.Id, limit: count }))
        .returns(S.SessionPage),
      findSession: M.call(S.Id).returns(R('Session')),
      listPresets: M.call().returns(list(R('Preset'), 64)),
    }),

  /** The one object the gateway publishes (F.1 #10). */
  Operator: () =>
    M.interface('Operator', {
      getFactory: M.call().returns(R('SessionFactory')),
    }),

  /** Inventory label `harness`; operator-only through the control socket. */
  HarnessRoot: () =>
    M.interface('HarnessRoot', {
      getOperator: M.call().returns(R('Operator')),
      status: M.call().returns(
        record({
          sessions: count,
          program: record({ digest: text(64), bytes: count }),
        }),
      ),
      loadSessionProgram: M.call(S.ProgramPiece).returns(
        record({ complete: M.boolean(), bytes: count }),
      ),
    }),
});

/**
 * Method names per interface, in declaration order (the gateway key guard
 * and the docs read these; a guard's payload is not reachable from the
 * prelude).
 */
export const methodNames = harden({
  Session: [
    'getInfo',
    'rename',
    'watch',
    'enqueueOnce',
    'getSubmissionReceipt',
    'listPending',
    'startTurn',
    'getCurrentTurn',
    'getHistoryPage',
    'getUsage',
  ],
  SessionInternal: ['rowSnapshot'],
  Turn: ['getStatus', 'cancel', 'whenFinished', 'resolve'],
  QueueEntry: ['describe', 'cancel'],
  TurnSink: ['dispatching', 'roundFinal', 'roundFailed', 'deadline'],
  ContextSource: ['page'],
  SpareMaker: ['make'],
  Endpoint: [
    'holdTurn',
    'releaseTurn',
    'startRound',
    'cancelRound',
    'armDeadline',
    'disarm',
  ],
  LivePublisher: ['publish'],
  AdapterTool: ['execute'],
  Live: ['subscribe'],
  LiveSubscription: ['next', 'close'],
  Composer: ['submit'],
  Backend: ['describe', 'open'],
  SessionHostFacet: ['liveChannel'],
  Registration: ['cancel'],
  AgentHostAdmin: [
    'makeBackend',
    'forSession',
    'bindSession',
    'onStart',
    'live',
    'composer',
  ],
  RowReporter: ['changed'],
  StartListener: ['started'],
  Preset: ['describe', 'snapshot'],
  SessionFactory: [
    'createSession',
    'listSessions',
    'findSession',
    'listPresets',
  ],
  Operator: ['getFactory'],
  HarnessRoot: ['getOperator', 'status', 'loadSessionProgram'],
});
