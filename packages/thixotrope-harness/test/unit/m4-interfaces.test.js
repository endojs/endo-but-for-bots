// @ts-check
// The M4 interface contract (W4.0 guards, checked by W4.1;
// designs/m4-interfaces.md 3, 12, 13): every M4 shape and method guard
// accepts a sample and refuses, at every place in the sample, an oversize
// string, an oversize array and an extra record key; the M4 versions of
// `SecretsAdmin` and `Secret` keep M2's method guards (compared through the
// guard payload, the technique M5's CC-072 asks the prelude to support;
// read directly here and pinned by this test); `vocabularyShapes()` answers
// every M4 shape and interface; `BackendKind` admits the pool kinds (H-1);
// the Node defaults equal the vat limits where a name is in both; and the
// fixed texts are exact.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { interfaces, methodNames, shapes } from '../../guest/lib/interfaces.js';
import {
  m4Interfaces,
  m4Limits,
  m4MethodNames,
  m4Shapes,
  m4SinkMethodGuards,
  m4SinkMethodNames,
  m4TextOf,
  m4Texts,
  poolKinds,
  providerOfKind,
  vocabularyShapes,
} from '../../guest/lib/interfaces-m4.js';
/* eslint-enable import/no-relative-packages */
import { subscriptionDefaults } from '../../config/defaults.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, makeExo, matches } = /** @type {GuestGlobals} */ (globalThis);

const HUGE_STRING = 'x'.repeat(2_097_153);
const HUGE_ARRAY = 20_001;

/** @param {string} label */
const far = label => Far(label, {});

const secret = far('Secret');
const member = far('PoolMember');
const backend = far('Backend');
const session = far('Session');
const host = far('SessionHostFacet');
const ISO = '2026-11-18T02:11:49.000Z';

const window = {
  name: 'primary',
  usedPercent: 40,
  resetsAt: ISO,
  windowMinutes: 300,
};
const declared = { plan: 'Max', windows: [window] };
const mark = { untilMs: 2000, strikes: 1, sinceMs: 1000, dated: true };
const memberState = {
  member,
  label: 'first',
  provider: 'claude',
  weight: 1,
  key: 'k1',
  state: 'active',
  mark,
  declared,
};
const served = { session, member, at: 1000 };
const catalogEntry = {
  secret,
  label: 'token',
  description: 'A subscription credential',
  generation: 2,
  state: 'active',
  bytes: 120,
};
const auditEvent = {
  at: 1000,
  label: 'token',
  op: 'read',
  outcome: 'succeeded',
  generation: 2,
};
const memberAccount = {
  label: 'first',
  provider: 'codex',
  provenance: 'observed',
  state: 'ok',
  windows: [window],
  limitReached: false,
  plan: 'Pro',
  credits: '3',
  banked: [{ expiresAt: ISO, label: 'reset' }],
  at: ISO,
  markedUntil: ISO,
  code: 'EXHAUSTED',
};
const poolAccounts = {
  backend,
  kind: 'codex-pool',
  label: 'codex',
  selection: 'auto',
  members: [memberAccount],
};
const poolSpec = {
  kind: 'claude-pool',
  label: 'claude',
  members: [member],
  modelId: 'model-a',
  contextLength: 200_000,
  maxOutputTokens: 16_384,
  timeoutMs: 1000,
  cacheLifetimeMs: 3000,
  baseUrl: 'http://127.0.0.1:1',
  tokenUrl: 'http://127.0.0.1:2',
  usageUrl: 'http://127.0.0.1:3',
  logPath: 'log',
};

