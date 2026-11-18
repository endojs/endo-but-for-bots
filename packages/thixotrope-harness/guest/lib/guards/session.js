// @ts-check
/**
 * The guards, shapes, method names and fixed texts the session program
 * reaches beyond `./base.js` (the session vat, its tools and the queue).
 *
 * The chain and its rules: `./base.js`. The tables exported here
 * (`shapes`, `interfaces`, `methodNames`, `texts`, `textOf`) hold
 * this module's entries and those of `./base.js`, the same objects.
 */
import { limits } from '../limits.js';
import {
  text,
  list,
  record,
  count,
  staged,
  R,
  done,
  lazyTable,
} from './base.js';
import * as below from './base.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

// ---------------------------------------------------------------- texts

/**
 * Fixed texts the spec requires (Part I section 4, Appendix A.4), word for
 * word, and the harness's own fixed texts. Builders use these constants and
 * functions; tests compare against them.
 */
export const texts = harden({
  ...below.texts,
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
  /** Turn.resolve on a turn whose outcome is known. */
  resolveNotUnknown: 'Only a turn whose outcome is unknown can be resolved',
  /** A history cursor this session did not issue. */
  badCursor: 'Unknown history cursor',
  /** QueueEntry.describe on an entry that was claimed or cancelled. */
  entryGone: 'This message is no longer waiting',
  /**
   * enqueueOnce or startTurn with empty or whitespace-only text. The spec
   * names the refusal (Fae trims and refuses) but gives no text; this is
   * Fae's (`packages/fae/session/pending-queue.js:49-53` at `1315bef86`,
   * JOURNAL J-0253, J-9150).
   */
  blankSubmission: 'A queued message must be non-empty text',
  /** Turn.resolve on a turn that was already resolved (one TurnResolved per turn). */
  turnAlreadyResolved: 'This turn was already resolved',

  // ---- M1b (m1b-interfaces.md section 13) ----
  /**
   * Architecture 6: the exec vat halted or was given up (the session cannot
   * tell which, J-9051); the vat is retired.
   */
  execTerminated:
    'exec scope terminated: the exec vat stopped (it exceeded the per-step compute budget or its worker failed repeatedly); bindings from earlier calls are gone',
  /** Architecture 6: the exec vat answered busy; it was retired. */
  execBusyReset:
    'the previous exec call was still running; the scope was reset',
  /**
   * M1b QC (J-0333, J-0390): the exec vat ran out of property names (its
   * name table is per vat and never shrinks; the engine's RangeError is
   * catchable, so the vat does not halt). The exec vat answers
   * `{ status: 'exhausted' }`; the session retires the scope.
   */
  execExhausted:
    'exec scope terminated: the exec vat ran out of property names (too many distinct keys were created); bindings from earlier calls are gone',
  /** Harness (R4-9): a session being deleted takes no new work. */
  sessionDeleting: 'This session is being deleted',
  /**
   * Harness (D-M2-1, m2-interfaces.md 4.9): `Turn.getContent` or
   * `Session.findTurn` of a turn whose records were sealed into the
   * archive; read it through the agent host's `History`.
   */
  turnSealed: 'This turn is archived; read it through the history service',
  /**
   * Harness (m2-interfaces.md 4.6): `Turn.resolve` of an archived
   * outcome-unknown turn the session no longer keeps (more than
   * `maxUnresolvedTurns` were waiting).
   */
  turnArchivedUnresolvable:
    'This turn is archived and can no longer be resolved',
  /**
   * Harness (m2-interfaces.md 4.8): a `ContextSource` cursor below the
   * session's sealed boundary.
   */
  recordsSealed: 'These records are archived',
  /** Harness: `Session.findTurn` with an id this session never minted. */
  unknownTurn: 'Unknown turn',
});

/**
 * The record kind letters of `SealRequest.kinds` (m2-interfaces.md 4.4),
 * by record kind; the adapter checks its copy of the range against them.
 */
