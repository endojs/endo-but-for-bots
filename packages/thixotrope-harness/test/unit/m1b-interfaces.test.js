// @ts-check
// The M1b interface contract (W1b.0; designs/m1b-interfaces.md): every M1b
// shape and method guard accepts a sample and refuses, at every place in the
// sample, an oversize string, an oversize array and an extra record key; the
// in-place widenings of M1a shapes accept staged fields; each M1b interface
// that shares an M1a name keeps every M1a method; limits.js still equals
// config/defaults.js; the fixed texts are exact; and live.js keeps at most
// one batch's worth of outside publishes pending behind one that never
// settles (J-9172). The samples double as worked examples for builders.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { limits as hostLimits } from '../../config/defaults.js';
/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  execArgumentNames,
  execDescription,
  interfaces,
  methodNames,
  shapes,
  textOf,
  texts,
} from '../../guest/lib/interfaces.js';
import { makeLivePublishing } from '../../guest/session/live.js';
/* eslint-enable import/no-relative-packages */
import {
  beforeSeam,
  m1bInterfaces,
  m1bMethodNames,
  m1bShapes,
} from './_contract-tables.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo, makePromiseKit, matches } = /** @type {GuestGlobals} */ (
  globalThis
);

const HUGE_STRING = 'x'.repeat(2_097_153);
const HUGE_ARRAY = 20_001;

/** @param {string} label */
const far = label => Far(label, {});

const blob = far('Blob');
const session = far('Session');
const turn = far('Turn');
const staged = { blob, preview: 'Hello, wor', bytes: 9000 };
const usage = {
  inputTokens: 10,
  outputTokens: 5,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
};
const turnStarted = {
  kind: 'turn-started',
  turnId: 't1',
  input: staged,
  at: 1,
};
const roundSettled = {
  kind: 'round-settled',
  turnId: 't1',
  round: 0,
  text: staged,
  callCount: 1,
  usage,
  at: 2,
  nativeContext: { blob, preview: '', bytes: 120 },
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
};
const poolStatus = {
  spareSessions: 2,
  spareExec: 1,
  refilling: 0,
  target: { spareSessions: 2, spareExec: 1 },
};
const listEvents = {
  row: { type: 'row', row: sessionRow },
  removed: { type: 'row-removed', session, key: 's1' },
};
const execRequest = {
  args: staged,
  writers: far('BlobWriters'),
  timer: far('Timer'),
  content: far('Content'),
  notice: texts.execBusyReset,
};

/** A sample for every M1b shape. */
const shapeSamples = {
  StagedText: staged,
  Progress: { round: 0, partial: staged, tail: 'wor', at: 5 },
  ContentRange: { offset: 0, maxBytes: limits.blobPageBytes },
  ContentPage: { text: 'Hello', next: 5, done: true },
  SleepMs: 1000,
  ExecScopeInfo: { scope: far('ExecScope'), deadlineMs: limits.execDeadlineMs },
  ExecRequest: execRequest,
  ExecOutcome: { status: 'ok', text: staged },
  ContextPage: { from: 0, records: [turnStarted, roundSettled], next: 'p2' },
  TurnContentPage: { records: [turnStarted, roundSettled], next: 'p2' },
  BlobStockEntry: { blob, key: 'b1' },
  BlobStock: [{ blob, key: 'b1' }],
  BlobKeys: ['b1', null],
  BlobPage: { blobs: [blob], next: 'p1' },
  CloseReason: 'queueBytes',
  ListEvent: listEvents.row,
  ListPublishBatch: { rev: 2, events: Object.values(listEvents) },
  ListSnapshotEvent: { type: 'list-snapshot' },
  ListDelivery: { seq: 2, rev: 2, event: listEvents.removed },
  ListBatch: {
    deliveries: [
      { seq: 1, rev: 1, event: { type: 'list-snapshot' } },
      { seq: 2, rev: 2, event: listEvents.row },
    ],
    closed: true,
    reason: 'client',
  },
  ListFeedInfo: { rev: 3 },
  PoolCounts: { spareSessions: 2, spareExec: 1 },
  PoolStatus: poolStatus,
  HarnessSettings: { spareSessions: 0, spareExec: 0, execDeadlineMs: 5000 },
  ProgramInfo: { digest: 'a'.repeat(64), bytes: 3 },
  HarnessStatus: {
    sessions: 1,
    program: { digest: 'a'.repeat(64), bytes: 3 },
    execProgram: { digest: 'b'.repeat(64), bytes: 2 },
    pool: poolStatus,
  },
};

