// @ts-check
// The M1a interface contract (W1a.0): every shape and every method guard in
// guest/lib/interfaces.js accepts a sample and refuses, at every place in the
// sample, a string longer than any bound, an array longer than any bound and
// a record with an extra key; guest/lib/limits.js equals config/defaults.js
// for every shared name. The samples double as worked examples for builders.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { limits as hostLimits } from '../../config/defaults.js';
// The guest tree is its own (private) package so its bundles carry no
// dependency; Node tests import its modules by path.
/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  echoArgumentNames,
  echoDescription,
  interfaces,
  methodNames,
  shapes,
  textOf,
  texts,
} from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, M, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

/** Longer than every string bound in the contract. */
const HUGE_STRING = 'x'.repeat(2_097_153);
/** Longer than every array bound in the contract. */
const HUGE_ARRAY = 20_001;

/** @param {string} label */
const far = label => Far(label, {});

const turn = far('Turn');
const sink = far('TurnSink');
const session = far('Session');
const entry = far('QueueEntry');
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  context: { usedTokens: 15, windowTokens: 0 },
};
const totals = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  context: { usedTokens: 15, windowTokens: 0 },
  turns: 1,
  incompleteTurns: 0,
};
const toolCall = {
  callId: 'call-1',
  name: 'echo',
  args: '{"text":"a","delayMs":1000}',
};
const intent = { opId: 't1/r0/c0', ...toolCall };
const records = {
  TurnStarted: { kind: 'turn-started', turnId: 't1', input: 'hi', at: 1 },
  Dispatched: { kind: 'dispatched', turnId: 't1', round: 0 },
  Partial: { kind: 'partial', turnId: 't1', round: 0, text: 'He' },
  RoundSettled: {
    kind: 'round-settled',
    turnId: 't1',
    round: 0,
    text: 'Hello',
    callCount: 1,
    usage,
    at: 2,
    servedBy: { label: 'scripted', modelId: 'm' },
  },
  ToolIntents: {
    kind: 'tool-intents',
    turnId: 't1',
    round: 0,
    intents: [intent],
  },
  ToolResult: {
    kind: 'tool-result',
    turnId: 't1',
    opId: 't1/r0/c0',
    name: 'echo',
    result: texts.toolOutcomeUnknown,
    failed: true,
    outcome: 'unknown',
  },
  TurnSettled: {
    kind: 'turn-settled',
    turnId: 't1',
    status: 'failed',
    at: 3,
    error: texts.frameLimit,
    final: 'Hello',
    usage,
  },
  TurnResolved: { kind: 'turn-resolved', turnId: 't1', note: 'ok', at: 4 },
};
const description = { ...echoDescription };
const pendingRow = {
  entry,
  key: 'q1',
  preview: 'next',
  state: 'queued',
  at: 1,
};
const pendingView = {
  entries: [pendingRow],
  hold: { reason: 'restart', message: texts.holdRestart },
};
const info = {
  key: 's1',
  title: 't',
  backendTitle: 'scripted',
  modelId: 'scripted-1',
  presetLabel: 'chat-only',
  createdAt: 1,
  reasoningEffort: 'low',
};
const turnStatus = {
  turnId: 't1',
  state: 'outcome-unknown',
  round: 0,
  at: 1,
  error: 'x',
  resolution: 'checked',
};
const turnPreview = {
  turn,
  turnId: 't1',
  state: 'completed',
  at: 1,
  records: [records.TurnStarted, records.ToolIntents, records.ToolResult],
  cut: false,
};
const foldStatus = {
  phase: 'thinking',
  streamingText: 'Hel',
  messages: [
    {
      role: 'tool',
      id: 't1/r0/c0',
      name: 'echo',
      args: '{}',
      result: null,
      failed: false,
      text: '',
    },
  ],
  error: null,
  usage: totals,
};
const vatEvents = {
  turnStart: { type: 'turn-start', turnId: 't1', input: 'hi', at: 1 },
  phase: { type: 'phase', turnId: 't1', phase: 'using tools' },
  toolCall: {
    type: 'tool_call',
    turnId: 't1',
    id: 't1/r0/c0',
    name: 'echo',
    args: '{}',
  },
  toolResult: {
    type: 'tool_result',
    turnId: 't1',
    id: 't1/r0/c0',
    name: 'echo',
    result: 'a',
    failed: false,
  },
  final: { type: 'final', turnId: 't1', text: 'Hello' },
  usage: { type: 'usage', turnId: 't1', ...totals },
  end: { type: 'end', turnId: 't1', status: 'completed' },
  abort: { type: 'abort', turnId: 't1', reason: texts.frameLimit },
  pending: { type: 'pending', pending: pendingView },
};
const sessionRow = {
  session,
  key: 's1',
  title: 't',
  state: 'ready',
  activity: 'passive',
  backendTitle: 'scripted',
  modelId: 'scripted-1',
  messageCount: 0,
  queuedCount: 0,
  effort: 'low',
};
const config = {
  key: 's1',
  title: 't',
  backendTitle: 'scripted',
  modelId: 'scripted-1',
  preset: { label: 'chat-only' },
  createdAt: 1,
  userInitiated: true,
  reasoningEffort: 'low',
};
const services = { backend: far('Backend'), host: far('SessionHostFacet') };
const scriptRound = {
  chunks: [
    { text: 'Hel', delayMs: 10 },
    { text: 'lo', repeat: 2 },
  ],
  chunkDelayMs: 50,
  dispatchDelayMs: 0,
  toolCalls: [
    { name: 'echo', args: '{"text":"a","delayMs":1000}', callId: 'c1' },
    { name: 'echo', argsKeys: 2000 },
  ],
  usage,
  error: 'scripted failure',
  stall: 'untilCancel',
};
const script = { turns: [{ input: 'hi', rounds: [scriptRound] }] };