export const archiveKindLetters = harden([
  ['turn-started', 's'],
  ['dispatched', 'd'],
  ['partial', 'p'],
  ['round-settled', 'r'],
  ['tool-intents', 'i'],
  ['tool-result', 't'],
  ['turn-settled', 'e'],
  ['turn-resolved', 'v'],
]);

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  ...below.textOf,
  /**
   * R4-43 (Fae src/tools.js:160).
   * @param {string} name
   * @param {readonly string[]} available
   */
  unknownTool: (name, available) =>
    `Unknown tool: "${name}". Available tools: ${available.join(', ')}`,
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
   * Backend.open failed (any error, including a retired break from the
   * manager vat, which is a guest vat: that vat is lost, not a restart).
   * @param {string} message
   */
  openFailed: message => `Could not open the backend: ${message}`,
  /**
   * Op ids (architecture 8): turn id, round, call ordinal within the round.
   * @param {string} turnId
   * @param {number} round
   * @param {number} ordinal
   */
  opId: (turnId, round, ordinal) => `${turnId}/r${round}/c${ordinal}`,

  // ---- M1b ----
  /**
   * Architecture 6: the exec deadline fired; the vat was retired.
   * @param {number} ms
   */
  execTimeout: ms =>
    `exec call timed out after ${ms} ms; the exec vat was stopped and the scope was reset; bindings from earlier calls are gone`,
  /**
   * ExecHandle.scope failed (the factory could not provide an exec vat).
   * @param {string} message
   */
  execUnavailable: message => `exec is unavailable: ${message}`,
  /**
   * M1b follow-ups (J-9369; M1a QC advisory J-0296 (7)): an inline
   * submission whose UTF-8 bytes exceed `inlineBytes` (the guard bounds
   * units only, so up to about 24.6 KB passed); the Composer stages such
   * text, so only a caller that skips it meets this.
   * @param {number} bytes
   * @param {number} limit
   */
  inlineTooLarge: (bytes, limit) =>
    `Inline text of ${bytes} bytes is over the ${limit}-byte limit; larger text must be staged (the Composer does this)`,
  /**
   * Harness (R4-48 departure, G-06; m2-interfaces.md 10): the turn deadline
   * (`turnDeadlineMs`, off by default) fired.
   * @param {number} ms
   */
  turnDeadline: ms =>
    `The turn ran longer than its ${ms} ms deadline and was stopped`,
  /**
   * The op id of a turn's deadline timer (architecture 8).
   * @param {string} turnId
   */
  turnDeadlineOpId: turnId => `${turnId}/deadline`,
});

// ---------------------------------------------------------------- shapes

/**
 * M1a's shapes (W1a.0), widened in place by M1b (`staged(...)`) and M2
 * (optional fields; m2-interfaces.md 1.4). `shapes` below holds them with
 * M1b's and M2's.
 */
