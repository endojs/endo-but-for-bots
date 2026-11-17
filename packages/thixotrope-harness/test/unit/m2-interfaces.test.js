// @ts-check
// The M2 interface contract (W2.0; designs/m2-interfaces.md): the folded
// tables keep every M1a and M1b entry and method, in order; every M2 shape
// and method guard accepts a sample and refuses, at every place in the
// sample, an oversize string, an oversize array and an extra record key;
// the M1a and M1b shapes M2 widens in place accept the new optional fields
// and still refuse what they refused; each `m2Interfaces` version keeps
// every folded method first; the M2 limits keep their stated relations
// (the archive's flatness bound among them); and the M2 fixed texts are
// exact. The samples double as worked examples for builders.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  interfaces,
  m1bInterfaces,
  m1bMethodNames,
  m1bShapes,
  m2Interfaces,
  m2MethodNames,
  methodNames,
  archiveKindLetters,
  secretCodes,
  shapes,
  textOf,
  texts,
} from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const HUGE_STRING = 'x'.repeat(2_097_153);
const HUGE_ARRAY = 20_001;

/** @param {string} label */
const far = label => Far(label, {});

const blob = far('Blob');
const session = far('Session');
const backend = far('Backend');
const turn = far('Turn');
const contextSource = far('ContextSource');
const digest = 'd'.repeat(64);
const staged = { blob, preview: 'Hello', bytes: 9000, digest };

/** M1a's shape names (the fold keeps every one). */
const M1A_SHAPES = harden([
  'Id',
  'Label',
  'Reason',
  'Text',
  'SubmissionText',
  'ToolName',
  'ModelId',
  'Cursor',
  'TurnState',
  'SettledStatus',
  'Phase',
  'Activity',
  'Lifecycle',
  'HoldReason',
  'ContextReading',
  'Usage',
  'UsageTotals',
  'Submission',
  'ToolCall',
  'ToolIntent',
  'ToolDescription',
  'ServedBy',
  'TurnStarted',
  'Dispatched',
  'Partial',
  'RoundSettled',
  'ToolIntents',
  'ToolResult',
  'TurnSettled',
  'TurnResolved',
  'TurnRecord',
  'RoundRequest',
  'RoundResult',
  'RoundFailure',
  'AdapterToolEntry',
  'TurnPorts',
  'ToolRequest',
  'ToolOutcome',
  'Hold',
  'PendingRow',
  'PendingView',
  'EntryInfo',
  'Receipt',
  'PresetSnapshot',
  'SessionInfo',
  'TurnStatus',
  'TurnPreview',
  'HistoryPage',
  'CurrentTurn',
  'WatchSnapshot',
  'VatEvent',
  'PublishBatch',
  'DeltaEvent',
  'FoldedMessage',
  'FoldableStatus',
  'SnapshotEvent',
  'Delivery',
  'LiveBatch',
  'RowPatch',
  'SessionRow',
  'SessionPage',
  'CreateOptions',
  'SessionConfig',
  'SessionServices',
  'MakeArgs',
  'MadeSession',
  'ProgramPiece',
  'ScriptKeys',
  'ScriptChunk',
  'ScriptToolCall',
  'ScriptRound',
  'ScriptTurn',
  'Script',
  'BackendSpec',
  'BackendInfo',
]);