/** A sample for every shape in `shapes`. */
const shapeSamples = {
  Id: 't1',
  Label: 'scripted',
  Reason: texts.frameLimit,
  Text: 'Hello',
  SubmissionText: 'hi',
  ToolName: 'echo',
  ModelId: 'scripted-1',
  Cursor: 'h32',
  TurnState: 'running',
  SettledStatus: 'interrupted',
  Phase: 'thinking',
  Activity: 'working',
  Lifecycle: 'lost',
  HoldReason: 'restart',
  ContextReading: { usedTokens: 1, windowTokens: 0 },
  Usage: usage,
  UsageTotals: totals,
  Submission: { text: 'hi' },
  ToolCall: toolCall,
  ToolIntent: intent,
  ToolDescription: description,
  ServedBy: { label: 'scripted', modelId: 'm' },
  ...records,
  TurnRecord: records.TurnSettled,
  RoundRequest: {
    turn,
    sink,
    turnId: 't1',
    round: 0,
    base: { count: 0, epoch: 0 },
    append: [records.TurnStarted],
    tools: [description],
    options: {
      modelId: 'scripted-1',
      reasoningEffort: 'low',
      maxOutputTokens: 1,
    },
    context: far('ContextSource'),
    system: 'You are a test.',
  },
  RoundResult: {
    round: 0,
    text: 'Hello',
    toolCalls: [toolCall],
    usage,
    at: 2,
    servedBy: { label: 'scripted', modelId: 'm' },
  },
  RoundFailure: {
    round: 0,
    reason: texts.frameLimit,
    at: 2,
    partial: 'He',
    usage,
  },
  AdapterToolEntry: { name: 'echo', tool: far('AdapterTool') },
  TurnPorts: {
    endpoint: far('Endpoint'),
    publisher: far('LivePublisher'),
    tools: [{ name: 'echo', tool: far('AdapterTool') }],
    since: 1_763_251_100_000,
  },
  ToolRequest: { opId: 't1/r0/c0', args: '{}' },
  ToolOutcome: { status: 'frame-limit', text: texts.frameLimit },
  Hold: { reason: 'refused', message: textOf.holdRefused('x') },
  PendingRow: pendingRow,
  PendingView: pendingView,
  EntryInfo: { key: 'q1', preview: 'next', state: 'queued', at: 1 },
  Receipt: {
    requestId: '1763251200000-0b7f0c3e-8a8e-4c1e-9a55-1d2f3a4b5c6d',
    duplicate: false,
    state: 'queued',
    entry,
    turn,
  },
  PresetSnapshot: { label: 'chat-only' },
  SessionInfo: info,
  TurnStatus: turnStatus,
  TurnPreview: turnPreview,
  HistoryPage: { turns: [turnPreview], next: 'h1' },
  CurrentTurn: { input: 'hi', turn, history: turnPreview },
  WatchSnapshot: {
    rev: 3,
    info,
    pending: pendingView,
    usage: totals,
    current: turnStatus,
  },
  VatEvent: vatEvents.usage,
  PublishBatch: { rev: 1, events: Object.values(vatEvents) },
  DeltaEvent: { type: 'delta', turnId: 't1', round: 0, text: 'Hel' },
  FoldedMessage: foldStatus.messages[0],
  FoldableStatus: foldStatus,
  SnapshotEvent: {
    type: 'snapshot',
    turn: { turnId: 't1', settled: false, status: foldStatus },
  },
  Delivery: { seq: 1, rev: 1, event: vatEvents.final },
  LiveBatch: {
    deliveries: [
      {
        seq: 1,
        rev: 0,
        event: {
          type: 'snapshot',
          turn: { turnId: 't1', settled: false, status: foldStatus },
        },
      },
      {
        seq: 2,
        rev: 0,
        event: { type: 'delta', turnId: 't1', round: 0, text: 'Hel' },
      },
      { seq: 3, rev: 1, event: vatEvents.end },
    ],
    closed: false,
  },
  RowPatch: {
    title: 't',
    activity: 'working',
    messageCount: 1,
    queuedCount: 0,
  },
  SessionRow: sessionRow,
  SessionPage: { rows: [sessionRow], rev: 1, next: 's1' },
  CreateOptions: {
    title: 't',
    preset: far('Preset'),
    backend: far('Backend'),
    modelId: 'scripted-1',
    reasoningEffort: 'low',
    systemPrompt: 'You are a test.',
    userInitiated: true,
    spoken: false,
    at: 1_763_251_200_000,
  },
  SessionConfig: config,
  SessionServices: services,
  MakeArgs: { config, services, rowReporter: far('RowReporter') },
  MadeSession: { session, internal: far('SessionInternal') },
  ProgramPiece: { digest: 'a'.repeat(64), index: 0, count: 1, text: 'src' },
  ScriptKeys: { prefix: 'reply', from: 0, count: 100_000 },
  ScriptChunk: { text: 'x', repeat: 65_536, delayMs: 0 },
  ScriptToolCall: { name: 'echo', callId: 'c', args: '{}' },
  ScriptRound: scriptRound,
  ScriptTurn: script.turns[0],
  Script: script,
  BackendSpec: {
    kind: 'scripted',
    label: 'scripted',
    script,
    logPath: '/tmp/x/scripted.log',
  },
  BackendInfo: { kind: 'scripted', label: 'scripted' },
};

