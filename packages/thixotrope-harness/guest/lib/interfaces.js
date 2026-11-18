// @ts-check
/**
 * The M1a interface contract (milestones.md M1a W1a.0; architecture.md
 * sections 3, 4 and 9; `designs/m1a-interfaces.md` says who calls each method,
 * in which crank, answered or sendOnly, the largest message, and what a
 * retired break from it means), M1b's (W1b.0; `designs/m1b-interfaces.md`)
 * and M2's (W2.0; `designs/m2-interfaces.md`).
 *
 * Tables: `shapes`, `interfaces` and `methodNames` hold every M1a, M1b and
 * M2 entry. M2 W2.0 folded M1b's tables into M1a's; at M2 sign-off (X1) the
 * M2 versions of the ten interfaces M2 extends were folded in the same way:
 * `interfaces.Session` is the M2 `Session` (with `findTurn`), and so on.
 * `m2Interfaces`, `m2MethodNames`, `m1bShapes`, `m1bInterfaces` and
 * `m1bMethodNames` remain as views over the folded tables (the same
 * objects), for modules written against them; new code imports `shapes`,
 * `interfaces` and `methodNames`.
 *
 * Where the entries live (X1): a vat program bundles every module it
 * imports whole, so the entries are split by the programs that read them
 * into a chain of modules, `guards/base.js` (the exec program) <
 * `guards/session.js` < `guards/factory.js` (with the factory's stand-in
 * session) < this module (Node-side code, the manager's modules, tests and
 * the gateway's vocabulary). Each module's tables answer its own entries
 * and every entry below it (the same objects); this module's tables answer
 * every entry. Guest programs import the module of the lowest program that
 * bundles them, never this one.
 *
 * Every object that crosses between M1a's units has its `M.interface` guard
 * in these modules; every record that crosses has a closed `M.splitRecord`
 * shape with a fixed key vocabulary (rule 12.10: a fresh record key costs a
 * vat one of its ~57,000 names for life); every string and array is bounded
 * from `limits.js`. Model and tool JSON crosses as text, never as a record.
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
import {
  text,
  list,
  record,
  count,
  staged,
  R,
  done,
  lazyTable,
} from './guards/base.js';
import { view } from './guards/session.js';
import * as below from './guards/factory.js';

export { execArgumentNames } from './guards/base.js';
export {
  archiveKindLetters,
  echoDescription,
  execDescription,
} from './guards/session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

/**
 * A hardened view of some names of a lazy table: each property reads the
 * table's (the same object). The M1b and M2 tables are such views since
 * their folds into the main tables.
 * @param {readonly string[]} names
 * @param {any} table
 */
const viewOf = (names, table) => {
  /** @type {any} */
  const answer = {};
  for (const name of names) {
    // The names are this module's own table keys, fixed in its source.
    // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
    Object.defineProperty(answer, name, {
      enumerable: true,
      get: () => table[name],
    });
  }
  return harden(answer);
};

// ---------------------------------------------------------------- texts

/**
 * Fixed texts the spec requires (Part I section 4, Appendix A.4), word for
 * word, and the harness's own fixed texts. Builders use these constants and
 * functions; tests compare against them.
 */