/** M1a's interfaces and their method names (before any extension). */
const M1A_METHODS = harden({
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

const archiveState = {
  sealedTo: 288,
  sealedTurns: 32,
  segments: 1,
  digest,
};
const segmentEntry = {
  from: 0,
  to: 288,
  firstTurn: 1,
  turns: 32,
  records: 288,
  bytes: 96_000,
  digest,
};
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
const totals = {
  ...usage,
  context: { usedTokens: 15, windowTokens: 200_000 },
  turns: 1,
  incompleteTurns: 0,
};
const info = {
  key: 's1',
  title: 'New chat',
  backendTitle: 'openrouter',
  modelId: 'org/model',
  presetLabel: 'chat-only',
  createdAt: 1,
};
const sessionConfig = {
  key: 's1',
  title: 'New chat',
  backendTitle: 'openrouter',
  modelId: 'org/model',
  preset: { label: 'chat-only' },
  createdAt: 1,
  userInitiated: true,
  systemPrompt: staged,
  contextLength: 200_000,
  maxOutputTokens: 4096,
  turnDeadlineMs: 600_000,
};
const turnStarted = {
  kind: 'turn-started',
  turnId: 't33',
  input: staged,
  at: 1,
};
const sealedField = {
  sealed: far('SealedText'),
  preview: 'Hello',
  bytes: 9000,
  digest,
};
const modelRow = {
  backend,
  modelId: 'org/model',
  selectionId: 'openrouter:org/model',
  title: 'Model',
  default: true,
  reasoningEfforts: [],
  description: 'A model.',
  contextLength: 200_000,
  maxOutputTokens: 8192,
};
const settings = {
  spareSessions: 2,
  spareExec: 1,
  execDeadlineMs: 120_000,
  backends: [backend],
  defaultBackend: backend,
  defaultModelId: 'org/model',
  turnDeadlineMs: 0,
};
const exportSession = {
  session,
  internal: far('SessionInternal'),
  key: 's1',
  title: 'New chat',
  state: 'ready',
  userInitiated: true,
};

/** A sample for every shape M2 adds. */
const shapeSamples = {
  BackendKind: 'openrouter',
  ArchiveState: archiveState,
  SegmentEntry: segmentEntry,
  SegmentPage: { segments: [segmentEntry], next: 'g1' },
  SealRequest: {
    from: 288,
    to: 576,
    firstTurn: 33,
    turns: 32,
    records: 288,
    bytes: 96_000,
    firstTurnId: 't33',
    lastTurnId: 't64',
    kinds: 'sdritrdre',
    epoch: 0,
    previous: digest,
    context: contextSource,
  },
  SealAnswer: { ...segmentEntry, from: 288, to: 576, firstTurn: 33 },
  SealedField: sealedField,
  SealedTextInfo: { bytes: 9000, preview: 'Hello', digest },
  ModelRequest: { backend, after: 'openrouter:org/a', limit: 50 },
  ModelRow: modelRow,
  ModelPage: { rows: [modelRow], state: 'ok', next: 'openrouter:org/model' },
  ResolvedModel: {
    modelId: 'org/model',
    contextLength: 200_000,
    maxOutputTokens: 8192,
  },
  NewSecret: { label: 'openrouter-auth', description: 'OpenRouter key' },
  SecretInfo: {
    label: 'openrouter-auth',
    description: 'OpenRouter key',
    generation: 2,
    state: 'active',
    bytes: 20,
  },
  SecretPage: { secrets: [far('Secret')], next: 'k2' },
  AuditEvent: {
    at: 5,
    label: 'openrouter-auth',
    op: 'read',
    outcome: 'failed',
    code: 'REVOKED',
    generation: 2,
  },
  AuditPage: [
    { at: 5, label: 'openrouter-auth', op: 'read', outcome: 'attempted' },
  ],
  SealedBox: {
    format: 'x25519-aes-256-gcm-1',
    publicKey: 'p'.repeat(43),
    box: 'b'.repeat(64),
  },
  SecretValue: 'not a real key',
  ReadGrantInfo: { label: 'openrouter-auth', description: 'OpenRouter key' },
  ExportEntry: {
    submission: { text: 'hi' },
    requestId: '1763251200000-00000000-0000-4000-8000-000000000000',
    at: 2,
  },
  SessionExportPage: {
    part: 'records',
    from: 288,
    records: [turnStarted],
    next: 'e1',
  },
  ImportProgress: { records: 289, complete: false },
  ExportSession: exportSession,
  FactoryExportPage: { sessions: [exportSession], settings, next: 's1' },
};

/** M1a and M1b shapes M2 widens in place, with the new fields. */
const widenedSamples = {
  Lifecycle: 'deleting',
  Receipt: {
    requestId: '1763251200000-00000000-0000-4000-8000-000000000000',
    duplicate: true,
    state: 'started',
    turnId: 't1',
  },
  RoundRequest: {
    turn,
    sink: far('TurnSink'),
    turnId: 't400',
    round: 0,
    base: { count: 3600, epoch: 0, archive: archiveState },
    append: [turnStarted],
    tools: [],
    options: { modelId: 'org/model' },
    context: contextSource,
    system: staged,
  },
  TurnPorts: {
    endpoint: far('Endpoint'),
    publisher: far('LivePublisher'),
    tools: [],
    since: 1,
    content: far('Content'),
    writers: far('BlobWriters'),
    timer: far('Timer'),
    archive: far('ArchivePort'),
  },
  HistoryPage: {
    turns: [],
    next: 'h33',
    archived: true,
    archive: archiveState,
  },
  SessionConfig: sessionConfig,
  BackendSpec: {
    kind: 'anthropic',
    label: 'provider',
    keyGrant: far('ReadGrant'),
    modelId: 'claude-sonnet-4-6',
    baseUrl: 'http://127.0.0.1:1/v1',
    timeoutMs: 3_600_000,
    maxOutputTokens: 4096,
  },
  BackendInfo: { kind: 'openrouter', label: 'openrouter', modelId: 'org/m' },
  HarnessSettings: settings,
};

// ---------------------------------------------------------------- variants

/**
 * Paths to every string, array and record in a sample (not into
 * remotables).
 * @param {unknown} value
 * @param {(string|number)[]} [at]
 * @returns {{ path: (string|number)[], kind: 'string' | 'array' | 'record' }[]}
 */
const pathsOf = (value, at = []) => {
  if (typeof value === 'string') return [{ path: at, kind: 'string' }];
  if (Array.isArray(value)) {
    return [
      { path: at, kind: 'array' },
      ...value.flatMap((item, i) => pathsOf(item, [...at, i])),
    ];
  }
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return [
      { path: at, kind: 'record' },
      ...Object.entries(value).flatMap(([k, v]) => pathsOf(v, [...at, k])),
    ];
  }
  return [];
};

/**
 * @param {any} value
 * @param {(string|number)[]} path
 * @param {(node: any) => any} fn
 * @returns {any}
 */
const replaceAt = (value, path, fn) => {
  if (path.length === 0) return fn(value);
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    return value.map((item, i) =>
      i === head ? replaceAt(item, rest, fn) : item,
    );
  }
  return { ...value, [head]: replaceAt(value[head], rest, fn) };
};