/** Staged forms of the M1a shapes widened in place. */
const widenedSamples = {
  Submission: staged,
  ToolCall: { callId: 'c1', name: 'exec', args: staged },
  ToolIntent: { opId: 't1/r0/c0', callId: 'c1', name: 'exec', args: staged },
  TurnStarted: turnStarted,
  Partial: { kind: 'partial', turnId: 't1', round: 0, text: staged },
  RoundSettled: roundSettled,
  ToolResult: {
    kind: 'tool-result',
    turnId: 't1',
    opId: 't1/r0/c0',
    name: 'exec',
    result: staged,
    failed: false,
  },
  TurnSettled: {
    kind: 'turn-settled',
    turnId: 't1',
    status: 'completed',
    at: 3,
    final: staged,
  },
  RoundResult: {
    round: 0,
    text: staged,
    toolCalls: [{ callId: '', name: 'exec', args: staged }],
    usage,
    at: 2,
    nativeContext: staged,
  },
  RoundFailure: { round: 0, reason: 'x', at: 2, partial: staged },
  TurnPorts: {
    endpoint: far('Endpoint'),
    publisher: far('LivePublisher'),
    tools: [],
    since: 1,
    content: far('Content'),
    writers: far('BlobWriters'),
    timer: far('Timer'),
  },
  ToolOutcome: { status: 'ok', text: staged },
  CurrentTurn: {
    input: staged,
    turn,
    history: { turn, turnId: 't1', state: 'running', at: 1, records: [] },
  },
  VatEvent: {
    type: 'tool_result',
    turnId: 't1',
    id: 'o',
    name: 'exec',
    result: staged,
    failed: false,
  },
  LiveBatch: { deliveries: [], closed: true, reason: 'queueDeliveries' },
  SessionServices: {
    backend: far('Backend'),
    host: far('SessionHostFacet'),
    execVat: far('ExecHandle'),
  },
  ScriptToolCall: { name: 'exec', code: { text: 'x', repeat: 300_000 } },
  ScriptRound: { chunks: [{ text: 'x' }], nativeContext: 'opaque' },
};

/**
 * Every path in a sample to a string, an array and a copy record.
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
 * A copy of `value` with the node at `path` replaced by `fn(node)`.
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

test('limits.js still equals config/defaults.js and keeps the M1b relations', t => {
  for (const name of Object.keys(limits)) {
    if (name in hostLimits) {
      t.is(
        limits[name],
        /** @type {Record<string, unknown>} */ (hostLimits)[name],
        name,
      );
    }
  }
  // Pieces and pages into a vat fit a frame with their wrapper.
  t.is(limits.blobPieceBytes, limits.frameBytes / 2);
  t.true(limits.blobPageBytes + 1024 <= limits.frameBytes);
  // A RoundResult that becomes ToolIntents still fits a frame.
  t.true(
    limits.roundResultBytes + limits.maxCallsPerMessage * 24 <=
      limits.frameBytes,
  );
  // Context pages go to an adapter only, within one crank's output.
  t.true(limits.contextPageBytes <= limits.crankOutBytes);
  t.true(limits.pageRecords <= limits.maxAppendRecords);
  t.is(limits.outsidePendingEvents, limits.publishBatchEvents);
  t.true(limits.execDeadlineMs <= limits.maxDelayMs);
  t.true(limits.spareSessions <= limits.maxSpares);
  t.true(limits.blobStockBatch <= limits.blobResolveBatch);
});

test('every M1b shape has a sample that matches and refuses every oversize string, array and extra key', t => {
  t.deepEqual(Object.keys(shapeSamples).sort(), Object.keys(m1bShapes).sort());
  let refused = 0;
  for (const [name, shape] of Object.entries(m1bShapes)) {
    const sample = harden(/** @type {any} */ (shapeSamples)[name]);
    t.true(matches(sample, shape), name);
    for (const { label, value } of badVariants(sample)) {
      t.false(matches(value, shape), `${name}: ${label}`);
      refused += 1;
    }
  }
  t.true(refused >= 120, `${refused} variants refused`);
});