export const texts = harden({
  ...below.texts,
  receiptLimit:
    'Submission receipt limit reached; wait for the retry window to expire',
  /** Backend.open with a SessionHostFacet the manager did not mint. */
  unknownSessionHost: 'Unknown session host',
  /** Content.read with a handle that has no file. */
  blobUnknown: 'Unknown blob',
  /**
   * M1b follow-ups (J-9364): a handle that was staged for another session
   * (`Content.read` through a session's ports, or a staged field in a
   * session's records that names another session's blob).
   */
  blobNotOwned: 'This blob belongs to another session',
  /** BlobWriter.append or close after close or abort. */
  writerClosed: 'This blob writer is closed',

  // ---- M2 (m2-interfaces.md section 14) ----
  /**
   * R4-77 (Fae providers/anthropic-streaming.js:170 at 1315bef86): a 401
   * from the Anthropic API.
   */
  anthropicAuthFailed:
    'Anthropic API authentication failed (invalid or expired API key). Check the configured Secret.',
  /**
   * R4-78 (lal providers/openrouter.js:515): appended, after a blank line,
   * to a reply the model cut at its own output limit.
   */
  outputLimitNote: '[The model stopped here: it reached its own output limit.]',
  /** R4-74 (lal providers/openrouter.js:337): network failure or unreadable answer. */
  openRouterUnreachable:
    'OpenRouter could not be reached or sent an unreadable response',
  /** R4-21 (Fae session/provider-connections.js:546): OpenRouter ids are `org/model`. */
  openRouterModelPrefix:
    'OpenRouter model must include its organization prefix',
  /**
   * Harness (R4-79: no provider body in failure text): the Anthropic API
   * could not be reached or answered something unreadable (OpenRouter's
   * wording, R4-74).
   */
  anthropicUnreachable:
    'Anthropic API could not be reached or sent an unreadable response',
});

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  ...below.textOf,
  /**
   * Composer (M1a, no staging): a submission over inlineBytes.
   * @param {number} bytes
   * @param {number} limit
   */
  submissionTooLarge: (bytes, limit) =>
    `message too large (${bytes} bytes; this build accepts at most ${limit})`,
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
   * M1b follow-ups (J-9361): a staging that would take a session's staged
   * text on disk over its quota (`blobLimits.sessionBytes`); the message of
   * the staging failure (`stagingFailed`).
   * @param {number} bytes the text being staged
   * @param {number} held bytes the session already has staged
   * @param {number} quota
   */
  blobSessionQuota: (bytes, held, quota) =>
    `the session's staged text would exceed its disk quota: ${bytes} more bytes on top of ${held}, quota ${quota} bytes`,
  /**
   * M1b follow-ups (J-9361): a staging that would take all staged text on
   * this daemon's disk over the daemon-wide quota (`blobLimits.daemonBytes`).
   * @param {number} bytes
   * @param {number} held bytes staged on this daemon's disk
   * @param {number} quota
   */
  blobDaemonQuota: (bytes, held, quota) =>
    `the daemon's staged text would exceed its disk quota: ${bytes} more bytes on top of ${held}, quota ${quota} bytes`,

  // ---- M2 (m2-interfaces.md section 14) ----
  /**
   * R4-74 (lal providers/openrouter.js:359): a non-2xx answer.
   * @param {number} status
   */
  openRouterHttp: status => `OpenRouter request failed (HTTP ${status})`,
  /**
   * R4-74, R4-93 (lal providers/openrouter.js:335): the request timeout.
   * @param {number} seconds
   */
  openRouterTimeout: seconds =>
    `OpenRouter did not answer within ${seconds} seconds`,
  /**
   * R4-74 (lal providers/openrouter.js:437-441): the last failure after
   * retries.
   * @param {string} failure
   * @param {number} attempts
   */
  afterAttempts: (failure, attempts) =>
    attempts > 1 ? `${failure}, after ${attempts} attempts` : failure,
  /**
   * R4-78 (lal providers/openrouter.js:458, 471): content filtering, or a
   * length stop with no text. `served` is `textOf.servedBy(...)` or ''.
   * @param {'content_filter' | 'length'} reason
   * @param {string} served
   */
  openRouterStopped: (reason, served) =>
    `OpenRouter completion stopped: ${reason}${served}`,
  /**
   * R4-78 (lal providers/openrouter.js:497): an answer with neither text
   * nor tool calls. `details` as `served`.
   * @param {string} details
   */
  openRouterEmpty: details =>
    `OpenRouter returned an empty assistant response${details}`,
  /**
   * R4-79 (lal providers/openrouter.js:379): an `error` object in the
   * answer (W2.1a: in a stream chunk). `details` as `served`, with the
   * error's code when it has an identifier's shape.
   * @param {string} details
   */
  openRouterApiError: details => `OpenRouter returned an API error${details}`,
  /**
   * R4-79 (lal providers/openrouter.js:394): no choice, or a choice that
   * finished with `error`. `details` as `served`.
   * @param {string} details
   */
  openRouterNoMessage: details =>
    `OpenRouter returned no successful assistant message${details}`,
  /**
   * The parenthesised detail of OpenRouter failures (lal
   * providers/openrouter.js:148-156): ` (served by m, via p)`, or ''.
   * Values are the provider's model and provider names only, never a body.
   * @param {readonly [string, string][]} parts label and value pairs
   */
  servedBy: parts =>
    parts.length === 0
      ? ''
      : ` (${parts.map(([label, value]) => `${label} ${value}`).join(', ')})`,
  /**
   * Harness (R4-79): an Anthropic API answer other than 2xx or 401.
   * @param {number} status
   */
  anthropicHttp: status => `Anthropic API request failed (HTTP ${status})`,
  /**
   * Harness (G-04, R4-93): the Anthropic request timeout.
   * @param {number} seconds
   */
  anthropicTimeout: seconds =>
    `Anthropic API did not answer within ${seconds} seconds`,
  /**
   * Harness (R4-78, R4-79; OpenRouter's wording): a stop the round cannot
   * deliver (`max_tokens` without text or inside a tool call, `refusal`, an
   * unknown stop reason). `reason` is the API's stop reason when it has an
   * identifier's shape, else `unknown`.
   * @param {string} reason
   */
  anthropicStopped: reason => `Anthropic API completion stopped: ${reason}`,
  /**
   * Harness (R4-79): an `error` event in the stream (`overloaded_error`,
   * `api_error`, ...). `details` is `textOf.servedBy([['type', t]])` or ''.
   * @param {string} details
   */
  anthropicApiError: details => `Anthropic API returned an error${details}`,
  /**
   * Harness (R4-42: on Claude the stop reason must agree with the presence
   * of tool calls; the Fae text was not available to this build).
   * @param {string} reason the stop reason (identifier-shaped or `unknown`)
   * @param {number} calls tool calls in the answer
   */
  anthropicStopMismatch: (reason, calls) =>
    `Anthropic API stop reason ${reason} does not match the ${calls} tool calls of its answer`,
  /**
   * A.4 creation error (Fae session/provider-connections.js:600).
   * @param {string} modelId
   */
  unknownProviderModel: modelId =>
    `Unknown model "${modelId}" for the provider backend`,
  /**
   * R7-24 (daemon secret-manager.js:27 at 1315bef86): every Secrets
   * failure is one of the fixed codes (`secretCodes`), never secret bytes.
   * @param {string} code
   */
  secretFailed: code => `Secret operation failed: "${code}"`,
  /**
   * Harness (m2-interfaces.md 4.4): sealing failed; nothing was dropped and
   * the session seals again later. Also the failure of an archive read.
   * @param {string} message
   */
  archiveFailed: message => `could not archive turns: ${message}`,
});