/** @type {Record<string, (node: any) => any>} */
const breakers = {
  string: () => HUGE_STRING,
  array: node => Array.from({ length: HUGE_ARRAY }, () => node[0] ?? 'x'),
  record: node => ({ ...node, zzUnexpectedKey: 1 }),
};

/** @param {unknown} sample */
const badVariants = sample =>
  pathsOf(sample).map(({ path, kind }) => ({
    label: `${kind} at ${path.join('.') || '(root)'}`,
    value: harden(replaceAt(sample, path, breakers[kind])),
  }));

// ---------------------------------------------------------------- the fold

test('the folded tables hold every M1a, M1b and M2 shape, and nothing else', t => {
  const known = new Set([
    ...M1A_SHAPES,
    ...Object.keys(m1bShapes),
    ...Object.keys(shapeSamples),
  ]);
  t.deepEqual(Object.keys(shapes).sort(), [...known].sort());
  for (const name of Object.keys(m1bShapes)) {
    t.is(
      /** @type {any} */ (m1bShapes)[name],
      /** @type {any} */ (shapes)[name],
      `m1bShapes.${name} is the folded shape`,
    );
  }
});

test('the folded interfaces keep every M1a and M1b method, in order', t => {
  for (const [name, own] of Object.entries(M1A_METHODS)) {
    const folded = /** @type {any} */ (methodNames)[name];
    t.deepEqual(folded.slice(0, own.length), own, `${name}: M1a first`);
  }
  for (const [name, names] of Object.entries(m1bMethodNames)) {
    t.deepEqual(
      /** @type {any} */ (methodNames)[name],
      [...names],
      `${name}: the M1b list`,
    );
    t.is(
      /** @type {any} */ (m1bInterfaces)[name],
      /** @type {any} */ (interfaces)[name],
      `m1bInterfaces.${name} is the folded guard`,
    );
  }
  t.deepEqual(Object.keys(methodNames).sort(), Object.keys(interfaces).sort());
  // A folded guard is the M1b version: an M1a-only stub is refused.
  t.throws(
    () =>
      makeExo('Turn', /** @type {any} */ (interfaces.Turn), {
        getStatus: () => undefined,
        cancel: () => undefined,
        whenFinished: async () => undefined,
        resolve: () => undefined,
      }),
    { message: /not implemented/ },
  );
});