test('M1a shapes widened in place accept staged fields and still refuse what they refused', t => {
  for (const [name, sample] of Object.entries(widenedSamples)) {
    const shape = /** @type {any} */ (shapes)[name];
    t.true(matches(harden(sample), shape), `${name} accepts staged`);
    for (const { label, value } of badVariants(harden(sample))) {
      t.false(matches(value, shape), `${name}: ${label}`);
    }
  }
  // Every record shape that carries a staged field accepts it in TurnRecord.
  t.true(matches(harden(turnStarted), shapes.TurnRecord));
  // A staged field must be a whole StagedText: no `text` wrapper, no units.
  t.false(
    matches(
      harden({ ...turnStarted, input: { text: 'hi' } }),
      shapes.TurnRecord,
    ),
  );
  t.false(
    matches(harden({ ...staged, units: 3 }), shapes.Submission),
    'StagedText is closed',
  );
  // M1b follow-ups (J-9363): an optional SHA-256 digest, 64 units at most.
  t.true(
    matches(harden({ ...staged, digest: 'c'.repeat(64) }), shapes.Submission),
    'a StagedText may carry its digest',
  );
  t.false(
    matches(harden({ ...staged, digest: 'c'.repeat(65) }), shapes.Submission),
    'a digest is at most 64 units',
  );
  t.false(
    matches(harden({ blob: 'b1', preview: '', bytes: 1 }), shapes.Submission),
    'blob is a handle, never a name',
  );
  // M1a values still match (the widening is additive).
  t.true(matches(harden({ text: 'hi' }), shapes.Submission));
  t.true(matches(harden({ status: 'ok', text: 'a' }), shapes.ToolOutcome));
});

/**
 * Sample arguments and return values for every M1b method.
 * @type {Record<string, Record<string, { args: unknown[], returns: unknown }>>}
 */