/**
 * R7-24 (daemon secret-manager.js at 1315bef86): the fixed codes of
 * Secrets failures and audit events; `textOf.secretFailed(code)`.
 */
export const secretCodes = harden([
  'INVALID_DESCRIPTION',
  'INVALID_SECRET_BYTES',
  'UNKNOWN_SECRET',
  'UNKNOWN_GRANT',
  'REVOKED',
  'STALE_READ',
  'READ_FAILED',
  'INVALID_GENERATION',
  'GENERATION_CONFLICT',
  'REPLACE_FAILED',
  'NOT_REVOKED',
  'DELETE_FAILED',
  'INVALID_LIMIT',
  'CREATE_FAILED',
]);

// ---------------------------------------------------------------- shapes

/**
 * M1a's shapes (W1a.0), widened in place by M1b (`staged(...)`) and M2
 * (optional fields; m2-interfaces.md 1.4). `shapes` below holds them with
 * M1b's and M2's.
 */
const m1aShapeBuilders = {
  Phase: () =>
    M.or('thinking', 'using tools', 'compacting context', 'cancelling'),

  // ---- adapter <-> session turn traffic ----

  /** `Endpoint.startRound` argument (architecture 4.1, D-9). */
  RoundRequest: () =>
    record(
      {
        turn: M.remotable('Turn'),
        sink: M.remotable('TurnSink'),
        turnId: S.Id,
        round: count,
        // M2: `archive` once the session has sealed segments (D-M2-1;
        // m2-interfaces.md 4.8): records before `archive.sealedTo` are
        // in the archive, not in the vat.
        base: record({ count, epoch: count }, { archive: S.ArchiveState }),
        append: list(S.TurnRecord, limits.maxAppendRecords),
        tools: list(S.ToolDescription, limits.maxToolsPerRound),
        options: record(
          { modelId: S.ModelId },
          { reasoningEffort: text(limits.effortUnits), maxOutputTokens: count },
        ),
      },
      // M2: `system` may be staged (a composed prompt over inlineBytes).
      // M5 widening (W5.3; H-6): or two parts, the stored prompt and the
      // turn's R4-29 line, joined by the adapter's `systemTextOf`.
      {
        context: M.remotable('ContextSource'),
        system: M.or(staged(S.Text), list(staged(S.Text), 2)),
      },
    ),
  /** What `Backend.open(host)` returns: one adapter incarnation's turn ports. */
  AdapterToolEntry: () =>
    record({
      name: S.ToolName,
      tool: M.remotable('AdapterTool'),
    }),
  /**
   * `since`: when the adapter incarnation that minted these ports started
   * (ms since the epoch, the adapter's clock). The session holds its ports
   * across turns and compares a turn's claim time with the `since` of fresh
   * ports to tell a turn in flight at a restart from one claimed on ports
   * that were already dead (m1a-interfaces.md 6.1, 7).
   */
  TurnPorts: () =>
    record(
      {
        endpoint: M.remotable('Endpoint'),
        publisher: M.remotable('LivePublisher'),
        tools: list(S.AdapterToolEntry, limits.maxToolsPerRound),
        since: count,
      },
      // M1b: what the exec vat is handed per call (m1b-interfaces.md 3.2).
      {
        content: M.remotable('Content'),
        writers: M.remotable('BlobWriters'),
        timer: M.remotable('Timer'),
        // M2 (D-M2-1): this session's archive port in this incarnation.
        archive: M.remotable('ArchivePort'),
      },
    ),
  /** `AdapterTool.execute` argument; M1b: `args` may be staged (W1b.1, 6.4). */
  ToolRequest: () => record({ opId: S.Id, args: staged(S.Text) }),
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
  /**
   * M2: `archived` when the turns before `next` are sealed (read them
   * through `History.page`); `archive` whenever the session has sealed
   * segments (m2-interfaces.md 4.9).
   */
  HistoryPage: () =>
    record(
      { turns: list(S.TurnPreview, limits.historyPageTurns) },
      { next: S.Cursor, archived: M.boolean(), archive: S.ArchiveState },
    ),
  CurrentTurn: () =>
    record({
      input: staged(S.SubmissionText),
      turn: M.remotable('Turn'),
      history: S.TurnPreview,
    }),

  // ---- live channel events ----

  /** Events a session vat publishes (architecture 4.2). */
  VatEvent: () =>
    M.or(
      record({
        type: 'turn-start',
        turnId: S.Id,
        input: staged(S.SubmissionText),
        at: count,
      }),
      record({ type: 'phase', turnId: S.Id, phase: S.Phase }),
      record({
        type: 'tool_call',
        turnId: S.Id,
        id: S.Id,
        name: S.ToolName,
        args: staged(S.Text),
      }),
      record({
        type: 'tool_result',
        turnId: S.Id,
        id: S.Id,
        name: S.ToolName,
        result: staged(text(limits.toolOutputUnits)),
        failed: M.boolean(),
      }),
      record({ type: 'final', turnId: S.Id, text: staged(S.Text) }),
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
      // `reason` (M1b, J-9172): why the channel closed this subscriber.
      { closed: M.boolean(), reason: B.CloseReason },
    ),
  // `keys` (integration J-9381): the scripted provider builds the text in the
  // adapter, `{"<prefix><from>":<from>,...}` with `count` keys (`text` is
  // then ignored), so a flood of fresh keys need not cross the manager vat
  // inside the script (a script of 2 MB halted it, C-5).
  ScriptKeys: () =>
    record({ prefix: text(limits.callIdUnits), from: count, count }),
  ScriptChunk: () =>
    record(
      { text: S.Text },
      { repeat: count, delayMs: count, keys: S.ScriptKeys },
    ),
  ScriptToolCall: () =>
    record(
      { name: S.ToolName },
      {
        callId: text(limits.callIdUnits),
        args: S.Text,
        argsKeys: count,
        // Integration (J-9381): args = JSON.stringify({ text: keys }) built
        // in the adapter, as ScriptChunk's `keys`.
        argsFreshKeys: S.ScriptKeys,
        // M1b: args = JSON.stringify({ code: text repeated }) (exec probes).
        code: record({ text: S.Text }, { repeat: count }),
        // W1b.6: the call appears `times` times (too-big probe: 300 calls).
        times: count,
      },
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
        // M1b: opaque native context for this round, staged as a Blob (R4-31).
        nativeContext: S.Text,
        // M2 W2.6: the round stands for this many rounds in a row (the
        // round-limit probe runs maxToolRounds rounds from one frame).
        times: M.and(count, M.lte(limits.maxToolRounds + 1)),
      },
    ),
  ScriptTurn: () =>
    record(
      { rounds: list(S.ScriptRound, limits.scriptRounds) },
      { input: S.SubmissionText },
    ),
  Script: () => record({ turns: list(S.ScriptTurn, limits.scriptRounds) }),
  /**
   * `AgentHostAdmin.makeBackend` argument. M2 adds the API kinds: the key is
   * a `ReadGrant` (D-6, R7-28), never a value; `modelId` is the slot's
   * configured model (R4-21, R4-88); `baseUrl` points a test at the fake
   * server (F.2 c); `timeoutMs` is the request timeout (R4-93).
   */
  BackendSpec: () =>
    M.or(
      record(
        { kind: 'scripted', label: S.Label, script: S.Script },
        { logPath: text(4096) },
      ),
      record(
        {
          kind: M.or('openrouter', 'anthropic'),
          label: S.Label,
          keyGrant: M.remotable('ReadGrant'),
        },
        {
          modelId: S.ModelId,
          baseUrl: text(limits.urlUnits),
          timeoutMs: M.and(count, M.gte(1000), M.lte(limits.maxTurnDeadlineMs)),
          maxOutputTokens: count,
          logPath: text(4096),
        },
      ),
    ),
};