/** A sample of every M4 shape. */
const shapeSamples = {
  Provider: 'claude',
  PoolKind: 'codex-pool',
  DeclaredProfile: declared,
  NewMember: {
    provider: 'claude',
    label: 'first',
    credential: secret,
    weight: 2,
    declared,
  },
  MemberInfo: {
    provider: 'claude',
    label: 'first',
    weight: 2,
    state: 'active',
    declared,
  },
  PoolSpec: poolSpec,
  PoolInfo: { kind: 'claude-pool', label: 'claude', modelId: 'model-a' },
  PoolDescription: {
    kind: 'claude-pool',
    label: 'claude',
    members: [member],
    state: 'active',
  },
  MemberPage: { members: [member], next: '64' },
  PoolPage: { pools: [backend] },
  Mark: mark,
  MemberState: memberState,
  ServedRecord: served,
  PoolState: { state: 'active', members: [memberState], served: [served] },
  MarkChange: { member, mark },
  PoolChange: { marks: [{ member, mark }], served: [served] },
  EffortRequest: { modelId: 'model-a', reasoningEffort: 'high' },
  EffortAnswer: { reasoningEffort: 'high' },
  SecretCatalogEntry: catalogEntry,
  SecretCatalogPage: { entries: [catalogEntry], next: '64' },
  SecretKeyInfo: { key: 'k1', generation: 2, state: 'revoked', bytes: 0 },
  AuditQuery: { secret, limit: 1000, before: 5000 },
  AuditReaderPage: { events: [auditEvent], next: 999 },
  Provenance: 'remembered',
  Window: window,
  BankedCredit: { expiresAt: ISO, label: 'reset' },
  MemberAccount: memberAccount,
  PoolAccounts: poolAccounts,
  AccountsView: { rev: 3, pools: [poolAccounts] },
  AccountsBatch: { rev: 4, pools: [poolAccounts] },
};

/**
 * Paths to every string, array and record in a sample (not into
 * remotables); as m2-interfaces.test.js.
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

test('every M4 shape has a sample that matches and refuses every oversize string, array and extra key', t => {
  t.deepEqual(Object.keys(shapeSamples).sort(), Object.keys(m4Shapes).sort());
  let refused = 0;
  for (const [name, sample] of Object.entries(shapeSamples)) {
    const shape = /** @type {any} */ (m4Shapes)[name];
    t.true(matches(harden(sample), shape), name);
    for (const { label, value } of badVariants(harden(sample))) {
      t.false(matches(value, shape), `${name}: ${label}`);
      refused += 1;
    }
  }
  t.true(refused >= 150, `${refused} variants refused`);
});

test('bounds that are not strings: 17 members, a 257th served record, an audit limit of 1,001', t => {
  const members = Array.from({ length: 17 }, () => member);
  t.false(matches(harden({ ...poolSpec, members }), m4Shapes.PoolSpec));
  t.true(
    matches(
      harden({ ...poolSpec, members: members.slice(1) }),
      m4Shapes.PoolSpec,
    ),
  );
  const many = Array.from({ length: m4Limits.servedRecords + 1 }, () => served);
  t.false(
    matches(
      harden({ state: 'active', members: [memberState], served: many }),
      m4Shapes.PoolState,
    ),
  );
  t.false(matches(harden({ limit: 1001 }), m4Shapes.AuditQuery));
  t.false(matches(harden({ ...window, usedPercent: 101 }), m4Shapes.Window));
  t.false(
    matches(harden({ ...poolSpec, kind: 'anthropic' }), m4Shapes.PoolSpec),
  );
});

const sessionPorts = {
  endpoint: far('Endpoint'),
  publisher: far('LivePublisher'),
  tools: [],
  since: 0,
};
const modelPage = { rows: [], state: 'ok' };