test('each m2Interfaces version keeps every folded method first, then M2s', t => {
  t.deepEqual(
    Object.keys(m2MethodNames).sort(),
    Object.keys(m2Interfaces).sort(),
  );
  for (const [name, names] of Object.entries(m2MethodNames)) {
    /** @type {string[]} */
    const folded = /** @type {any} */ (methodNames)[name];
    t.deepEqual(names.slice(0, folded.length), [...folded], name);
    t.true(names.length > folded.length, `${name} gains a method`);
  }
});

// ---------------------------------------------------------------- shapes

test('limits keep the M2 relations', t => {
  // A history page crank stays a fraction of a context page crank.
  t.true(limits.historyPageRecords < limits.pageRecords);
  t.true(limits.historyPageRecords <= limits.historyTurnRecords);
  // The archive's flatness rule (m2-interfaces.md 4.13): the live turns a
  // session keeps vary by at most a quarter between seals.
  t.true(limits.archiveSegmentTurns * 4 <= limits.archiveKeepTurns);
  // A segment is at least a page of turns and fits the per-session bound.
  t.true(limits.archiveSegmentTurns >= 1);
  t.true(limits.archiveSegmentRecords >= limits.pageRecords);
  t.true(limits.archiveMaxSegments * limits.archiveSegmentTurns >= 100_000);
  t.true(limits.segmentPageEntries <= limits.blobResolveBatch);
  t.true(limits.modelPageRows <= limits.sessionPageRows);
  t.true(limits.secretDescriptionUnits === 200);
  t.true(limits.secretValueBytes === 1_048_576);
  t.true(
    Number(limits.sealedBoxUnits) >=
      (Number(limits.secretValueBytes) * 4) / 3 + 64,
  );
  t.true(limits.maxTurnDeadlineMs <= 86_400_000);
});

test('every M2 shape has a sample that matches and refuses every oversize string, array and extra key', t => {
  let refused = 0;
  for (const [name, sample] of Object.entries(shapeSamples)) {
    const shape = /** @type {any} */ (shapes)[name];
    t.truthy(shape, name);
    t.true(matches(harden(sample), shape), name);
    for (const { label, value } of badVariants(harden(sample))) {
      t.false(matches(value, shape), `${name}: ${label}`);
      refused += 1;
    }
  }
  t.true(refused >= 90, `${refused} variants refused`);
});

test('shapes widened in place accept the M2 fields and still refuse what they refused', t => {
  for (const [name, sample] of Object.entries(widenedSamples)) {
    const shape = /** @type {any} */ (shapes)[name];
    t.true(matches(harden(sample), shape), `${name} accepts M2 fields`);
    for (const { label, value } of badVariants(harden(sample))) {
      t.false(matches(value, shape), `${name}: ${label}`);
    }
  }
  // Earlier values still match.
  t.true(matches('lost', shapes.Lifecycle));
  t.false(matches('deleted', shapes.Lifecycle));
  t.true(
    matches(
      harden({ kind: 'scripted', label: 's', script: { turns: [] } }),
      shapes.BackendSpec,
    ),
  );
  // An API backend holds a grant, never a key value.
  t.false(
    matches(
      harden({ ...widenedSamples.BackendSpec, keyGrant: 'not a real key' }),
      shapes.BackendSpec,
    ),
  );
  t.false(
    matches(
      harden({ ...widenedSamples.BackendSpec, kind: 'scripted' }),
      shapes.BackendSpec,
    ),
    'a scripted spec has a script, not a grant',
  );
  t.false(
    matches(
      harden({ ...widenedSamples.BackendSpec, kind: 'fae-claude' }),
      shapes.BackendSpec,
    ),
    'subscription kinds are M4',
  );
});