/**
 * Every path in a sample to a string, an array and a copy record, so each
 * can be replaced in turn. Remotables are leaves.
 * @param {unknown} value
 * @param {(string|number)[]} [at]
 * @returns {{ path: (string|number)[], kind: 'string'|'array'|'record' }[]}
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
 * A copy of `value` with the node at `path` replaced by `fn(node)`;
 * remotables are kept by reference.
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
  array: node => Array.from({ length: HUGE_ARRAY }, () => node[0]),
  record: node => ({ ...node, zzUnexpectedKey: 1 }),
};

/**
 * Each bad variant of a sample: one per string, array and record in it.
 * @param {unknown} sample
 */
const badVariants = sample =>
  pathsOf(sample).map(({ path, kind }) => ({
    label: `${kind} at ${path.join('.') || '(root)'}`,
    kind,
    value: harden(replaceAt(sample, path, breakers[kind])),
  }));

test('limits.js equals config/defaults.js for every shared name', t => {
  const shared = Object.keys(limits).filter(name => name in hostLimits);
  t.deepEqual(shared.sort(), [
    'crankOutBytes',
    'execSourceBytes',
    'frameBytes',
    'inlineBytes',
    'sendsPerCrank',
    'vatKeyNames',
  ]);
  for (const name of shared) {
    t.is(
      limits[name],
      /** @type {Record<string, unknown>} */ (hostLimits)[name],
      name,
    );
  }
});