/** Arguments and a return value for every M4 method (M2 methods: M2's test). */
const methodSamples = {
  SubscriptionsAdmin: {
    makeMember: { args: [shapeSamples.NewMember], returns: member },
    listMembers: { args: ['0'], returns: shapeSamples.MemberPage },
    makePool: { args: [poolSpec], returns: backend },
    listPools: { args: [], returns: shapeSamples.PoolPage },
    describePool: { args: [backend], returns: shapeSamples.PoolDescription },
    retirePool: { args: [backend], returns: undefined },
    accounts: { args: [], returns: far('Accounts') },
  },
  PoolMember: {
    describe: { args: [], returns: shapeSamples.MemberInfo },
    retire: { args: [], returns: undefined },
  },
  PoolBackend: {
    describe: { args: [], returns: shapeSamples.PoolInfo },
    open: { args: [host], returns: sessionPorts },
    listModels: { args: [{ limit: 10, after: 'x' }], returns: modelPage },
    resolveModel: { args: ['model-a'], returns: { modelId: 'model-a' } },
    resolveEffort: {
      args: [shapeSamples.EffortRequest],
      returns: shapeSamples.EffortAnswer,
    },
  },
  SecretsAdmin: {
    catalog: { args: ['64'], returns: shapeSamples.SecretCatalogPage },
    auditReader: { args: [], returns: far('AuditReader') },
    subscriptions: { args: [], returns: far('SubscriptionsAdmin') },
  },
  Secret: {
    setDescription: { args: ['A new description'], returns: undefined },
  },
  CredentialOps: {
    describeSecrets: {
      args: [['k1', 'k2']],
      returns: [shapeSamples.SecretKeyInfo, null],
    },
    setSecretDescription: { args: ['k1', 'A description'], returns: undefined },
    auditReader: { args: [], returns: far('AuditReader') },
    accounts: { args: [], returns: far('Accounts') },
  },
  AuditReader: {
    page: {
      args: [shapeSamples.AuditQuery],
      returns: shapeSamples.AuditReaderPage,
    },
  },
  Accounts: {
    list: { args: [], returns: shapeSamples.AccountsView },
    forBackend: { args: [backend], returns: poolAccounts },
    forSession: { args: [session], returns: undefined },
    refresh: { args: [backend], returns: shapeSamples.AccountsView },
    watch: { args: [3], returns: far('AccountsSubscription') },
  },
  AccountsSubscription: {
    next: { args: [], returns: shapeSamples.AccountsBatch },
    close: { args: [], returns: undefined },
  },
};

/**
 * A stub exo answering the samples (M2 methods are no-ops).
 * @param {string} name
 */
const stubExo = name => {
  /** @type {Record<string, (...args: any[]) => any>} */
  const methods = {};
  for (const method of /** @type {any} */ (m4MethodNames)[name]) {
    methods[method] = () => undefined;
  }
  for (const [method, { returns }] of Object.entries(
    /** @type {any} */ (methodSamples)[name],
  )) {
    methods[method] = () => harden(returns);
  }
  return makeExo(name, /** @type {any} */ (m4Interfaces)[name], methods);
};

test('every M4 interface has method names and samples; a stub exo accepts them', async t => {
  t.deepEqual(
    Object.keys(methodSamples).sort(),
    Object.keys(m4Interfaces).sort(),
  );
  t.deepEqual(
    Object.keys(m4MethodNames).sort(),
    Object.keys(m4Interfaces).sort(),
  );
  const calls = [];
  for (const [name, samples] of Object.entries(methodSamples)) {
    const exo = stubExo(name);
    const own = Object.keys(samples);
    const names = /** @type {any} */ (m4MethodNames)[name];
    t.deepEqual(names.slice(names.length - own.length), own, name);
    for (const [method, { args }] of Object.entries(samples)) {
      calls.push(
        t.notThrowsAsync(
          async () => /** @type {any} */ (exo)[method](...harden(args)),
          `${name}.${method}`,
        ),
      );
    }
  }
  await Promise.all(calls);
});

