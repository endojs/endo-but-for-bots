// @ts-check
/**
 * The guards, shapes, method names and fixed texts the factory program and
 * the factory's stand-in session program reach beyond `./session.js`.
 *
 * The chain and its rules: `./base.js`. The tables exported here
 * (`shapes`, `interfaces`, `methodNames`, `texts`, `textOf`) hold
 * this module's entries and those of `./session.js`, the same objects.
 */
import { limits } from '../limits.js';
import { text, list, record, count, R, done, lazyTable } from './base.js';
import * as below from './session.js';
// The cross-lane seam unit (WX.1): mail's operator method and settings
// (m9-interfaces.md 6.2 F6) and voice (m11-interfaces.md appendix A, H1).
import { voiceLimits } from '../voice-preferences.js';

export { reservedLabels } from './session.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);

// ---------------------------------------------------------------- names

/** What a MailAddress designates (`describe().kind`). */
export const addressKinds = harden(['session', 'operator', 'subagent']);
/** States of an operator request or form (`RequestInfo.state`). */
export const requestStates = harden([
  'open',
  'answered',
  'rejected',
  'submitted',
  'cancelled',
  'failed',
]);

/** Method names per interface, in declaration order. */
export const postOfficeMethodNames = harden({
  MailAddress: harden(['describe']),
  Outbox: harden(['post']),
  RequestTicket: harden(['describe', 'answer', 'submit']),
  OperatorMailbox: harden([
    'send',
    'request',
    'form',
    'list',
    'rev',
    'addressOf',
  ]),
  OperatorMessage: harden(['describe', 'take', 'reply', 'dismiss']),
  RequestHandle: harden(['describe', 'whenSettled', 'cancel']),
  Delegation: harden(['spawn', 'children']),
  SubagentHandle: harden(['describe', 'ask', 'cancelAsk', 'stop']),
  /** The method M9 adds to `Operator` (seam in `./factory.js`). */
  Operator: harden(['getMail']),
});

/**
 * Preset templates (R3-11..R3-17; Fae `preset-catalog.js` templates).
 * M5 provisions `chat-only` and `general` (no shell); the others are
 * listed and refused at creation until a later milestone registers their
 * object kinds in `guest/factory/preset-templates.js` (M6). `full-control`
 * waits for open decision 5; `rsi` and `machine-admin` are context only.
 */
export const presetTemplateNames = harden([
  'chat-only',
  'general',
  'development',
  'new-project',
]);
/** Built-in presets (R3-11..R3-15; Fae `BUILTIN_PRESETS`), in list order. */
export const builtInPresetLabels = harden([
  'development',
  'chat-only',
  'general',
  'new-project',
  'voice',
]);
/** Object kinds templates name (Fae); M5 provisions none of them. */
export const templateObjectKinds = harden([
  'git-workspace',
  'development-environment',
]);

// ---------------------------------------------------------------- texts

/**
 * Fixed texts the spec requires (Part I section 4, Appendix A.4), word for
 * word, and the harness's own fixed texts. Builders use these constants and
 * functions; tests compare against them.
 */
const q = value => JSON.stringify(value);

/**
 * The texts the factory composes (the post office, the operator's mailbox,
 * the subagent tree); a session forwards them as tool results and never
 * builds them, so they stay out of the session program (D-M9-19). Fae's
 * words where a source is named, else the harness's own (J-1112).
 */