test('the guest limits keep their stated relations', t => {
  for (const [name, value] of Object.entries(limits)) {
    t.true(Number.isSafeInteger(value) && value > 0, name);
  }
  t.is(limits.textUnits, limits.frameBytes);
  t.is(limits.submissionUnits, limits.inlineBytes);
  t.true(limits.callWindow <= limits.maxCallsPerRound);
  t.true(limits.maxCallsPerRound <= limits.maxCallsPerMessage);
  // A round's sends stay inside the per-crank rule: the call window plus a
  // publish, a row change, the next round and the lease release.
  t.true(limits.callWindow + 4 <= limits.sendsPerCrank);
  t.true(limits.toolOutputUnits >= limits.textUnits);
});

// Since M2 W2.0 the tables hold M1a's, M1b's and M2's entries; this file
// checks M1a's (its samples name them) and m2-interfaces.test.js checks that
// every entry of the folded tables has a sample in one of the three files.
test('every shape has a sample, and the sample matches it', t => {
  for (const name of Object.keys(shapeSamples)) {
    t.true(Object.keys(shapes).includes(name), name);
    const sample = harden(/** @type {any} */ (shapeSamples)[name]);
    t.true(matches(sample, /** @type {any} */ (shapes)[name]), name);
  }
});

test('every shape refuses an oversize string, an oversize array and an extra key wherever one can occur', t => {
  let refused = 0;
  for (const name of Object.keys(shapeSamples)) {
    const shape = /** @type {any} */ (shapes)[name];
    const sample = harden(/** @type {any} */ (shapeSamples)[name]);
    for (const { label, value } of badVariants(sample)) {
      t.false(matches(value, shape), `${name}: ${label}`);
      refused += 1;
    }
  }
  t.true(refused > 500, `${refused} variants refused`);
});

test('every record shape is closed: each record in each sample has a fixed key vocabulary', t => {
  // The variants above add an unknown key to every record; here, the shapes
  // whose samples are records at their root are the closed ones.
  const recordShapes = Object.entries(shapeSamples).filter(
    ([, sample]) =>
      sample !== null &&
      typeof sample === 'object' &&
      !Array.isArray(sample) &&
      Object.getPrototypeOf(sample) === Object.prototype,
  );
  t.true(recordShapes.length >= 60);
  for (const [name, sample] of recordShapes) {
    t.false(
      matches(
        harden({ .../** @type {object} */ (sample), extra: 1 }),
        shapes[name],
      ),
      `${name} refuses an extra key`,
    );
  }
});

/**
 * Sample arguments and a sample return value for every method; the stub
 * exo returns the sample so the return guard is exercised too.
 * @type {Record<string, Record<string, { args: unknown[], returns: unknown }>>}
 */