test('every M4 method refuses an oversize string, an oversize array and an extra key in its arguments', async t => {
  const calls = [];
  for (const [name, samples] of Object.entries(methodSamples)) {
    const exo = stubExo(name);
    for (const [method, { args }] of Object.entries(samples)) {
      const variants = badVariants(harden(args)).filter(
        ({ label }) => label !== 'array at (root)',
      );
      for (const { label, value } of variants) {
        calls.push(
          t.throwsAsync(
            async () => /** @type {any} */ (exo)[method](...value),
            undefined,
            `${name}.${method}: ${label}`,
          ),
        );
      }
    }
  }
  await Promise.all(calls);
  t.true(calls.length >= 30, `${calls.length} variants refused`);
});

test('return guards refuse what the contract keeps out: a key value, an unbounded page', async t => {
  const stub = (/** @type {string} */ name, /** @type {any} */ methods) =>
    makeExo(name, /** @type {any} */ (m4Interfaces)[name], methods);
  // MemberInfo never carries the credential or its key.
  const leaky = stub('PoolMember', {
    describe: () => harden({ ...shapeSamples.MemberInfo, key: 'k1' }),
    retire: () => undefined,
  });
  t.throws(() => leaky.describe());
  const catalog = stub('SecretsAdmin', {
    list: () => undefined,
    create: () => undefined,
    openWriter: () => undefined,
    audit: () => undefined,
    catalog: () =>
      harden({ entries: [{ ...catalogEntry, value: 'secret bytes' }] }),
    auditReader: () => undefined,
    subscriptions: () => undefined,
  });
  await t.throwsAsync(() => catalog.catalog());
});

/**
 * The method guards of an interface guard (`guard.payload.methodGuards`;
 * pinned here until CC-072's prelude helper exists).
 * @param {any} guard
 */
const methodGuardsOf = guard => guard.payload.methodGuards;

test('M4 SecretsAdmin and Secret keep M2s method guards, first and equal', t => {
  for (const name of ['SecretsAdmin', 'Secret']) {
    const m2 = methodGuardsOf(/** @type {any} */ (interfaces)[name]);
    const m4 = methodGuardsOf(/** @type {any} */ (m4Interfaces)[name]);
    const m2Names = /** @type {any} */ (methodNames)[name];
    t.deepEqual(Object.keys(m2).sort(), [...m2Names].sort(), name);
    t.deepEqual(
      /** @type {any} */ (m4MethodNames)[name].slice(0, m2Names.length),
      [...m2Names],
      name,
    );
    for (const method of m2Names) {
      t.deepEqual(m4[method], m2[method], `${name}.${method}`);
    }
  }
});

test('the sink guards name the three sink methods', t => {
  t.deepEqual(
    Object.keys(m4SinkMethodGuards()).sort(),
    [...m4SinkMethodNames].sort(),
  );
});

test('vocabularyShapes answers every M4 shape and interface', t => {
  const answered = vocabularyShapes();
  t.is(
    answered.length,
    Object.keys(m4Shapes).length + Object.keys(m4Interfaces).length,
  );
  for (const shape of Object.values(m4Shapes)) t.true(answered.includes(shape));
  for (const guard of Object.values(m4Interfaces))
    t.true(answered.includes(guard));
});

test('BackendKind and BackendInfo admit the pool kinds (H-1)', t => {
  for (const kind of [...poolKinds, 'scripted', 'openrouter', 'anthropic']) {
    t.true(matches(kind, shapes.BackendKind), kind);
    t.true(matches(harden({ kind, label: 'b' }), shapes.BackendInfo), kind);
  }
  t.false(matches('other-pool', shapes.BackendKind));
  t.deepEqual(providerOfKind, {
    'claude-pool': 'claude',
    'codex-pool': 'codex',
  });
});