export const texts = harden({
  ...below.texts,
  /** R3-214 (daemon mail.js:1252-1258): a reply naming a postmark that was not delivered to the replier. */
  mailFraud: 'Mail fraud: unrecognized parcel',
  /** Harness: `send` to an object the post office did not mint (never called). */
  notAnAddress: 'The recipient is not a mail address',
  /** Harness: a settled or cancelled request answered again. */
  requestClosed: 'This request is already settled or was cancelled',
  /** A request or form whose sender cancelled it. */
  requestCancelled: 'The request was cancelled by its sender',
  /** `addressOf` / `send` with a Session this factory did not make. */
  notASession: 'Not a session of this harness',
  /** `take` of an edge the message does not carry. */
  noAttachment: 'The message has no attachment with that edge name',
  /** R4-6, adapted to object passing (Endo: "use backendId and modelId"). */
  modelOption:
    'createSession option "model" is unsupported; use backend and modelId',
  /** findSession with a key the factory does not know. */
  unknownSession: 'Unknown session',
  /** createSession without a backend (M1a has no factory default). */
  noBackend: 'No backend given and no default backend is configured',
  /** createSession with a blank systemPrompt (R4-27). */
  blankSystemPrompt: 'createSession systemPrompt must be a nonblank string',
  /** A.4 creation error (Fae session/provider-connections.js:590). */
  catalogUnavailable:
    'Model catalog unavailable for the provider backend; no model can be admitted now',
  /**
   * Harness (R4-21: no backend but the factory's default accepts an empty
   * model; the spec gives no text): a creation on another backend without
   * a model, or on an API backend that has no configured model.
   */
  modelRequired: 'A model must be chosen for this backend',

  // ---- presets and the operator inventory (M5, m5-interfaces.md) ----

  invalidPreset: 'Invalid preset',
  unknownTemplate: 'Unknown preset template',
  invalidEndowments: 'Invalid preset endowments',
  invalidTemplateObject: 'Invalid template object',
  templateObjectsRequired: 'This preset requires all of its template objects',
  shellNeedsWorkspace: 'An isolated shell requires a workspace',
  invalidNetworkPolicy: 'Invalid network policy',
  chatOnlyRule: 'Chat only requires internet off and no additional objects',
  backendForDefaults: 'Choose a backend for model defaults',
  modelForBackend: 'Choose a model for this backend',
  presetStale: 'Preset settings changed elsewhere. Reload before saving.',
  tooManyPresets: 'Too many assistant presets',
  builtInTemplateFixed: 'This built-in preset cannot change its template',
  builtInNotDeletable: 'Built-in presets can be reset, not deleted',
  onlyBuiltInReset: 'Only built-in presets can be reset',
  /** Fae `Unknown preset`: an object the catalogue did not make. */
  unknownPreset: 'Unknown preset',
  // ---- harness ----
  /** A preset object after `delete()`. */
  presetDeleted: 'This preset was deleted',
  /** The preset was saved between the creation's snapshot and its grant. */
  presetChanged:
    'The preset changed while the session was being created; try again',
  /**
   * A preset record over `limits.presetRecordBytes` (the editor before
   * sending, `PresetCatalog.create` and `Preset.save`), or a new session's
   * `make` argument (config with the snapshot, services with the
   * endowments) that would not fit one frame (rule 12.5).
   */
  presetTooLarge:
    'This preset is too large; shorten its instructions, description or labels, or remove objects',
  /** `Inventory.add` with `maxInventoryEntries` entries. */
  inventoryFull: 'The inventory is full',
  /** An inventory entry after `remove()`. */
  entryRemoved: 'This inventory entry was removed',

  // ---- environments (m6-interfaces.md 15.2; WX.1) ----
  /**
   * R3-21: the same words as `guards/environments.js`
   * `environmentTexts.runnerRequired` (a unit test keeps them equal).
   */
  runnerRequired:
    'A preset that provisions a shell needs a configured environment runner',
});

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  ...below.textOf,
  /** @param {number} limit */
  operatorInboxFull: limit =>
    `The operator's inbox is full (${limit} messages); try again after the operator dismisses some`,
  /** @param {string} title */
  recipientLost: title =>
    `The recipient ${q(title)} stopped working (its session was lost); the message was not delivered`,
  /**
   * Harness: a stray body (a reply, a value) kept inline (strayBodyBytes).
   * @param {number} units the original length
   */
  bodyCut: units =>
    `\n[Message cut from ${units} characters; only this prefix was kept]`,
  /**
   * @param {number} bytes
   * @param {number} limit
   */
  envelopeTooLarge: (bytes, limit) =>
    `The message is ${bytes} bytes with its form fields and attachment labels; the limit is ${limit}`,
  /**
   * R4-71 (Fae subagent-admission.js).
   * @param {number} limit
   */
  treeLimit: limit =>
    `Subagent tree limit of ${limit} reached; use existing helpers or finish the task yourself.`,
  /** @param {string} name */
  subagentLost: name =>
    `Subagent ${q(name)} stopped working (its session was lost); stop it and spawn another`,
  /**
   * Fae subagent.js askTool, non-retaining form (R4-72).
   * @param {readonly string[]} edges
   */
  answerAttachments: edges =>
    `\n\n(System: the reply attached object(s) with edge name(s) ${edges
      .map(edge => `"${edge}"`)
      .join(
        ', ',
      )}, which this session does not retain. To keep one, ask the subagent to store it under a pet name and tell you the name.)`,
  /**
   * R4-70: a child's title.
   * @param {string} parentTitle
   * @param {string} name
   */
  childTitle: (parentTitle, name) => `${parentTitle} / ${name}`,
  /** @param {number} limit */
  postOfficeBusy: limit =>
    `The post office has ${limit} deliveries in flight; try again shortly`,
  /** @param {string} title */
  requestFailed: title =>
    `The request could not be delivered: ${q(title)} stopped working`,
  /**
   * createSession options M1a does not implement yet.
   * @param {string} name
   */
  optionNotSupported: name =>
    `createSession option "${name}" is not supported yet`,

  // ---- presets and the operator inventory (M5, m5-interfaces.md) ----

  /**
   * Fae `text()`.
   * @param {string} label
   */
  invalidField: label => `Invalid ${label}`,
  /**
   * R3-22 (Fae `name()`).
   * @param {string} name
   */
  reservedEndowment: name => `Reserved or invalid endowment name: ${name}`,
  /** @param {string} name */
  duplicateEndowment: name => `Duplicate endowment name: ${name}`,
  /** @param {string} name */
  endowmentNotObject: name => `Endowment ${name} must be an object capability`,
  /**
   * R3-21 and templates whose object kinds no milestone has registered.
   * @param {string} kind
   */
  presetNeeds: kind =>
    `This preset needs a ${kind}, which this harness cannot provide yet`,
  /** @param {string} label */
  inventoryLabelTaken: label =>
    `The inventory already has an entry labelled "${label}"`,
});

// ---------------------------------------------------------------- shapes