const m1aShapeBuilders = {
  Id: () => text(limits.idUnits),
  Label: () => text(limits.labelUnits),
  Text: () => text(limits.textUnits),
  SubmissionText: () => text(limits.submissionUnits),
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
  Activity: () => M.or('passive', 'working', 'error'),
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
  /** A user submission: inline text, or (M1b) a StagedText over inlineBytes. */
  Submission: () => M.or(record({ text: S.SubmissionText }), B.StagedText),
  /** A tool call as the model returned it; `args` is the model's JSON text (or staged). */
  ToolCall: () =>
    record({
      callId: text(limits.callIdUnits),
      name: S.ToolName,
      args: staged(S.Text),
    }),
  /** One tool intent: a ToolCall with the op id the session assigned. */
  ToolIntent: () =>
    record({
      opId: S.Id,
      callId: text(limits.callIdUnits),
      name: S.ToolName,
      args: staged(S.Text),
    }),
  /** Who served a round (R4-50, R4-108). */
  // M2 W2.1a: OpenRouter also names the upstream provider (R4-108).
  ServedBy: () =>
    record({ label: S.Label, modelId: S.ModelId }, { provider: S.Label }),
  TurnStarted: () =>
    record(
      {
        kind: 'turn-started',
        turnId: S.Id,
        input: staged(S.SubmissionText),
        at: count,
      },
      // M5 widening (W5.3; m5-interfaces.md 9.1 H-6): the labels of the
      // message's attachments (R3-8, R4-29), never the objects.
      {
        attachments: list(
          text(limits.endowmentLabelUnits),
          limits.maxAttachments,
        ),
      },
    ),
  Dispatched: () => record({ kind: 'dispatched', turnId: S.Id, round: count }),
  Partial: () =>
    record({
      kind: 'partial',
      turnId: S.Id,
      round: count,
      text: staged(S.Text),
    }),
  RoundSettled: () =>
    record(
      {
        kind: 'round-settled',
        turnId: S.Id,
        round: count,
        text: staged(S.Text),
        callCount: count,
        usage: S.Usage,
        at: count,
      },
      { servedBy: S.ServedBy, nativeContext: B.StagedText },
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
        result: staged(text(limits.toolOutputUnits)),
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
      { error: S.Reason, final: staged(S.Text), usage: S.Usage },
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
  /** `TurnSink.roundFinal` argument. */
  RoundResult: () =>
    record(
      {
        round: count,
        text: staged(S.Text),
        toolCalls: list(S.ToolCall, limits.maxCallsPerMessage),
        usage: S.Usage,
        at: count,
      },
      { servedBy: S.ServedBy, nativeContext: B.StagedText },
    ),
  /** `TurnSink.roundFailed` argument; `partial` is the text streamed so far. */
  RoundFailure: () =>
    record(
      { round: count, reason: S.Reason, at: count },
      { partial: staged(S.Text), usage: S.Usage },
    ),
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
      // M2: a started receipt of an archived turn names it by `turnId`
      // only (m2-interfaces.md 5.3).
      {
        entry: M.remotable('QueueEntry'),
        turn: M.remotable('Turn'),
        turnId: S.Id,
      },
    ),
  // M5 widening (W5.3 for W5.1; H-6): optional data fields, no objects.
  PresetSnapshot: () =>
    record(
      { label: S.Label },
      {
        template: text(limits.templateKindUnits),
        instructions: text(limits.presetInstructionsUnits),
        networkPolicy: M.or('off', 'public-internet'),
        modelId: S.ModelId,
        reasoningEffort: text(limits.effortUnits),
        objects: list(
          record({
            kind: text(limits.templateKindUnits),
            label: text(limits.endowmentLabelUnits),
          }),
          limits.maxTemplateObjects,
        ),
        endowmentLabels: list(
          text(limits.endowmentLabelUnits),
          limits.maxEndowments,
        ),
        revision: count,
      },
    ),
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
  RowPatch: () =>
    record(
      {},
      {
        title: text(limits.titleUnits),
        activity: S.Activity,
        messageCount: count,
        queuedCount: count,
        // M2 W2.7 (m2-interfaces.md 7.2): an imported session reports the
        // end of its import; the factory lists its row from then on.
        imported: true,
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
      {
        reasoningEffort: text(limits.effortUnits),
        // M2: the prompt composed at creation (R4-26..R4-28), staged when
        // over inlineBytes; the window of the resolved model (R4-33); the
        // turn deadline (0 or absent: off; m2-interfaces.md 10).
        systemPrompt: staged(S.Text),
        contextLength: count,
        maxOutputTokens: count,
        turnDeadlineMs: count,
      },
    ),
  SessionServices: () =>
    record(
      {
        backend: M.remotable('Backend'),
        host: M.remotable('SessionHostFacet'),
      },
      // M1b W1b.5: the session's exec vat lease (architecture 3.2).
      // M5 widening (W5.3 for W5.1; H-6): the preset's endowments.
      {
        execVat: M.remotable('ExecHandle'),
        endowments: list(
          record({
            label: text(limits.endowmentLabelUnits),
            value: M.remotable(),
          }),
          limits.maxEndowments,
        ),
      },
    ),
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
};

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

/**
 * Return guards of `getHistoryPage` and `getCurrentTurn` (contract 3.1,
 * J-0243, J-9156). Their records were checked against their closed shape
 * when they were appended (records.js) and a preview only shortens strings
 * or drops intents, so the return guard checks the page's structure and
 * bounds (turn and record counts, ids, states) and each record only for
 * being a key (passable data: no promise, error or unknown object; pass
 * styles are memoized per hardened object): one `M.splitRecord` per turn
 * instead of an `M.or` of eight closed records per record. `M.record()`
 * would walk every entry of every record again (about 30 us per record in
 * Node against 3 us for `M.key()`, J-9156). Not in `shapes`: they do not
 * bound strings inside records (the strict `shapes.HistoryPage` and
 * `shapes.CurrentTurn` still describe the value).
 * @type {Map<string, any>}
 */
const views = new Map();

/** @param {string} name */
export const view = name => {
  if (!views.has(name)) {
    const preview = record(
      {
        turn: R('Turn'),
        turnId: S.Id,
        state: S.TurnState,
        at: count,
        records: list(M.key(), limits.historyTurnRecords),
      },
      { cut: M.boolean() },
    );
    views.set(
      'HistoryPage',
      record(
        { turns: list(preview, limits.historyPageTurns) },
        { next: S.Cursor, archived: M.boolean(), archive: S.ArchiveState },
      ),
    );
    views.set(
      'CurrentTurn',
      record({
        input: staged(S.SubmissionText),
        turn: R('Turn'),
        history: preview,
      }),
    );
  }
  return views.get(name);
};

/**
 * Method guards of interfaces later milestones extend: the M1a methods, then
 * (in `foldedMethods` below) M1b's, then (in `m2InterfaceBuilders`) M2's,
 * always in that order.
 */
export const methodsOf = harden({
  ...below.methodsOf,
  Turn: () => ({
    getStatus: M.call().returns(S.TurnStatus),
    cancel: M.call().returns(done),
    whenFinished: M.callWhen().returns(S.TurnStatus),
    resolve: M.call(S.Reason).returns(done),
  }),
  TurnSink: () => ({
    dispatching: M.call(count).returns(M.boolean()),
    roundFinal: M.call(S.RoundResult).returns(done),
    roundFailed: M.call(S.RoundFailure).returns(done),
    deadline: M.call(record({ opId: S.Id })).returns(done),
  }),
  Session: () => ({
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
    getCurrentTurn: M.call().returns(M.or(done, view('CurrentTurn'))),
    getHistoryPage: M.call().optional(S.Cursor).returns(view('HistoryPage')),
    getUsage: M.call().returns(S.UsageTotals),
  }),
  SessionInternal: () => ({
    rowSnapshot: M.call().returns(S.RowPatch),
  }),
  QueueEntry: () => ({
    describe: M.call().returns(S.EntryInfo),
    cancel: M.call().returns(M.boolean()),
  }),
  Composer: () => ({
    submit: M.callWhen(
      R('Session'),
      M.string({ stringLengthLimit: limits.messageUnits }),
      text(limits.requestIdUnits),
    ).returns(S.Receipt),
  }),
});

/**
 * M1a's interface guards (W1a.0). `interfaces` below holds them with M1b's
 * (whose versions replace the M1a ones they extend) and M2's new ones.
 */
const m1aInterfaceBuilders = {
  /** What the evaluating crank of the session program returns (M1a cold create; M1b pool). */
  SpareMaker: () =>
    M.interface('SpareMaker', {
      make: M.call(S.MakeArgs).returns(S.MadeSession),
    }),
};

/** M1a's method names per interface, in declaration order. */
export const m1aMethodNames = harden({
  ...below.m1aMethodNames,
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
});

export const execDescription = harden({
  name: 'exec',
  description:
    'Run JavaScript in your persistent scope. The code is the body of an async function: top-level await works, and a top-level return gives the result (JSON-rendered). In scope: powers, E (eventual send: E(ref).method()), harden, console (output is discarded), sleep(ms). Top-level const and let are per call; globalThis.name = value persists across calls, turns and restarts, until the scope is reset (a reset is always stated in the result). No Date, Math.random, timers, import or require. A call that runs longer than the exec deadline is stopped and resets the scope.',
  parameters: JSON.stringify({
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description:
          'JavaScript; runs as an async function body. Return a result.',
      },
    },
    required: ['code'],
    additionalProperties: false,
  }),
});