test('Node defaults equal the vat limits where a name is in both', t => {
  const shared = Object.keys(subscriptionDefaults).filter(
    name => name in m4Limits,
  );
  t.deepEqual(shared.sort(), [
    'auditReaderDefault',
    'auditReaderMax',
    'credentialBytes',
    'servedRecords',
  ]);
  for (const name of shared) {
    t.is(
      /** @type {any} */ (subscriptionDefaults)[name],
      /** @type {any} */ (m4Limits)[name],
      name,
    );
  }
  t.true(Object.isFrozen(subscriptionDefaults));
  t.true(Object.isFrozen(subscriptionDefaults.codexOverloadDelaysMs));
  t.deepEqual(
    [...subscriptionDefaults.claudeOverloadDelaysMs],
    [...subscriptionDefaults.codexOverloadDelaysMs],
  );
  t.like(subscriptionDefaults, {
    cacheLifetimeMs: 300_000,
    servedStampMs: 60_000,
    servedFlushMs: 1000,
    backoffStartMs: 60_000,
    backoffMaxMs: 3_600_000,
    undatedBlockMs: 3_600_000,
    requestTimeoutMs: 3_600_000,
    claudeMaxOutputTokens: 16_384,
    claudeContextLength: 200_000,
    refreshSkewMs: 120_000,
    readingsFlushMs: 5000,
  });
  t.deepEqual(
    [...subscriptionDefaults.codexOverloadDelaysMs],
    [5000, 10_000, 20_000, 40_000, 60_000],
  );
});

test('the fixed M4 texts (section 13)', t => {
  t.is(m4Texts.subscriptionsExhausted, 'Provider subscriptions exhausted');
  t.is(m4TextOf.subscriptionsExhausted(), 'Provider subscriptions exhausted');
  t.is(
    m4TextOf.subscriptionsExhausted(ISO),
    `Provider subscriptions exhausted; the first member is expected back at ${ISO}`,
  );
  t.is(m4Texts.claudeInferenceFailed, 'Claude subscription inference failed');
  t.is(
    m4TextOf.subscriptionHttp(503),
    'Subscription inference failed (HTTP 503)',
  );
  t.is(m4Texts.emptyMessagesOutput, 'Empty Messages assistant output');
  t.is(m4Texts.emptyResponsesOutput, 'Empty Responses assistant output');
  t.is(
    m4TextOf.responsesFailed('response.failed', ['code=server_error'], 'Why.'),
    'Subscription inference ended unsuccessfully (response.failed; code=server_error) Why.',
  );
  t.is(
    m4TextOf.responsesFailed('response.incomplete', []),
    'Subscription inference ended unsuccessfully (response.incomplete)',
  );
  t.is(
    m4Texts.unsupportedEffort,
    'Unsupported reasoning effort for Fae subscription',
  );
  t.is(
    m4Texts.secretTooLargeForBrowser,
    'This value is too large to send from the browser; write it from the command line with scripts/subscription-login.mjs --value-file, which sends a sealed box',
  );
  t.is(m4Texts.secretNotText, 'This file is not text; secrets hold text');
  t.is(
    m4Texts.accountsWatchClosed,
    'This accounts watch is closed; watch again',
  );
  t.deepEqual(
    [
      m4Texts.provenanceObserved,
      m4Texts.provenanceDeclared,
      m4Texts.provenanceRemembered,
      m4Texts.provenanceUnavailable,
    ],
    ['observed', 'declared', 'remembered', 'unavailable'],
  );
  t.is(
    m4TextOf.memberFailed('first', 'CONSUMED'),
    'Subscription member "first" failed: "CONSUMED"',
  );
  for (const name of [
    'effortNotSupported',
    'subscriptionModelRequired',
    'noUsableMember',
    'memberConflict',
    'poolConflict',
    'memberKind',
    'unknownMember',
    'unknownPool',
    'retired',
    'credentialConsumed',
    'credentialExpired',
    'credentialInvalid',
    'credentialRejected',
    'noSubscriptionAccounts',
  ]) {
    const value = /** @type {any} */ (m4Texts)[name];
    t.is(typeof value, 'string', name);
    t.regex(/** @type {string} */ (value), /^[^\n]+$/, name);
  }
});