const methodSamples = {
  Session: {
    getInfo: { args: [], returns: info },
    rename: { args: ['new title'], returns: undefined },
    watch: { args: [], returns: shapeSamples.WatchSnapshot },
    enqueueOnce: {
      args: [{ text: 'hi' }, shapeSamples.Receipt.requestId, 1_763_251_200_000],
      returns: shapeSamples.Receipt,
    },
    getSubmissionReceipt: {
      args: [shapeSamples.Receipt.requestId],
      returns: undefined,
    },
    listPending: { args: [], returns: pendingView },
    startTurn: { args: [{ text: 'hi' }, 5], returns: turn },
    getCurrentTurn: { args: [], returns: shapeSamples.CurrentTurn },
    getHistoryPage: { args: ['h1'], returns: shapeSamples.HistoryPage },
    getUsage: { args: [], returns: totals },
  },
  SessionInternal: {
    rowSnapshot: { args: [], returns: shapeSamples.RowPatch },
  },
  Turn: {
    getStatus: { args: [], returns: turnStatus },
    cancel: { args: [], returns: undefined },
    whenFinished: { args: [], returns: turnStatus },
    resolve: { args: ['checked the file'], returns: undefined },
  },
  QueueEntry: {
    describe: { args: [], returns: shapeSamples.EntryInfo },
    cancel: { args: [], returns: true },
  },
  TurnSink: {
    dispatching: { args: [0], returns: true },
    roundFinal: { args: [shapeSamples.RoundResult], returns: undefined },
    roundFailed: { args: [shapeSamples.RoundFailure], returns: undefined },
    deadline: { args: [{ opId: 't1/r0/c0' }], returns: undefined },
  },
  // M1a's shape-only ContextSource is M1b's since the fold (`from`).
  ContextSource: {
    page: {
      args: ['c1'],
      returns: { from: 0, records: [records.TurnStarted], next: 'c2' },
    },
  },
  SpareMaker: {
    make: { args: [shapeSamples.MakeArgs], returns: shapeSamples.MadeSession },
  },
  Endpoint: {
    holdTurn: { args: [turn], returns: undefined },
    releaseTurn: { args: [turn], returns: undefined },
    startRound: { args: [shapeSamples.RoundRequest], returns: undefined },
    cancelRound: { args: [turn], returns: undefined },
    armDeadline: {
      args: [{ turn, opId: 't1/r0/c0', ms: 120_000 }],
      returns: undefined,
    },
    disarm: { args: [{ turn, opId: 't1/r0/c0' }], returns: undefined },
  },
  LivePublisher: {
    publish: { args: [shapeSamples.PublishBatch], returns: undefined },
  },
  AdapterTool: {
    execute: {
      args: [shapeSamples.ToolRequest],
      returns: { status: 'ok', text: 'a' },
    },
  },
  Live: {
    subscribe: { args: [session, 3], returns: far('LiveSubscription') },
  },
  LiveSubscription: {
    next: { args: [], returns: shapeSamples.LiveBatch },
    close: { args: [], returns: undefined },
  },
  Composer: {
    submit: {
      args: [session, 'hi', shapeSamples.Receipt.requestId],
      returns: shapeSamples.Receipt,
    },
  },
  Backend: {
    describe: { args: [], returns: shapeSamples.BackendInfo },
    open: { args: [far('SessionHostFacet')], returns: shapeSamples.TurnPorts },
  },
  SessionHostFacet: {
    liveChannel: { args: [], returns: far('LivePublisher') },
  },
  Registration: { cancel: { args: [], returns: undefined } },
  AgentHostAdmin: {
    makeBackend: { args: [shapeSamples.BackendSpec], returns: far('Backend') },
    forSession: { args: [], returns: far('SessionHostFacet') },
    bindSession: {
      args: [far('SessionHostFacet'), session],
      returns: undefined,
    },
    onStart: { args: [far('StartListener')], returns: far('Registration') },
    live: { args: [], returns: far('Live') },
    composer: { args: [], returns: far('Composer') },
  },
  RowReporter: {
    changed: { args: [shapeSamples.RowPatch], returns: undefined },
  },
  StartListener: { started: { args: [], returns: undefined } },
  Preset: {
    // M1a answered { label, builtIn }; M5's PresetView (the one Preset
    // guard since the fold, F2) carries every saved field.
    describe: {
      args: [],
      returns: {
        label: 'chat-only',
        builtIn: true,
        template: 'chat-only',
        description: '',
        instructions: '',
        networkPolicy: 'off',
        objects: [],
        endowments: [],
        revision: 0,
        available: true,
      },
    },
    snapshot: { args: [], returns: { label: 'chat-only' } },
  },
  SessionFactory: {
    createSession: { args: [shapeSamples.CreateOptions], returns: session },
    listSessions: {
      args: [{ after: 's1', limit: 50 }],
      returns: shapeSamples.SessionPage,
    },
    findSession: { args: ['s1'], returns: session },
    listPresets: { args: [], returns: [far('Preset')] },
  },
  Operator: { getFactory: { args: [], returns: far('SessionFactory') } },
  HarnessRoot: {
    getOperator: { args: [], returns: far('Operator') },
    status: {
      args: [],
      returns: { sessions: 1, program: { digest: 'a'.repeat(64), bytes: 3 } },
    },
    loadSessionProgram: {
      args: [shapeSamples.ProgramPiece],
      returns: { complete: true, bytes: 3 },
    },
  },
};