const methodSamples = {
  Blob: {},
  BlobWriters: { open: { args: [], returns: far('BlobWriter') } },
  BlobWriter: {
    append: { args: ['piece'], returns: undefined },
    close: { args: [], returns: staged },
    abort: { args: [], returns: undefined },
  },
  Content: {
    read: {
      args: [blob, shapeSamples.ContentRange],
      returns: shapeSamples.ContentPage,
    },
  },
  Timer: {
    sleep: { args: [1000], returns: undefined },
    alarm: { args: [1000], returns: far('Alarm') },
  },
  TurnSink: {
    dispatching: { args: [0], returns: true },
    roundFinal: { args: [widenedSamples.RoundResult], returns: undefined },
    roundFailed: { args: [widenedSamples.RoundFailure], returns: undefined },
    deadline: { args: [{ opId: 't1/r0/c0' }], returns: undefined },
    progress: { args: [shapeSamples.Progress], returns: true },
  },
  Turn: {
    getStatus: {
      args: [],
      returns: { turnId: 't1', state: 'running', round: 0, at: 1 },
    },
    cancel: { args: [], returns: undefined },
    whenFinished: {
      args: [],
      returns: { turnId: 't1', state: 'completed', round: 0, at: 1 },
    },
    resolve: { args: ['checked'], returns: undefined },
    getContent: { args: ['p1'], returns: shapeSamples.TurnContentPage },
  },
  ContextSource: {
    page: { args: ['p0'], returns: shapeSamples.ContextPage },
  },
  ExecScope: {
    run: { args: [execRequest], returns: { status: 'busy' } },
    abandon: { args: [], returns: undefined },
  },
  ExecHandle: {
    scope: { args: [], returns: shapeSamples.ExecScopeInfo },
    retire: { args: [far('ExecScope')], returns: undefined },
  },
  ListPublisher: {
    publish: { args: [shapeSamples.ListPublishBatch], returns: undefined },
  },
  ListSubscription: {
    next: { args: [], returns: shapeSamples.ListBatch },
    close: { args: [], returns: undefined },
  },
  Live: {
    subscribe: { args: [session, 3], returns: far('LiveSubscription') },
    subscribeList: { args: [3], returns: far('ListSubscription') },
  },
  AgentHostAdmin: {
    makeBackend: {
      args: [
        {
          kind: 'scripted',
          label: 's',
          script: { turns: [{ rounds: [widenedSamples.ScriptRound] }] },
        },
      ],
      returns: far('Backend'),
    },
    forSession: { args: [], returns: far('SessionHostFacet') },
    bindSession: {
      args: [far('SessionHostFacet'), session],
      returns: undefined,
    },
    onStart: { args: [far('StartListener')], returns: far('Registration') },
    live: { args: [], returns: far('Live') },
    composer: { args: [], returns: far('Composer') },
    content: { args: [], returns: far('Content') },
    listPublisher: { args: [], returns: far('ListPublisher') },
  },
  StartListener: {
    started: { args: [], returns: undefined },
    attached: { args: [], returns: undefined },
  },
  SessionFactory: {
    createSession: { args: [{ title: 't', at: 1 }], returns: session },
    listSessions: {
      args: [{ after: 's1', limit: 50 }],
      returns: { rows: [sessionRow], rev: 3 },
    },
    findSession: { args: ['s1'], returns: session },
    listPresets: { args: [], returns: [far('Preset')] },
    sessionListFeed: { args: [], returns: { rev: 3 } },
  },
  HarnessRoot: {
    getOperator: { args: [], returns: far('Operator') },
    status: { args: [], returns: shapeSamples.HarnessStatus },
    loadSessionProgram: {
      args: [{ digest: 'a'.repeat(64), index: 0, count: 1, text: 'src' }],
      returns: { complete: true, bytes: 3 },
    },
    loadExecProgram: {
      args: [{ digest: 'b'.repeat(64), index: 0, count: 1, text: 'src' }],
      returns: { complete: true, bytes: 3 },
    },
    configure: { args: [shapeSamples.HarnessSettings], returns: poolStatus },
    whenSettled: { args: [], returns: poolStatus },
  },
};

/** @param {string} name */
const stubExo = name => {
  /** @type {Record<string, (...args: any[]) => any>} */
  const methods = {};
  // Methods M2 added to an M1b interface (the folded guard has them, X1);
  // m2-interfaces.test.js calls those.
  for (const method of /** @type {any} */ (methodNames)[name]) {
    methods[method] = () => undefined;
  }
  for (const [method, { returns }] of Object.entries(methodSamples[name])) {
    methods[method] = () => harden(returns);
  }
  return makeExo(name, /** @type {any} */ (m1bInterfaces)[name], methods);
};