// ---------------------------------------------------------------- methods

/**
 * Sample arguments and return values for every M2 method (new interfaces
 * and the M2 methods of `m2Interfaces`).
 * @type {Record<string, Record<string, { args: unknown[], returns: unknown }>>}
 */
const methodSamples = {
  ArchivePort: {
    seal: {
      args: [shapeSamples.SealRequest],
      returns: shapeSamples.SealAnswer,
    },
  },
  History: {
    page: {
      args: [session, 'h33'],
      returns: {
        turns: [
          {
            turnId: 't32',
            state: 'outcome-unknown',
            at: 1,
            sealed: true,
            records: [{ ...turnStarted, turnId: 't32', input: sealedField }],
            cut: true,
          },
        ],
        next: 'h32',
      },
    },
    turnContent: {
      args: [session, 't32', 'c1'],
      returns: { records: [{ ...turnStarted, input: sealedField }] },
    },
  },
  SealedText: {
    read: {
      args: [{ offset: 0, maxBytes: limits.blobPageBytes }],
      returns: { text: 'Hello', next: 5, done: false },
    },
    describe: { args: [], returns: shapeSamples.SealedTextInfo },
  },
  SecretsAdmin: {
    list: { args: ['k1'], returns: shapeSamples.SecretPage },
    create: { args: [shapeSamples.NewSecret], returns: far('Secret') },
    openWriter: { args: [], returns: far('SecretWriter') },
    audit: { args: [100], returns: shapeSamples.AuditPage },
  },
  Secret: {
    describe: { args: [], returns: shapeSamples.SecretInfo },
    makeReadGrant: { args: [], returns: far('ReadGrant') },
    revoke: { args: [], returns: undefined },
    delete: { args: [], returns: undefined },
    audit: { args: [10], returns: shapeSamples.AuditPage },
  },
  ReadGrant: { describe: { args: [], returns: shapeSamples.ReadGrantInfo } },
  SecretWriter: {
    replace: {
      args: [far('Secret'), shapeSamples.SealedBox, 2],
      returns: { generation: 3 },
    },
    publicKey: { args: [], returns: 'p'.repeat(43) },
  },
  Session: {
    findTurn: { args: ['t32'], returns: turn },
  },
  SessionInternal: {
    blobPage: { args: ['b1'], returns: { blobs: [blob], next: 'b2' } },
    deleteSelf: { args: [], returns: undefined },
    exportState: { args: ['e1'], returns: shapeSamples.SessionExportPage },
    importState: {
      args: [
        {
          part: 'head',
          info,
          config: sessionConfig,
          usage: totals,
          archive: archiveState,
        },
      ],
      returns: shapeSamples.ImportProgress,
    },
  },
  QueueEntry: {
    edit: { args: [staged], returns: undefined },
    sendNow: { args: [], returns: undefined },
  },
  ContextSource: {
    segments: { args: ['g1'], returns: shapeSamples.SegmentPage },
  },
  SessionFactory: {
    deleteSession: { args: [session], returns: undefined },
    listBackends: { args: [], returns: [backend] },
    listModels: {
      args: [shapeSamples.ModelRequest],
      returns: shapeSamples.ModelPage,
    },
  },
  HarnessRoot: {
    exportState: { args: ['s1'], returns: shapeSamples.FactoryExportPage },
    importSession: {
      args: [{ title: 'Imported', backend, modelId: 'org/model', at: 3 }],
      returns: { session, internal: far('SessionInternal') },
    },
  },
  Operator: { getSecrets: { args: [], returns: far('SecretsAdmin') } },
  AgentHostAdmin: {
    getSecrets: { args: [], returns: far('SecretsAdmin') },
    releaseBlobs: { args: [[blob]], returns: undefined },
    releaseArchive: { args: [session], returns: undefined },
    history: { args: [], returns: far('History') },
    writersFor: { args: [session], returns: far('BlobWriters') },
  },
  Backend: {
    listModels: {
      args: [{ limit: 10 }],
      returns: { rows: [], state: 'unavailable', error: 'x' },
    },
    resolveModel: { args: ['org/model'], returns: shapeSamples.ResolvedModel },
  },
  Composer: {
    edit: { args: [far('QueueEntry'), 'edited'], returns: undefined },
  },
};