export const echoArgumentNames = harden(['text', 'delayMs', 'bytes', 'data']);

/**
 * Method guards of interfaces later milestones extend: the M1a methods, then
 * (in `foldedMethods` below) M1b's, then (in `m2InterfaceBuilders`) M2's,
 * always in that order.
 */
const methodsOf = harden({
  ...below.methodsOf,
  Live: () => ({
    subscribe: M.callWhen(R('Session'))
      .optional(count)
      .returns(R('LiveSubscription')),
  }),
  AgentHostAdmin: () => ({
    makeBackend: M.callWhen(S.BackendSpec).returns(R('Backend')),
    forSession: M.call().returns(R('SessionHostFacet')),
    bindSession: M.call(R('SessionHostFacet'), R('Session')).returns(done),
    onStart: M.call(R('StartListener')).returns(R('Registration')),
    live: M.callWhen().returns(R('Live')),
    composer: M.callWhen().returns(R('Composer')),
  }),
  Backend: () => ({
    describe: M.call().returns(S.BackendInfo),
    open: M.callWhen(R('SessionHostFacet')).returns(S.TurnPorts),
  }),
});

/**
 * M1a's interface guards (W1a.0). `interfaces` below holds them with M1b's
 * (whose versions replace the M1a ones they extend) and M2's new ones.
 */