/** M1b's shapes (W1b.0); in `shapes` since M2 W2.0. */
const m1bShapeBuilders = {
  /** `TurnSink.progress`: the round's whole text so far, staged; `tail` its last units. */
  Progress: () =>
    record({
      round: count,
      partial: B.StagedText,
      tail: text(limits.messagePreviewUnits),
      at: count,
    }),
  /** M2 delete hook (shape only in M1b): one page of a session's blobs. */
  BlobPage: () =>
    record(
      { blobs: list(M.remotable('Blob'), limits.blobResolveBatch) },
      { next: S.Cursor },
    ),
};

/**
 * Structural return guards of record pages (records as keys, J-9156).
 * @type {Map<string, any>}
 */
const pageViews = new Map();

/** @param {'ContextPage' | 'TurnContentPage'} name */
const pageView = name => {
  if (!pageViews.has(name)) {
    const records = list(M.key(), limits.pageRecords);
    pageViews.set(
      'ContextPage',
      record({ from: count, records }, { next: S.Cursor }),
    );
    pageViews.set('TurnContentPage', record({ records }, { next: S.Cursor }));
  }
  return pageViews.get(name);
};

/**
 * Method guards of the M1b versions that M2 extends again (M1a's methods
 * first, then M1b's).
 */
export const foldedMethodsOf = harden({
  ...below.foldedMethodsOf,
  ContextSource: () => ({
    page: M.call().optional(S.Cursor).returns(pageView('ContextPage')),
  }),
});