/** @param {string} name */
const guardOf = name =>
  /** @type {any} */ (m2Interfaces)[name] ??
  /** @type {any} */ (interfaces)[name];
/** @param {string} name */
const namesOf = name =>
  /** @type {any} */ (m2MethodNames)[name] ??
  /** @type {any} */ (methodNames)[name];

/**
 * A stub exo whose M2 methods return the samples (folded methods are
 * no-ops: m1a- and m1b-interfaces.test.js call those).
 * @param {string} name
 */
const stubExo = name => {
  /** @type {Record<string, (...args: any[]) => any>} */
  const methods = {};
  for (const method of namesOf(name)) methods[method] = () => undefined;
  for (const [method, { returns }] of Object.entries(methodSamples[name])) {
    methods[method] = () => harden(returns);
  }
  return makeExo(name, guardOf(name), methods);
};

test('every M2 interface has method names and samples; a stub exo accepts them', async t => {
  const fresh = Object.keys(interfaces).filter(
    name =>
      !(name in M1A_METHODS) &&
      !(name in m1bMethodNames) &&
      !(name in m2Interfaces),
  );
  t.deepEqual(
    [...fresh, ...Object.keys(m2Interfaces)].sort(),
    Object.keys(methodSamples).sort(),
  );
  const calls = [];
  for (const name of Object.keys(methodSamples)) {
    const exo = stubExo(name);
    const own = Object.keys(methodSamples[name]);
    const names = namesOf(name);
    t.deepEqual(names.slice(names.length - own.length), own, name);
    for (const [method, { args }] of Object.entries(methodSamples[name])) {
      calls.push(
        t.notThrowsAsync(
          async () => exo[method](...harden(args)),
          `${name}.${method}`,
        ),
      );
    }
  }
  await Promise.all(calls);
});

test('every M2 method refuses an oversize string, an oversize array and an extra key in its arguments', async t => {
  const calls = [];
  for (const name of Object.keys(methodSamples)) {
    const exo = stubExo(name);
    for (const [method, { args }] of Object.entries(methodSamples[name])) {
      const variants = badVariants(harden(args)).filter(
        ({ label }) => label !== 'array at (root)',
      );
      for (const { label, value } of variants) {
        calls.push(
          t.throwsAsync(
            async () => exo[method](...value),
            undefined,
            `${name}.${method}: ${label}`,
          ),
        );
      }
    }
  }
  await Promise.all(calls);
  t.true(calls.length >= 40, `${calls.length} variants refused`);
});