/**
 * M1a's shapes (W1a.0), widened in place by M1b (`staged(...)`) and M2
 * (optional fields; m2-interfaces.md 1.4). `shapes` below holds them with
 * M1b's and M2's.
 */
const m1aShapeBuilders = {
  // M2: `deleting` while deleteSession runs (R4-9; m2-interfaces.md 7).
  Lifecycle: () => M.or('creating', 'ready', 'error', 'lost', 'deleting'),
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
        // When the caller made the request (ms since the epoch): the caller
        // has the clock (as the Composer stamps enqueueOnce); the session's
        // createdAt. Absent: the factory's latest known time.
        at: count,
        // Admitted only so the factory can refuse it with the R4-6 text.
        model: M.any(),
      },
    ),
  ProgramPiece: () =>
    record({
      digest: text(64),
      index: count,
      count,
      text: text(limits.frameBytes),
    }),
  /** M2: the backend kinds (R4-12, R4-13); `scripted` is the test double; M4 (H-1): the pool kinds. */
  BackendKind: () =>
    M.or('scripted', 'openrouter', 'anthropic', 'claude-pool', 'codex-pool'),
  BackendInfo: () =>
    record(
      { kind: S.BackendKind, label: S.Label },
      // M2: the default model of an API backend (R4-21, R4-88).
      { modelId: S.ModelId },
    ),
};

/**
 * Method guards of interfaces later milestones extend: the M1a methods, then
 * (in `foldedMethods` below) M1b's, then (in `m2InterfaceBuilders`) M2's,
 * always in that order.
 */
export const methodsOf = harden({
  ...below.methodsOf,
  SessionFactory: () => ({
    createSession: M.callWhen(S.CreateOptions).returns(R('Session')),
    listSessions: M.call()
      .optional(record({}, { after: S.Id, limit: count }))
      .returns(S.SessionPage),
    findSession: M.call(S.Id).returns(R('Session')),
    listPresets: M.call().returns(list(R('Preset'), 64)),
  }),
  Operator: () => ({
    getFactory: M.call().returns(R('SessionFactory')),
  }),
});

/**
 * M1a's interface guards (W1a.0). `interfaces` below holds them with M1b's
 * (whose versions replace the M1a ones they extend) and M2's new ones.
 */
const m1aInterfaceBuilders = {
  // ---- factory vat (W1a.6) ----

  /** Per-session row reporter, held by that session only (architecture 3.1). */
  RowReporter: () =>
    M.interface('RowReporter', {
      changed: M.call(S.RowPatch).returns(done),
    }),
};

/** M1a's method names per interface, in declaration order. */
export const m1aMethodNames = harden({
  ...below.m1aMethodNames,
  Operator: ['getFactory'],
});

/** M1b's shapes (W1b.0); in `shapes` since M2 W2.0. */
const m1bShapeBuilders = {
  /**
   * `ExecHandle.scope()`: the session's current exec scope and its deadline
   * (`ExecLease` until HR-SYN-33: it leases nothing; a shape name only, no
   * record key or wire name changed).
   */
  ExecScopeInfo: () =>
    record({ scope: M.remotable('ExecScope'), deadlineMs: count }),
  /** A session-list change (D-8; architecture 3.1). */
  ListEvent: () =>
    M.or(
      record({ type: 'row', row: S.SessionRow }),
      record({
        type: 'row-removed',
        session: M.remotable('Session'),
        key: S.Id,
      }),
    ),
  /** `ListPublisher.publish` argument: one batch per factory crank. */
  ListPublishBatch: () =>
    record({
      rev: count,
      events: list(B.ListEvent, limits.publishBatchEvents),
    }),
  ListFeedInfo: () => record({ rev: count }),
  PoolCounts: () =>
    record({
      spareSessions: M.and(count, M.lte(limits.maxSpares)),
      spareExec: M.and(count, M.lte(limits.maxSpares)),
    }),
  /** `HarnessRoot.whenSettled()` / `status().pool`. */
  PoolStatus: () =>
    record({
      spareSessions: count,
      spareExec: count,
      refilling: count,
      target: B.PoolCounts,
    }),
  /**
   * `HarnessRoot.configure` argument (operator settings, architecture 9).
   * M2 (m2-interfaces.md 8.5, 10): the backends `listBackends` offers, the
   * default backend and model of a creation that names none (R4-21, R4-88),
   * and the turn deadline (0: off).
   */
  HarnessSettings: () =>
    record(
      {},
      {
        spareSessions: M.and(count, M.lte(limits.maxSpares)),
        spareExec: M.and(count, M.lte(limits.maxSpares)),
        execDeadlineMs: M.and(count, M.gte(1000), M.lte(limits.maxDelayMs)),
        backends: list(M.remotable('Backend'), limits.maxBackends),
        defaultBackend: M.remotable('Backend'),
        defaultModelId: S.ModelId,
        turnDeadlineMs: M.and(count, M.lte(limits.maxTurnDeadlineMs)),
        // Environments (m6-interfaces.md 15.2, seam S-2; WX.1).
        environments: M.remotable('EnvironmentsAdmin'),
        // Subagents (m9-interfaces.md 6.2 F6; WX.1): the defaults in
        // `limits` are the ceilings.
        maxDescendants: M.and(count, M.lte(limits.maxDescendants)),
        maxDepth: M.and(count, M.lte(limits.maxDepth)),
        askTimeoutSeconds: M.and(
          count,
          M.gte(limits.minAskTimeoutSeconds),
          M.lte(limits.askTimeoutSeconds),
        ),
      },
    ),
  ProgramInfo: () => record({ digest: text(64), bytes: count }),
  HarnessStatus: () =>
    record(
      { sessions: count, program: B.ProgramInfo },
      {
        execProgram: B.ProgramInfo,
        pool: B.PoolStatus,
        // HR-GUEST-12: present when the factory's start listener could not
        // be registered (the factory then has no restart recovery): the
        // registration's error message.
        error: B.Reason,
      },
    ),
};