/** M1b's interface guards (W1b.0); in `interfaces` since M2 W2.0. */
const m1bInterfaceBuilders = {
  // ---- session vat (W1b.1, W1b.2) ----

  /** M1a TurnSink + `progress` (W1b.1). */
  TurnSink: () =>
    M.interface('TurnSink', {
      ...methodsOf.TurnSink(),
      // Answered from M1b QC (J-0393): true when the session kept this
      // checkpoint in place of the previous one, so the adapter may delete
      // the previous one's file.
      progress: M.call(B.Progress).returns(M.boolean()),
    }),
  /** M1a Turn + `getContent` (W1b.1). */
  Turn: () =>
    M.interface('Turn', {
      ...methodsOf.Turn(),
      getContent: M.call()
        .optional(S.Cursor)
        .returns(pageView('TurnContentPage')),
    }),
};

/** M1b's method names per interface (M1a's first where M1b extends one). */
export const m1bMethodLists = harden({
  ...below.m1bMethodLists,
});

// ================================================================ M2
//
// The M2 contract (W2.0; designs/m2-interfaces.md). New shapes and new
// interfaces go into the folded tables, and so do the M2 versions of the
// interfaces M2 extends (`m2Versions`; the fold, m2-interfaces.md 1.3).

/** M2's shapes (W2.0). */
const m2ShapeBuilders = {
  // ---- the record archive (D-M2-1; m2-interfaces.md 4) ----

  /**
   * Where a session's live records start: records before `sealedTo` are in
   * `segments` sealed segments, turns before `sealedTurns + 1` (by ordinal)
   * are archived, and `digest` is the last segment's chained digest ('' for
   * none).
   */
  ArchiveState: () =>
    record({
      sealedTo: count,
      sealedTurns: count,
      segments: count,
      digest: text(64),
    }),
  /**
   * One sealed segment as the vat indexes it: records [from, to), turns
   * firstTurn .. firstTurn + turns - 1 (ordinals), its record bytes, and its
   * chained digest (m2-interfaces.md 4.2).
   */
  SegmentEntry: () =>
    record({
      from: count,
      to: count,
      firstTurn: count,
      turns: count,
      records: count,
      bytes: count,
      digest: text(64),
    }),
  /** `ContextSource.segments` answer, oldest first. */
  SegmentPage: () =>
    record(
      { segments: list(S.SegmentEntry, limits.segmentPageEntries) },
      { next: S.Cursor },
    ),

  // ---- delete, export and importing (m2-interfaces.md 7) ----

  /** One waiting entry as exported. */
  ExportEntry: () =>
    record({
      submission: S.Submission,
      requestId: text(limits.requestIdUnits),
      at: count,
    }),
  /**
   * `SessionInternal.exportState` page and `importState` chunk: one `part`
   * each, in the order head, archive, records, queue, end.
   */
  SessionExportPage: () =>
    record(
      { part: M.or('head', 'archive', 'records', 'queue', 'end') },
      {
        info: S.SessionInfo,
        config: S.SessionConfig,
        usage: S.UsageTotals,
        archive: S.ArchiveState,
        segments: list(S.SegmentEntry, limits.segmentPageEntries),
        from: count,
        records: list(S.TurnRecord, limits.pageRecords),
        entries: list(S.ExportEntry, limits.maxWaiting),
        hold: S.Hold,
        next: S.Cursor,
      },
    ),
  /** `SessionInternal.importState` answer. */
  ImportProgress: () => record({ records: count, complete: M.boolean() }),
};

