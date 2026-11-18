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
});

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  ...below.textOf,
  /**
   * createSession options M1a does not implement yet.
   * @param {string} name
   */
  optionNotSupported: name =>
    `createSession option "${name}" is not supported yet`,
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
  /** `ExecHandle.scope()`: the session's current exec scope and its deadline. */
  ExecLease: () =>
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
      },
    ),
  ProgramInfo: () => record({ digest: text(64), bytes: count }),
  HarnessStatus: () =>
    record(
      { sessions: count, program: B.ProgramInfo },
      { execProgram: B.ProgramInfo, pool: B.PoolStatus },
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
      scope: M.callWhen().returns(B.ExecLease),
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
    }),
  /** + `getSecrets` (W2.7 forwards to the agent host's). */
  Operator: () =>
    M.interface('Operator', {
      ...methodsOf.Operator(),
      getSecrets: M.callWhen().returns(R('SecretsAdmin')),
    }),
};

/** M2's new interfaces' method names. */
export const m2NewMethodNames = harden({
  ...below.m2NewMethodNames,
});

/** Method names of `m2Interfaces`: the folded ones first, then M2's. */
export const m2VersionMethodNames = harden({
  ...below.m2VersionMethodNames,
  Operator: [...m1aMethodNames.Operator, 'getSecrets'],
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