const m1aInterfaceBuilders = {
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
  /** A channel's subscriber facet, one per subscriber. */
  LiveSubscription: () =>
    M.interface('LiveSubscription', {
      next: M.callWhen().returns(S.LiveBatch),
      close: M.call().returns(done),
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
  /** A preset (M1a: the built-in `chat-only`). */
  Preset: () =>
    M.interface('Preset', {
      describe: M.call().returns(
        record({ label: S.Label, builtIn: M.boolean() }),
      ),
      snapshot: M.call().returns(S.PresetSnapshot),
    }),
};

/** M1a's method names per interface, in declaration order. */
const m1aMethodNames = harden({
  ...below.m1aMethodNames,
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
  HarnessRoot: ['getOperator', 'status', 'loadSessionProgram'],
});

/** M1b's shapes (W1b.0); in `shapes` since M2 W2.0. */
const m1bShapeBuilders = {
  /** `Content.read` range: UTF-8 byte offset and the page budget. */
  ContentRange: () =>
    record({
      offset: count,
      maxBytes: M.and(count, M.lte(limits.blobPageBytes)),
    }),
  /** One page of a blob: whole code points; `next` is the byte offset after it. */
  ContentPage: () =>
    record({
      text: text(limits.blobPageBytes),
      next: count,
      done: M.boolean(),
    }),
  /** `Timer.sleep` argument (exec `sleep(ms)`, clamped by the exec vat). */
  SleepMs: () => M.and(count, M.lte(limits.maxDelayMs)),
  /** `ContextSource.page` answer: records from absolute index `from`. */
  ContextPage: () =>
    record(
      { from: count, records: list(S.TurnRecord, limits.pageRecords) },
      { next: S.Cursor },
    ),
  /** `Turn.getContent` answer: the turn's records in full, in log order. */
  TurnContentPage: () =>
    record(
      { records: list(S.TurnRecord, limits.pageRecords) },
      { next: S.Cursor },
    ),
  /** Manager sink (W1b.1 internal): a minted handle and its file key. */
  BlobStockEntry: () => record({ blob: M.remotable('Blob'), key: S.Id }),
  BlobStock: () => list(B.BlobStockEntry, limits.blobStockBatch),
  /** Manager sink `resolveBlobs` answer: a key per handle, null if unknown. */
  BlobKeys: () => list(M.or(null, S.Id), limits.blobResolveBatch),
  /** Why a channel closed a subscriber (`AH/channels.js` closeReasons keys). */
  CloseReason: () =>
    M.or('client', 'queueDeliveries', 'queueBytes', 'subscriberLimit'),
  ListSnapshotEvent: () => record({ type: 'list-snapshot' }),
  ListDelivery: () =>
    record({
      seq: count,
      rev: count,
      event: M.or(B.ListSnapshotEvent, B.ListEvent),
    }),
  ListBatch: () =>
    record(
      { deliveries: list(B.ListDelivery, limits.liveBatchDeliveries) },
      { closed: M.boolean(), reason: B.CloseReason },
    ),
};

/**
 * Method guards of the M1b versions that M2 extends again (M1a's methods
 * first, then M1b's).
 */
const foldedMethodsOf = harden({
  ...below.foldedMethodsOf,
  AgentHostAdmin: () => ({
    ...methodsOf.AgentHostAdmin(),
    content: M.callWhen().returns(R('Content')),
    listPublisher: M.callWhen().returns(R('ListPublisher')),
  }),
});

/** M1b's interface guards (W1b.0); in `interfaces` since M2 W2.0. */
const m1bInterfaceBuilders = {
  // ---- blobs and content (W1b.1) ----

  /** Manager-minted handle (D-15); no methods: read it through Content. */
  Blob: () => M.interface('Blob', {}),
  /** Adapter: opens a writer for one blob (TurnPorts.writers; the exec vat). */
  BlobWriters: () =>
    M.interface('BlobWriters', {
      open: M.callWhen().returns(R('BlobWriter')),
    }),
  /** Adapter: one blob being written; `close` fsyncs and answers its StagedText. */
  BlobWriter: () =>
    M.interface('BlobWriter', {
      append: M.callWhen(text(limits.blobPieceBytes)).returns(done),
      close: M.callWhen().returns(B.StagedText),
      abort: M.call().returns(done),
    }),
  /** Adapter: reads any blob whose handle the caller holds. */
  Content: () =>
    M.interface('Content', {
      read: M.callWhen(R('Blob'), B.ContentRange).returns(B.ContentPage),
    }),
  /** Adapter timer (exec `sleep`). */
  Timer: () =>
    M.interface('Timer', {
      sleep: M.callWhen(B.SleepMs).returns(done),
    }),

  // ---- session list feed (W1b.5) ----

  /** Adapter: the session list channel's publisher (held by the factory). */
  ListPublisher: () =>
    M.interface('ListPublisher', {
      publish: M.call(B.ListPublishBatch).returns(done),
    }),
  /** Adapter: one list subscriber. */
  ListSubscription: () =>
    M.interface('ListSubscription', {
      next: M.callWhen().returns(B.ListBatch),
      close: M.call().returns(done),
    }),
  /** M1a Live + `subscribeList`. */
  Live: () =>
    M.interface('Live', {
      ...methodsOf.Live(),
      subscribeList: M.callWhen()
        .optional(count)
        .returns(R('ListSubscription')),
    }),
};

/** M1b's method names per interface (M1a's first where M1b extends one). */
const m1bMethodLists = harden({
  ...below.m1bMethodLists,
  Blob: [],
  BlobWriters: ['open'],
  BlobWriter: ['append', 'close', 'abort'],
  Content: ['read'],
  Timer: ['sleep'],
  TurnSink: [...m1aMethodNames.TurnSink, 'progress'],
  Turn: [...m1aMethodNames.Turn, 'getContent'],
  ContextSource: ['page'],
  ExecScope: ['run', 'abandon'],
  ExecHandle: ['scope', 'retire'],
  ListPublisher: ['publish'],
  ListSubscription: ['next', 'close'],
  Live: [...m1aMethodNames.Live, 'subscribeList'],
  AgentHostAdmin: [
    ...m1aMethodNames.AgentHostAdmin,
    'content',
    'listPublisher',
  ],
  StartListener: [...m1aMethodNames.StartListener, 'attached'],
  SessionFactory: [...m1aMethodNames.SessionFactory, 'sessionListFeed'],
  HarnessRoot: [
    ...m1aMethodNames.HarnessRoot,
    'loadExecProgram',
    'configure',
    'whenSettled',
  ],
});

// ================================================================ M2
//
// The M2 contract (W2.0; designs/m2-interfaces.md). New shapes and new
// interfaces go into the folded tables, and so do the M2 versions of the
// interfaces M2 extends (`m2Versions`; the fold, m2-interfaces.md 1.3).

/** M2's shapes (W2.0). */
const m2ShapeBuilders = {
  /**
   * `ArchivePort.seal` argument (crank S, m2-interfaces.md 4.4): the vat's
   * range and its fingerprint (`kinds`: one letter per record of the range,
   * in log order, `archiveKindLetters`; only the first
   * `archiveSegmentRecords` when one turn is larger); `previous` is the digest the new
   * segment chains to ('' for the first); `context` serves records the
   * adapter lacks (never below `from`).
   */
  SealRequest: () =>
    record({
      from: count,
      to: count,
      firstTurn: count,
      turns: count,
      records: count,
      bytes: count,
      firstTurnId: S.Id,
      lastTurnId: S.Id,
      kinds: text(limits.archiveSegmentRecords),
      epoch: count,
      previous: text(64),
      context: M.remotable('ContextSource'),
    }),
  /** `ArchivePort.seal` answer: the segment is durable (fsynced, renamed). */
  SealAnswer: () => S.SegmentEntry,
  /**
   * A staged field of an archived record as `History` shows it: no Blob
   * handle (the vat dropped it), a `SealedText` to read the text.
   */
  SealedField: () =>
    record(
      {
        sealed: M.remotable('SealedText'),
        preview: text(limits.messagePreviewUnits),
        bytes: count,
      },
      { digest: text(64) },
    ),
  /** `SealedText.describe()`. */
  SealedTextInfo: () =>
    record(
      { bytes: count, preview: text(limits.messagePreviewUnits) },
      { digest: text(64) },
    ),

  // ---- secrets (m2-interfaces.md 9) ----

  /** `SecretsAdmin.create` argument (R7-25: description 1-200, no newline). */
  NewSecret: () =>
    record({
      label: S.Label,
      description: text(limits.secretDescriptionUnits),
    }),
  /** `Secret.describe()`: never the value (R7-22, R7-26). */
  SecretInfo: () =>
    record({
      label: S.Label,
      description: text(limits.secretDescriptionUnits),
      generation: count,
      state: M.or('active', 'revoked'),
      bytes: count,
    }),
  SecretPage: () =>
    record(
      { secrets: list(M.remotable('Secret'), limits.secretPageEntries) },
      { next: S.Cursor },
    ),
  /** One audit event (R7-24): fixed outcome and code, no bytes. */
  AuditEvent: () =>
    record(
      {
        at: count,
        label: S.Label,
        op: M.or(
          'create',
          'read',
          'replace',
          'revoke',
          'delete',
          'setDescription',
        ),
        outcome: M.or('attempted', 'succeeded', 'failed'),
      },
      { code: text(limits.secretCodeUnits), generation: count },
    ),
  AuditPage: () => list(S.AuditEvent, limits.auditPageEvents),
  /**
   * A value sealed to the adapter's X25519 key (D-6: the CLI path; the hub
   * carries only ciphertext). `publicKey` is the sender's ephemeral key.
   */
  SealedBox: () =>
    record({
      format: 'x25519-aes-256-gcm-1',
      publicKey: text(64),
      box: text(limits.sealedBoxUnits),
    }),
  /** A plain secret value (adapter-local writer only; never into a vat). */
  SecretValue: () => text(limits.secretValueBytes),
  ReadGrantInfo: () =>
    record({
      label: S.Label,
      description: text(limits.secretDescriptionUnits),
    }),
};

/**
 * Structural return guards of the archive's pages (records as keys, as
 * M1a's history views, J-9156): `History` builds them from segment files.
 * @type {Map<string, any>}
 */
const archiveViews = new Map();

/** @param {'SealedTurnPreview' | 'ArchiveHistoryPage' | 'SealedContentPage'} name */
const archiveView = name => {
  if (!archiveViews.has(name)) {
    const preview = record(
      {
        turnId: S.Id,
        state: S.TurnState,
        at: count,
        sealed: true,
        records: list(M.key(), limits.historyTurnRecords),
      },
      { cut: M.boolean(), resolution: S.Reason },
    );
    archiveViews.set('SealedTurnPreview', preview);
    archiveViews.set(
      'ArchiveHistoryPage',
      record(
        { turns: list(preview, limits.historyPageTurns) },
        { next: S.Cursor },
      ),
    );
    archiveViews.set(
      'SealedContentPage',
      record(
        { records: list(M.key(), limits.pageRecords) },
        { next: S.Cursor },
      ),
    );
  }
  return archiveViews.get(name);
};

/** M2's new interface guards (W2.0). */
const m2InterfaceBuilders = {
  // ---- archive (W2.8 adapter, W2.5 vat) ----

  /** Adapter: one session's archive in one incarnation (TurnPorts.archive). */
  ArchivePort: () =>
    M.interface('ArchivePort', {
      seal: M.callWhen(S.SealRequest).returns(S.SealAnswer),
    }),
  /**
   * Adapter-local (gateway, tests through `AgentHostAdmin.history()`):
   * history pages of any session, archived turns from segment files.
   */
  History: () =>
    M.interface('History', {
      page: M.callWhen(R('Session'))
        .optional(S.Cursor)
        .returns(M.or(view('HistoryPage'), archiveView('ArchiveHistoryPage'))),
      turnContent: M.callWhen(R('Session'), S.Id)
        .optional(S.Cursor)
        .returns(archiveView('SealedContentPage')),
    }),
  /** Adapter-local: the text of one archived staged field. */
  SealedText: () =>
    M.interface('SealedText', {
      read: M.callWhen(B.ContentRange).returns(B.ContentPage),
      describe: M.call().returns(S.SealedTextInfo),
    }),

  // ---- secrets (W2.3; D-6) ----

  /** Manager: the Secrets manager (R3-231, R7-22); held by the operator. */
  SecretsAdmin: () =>
    M.interface('SecretsAdmin', {
      list: M.call().optional(S.Cursor).returns(S.SecretPage),
      create: M.callWhen(S.NewSecret).returns(R('Secret')),
      openWriter: M.callWhen().returns(R('SecretWriter')),
      audit: M.callWhen()
        .optional(M.and(count, M.lte(limits.auditPageEvents)))
        .returns(S.AuditPage),
    }),
  /** Manager: one secret's admin facet (R7-23), reached from the catalogue. */
  Secret: () =>
    M.interface('Secret', {
      describe: M.callWhen().returns(S.SecretInfo),
      makeReadGrant: M.call().returns(R('ReadGrant')),
      revoke: M.callWhen().returns(done),
      delete: M.callWhen().returns(done),
      audit: M.callWhen()
        .optional(M.and(count, M.lte(limits.auditPageEvents)))
        .returns(S.AuditPage),
    }),
  /**
   * Manager: a read grant (R7-23). It has no read method: a value is read
   * only in the agent-host adapter, by the backend that holds the grant.
   */
  ReadGrant: () =>
    M.interface('ReadGrant', {
      describe: M.call().returns(S.ReadGrantInfo),
    }),
  /**
   * Adapter-local: writes values (D-6); never in a vat. Reachable through
   * the hub (`SecretsAdmin.openWriter()`), so `replace` takes a box sealed
   * to `publicKey()` only: a plain value never crosses the hub. The
   * gateway's in-process path takes a plain value (`AH/secrets/writer.js`
   * `replaceLocal`, m3-interfaces A-11).
   */
  SecretWriter: () =>
    M.interface('SecretWriter', {
      replace: M.callWhen(R('Secret'), S.SealedBox)
        .optional(count)
        .returns(record({ generation: count })),
      publicKey: M.call().returns(text(64)),
    }),
};

/** M2 versions of the interfaces M2 extends (folded methods first). */
const m2Versions = {
  /** + secrets, blob and archive release, history, import writers. */
  AgentHostAdmin: () =>
    M.interface('AgentHostAdmin', {
      ...foldedMethodsOf.AgentHostAdmin(),
      getSecrets: M.call().returns(R('SecretsAdmin')),
      releaseBlobs: M.callWhen(
        list(R('Blob'), limits.blobResolveBatch),
      ).returns(done),
      releaseArchive: M.callWhen(R('Session')).returns(done),
      history: M.callWhen().returns(R('History')),
      // No session: writers whose blobs no session owns yet (17.3: the
      // first session that presents one holds it): the factory stages a
      // composed prompt over inlineBytes before the session exists.
      writersFor: M.callWhen().optional(R('Session')).returns(R('BlobWriters')),
    }),
  /** + the catalogue (W2.2's ops; manager forwards, W2.3). */
  Backend: () =>
    M.interface('Backend', {
      ...methodsOf.Backend(),
      listModels: M.callWhen().optional(S.ModelRequest).returns(S.ModelPage),
      resolveModel: M.callWhen().optional(S.ModelId).returns(S.ResolvedModel),
    }),
};

/** M2's new interfaces' method names. */
const m2NewMethodNames = harden({
  ...below.m2NewMethodNames,
  ArchivePort: ['seal'],
  History: ['page', 'turnContent'],
  SealedText: ['read', 'describe'],
  SecretsAdmin: ['list', 'create', 'openWriter', 'audit'],
  Secret: ['describe', 'makeReadGrant', 'revoke', 'delete', 'audit'],
  ReadGrant: ['describe'],
  SecretWriter: ['replace', 'publicKey'],
});

/** Method names of `m2Interfaces`: the folded ones first, then M2's. */
const m2VersionMethodNames = harden({
  ...below.m2VersionMethodNames,
  SessionInternal: [
    ...m1aMethodNames.SessionInternal,
    'blobPage',
    'deleteSelf',
    'exportState',
    'importState',
  ],
  QueueEntry: [...m1aMethodNames.QueueEntry, 'edit', 'sendNow'],
  ContextSource: [...m1bMethodLists.ContextSource, 'segments'],
  SessionFactory: [
    ...m1bMethodLists.SessionFactory,
    'deleteSession',
    'listBackends',
    'listModels',
  ],
  HarnessRoot: [...m1bMethodLists.HarnessRoot, 'exportState', 'importSession'],
  AgentHostAdmin: [
    ...m1bMethodLists.AgentHostAdmin,
    'getSecrets',
    'releaseBlobs',
    'releaseArchive',
    'history',
    'writersFor',
  ],
  Backend: [...m1aMethodNames.Backend, 'listModels', 'resolveModel'],
  Composer: [...m1aMethodNames.Composer, 'edit'],
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
  {
    ...m1aInterfaceBuilders,
    ...m1bInterfaceBuilders,
    ...m2InterfaceBuilders,
    ...m2Versions,
  },
  below.interfaces,
);

/** Method names per interface of `interfaces`, in declaration order. */
export const methodNames = harden({
  ...m1aMethodNames,
  ...m1bMethodLists,
  ...m2NewMethodNames,
  ...m2VersionMethodNames,
});

/** The ten interfaces M2 extends (m2-interfaces.md 1.3). */
const m2Names = harden([
  'Session',
  'SessionInternal',
  'QueueEntry',
  'ContextSource',
  'SessionFactory',
  'HarnessRoot',
  'Operator',
  'AgentHostAdmin',
  'Backend',
  'Composer',
]);

/**
 * The M2 versions as a view of the folded table (the same guards), for
 * modules written against it before the fold.
 */
export const m2Interfaces = viewOf(m2Names, interfaces);

/** Method names of `m2Interfaces`: the folded lists (the same arrays). */
export const m2MethodNames = harden({
  Session: methodNames.Session,
  SessionInternal: methodNames.SessionInternal,
  QueueEntry: methodNames.QueueEntry,
  ContextSource: methodNames.ContextSource,
  SessionFactory: methodNames.SessionFactory,
  HarnessRoot: methodNames.HarnessRoot,
  Operator: methodNames.Operator,
  AgentHostAdmin: methodNames.AgentHostAdmin,
  Backend: methodNames.Backend,
  Composer: methodNames.Composer,
});

/**
 * The M1b tables as views of the folded ones (the same shape and guard
 * objects), for modules written against them before the fold. Where M2
 * extended an M1b interface the view answers the M2 version; the method
 * lists stay M1b's.
 */
export const m1bShapes = viewOf(
  [
    'StagedText',
    'Progress',
    'ContentRange',
    'ContentPage',
    'SleepMs',
    'ExecLease',
    'ExecRequest',
    'ExecOutcome',
    'ContextPage',
    'TurnContentPage',
    'BlobStockEntry',
    'BlobStock',
    'BlobKeys',
    'BlobPage',
    'CloseReason',
    'ListEvent',
    'ListPublishBatch',
    'ListSnapshotEvent',
    'ListDelivery',
    'ListBatch',
    'ListFeedInfo',
    'PoolCounts',
    'PoolStatus',
    'HarnessSettings',
    'ProgramInfo',
    'HarnessStatus',
  ],
  shapes,
);
export const m1bInterfaces = viewOf(
  [
    'Blob',
    'BlobWriters',
    'BlobWriter',
    'Content',
    'Timer',
    'TurnSink',
    'Turn',
    'ContextSource',
    'ExecScope',
    'ExecHandle',
    'ListPublisher',
    'ListSubscription',
    'Live',
    'AgentHostAdmin',
    'StartListener',
    'SessionFactory',
    'HarnessRoot',
  ],
  interfaces,
);
export const m1bMethodNames = m1bMethodLists;