/**
 * A stub exo for an interface whose methods return the samples.
 * @param {string} name
 */
const stubExo = name => {
  const samples = methodSamples[name];
  /** @type {Record<string, (...args: any[]) => any>} */
  const methods = {};
  // Methods later milestones added to an M1a interface (the folded guard
  // has them); m1b- and m2-interfaces.test.js call those.
  for (const method of /** @type {any} */ (methodNames)[name]) {
    methods[method] = () => undefined;
  }
  for (const [method, { returns }] of Object.entries(samples)) {
    methods[method] = () => harden(returns);
  }
  return makeExo(name, /** @type {any} */ (interfaces)[name], methods);
};

test('every interface has method names, samples, and a stub exo accepts the samples', async t => {
  t.deepEqual(Object.keys(methodNames).sort(), Object.keys(interfaces).sort());
  for (const name of Object.keys(methodSamples)) {
    t.true(Object.keys(interfaces).includes(name), name);
  }
  const calls = [];
  for (const name of Object.keys(methodSamples)) {
    const names = /** @type {any} */ (methodNames)[name];
    const own = Object.keys(methodSamples[name]);
    // M1a's methods first, in order; later milestones' after them.
    t.deepEqual(names.slice(0, own.length), own, name);
    const exo = stubExo(name);
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

test('every method refuses an oversize string, an oversize array and an extra key in its arguments', async t => {
  const calls = [];
  for (const name of Object.keys(methodSamples)) {
    const exo = stubExo(name);
    for (const [method, { args }] of Object.entries(methodSamples[name])) {
      // Every variant but the one that lengthens the argument list itself.
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
  t.true(calls.length > 100, `${calls.length} variants refused`);
});

test('a guard refuses a return value outside its shape', async t => {
  const exo = makeExo('Turn', interfaces.Turn, {
    getContent: () => harden({ records: [] }),
    getStatus: () => harden({ ...turnStatus, extra: 1 }),
    cancel: () => undefined,
    whenFinished: async () => harden({ ...turnStatus, state: 'unknown' }),
    resolve: () => undefined,
  });
  t.throws(() => exo.getStatus());
  await t.throwsAsync(() => exo.whenFinished());
});

test('sendOnly methods return nothing; answered ones say what they return', t => {
  // Spot checks of the call conventions m1a-interfaces.md lists.
  const exo = stubExo('Endpoint');
  t.is(exo.startRound(harden(shapeSamples.RoundRequest)), undefined);
  t.is(exo.releaseTurn(turn), undefined);
  t.true(matches(harden({ status: 'ok', text: '' }), shapes.ToolOutcome));
  t.false(matches(harden({ status: 'error', text: '' }), shapes.ToolOutcome));
  t.false(
    matches(
      harden({ ...records.TurnStarted, input: { text: 'hi' } }),
      shapes.TurnRecord,
    ),
  );
  t.true(matches('t1', M.string()));
});

test('fixed texts are the spec texts', t => {
  t.is(
    texts.activeTurn,
    'Session already has an active turn; observe or cancel it first',
  );
  t.is(
    texts.interruptedBeforeDispatch,
    'Interrupted before dispatch; no backend execution was started.',
  );
  t.is(
    texts.toolOutcomeUnknown,
    'Tool outcome unknown; do not automatically retry.',
  );
  t.is(texts.frameLimit, "round output exceeds this build's frame limit");
  t.is(
    textOf.unknownTool('x', ['echo', 'exec']),
    'Unknown tool: "x". Available tools: echo, exec',
  );
  t.is(
    textOf.unexpectedArgument('x', 'echo', echoArgumentNames),
    'Unexpected argument "x" for echo; allowed arguments: text, delayMs, bytes, data',
  );
  t.is(
    textOf.unexpectedArgument('x', 'none', []),
    'Unexpected argument "x" for none; allowed arguments: (none)',
  );
  t.is(
    textOf.argumentsNotJson('Unexpected end of JSON input'),
    'could not parse tool arguments as JSON (Unexpected end of JSON input). Re-send this tool call with valid JSON arguments.',
  );
  t.is(textOf.errorResult('boom'), 'Error: boom');
  t.is(
    textOf.truncationMarker(40_000),
    '\n[Tool output truncated from 40000 characters. Only a prefix is shown; use filtering or pagination for more.]',
  );
  t.is(
    textOf.queueFull(limits.maxWaiting),
    'This session already has 100 messages waiting; send or delete some first',
  );
  t.is(textOf.opId('t3', 1, 0), 't3/r1/c0');
  // The spec names the blank refusal without a text; this is Fae's (J-9150).
  t.is(texts.blankSubmission, 'A queued message must be non-empty text');
  t.is(texts.turnAlreadyResolved, 'This turn was already resolved');
  t.is(textOf.synthesizedCallId(2, 5), 'floot-synth-2-5');
  t.true(texts.roundLimit.startsWith("I wasn't able to finish that"));
  const parameters = JSON.parse(echoDescription.parameters);
  t.deepEqual(Object.keys(parameters.properties), [...echoArgumentNames]);
  t.true(matches(harden({ ...echoDescription }), shapes.ToolDescription));
});

test('getHistoryPage and getCurrentTurn return through a structural guard (J-9156)', t => {
  // Records were checked at append; the return guard checks the page's
  // structure and bounds, and each record only for being a key.
  const preview = (/** @type {number} */ n) =>
    harden({
      ...turnPreview,
      records: Array.from({ length: n }, () => records.TurnStarted),
    });
  const exo = (/** @type {any} */ page, /** @type {any} */ current) =>
    makeExo('Session', /** @type {any} */ (interfaces.Session), {
      // Methods later milestones added (the folded guard has them).
      ...Object.fromEntries(
        /** @type {any} */ (methodNames).Session.map(
          (/** @type {string} */ method) => [method, () => undefined],
        ),
      ),
      ...Object.fromEntries(
        Object.entries(methodSamples.Session).map(([method, { returns }]) => [
          method,
          () => harden(returns),
        ]),
      ),
      getHistoryPage: () => page,
      getCurrentTurn: () => current,
    });
  const ok = exo(
    harden({ turns: [preview(limits.historyTurnRecords)], next: 'h1' }),
    harden({ input: 'hi', turn, history: preview(3) }),
  );
  t.notThrows(() => ok.getHistoryPage());
  t.notThrows(() => ok.getCurrentTurn());
  t.true(matches(ok.getHistoryPage(), shapes.HistoryPage), 'strict shape too');
  // Bounds and structure still hold.
  const tooManyTurns = harden({
    turns: Array.from({ length: limits.historyPageTurns + 1 }, () =>
      preview(1),
    ),
  });
  t.throws(() => exo(tooManyTurns, undefined).getHistoryPage());
  const tooManyRecords = harden({
    turns: [preview(limits.historyTurnRecords + 1)],
  });
  t.throws(() => exo(tooManyRecords, undefined).getHistoryPage());
  const extraKey = harden({ turns: [harden({ ...preview(1), extra: 1 })] });
  t.throws(() => exo(extraKey, undefined).getHistoryPage());
  // Each record must be passable data (a key): no promise inside.
  const notKey = harden({
    turns: [
      harden({
        ...preview(0),
        records: [harden({ kind: 'turn-started', at: Promise.resolve(1) })],
      }),
    ],
  });
  t.throws(() => exo(notKey, undefined).getHistoryPage());
  t.throws(() =>
    exo(
      undefined,
      harden({ input: 'hi', turn, history: preview(0), extra: 1 }),
    ).getCurrentTurn(),
  );
});