/**
 * `SessionInternal.importState` argument (W2.7, J-0481): a
 * `SessionExportPage` whose `records` are checked structurally (keys, as
 * the structural page views, J-9156). The session checks each record by
 * its kind as it appends it (`RecordLog.append`), so the guard does not
 * try the eight `TurnRecord` alternatives on every imported record first
 * (about 9 ms a record in a vat).
 * @type {any}
 */
let importChunk;

const importChunkView = () => {
  importChunk ??= record(
    { part: M.or('head', 'archive', 'records', 'queue', 'end') },
    {
      info: S.SessionInfo,
      config: S.SessionConfig,
      usage: S.UsageTotals,
      archive: S.ArchiveState,
      segments: list(S.SegmentEntry, limits.segmentPageEntries),
      from: count,
      records: list(M.key(), limits.pageRecords),
      entries: list(S.ExportEntry, limits.maxWaiting),
      hold: S.Hold,
      next: S.Cursor,
    },
  );
  return importChunk;
};

/** M2 versions of the interfaces M2 extends (folded methods first). */
const m2Versions = {
  /** + `findTurn` (W2.5; m2-interfaces.md 4.9). */
  Session: () =>
    M.interface('Session', {
      ...methodsOf.Session(),
      findTurn: M.call(S.Id).returns(R('Turn')),
    }),
  /** + delete, blob paging, data-only export and importing (W2.7). */
  SessionInternal: () =>
    M.interface('SessionInternal', {
      ...methodsOf.SessionInternal(),
      blobPage: M.call().optional(S.Cursor).returns(B.BlobPage),
      deleteSelf: M.call().returns(done),
      exportState: M.call().optional(S.Cursor).returns(S.SessionExportPage),
      importState: M.call(importChunkView()).returns(S.ImportProgress),
    }),
  /** + `edit`, `sendNow` (W2.4; A.4 editPending, sendPending). */
  QueueEntry: () =>
    M.interface('QueueEntry', {
      ...methodsOf.QueueEntry(),
      edit: M.call(S.Submission).returns(done),
      sendNow: M.call().returns(done),
    }),
  /** + `segments` (W2.5; m2-interfaces.md 4.8). */
  ContextSource: () =>
    M.interface('ContextSource', {
      ...foldedMethodsOf.ContextSource(),
      segments: M.call().optional(S.Cursor).returns(S.SegmentPage),
    }),
  /** + `edit` (W2.4): stages an edit over inlineBytes, as `submit`. */
  Composer: () =>
    M.interface('Composer', {
      ...methodsOf.Composer(),
      edit: M.callWhen(
        R('QueueEntry'),
        M.string({ stringLengthLimit: limits.messageUnits }),
      ).returns(done),
    }),
};

/** M2's new interfaces' method names. */
export const m2NewMethodNames = harden({
  ...below.m2NewMethodNames,
});

/** Method names of `m2Interfaces`: the folded ones first, then M2's. */
export const m2VersionMethodNames = harden({
  ...below.m2VersionMethodNames,
  Session: [...m1aMethodNames.Session, 'findTurn'],
});

// ================================================================ tables

/**
 * Every shape this module and the modules below it hold, by name, built on
 * first use and kept (see `lazyTable`).
 */
export const shapes = lazyTable(
  { ...m1aShapeBuilders, ...m1bShapeBuilders, ...m2ShapeBuilders },
  below.shapes,
);
/** Shorthands inside this module. */
const S = shapes;
const B = shapes;

/**
 * Every interface guard this module and the modules below it hold, by
 * interface name, built on first use and kept. Where M1b or M2 extended an
 * interface this is the latest version (the M2 fold, m2-interfaces.md 1.3).
 */
export const interfaces = lazyTable(
  { ...m1aInterfaceBuilders, ...m1bInterfaceBuilders, ...m2Versions },
  below.interfaces,
);

/** Method names per interface of `interfaces`, in declaration order. */
export const methodNames = harden({
  ...m1aMethodNames,
  ...m1bMethodLists,
  ...m2NewMethodNames,
  ...m2VersionMethodNames,
});