/**
 * Method guards of the M1b versions that M2 extends again (M1a's methods
 * first, then M1b's).
 */
export const foldedMethodsOf = harden({
  ...below.foldedMethodsOf,
  SessionFactory: () => ({
    ...methodsOf.SessionFactory(),
    sessionListFeed: M.call().returns(B.ListFeedInfo),
  }),
  HarnessRoot: () => ({
    getOperator: M.call().returns(R('Operator')),
    status: M.call().returns(B.HarnessStatus),
    loadSessionProgram: M.call(S.ProgramPiece).returns(
      record({ complete: M.boolean(), bytes: count }),
    ),
    loadExecProgram: M.call(S.ProgramPiece).returns(
      record({ complete: M.boolean(), bytes: count }),
    ),
    configure: M.call(B.HarnessSettings).returns(B.PoolStatus),
    whenSettled: M.callWhen().returns(B.PoolStatus),
  }),
});

/** M1b's interface guards (W1b.0); in `interfaces` since M2 W2.0. */
const m1bInterfaceBuilders = {
  /** Factory: the session's exec vat lease (architecture 3.2). */
  ExecHandle: () =>
    M.interface('ExecHandle', {
      scope: M.callWhen().returns(B.ExecScopeInfo),
      retire: M.call(R('ExecScope')).returns(done),
    }),
  /**
   * M1a StartListener + `attached` (M1b follow-ups, J-9362): the manager
   * tells its start listeners, sendOnly, each time a new adapter incarnation
   * attaches outside a daemon start (an adapter-only restart), so objects
   * they fetched from the previous incarnation (the list publisher) are
   * fetched again.
   */
  StartListener: () =>
    M.interface('StartListener', {
      started: M.call().returns(done),
      attached: M.call().returns(done),
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
  // ---- providers and the model catalogue (m2-interfaces.md 8) ----

  /** `Backend.listModels` / `SessionFactory.listModels` argument. */
  ModelRequest: () =>
    record(
      {},
      {
        backend: M.remotable('Backend'),
        after: text(limits.modelCursorUnits),
        limit: M.and(count, M.lte(limits.modelPageRows)),
        // W2.2 (R4-20): the factory's default backend and configured model,
        // added by the factory when it forwards to `Backend.listModels`, so
        // the catalogue can mark the default row and choose bare selection
        // ids on the default backend. Absent: no row is default and every
        // selection id is `<label>:<model>`.
        defaultBackend: M.remotable('Backend'),
        defaultModelId: S.ModelId,
      },
    ),
  /** A.4 model row, object style (R4-20): `backend` replaces the backend id. */
  ModelRow: () =>
    record(
      {
        backend: M.remotable('Backend'),
        modelId: S.ModelId,
        selectionId: text(limits.modelCursorUnits),
        title: S.Label,
        default: M.boolean(),
        reasoningEfforts: list(text(limits.effortUnits), limits.maxEfforts),
      },
      {
        description: text(limits.modelDescriptionUnits),
        defaultReasoningEffort: text(limits.effortUnits),
        contextLength: count,
        maxOutputTokens: count,
      },
    ),
  /**
   * One page of a catalogue (R4-17: `unavailable` with no rows on a failed
   * read; `error` is a fixed text, never a provider body).
   */
  ModelPage: () =>
    record(
      {
        rows: list(S.ModelRow, limits.modelPageRows),
        state: M.or('ok', 'unavailable'),
      },
      { next: text(limits.modelCursorUnits), error: S.Reason },
    ),
  /** `Backend.resolveModel` answer: what a creation stores (R4-21, R4-22). */
  ResolvedModel: () =>
    record(
      { modelId: S.ModelId },
      { contextLength: count, maxOutputTokens: count },
    ),
  /** One session of `HarnessRoot.exportState`. */
  ExportSession: () =>
    record({
      session: M.remotable('Session'),
      internal: M.remotable('SessionInternal'),
      key: S.Id,
      title: text(limits.titleUnits),
      state: S.Lifecycle,
      userInitiated: M.boolean(),
    }),
  /** `HarnessRoot.exportState` page: settings first, then sessions. */
  FactoryExportPage: () =>
    record(
      { sessions: list(S.ExportSession, limits.sessionPageRows) },
      { settings: B.HarnessSettings, next: S.Id },
    ),
};

/** Presets and the operator inventory (M5, `m5-interfaces.md` section 6). */
const presetShapeBuilders = {
  TemplateName: () => M.or(...presetTemplateNames),
  NetworkPolicyName: () => M.or('off', 'public-internet'),
  TemplateObject: () =>
    record({
      kind: text(limits.templateKindUnits),
      label: S.EdgeLabel,
    }),
  /** An endowment: a label and the object (S.1 #4). */
  Endowment: () => S.Attachment,
  /**
   * What `PresetCatalog.create` and `Preset.save` take (R6-55): every
   * editable field. Legacy callers can still include the ignored effort.
   */
  PresetRecord: () =>
    record(
      {
        label: text(limits.presetLabelUnits),
        template: S.TemplateName,
      },
      {
        description: text(limits.presetDescriptionUnits),
        instructions: text(limits.presetInstructionsUnits),
        networkPolicy: S.NetworkPolicyName,
        workspaceSeed: S.WorkspaceSeed,
        backend: R('Backend'),
        modelId: S.ModelId,
        reasoningEffort: text(limits.effortUnits),
        objects: list(S.TemplateObject, limits.maxTemplateObjects),
        endowments: list(S.Endowment, limits.maxEndowments),
      },
    ),
  /** `Preset.describe()`: the record as saved, and what the editor shows. */
  PresetView: () =>
    record(
      {
        label: text(limits.presetLabelUnits),
        builtIn: M.boolean(),
        template: S.TemplateName,
        description: text(limits.presetDescriptionUnits),
        instructions: text(limits.presetInstructionsUnits),
        networkPolicy: S.NetworkPolicyName,
        objects: list(S.TemplateObject, limits.maxTemplateObjects),
        endowments: list(S.Endowment, limits.maxEndowments),
        revision: count,
        available: M.boolean(),
      },
      {
        workspaceSeed: S.WorkspaceSeed,
        backend: R('Backend'),
        modelId: S.ModelId,
        reasoningEffort: text(limits.effortUnits),
        unavailableReason: S.Reason,
      },
    ),
  /** `PresetCatalog.configuration()` (A.4 `getPresetConfiguration`). */
  PresetConfiguration: () =>
    record({
      revision: count,
      presets: list(R('Preset'), limits.maxPresets),
      defaultPreset: R('Preset'),
    }),
  /** `PresetCatalog.create` answer. */
  PresetCreated: () => record({ preset: R('Preset'), revision: count }),
  /** One inventory entry as a page shows it. */
  InventoryRow: () =>
    record({
      entry: R('InventoryEntry'),
      label: S.EdgeLabel,
      value: M.remotable(),
    }),
  /** `Inventory.list` page (cursor is text, S.2 d). */
  InventoryPage: () =>
    record(
      {
        rows: list(S.InventoryRow, limits.inventoryPageEntries),
        rev: count,
      },
      { next: S.Cursor },
    ),
};

/**
 * Voice (m11-interfaces.md appendix A, seam H1; WX.1): the factory vat's
 * `Voice` facet and the speech settings `HarnessRoot.configureSpeech`
 * writes (D-M11-21).
 */
const voiceShapeBuilders = {
  /** R5-54: the shared record; every field optional. */
  VoicePreferences: () =>
    record(
      {},
      {
        voice: text(voiceLimits.voiceUnits),
        speed: M.number(),
        noiseScale: M.number(),
        noiseW: M.number(),
        sentenceSilence: M.number(),
      },
    ),
  /** A write: the same fields (ranges checked in the method, D-M11-19). */
  VoicePreferencesPatch: () => S.VoicePreferences,
  VoiceSessionRequest: () =>
    record(
      {},
      {
        invocationId: text(voiceLimits.invocationIdUnits),
        title: text(limits.titleUnits),
        at: count,
      },
    ),
  VoiceSessionAnswer: () =>
    record(
      { session: R('Session'), key: S.Id, duplicate: M.boolean() },
      { warning: text(limits.labelUnits * 2) },
    ),
  SpeechInSettings: () =>
    M.or(
      record({ kind: 'off' }),
      record(
        {
          kind: 'process',
          command: list(
            text(voiceLimits.commandArgUnits),
            voiceLimits.commandArgs,
          ),
          language: text(32),
        },
        { warm: M.boolean() },
      ),
      record(
        {
          kind: 'openai-audio',
          baseUrl: text(voiceLimits.settingUnits),
          model: text(256),
          language: text(32),
        },
        { key: R('ReadGrant'), partialIntervalMs: count },
      ),
    ),
  SpeechOutSettings: () =>
    M.or(
      record({ kind: 'off' }),
      record(
        {
          kind: 'process',
          command: list(
            text(voiceLimits.commandArgUnits),
            voiceLimits.commandArgs,
          ),
          voicesDir: text(voiceLimits.commandArgUnits),
        },
        {
          defaultVoice: text(voiceLimits.voiceUnits),
          defaultSpeed: M.number(),
          spareSynth: M.boolean(),
        },
      ),
      record(
        {
          kind: 'openai-audio',
          baseUrl: text(voiceLimits.settingUnits),
          model: text(256),
          voices: list(
            text(voiceLimits.voiceUnits),
            voiceLimits.providerVoices,
          ),
        },
        {
          key: R('ReadGrant'),
          defaultVoice: text(voiceLimits.voiceUnits),
          defaultSpeed: M.number(),
        },
      ),
    ),
  SpeechSettings: () =>
    record(
      { speechIn: S.SpeechInSettings, speechOut: S.SpeechOutSettings },
      { revision: count },
    ),
};

/** Voice's interfaces (m11-interfaces.md appendix A; WX.1). */
const voiceInterfaceBuilders = {
  Voice: () =>
    M.interface('Voice', {
      getPreferences: M.call().returns(S.VoicePreferences),
      setPreferences: M.call(S.VoicePreferencesPatch).returns(
        S.VoicePreferences,
      ),
      getVoicePreset: M.call().returns(R('Preset')),
      setVoicePreset: M.call(R('Preset'), count).returns(R('Preset')),
      startVoiceSession: M.callWhen()
        .optional(S.VoiceSessionRequest)
        .returns(S.VoiceSessionAnswer),
      speechSettings: M.call().returns(S.SpeechSettings),
    }),
};

/** Interfaces of presets and the operator inventory (M5). */
const presetInterfaceBuilders = {
  /** The preset catalogue (A.4 `listPresets`, `getPresetConfiguration`). */
  PresetCatalog: () =>
    M.interface('PresetCatalog', {
      list: M.call().returns(list(R('Preset'), limits.maxPresets)),
      configuration: M.call().returns(S.PresetConfiguration),
      create: M.call(S.PresetRecord, count).returns(S.PresetCreated),
      defaultPreset: M.call().returns(R('Preset')),
    }),
  /**
   * One preset, for its life (M1a's `describe`, `snapshot`, widened; the
   * A.4 `savePreset`, `deletePreset`, `resetPreset` as its own methods).
   * Each edit takes the catalogue revision the caller saw and answers the
   * new one (S.2 e).
   */
  Preset: () =>
    M.interface('Preset', {
      describe: M.call().returns(S.PresetView),
      snapshot: M.call().returns(S.PresetSnapshot),
      save: M.call(S.PresetRecord, count).returns(count),
      delete: M.call(count).returns(count),
      reset: M.call(count).returns(count),
    }),
  /** The operator's inventory (minimal; M12's Home adds the live view). */
  Inventory: () =>
    M.interface('Inventory', {
      list: M.call().optional(S.Cursor).returns(S.InventoryPage),
      add: M.call(S.EdgeLabel, M.remotable()).returns(R('InventoryEntry')),
      addAll: M.call(list(S.Attachment, limits.inventoryPageEntries)).returns(
        list(R('InventoryEntry'), limits.inventoryPageEntries),
      ),
      rev: M.call().returns(count),
    }),
  /** One inventory entry (per-item operations, S.1 #3). */
  InventoryEntry: () =>
    M.interface('InventoryEntry', {
      describe: M.call().returns(record({ label: S.EdgeLabel })),
      value: M.call().returns(M.remotable()),
      relabel: M.call(S.EdgeLabel).returns(done),
      remove: M.call().returns(done),
    }),
};

/** M2 versions of the interfaces M2 extends (folded methods first). */
const m2Versions = {
  /** + `deleteSession` (W2.7), `listBackends`, `listModels` (W2.7 for W2.2). */
  SessionFactory: () =>
    M.interface('SessionFactory', {
      ...foldedMethodsOf.SessionFactory(),
      deleteSession: M.callWhen(R('Session')).returns(done),
      listBackends: M.call().returns(list(R('Backend'), limits.maxBackends)),
      listModels: M.callWhen().optional(S.ModelRequest).returns(S.ModelPage),
    }),
  /** + data-only export and importing (W2.7). */
  HarnessRoot: () =>
    M.interface('HarnessRoot', {
      ...foldedMethodsOf.HarnessRoot(),
      exportState: M.call().optional(S.Id).returns(S.FactoryExportPage),
      importSession: M.callWhen(S.CreateOptions).returns(S.MadeSession),
      // Voice (m11-interfaces.md appendix A, D-M11-21; WX.1): the
      // provisioning path, never a page.
      configureSpeech: M.call(S.SpeechSettings).returns(S.SpeechSettings),
    }),
  /** + `getSecrets` (W2.7 forwards to the agent host's). */
  Operator: () =>
    M.interface('Operator', {
      ...methodsOf.Operator(),
      getSecrets: M.callWhen().returns(R('SecretsAdmin')),
      // M5 (W5.1): the preset catalogue and the operator inventory.
      getPresets: M.call().returns(R('PresetCatalog')),
      getInventory: M.call().returns(R('Inventory')),
      // Mail (m9-interfaces.md 6.2 F6; WX.1).
      getMail: M.call().returns(R('OperatorMailbox')),
      // Voice (m11-interfaces.md appendix A, H1; WX.1).
      getVoice: M.call().returns(R('Voice')),
      findSubagentSession: M.call(R('Session'), text(limits.subagentNameUnits))
        .optional(S.Id)
        .returns(R('Session')),
    }),
};

/** Method names of the interfaces M2 and M5 added, in declaration order. */
export const m2NewMethodNames = harden({
  ...below.m2NewMethodNames,
  PresetCatalog: ['list', 'configuration', 'create', 'defaultPreset'],
  Preset: ['describe', 'snapshot', 'save', 'delete', 'reset'],
  Inventory: ['list', 'add', 'addAll', 'rev'],
  InventoryEntry: ['describe', 'value', 'relabel', 'remove'],
  // Voice (m11-interfaces.md appendix A; WX.1).
  Voice: [
    'getPreferences',
    'setPreferences',
    'getVoicePreset',
    'setVoicePreset',
    'startVoiceSession',
    'speechSettings',
  ],
});

/** Method names of `m2Interfaces`: the folded ones first, then M2's. */
export const m2VersionMethodNames = harden({
  ...below.m2VersionMethodNames,
  Operator: [
    ...m1aMethodNames.Operator,
    'getSecrets',
    'getPresets',
    'getInventory',
    // WX.1: mail (m9-interfaces.md F6), voice (m11-interfaces.md H1).
    ...postOfficeMethodNames.Operator,
    'getVoice',
    'findSubagentSession',
  ],
});

// ================================================================ tables

/**
 * Every shape this module and the modules below it hold, by name, built on
 * first use and kept (see `lazyTable`).
 */
const postOfficeShapeBuilders = {
  // The shapes the factory checks and the session only builds or
  // receives from harness-minted exos (moved out of `./mail.js` so the
  // session program does not carry them; m9-interfaces.md D-M9-19).
  /** One submitted value: JSON text of the field's kind (no data keys). */
  FormValue: () =>
    record({
      name: text(limits.formFieldNameUnits),
      json: text(limits.requestAnswerBytes),
    }),
  FormSubmission: () => list(S.FormValue, limits.formFields),
  /**
   * What a session posts (`Outbox.post`): recipients are objects (a
   * MailAddress or a SubagentHandle; anything else is refused by the post
   * office without being called).
   */
  MailDraft: () =>
    record(
      {
        to: list(M.remotable(), limits.recipientsPerSend),
        body: below.shapes.MailBody,
        attachments: S.Attachments,
      },
      { inReplyTo: count },
    ),
  /** One recipient's outcome, in `to` order. */
  PostResult: () => record({}, { postmark: count, refused: S.Reason }),
  PostReceipt: () =>
    record({ results: list(S.PostResult, limits.recipientsPerSend) }),
  /** A typed answer to a request (JSON text) or its rejection. */
  RequestAnswer: () =>
    M.or(
      record({ json: text(limits.requestAnswerBytes) }),
      record({ rejected: S.Reason }),
    ),
  /** `Delegation.spawn` argument (R4-70). */
  SpawnRequest: () =>
    record(
      {
        name: text(limits.subagentNameUnits),
        attachments: S.Attachments,
        at: count,
      },
      // Inline only (D-M9-20): the factory composes the child's prompt
      // as text in the creation's resolver.
      { systemPrompt: text(limits.inlineBytes) },
    ),
  SpawnAnswer: () =>
    record(
      { handle: R('SubagentHandle'), title: text(limits.titleUnits) },
      { childKey: S.Id },
    ),
  /** `SubagentHandle.ask` argument (R4-72). */
  AskRequest: () =>
    record({
      task: below.shapes.MailBody,
      attachments: S.Attachments,
      at: count,
    }),
  /**
   * The answer, already cut to the tool limit by the adapter's copy
   * (`cutFrom`: the answer's length in units when cut); `edges` are the
   * reply's attachment labels, reported, never kept (R4-72).
   */
  AskAnswer: () =>
    record(
      {
        text: below.shapes.MailBody,
        edges: list(S.EdgeLabel, limits.maxAttachments),
      },
      { cutFrom: count },
    ),
  SubagentState: () => M.or('ready', 'asking', 'lost', 'stopping'),
  SubagentInfo: () =>
    record(
      {
        name: text(limits.subagentNameUnits),
        handle: R('SubagentHandle'),
        state: S.SubagentState,
      },
      { childKey: S.Id },
    ),
  /** `Delegation.children()`: a parent's live children (<= 64 by guard). */
  SubagentList: () => list(S.SubagentInfo, 64),
  AddressKind: () => M.or(...addressKinds),
  AddressInfo: () =>
    record({ title: text(limits.titleUnits), kind: S.AddressKind }),
  RequestState: () => M.or(...requestStates),
  /** What a request ticket tells the session that holds it. */
  TicketInfo: () =>
    record({ kind: M.or('request', 'form'), state: S.RequestState }),
  /**
   * The operator's message: recipients are Sessions or MailAddresses; the
   * body is inline (the operator stages nothing in M9; D-M9-9).
   */
  OperatorDraft: () =>
    record(
      {
        to: list(M.remotable(), limits.recipientsPerSend),
        body: text(limits.inlineBytes),
        attachments: S.Attachments,
      },
      { inReplyTo: count },
    ),
  /** A reply from the operator's inbox (`OperatorMessage.reply`). */
  OperatorReply: () =>
    record({ body: text(limits.inlineBytes), attachments: S.Attachments }),
  RequestDraft: () =>
    record(
      { to: M.remotable(), description: text(limits.requestDescriptionUnits) },
      { responseKey: text(limits.responseKeyUnits) },
    ),
  FormDraft: () =>
    record(
      {
        to: M.remotable(),
        description: text(limits.requestDescriptionUnits),
        fields: list(below.shapes.FormField, limits.formFields),
      },
      { responseKey: text(limits.responseKeyUnits) },
    ),
  RequestInfo: () =>
    record(
      {
        kind: M.or('request', 'form'),
        state: S.RequestState,
        postmark: count,
      },
      {
        json: text(limits.requestAnswerBytes),
        values: S.FormSubmission,
        reason: S.Reason,
      },
    ),
  /** One row of the operator's inbox. The body is read through `Content`. */
  OperatorMessageView: () =>
    record(
      {
        message: R('OperatorMessage'),
        number: count,
        type: below.shapes.MailType,
        from: R('MailAddress'),
        fromTitle: text(limits.titleUnits),
        body: below.shapes.MailBody,
        edges: list(S.EdgeLabel, limits.maxAttachments),
        at: count,
      },
      { inReplyTo: count, values: S.FormSubmission, cutFrom: count },
    ),
  PageOptions: () =>
    record(
      {},
      { after: count, limit: M.and(count, M.lte(limits.operatorPageRows)) },
    ),
  OperatorMailPage: () =>
    record(
      {
        messages: list(S.OperatorMessageView, limits.operatorPageRows),
        rev: count,
      },
      { next: count },
    ),
  SubagentDescription: () =>
    record({
      name: text(limits.subagentNameUnits),
      state: S.SubagentState,
      depth: count,
    }),
};

export const shapes = lazyTable(
  {
    ...m1aShapeBuilders,
    ...m1bShapeBuilders,
    ...m2ShapeBuilders,
    ...presetShapeBuilders,
    ...voiceShapeBuilders,
    ...postOfficeShapeBuilders,
  },
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
const postOfficeInterfaceBuilders = {
  /**
   * Factory exo, one per session, per subagent and one for the operator.
   * Held by sessions (label `user`, mail `from`, attachments) and the
   * operator. The post office recognises it by rights amplification.
   */
  MailAddress: () =>
    M.interface('MailAddress', {
      describe: M.call().returns(S.AddressInfo),
    }),
  /** Factory exo, one per session (`SessionServices.mail`); binds the sender. */
  Outbox: () =>
    M.interface('Outbox', {
      post: M.callWhen(S.MailDraft).returns(S.PostReceipt),
    }),
  /** Factory exo, one per request or form, carried in its envelope. */
  RequestTicket: () =>
    M.interface('RequestTicket', {
      describe: M.call().returns(S.TicketInfo),
      answer: M.call(S.RequestAnswer).returns(done),
      submit: M.call(S.FormSubmission).returns(done),
    }),
  /** Factory exo, one (`Operator.getMail()`). */
  OperatorMailbox: () =>
    M.interface('OperatorMailbox', {
      send: M.callWhen(S.OperatorDraft).returns(S.PostReceipt),
      request: M.callWhen(S.RequestDraft).returns(R('RequestHandle')),
      form: M.callWhen(S.FormDraft).returns(R('RequestHandle')),
      list: M.call().optional(S.PageOptions).returns(S.OperatorMailPage),
      rev: M.call().returns(count),
      addressOf: M.call(R('Session')).returns(R('MailAddress')),
    }),
  /** Factory exo, one per message in the operator's inbox. */
  OperatorMessage: () =>
    M.interface('OperatorMessage', {
      describe: M.call().returns(S.OperatorMessageView),
      take: M.call(S.EdgeLabel).returns(S.AttachmentValue),
      reply: M.callWhen(S.OperatorReply).returns(S.PostReceipt),
      dismiss: M.callWhen().returns(done),
    }),
  /** Factory exo: the operator's side of a request or form. */
  RequestHandle: () =>
    M.interface('RequestHandle', {
      describe: M.call().returns(S.RequestInfo),
      whenSettled: M.callWhen().returns(S.RequestInfo),
      cancel: M.call().returns(done),
    }),
  /**
   * Factory exo, one per session below the depth limit
   * (`SessionServices.subagents`); absent at the limit (R4-69).
   */
  Delegation: () =>
    M.interface('Delegation', {
      spawn: M.callWhen(S.SpawnRequest).returns(S.SpawnAnswer),
      children: M.call().returns(S.SubagentList),
    }),
  /** Factory exo, one per child; also a mail address of the child. */
  SubagentHandle: () =>
    M.interface('SubagentHandle', {
      describe: M.call().returns(S.SubagentDescription),
      ask: M.callWhen(S.AskRequest).returns(S.AskAnswer),
      cancelAsk: M.call().returns(done),
      stop: M.callWhen().returns(done),
    }),
};

export const interfaces = lazyTable(
  {
    ...m1aInterfaceBuilders,
    ...m1bInterfaceBuilders,
    ...m2Versions,
    ...presetInterfaceBuilders,
    ...voiceInterfaceBuilders,
    ...postOfficeInterfaceBuilders,
  },
  below.interfaces,
);

/** Method names per interface of `interfaces`, in declaration order. */
export const methodNames = harden({
  ...postOfficeMethodNames,
  ...m1aMethodNames,
  ...m1bMethodLists,
  ...m2NewMethodNames,
  ...m2VersionMethodNames,
});