test('return guards: an archive page and a vat page both pass History.page; a key value never passes', async t => {
  const vatPage = {
    turns: [],
    next: 'h33',
    archived: true,
    archive: archiveState,
  };
  const history = makeExo('History', interfaces.History, {
    page: async (/** @type {any} */ _s, /** @type {string} */ cursor) =>
      harden(cursor === 'vat' ? vatPage : methodSamples.History.page.returns),
    turnContent: async () => harden({ records: [] }),
  });
  await t.notThrowsAsync(() => history.page(session, 'vat'));
  await t.notThrowsAsync(() => history.page(session, 'h33'));
  const leaky = makeExo('Secret', interfaces.Secret, {
    describe: async () =>
      harden({ ...shapeSamples.SecretInfo, value: 'not a real key' }),
    makeReadGrant: () => far('ReadGrant'),
    revoke: async () => undefined,
    delete: async () => undefined,
    audit: async () => harden([]),
  });
  await t.throwsAsync(
    () => leaky.describe(),
    undefined,
    'SecretInfo is closed',
  );
  // The M2 switching rule: an exo switched to m2Interfaces must have every
  // M2 method (unbuilt ones answer textOf.notBuilt).
  t.throws(
    () =>
      makeExo('QueueEntry', /** @type {any} */ (m2Interfaces.QueueEntry), {
        describe: () => undefined,
        cancel: () => false,
        edit: () => undefined,
      }),
    { message: /not implemented/ },
  );
});

// ---------------------------------------------------------------- texts

test('the fixed M2 texts', t => {
  t.is(
    texts.anthropicAuthFailed,
    'Anthropic API authentication failed (invalid or expired API key). Check the configured Secret.',
  );
  t.is(
    texts.outputLimitNote,
    '[The model stopped here: it reached its own output limit.]',
  );
  t.is(
    texts.openRouterUnreachable,
    'OpenRouter could not be reached or sent an unreadable response',
  );
  t.is(
    texts.openRouterModelPrefix,
    'OpenRouter model must include its organization prefix',
  );
  t.is(
    texts.catalogUnavailable,
    'Model catalog unavailable for the provider backend; no model can be admitted now',
  );
  t.is(textOf.openRouterHttp(429), 'OpenRouter request failed (HTTP 429)');
  t.is(
    textOf.openRouterTimeout(3600),
    'OpenRouter did not answer within 3600 seconds',
  );
  t.is(
    textOf.afterAttempts('OpenRouter request failed (HTTP 503)', 3),
    'OpenRouter request failed (HTTP 503), after 3 attempts',
  );
  t.is(textOf.afterAttempts('x', 1), 'x');
  t.is(
    textOf.openRouterStopped(
      'content_filter',
      textOf.servedBy([
        ['served by', 'org/model'],
        ['via', 'Prov'],
      ]),
    ),
    'OpenRouter completion stopped: content_filter (served by org/model, via Prov)',
  );
  t.is(
    textOf.openRouterEmpty(''),
    'OpenRouter returned an empty assistant response',
  );
  t.is(
    textOf.openRouterApiError(' (code 502)'),
    'OpenRouter returned an API error (code 502)',
  );
  t.is(
    textOf.openRouterNoMessage(''),
    'OpenRouter returned no successful assistant message',
  );
  t.is(
    textOf.unknownProviderModel('org/x'),
    'Unknown model "org/x" for the provider backend',
  );
  t.is(textOf.secretFailed('REVOKED'), 'Secret operation failed: "REVOKED"');
  t.true(
    ['REVOKED', 'STALE_READ', 'READ_FAILED'].every(code =>
      secretCodes.includes(code),
    ),
  );
  t.is(textOf.anthropicHttp(529), 'Anthropic API request failed (HTTP 529)');
  t.is(textOf.turnDeadlineOpId('t3'), 't3/deadline');
  t.is(textOf.notBuilt('deleteSession'), 'not built yet: deleteSession');
  t.is(
    texts.turnSealed,
    'This turn is archived; read it through the history service',
  );
  t.is(texts.sessionDeleting, 'This session is being deleted');
  t.is(texts.unknownTurn, 'Unknown turn');
  // One letter per record kind, all distinct (SealRequest.kinds).
  t.is(new Set(archiveKindLetters.map(([, letter]) => letter)).size, 8);
  t.is(new Set(archiveKindLetters.map(([kind]) => kind)).size, 8);
  // M1a's texts the M2 units use are unchanged.
  t.is(
    texts.blankSystemPrompt,
    'createSession systemPrompt must be a nonblank string',
  );
});