test('every M1b interface has method names and samples; a stub exo accepts them', async t => {
  t.deepEqual(
    Object.keys(m1bMethodNames).sort(),
    Object.keys(m1bInterfaces).sort(),
  );
  t.deepEqual(
    Object.keys(methodSamples).sort(),
    Object.keys(m1bInterfaces).sort(),
  );
  const calls = [];
  for (const [name, names] of Object.entries(m1bMethodNames)) {
    // TurnSink's `compacted` (WX.1, `seamLater`) has its samples with the
    // context window's tests.
    t.deepEqual(
      Object.keys(methodSamples[name]),
      beforeSeam(name, names),
      name,
    );
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

test('every M1b method refuses an oversize string, an oversize array and an extra key in its arguments', async t => {
  const calls = [];
  for (const name of Object.keys(m1bMethodNames)) {
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
  t.true(calls.length >= 69, `${calls.length} variants refused`);
});

test('an M1b interface under an M1a name keeps every M1a method, in order, first', t => {
  for (const name of Object.keys(m1bMethodNames)) {
    // Since the M2 fold (X1) the folded list may be M2's, which keeps every
    // M1b method first (M1a's first is checked by m2-interfaces.test.js).
    const folded = /** @type {Record<string, readonly string[]>} */ (
      methodNames
    )[name];
    t.deepEqual(
      folded.slice(0, m1bMethodNames[name].length),
      [...m1bMethodNames[name]],
      name,
    );
    t.truthy(/** @type {any} */ (interfaces)[name], name);
  }
  // A guard admits only its own methods: an M1a exo cannot pass for M1b.
  t.throws(() =>
    makeExo('TurnSink', /** @type {any} */ (m1bInterfaces.TurnSink), {
      dispatching: () => true,
      roundFinal: () => {},
      roundFailed: () => {},
      deadline: () => {},
    }),
  );
});

test('return guards: an exec outcome, a busy answer and a structural record page', async t => {
  const exo = /** @type {any} */ (
    makeExo('ExecScope', /** @type {any} */ (m1bInterfaces.ExecScope), {
      run: async () => harden({ status: 'ok', text: 'a'.repeat(9) }),
      abandon: () => {},
      // M5's method, in the one ExecScope guard since the fold (F2).
      inspect: async () => harden({ status: 'exhausted' }),
    })
  );
  const answer = await exo.run(harden(execRequest));
  t.deepEqual(answer, {
    status: 'ok',
    text: 'a'.repeat(9),
  });
  const busy = /** @type {any} */ (
    makeExo('ExecScope', /** @type {any} */ (m1bInterfaces.ExecScope), {
      run: async () => harden({ status: 'busy', text: 'x' }),
      abandon: () => {},
      inspect: async () => harden({ status: 'exhausted' }),
    })
  );
  await t.throwsAsync(
    () => busy.run(harden(execRequest)),
    undefined,
    'busy carries no text',
  );
  // M1b QC (J-0390): an exhausted name table is its own answer, without text.
  const answers = (/** @type {any} */ value) =>
    /** @type {any} */ (
      makeExo('ExecScope', /** @type {any} */ (m1bInterfaces.ExecScope), {
        run: async () => harden(value),
        abandon: () => {},
        inspect: async () => harden({ status: 'exhausted' }),
      })
    ).run(harden(execRequest));
  t.deepEqual(await answers({ status: 'exhausted' }), { status: 'exhausted' });
  await t.throwsAsync(() => answers({ status: 'exhausted', text: 'x' }));
  await t.throwsAsync(() => answers({ status: 'lost' }));
  // ContextSource.page: structure and bounds, records only as keys (J-9156).
  const page = (/** @type {any} */ value) =>
    /** @type {any} */ (
      makeExo(
        'ContextSource',
        /** @type {any} */ (m1bInterfaces.ContextSource),
        // `segments`: M2's, in the folded guard (X1).
        { page: () => harden(value), segments: () => harden({ segments: [] }) },
      )
    );
  const many = Array.from({ length: limits.pageRecords }, () => turnStarted);
  t.notThrows(() => page({ from: 7, records: many }).page());
  t.throws(() => page({ from: 7, records: [...many, turnStarted] }).page());
  t.throws(() => page({ records: [turnStarted] }).page(), undefined, 'from');
  t.throws(() =>
    page({ from: 0, records: [{ kind: 'x', at: Promise.resolve(1) }] }).page(),
  );
});

test('the fixed M1b texts', t => {
  t.is(
    texts.execTerminated,
    'exec scope terminated: the exec vat stopped (it exceeded the per-step compute budget or its worker failed repeatedly); bindings from earlier calls are gone',
  );
  t.is(
    texts.execBusyReset,
    'the previous exec call was still running; the scope was reset',
  );
  t.is(
    textOf.execTimeout(5000),
    'exec call timed out after 5000 ms; the exec vat was stopped and the scope was reset; bindings from earlier calls are gone',
  );
  t.is(
    textOf.execSourceTooLarge(307_200, limits.execSourceBytes),
    'exec source too large (307200 bytes; limit 262144)',
  );
  t.true(
    texts.execNoReturn.startsWith(
      'done (no return value). Use a top-level return',
    ),
  );
  t.is(texts.execCodeRequired, 'code is required');
  // R4-46 and the calls-per-round text are M1a's, unchanged.
  t.is(
    textOf.truncationMarker(100_000),
    '\n[Tool output truncated from 100000 characters. Only a prefix is shown; use filtering or pagination for more.]',
  );
  t.is(
    textOf.tooManyCalls(100, limits.maxCallsPerRound),
    'Too many tool calls in one round (100); only the first 64 were run.',
  );
  // The blank refusal keeps Fae's text (the spec gives none; J-9150, J-0302).
  t.is(texts.blankSubmission, 'A queued message must be non-empty text');
  const parameters = JSON.parse(execDescription.parameters);
  t.deepEqual(Object.keys(parameters.properties), [...execArgumentNames]);
  t.true(matches(harden({ ...execDescription }), shapes.ToolDescription));
});

/**
 * A SessionHostFacet stand-in whose publishers never answer: the outside
 * chain can never settle.
 */
const stuckHost = () => {
  const publishes = [];
  const neverAnswers = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => {
      publishes.push(batch);
      return makePromiseKit().promise;
    },
  });
  return {
    publishes,
    host: Far('SessionHostFacet', { liveChannel: () => neverAnswers }),
  };
};

/** @param {number} n */
const pendingEvent = n =>
  harden({
    type: 'pending',
    pending: { entries: [], hold: { reason: 'restart', message: `${n}` } },
  });

test("outside publishes behind one that never settles stay within one batch's worth (J-9172)", async t => {
  const { host, publishes } = stuckHost();
  const live = makeLivePublishing({ host });
  /** @type {Promise<void>[]} */
  const waits = [];
  for (let i = 0; i < 1000; i += 1) {
    waits.push(live.outside([pendingEvent(i)]));
    const state = live.outsideState();
    t.true(state.pendingEvents <= limits.outsidePendingEvents);
    t.true(state.pendingBytes <= limits.frameBytes);
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  const state = live.outsideState();
  t.true(state.inFlight);
  t.is(publishes.length, 1, 'one publish in flight, never answered');
  t.is(state.pending, limits.outsidePendingEvents);
  t.is(state.dropped, 1000 - 1 - limits.outsidePendingEvents);
  // Dropped batches resolve their callers; kept ones wait.
  const settled = await Promise.race([
    Promise.all(waits.slice(1, 1 + state.dropped)).then(
      () => 'dropped settled',
    ),
    new Promise(resolve => setTimeout(() => resolve('timeout'), 500)),
  ]);
  t.is(settled, 'dropped settled');
  // The newest batch is kept, with the latest rev.
  t.is(live.rev(), 1 + 1000);
});

test('a liveChannel() that never settles also leaves at most the bound pending', async t => {
  const live = makeLivePublishing({
    host: Far('SessionHostFacet', {
      liveChannel: () => makePromiseKit().promise,
    }),
  });
  for (let i = 0; i < 300; i += 1) void live.outside([pendingEvent(i)]);
  await null;
  const state = live.outsideState();
  t.true(state.inFlight);
  t.is(state.pending, limits.outsidePendingEvents);
  t.is(state.dropped, 300 - 1 - limits.outsidePendingEvents);
});

test('outside publishes still go out in rev order and keep going after a slow one', async t => {
  /** @type {any[]} */
  const published = [];
  /** @type {{ resolve: (v?: any) => void }[]} */
  const answers = [];
  const publisher = Far('LivePublisher', {
    publish: (/** @type {any} */ batch) => {
      published.push(batch.rev);
      const kit = makePromiseKit();
      answers.push(kit);
      return kit.promise;
    },
  });
  const live = makeLivePublishing({
    host: Far('SessionHostFacet', { liveChannel: () => publisher }),
  });
  const first = live.outside([pendingEvent(1)]);
  const second = live.outside([pendingEvent(2)]);
  const third = live.outside([pendingEvent(3)]);
  await new Promise(resolve => setTimeout(resolve, 10));
  t.deepEqual(published, [2]);
  t.is(live.outsideState().pending, 2);
  answers[0].resolve(undefined);
  await first;
  await new Promise(resolve => setTimeout(resolve, 10));
  answers[1].resolve(undefined);
  await second;
  await new Promise(resolve => setTimeout(resolve, 10));
  answers[2].resolve(undefined);
  await third;
  t.deepEqual(published, [2, 3, 4]);
  t.deepEqual(live.outsideState(), {
    inFlight: false,
    pending: 0,
    pendingEvents: 0,
    pendingBytes: 0,
    dropped: 0,
  });
  await live.outside([]);
});
