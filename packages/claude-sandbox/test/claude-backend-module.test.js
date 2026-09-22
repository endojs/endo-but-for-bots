// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { HostedToolSetInterface } from '@endo/hosted-agent';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SESSION_RECORDS_PATH,
  controllerSpecifier,
  make,
  resolveBackendConfig,
} from '../src/claude-backend-module.js';
import { makeSandboxSessionId } from '../src/claude-session-plan.js';
import {
  brokerServiceSpecifier,
  nativeSandboxSpecifier,
  sessionStorageSpecifier,
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';

/** @import { EndoHost } from '@endo/daemon' */

const key = (...parts) => JSON.stringify(parts.flat());
const digest = `sha256:${'a'.repeat(64)}`;
const imageRef = `localhost/claude@${digest}`;
const rootfs = `oci:${imageRef}`;
/** The persisted broker profile a session takes its image and kind from. */
const brokerConfig = (overrides = {}) =>
  JSON.stringify({
    ownerId: 'claude-broker',
    directory: '/srv/broker',
    imageRef,
    imageDigest: digest,
    listenerImageRef: `localhost/listener@sha256:${'c'.repeat(64)}`,
    publicInternet: true,
    credentialKind: 'oauthToken',
    ...overrides,
  });
const makeToolSet = () =>
  makeExo('HostedToolSet', HostedToolSetInterface, {
    async describe() {
      return harden({ dynamicTools: [], toolSetId: 'tools-v1' });
    },
    async execute() {
      return 'ok';
    },
    help: () => 'test tool set',
  });

/** A recording stand-in for the daemon's session owner. */
const makeFakeOwner = () => {
  /** @type {Map<string, { plan: string, references: Record<string, string>, phase: string }>} */
  const records = new Map();
  /** @type {any[][]} */
  const log = [];
  /** @type {{ createError: Error | undefined }} */
  const knobs = { createError: undefined, catalogDown: false };
  const facet = harden({
    async send() {
      return harden({});
    },
    async interrupt() {
      await null;
    },
    async status() {
      return harden({ ready: true });
    },
  });
  const owner = harden({
    async create(name, plan, references) {
      log.push(['create', name, plan, references]);
      if (knobs.createError) throw knobs.createError;
      records.set(name, {
        plan,
        references: { ...references },
        phase: 'planned',
      });
      return harden({ ...records.get(name) });
    },
    async inspect(name) {
      log.push(['inspect', name]);
      const record = records.get(name);
      return record === undefined ? undefined : harden({ ...record });
    },
    async revise(name, plan) {
      log.push(['revise', name, plan]);
      const record = records.get(name);
      if (!record) throw Error('missing record');
      record.plan = plan;
    },
    async start(name, tools) {
      log.push(['start', name, await E(tools).describe()]);
      const record = records.get(name);
      if (!record) throw Error('missing record');
      record.phase = 'ready';
      return facet;
    },
    async stop(name) {
      log.push(['stop', name]);
      const record = records.get(name);
      if (record) record.phase = 'stopped';
    },
    async remove(name) {
      log.push(['remove', name]);
      records.delete(name);
    },
  });
  return { owner, records, log, facet, knobs };
};

/** @param {import('ava').ExecutionContext} t */
const fixture = async t => {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'claude-backend-')),
  );
  t.teardown(() => rm(base, { recursive: true, force: true }));
  const roots = harden({
    workspaceDir: path.join(base, 'workspaces'),
    mcpDir: path.join(base, 'private'),
  });
  const { owner, records, log, facet, knobs } = makeFakeOwner();
  const bindings = new Map();
  const formulas = new Map();
  const environments = new Map();
  const seed = (namePath, id, specifier, env) => {
    bindings.set(key(...namePath), id);
    formulas.set(
      id,
      harden({
        type: 'make-unconfined',
        properties: { specifier: { kind: 'literal', value: specifier } },
      }),
    );
    environments.set(id, harden(env));
  };
  seed(
    ['claude-sandbox', 'native-sandbox'],
    'native-id',
    nativeSandboxSpecifier,
    {
      ENDO_SANDBOX_RUNTIME_DIR: path.join(base, 'runtime', 'native'),
      ENDO_SANDBOX_OWNER_ID: 'owner-native',
      ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
      ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
    },
  );
  seed(
    ['claude-sandbox', 'state-provider'],
    'state-id',
    stateProviderSpecifier,
    {
      ENDO_CLAUDE_STATE_DIR: path.join(base, 'state'),
    },
  );
  seed(
    ['claude-sandbox', 'session-storage'],
    'storage-id',
    sessionStorageSpecifier,
    {
      CLAUDE_WORKSPACE_BASE_DIR: roots.workspaceDir,
      CLAUDE_MCP_DIR: roots.mcpDir,
    },
  );
  seed(
    ['claude-sandbox', 'broker-service'],
    'broker-id',
    brokerServiceSpecifier,
    { CLAUDE_BROKER_CONFIG: brokerConfig() },
  );
  /** @type {any[]} */
  const ownerRequests = [];
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ (
      harden({
        async identify(...parts) {
          return bindings.get(key(...parts));
        },
        async has(...parts) {
          return bindings.has(key(...parts));
        },
        async lookup() {
          return harden({
            subscriptions: async () =>
              harden([
                { id: 'first', label: 'First' },
                { id: 'second', label: 'Second' },
              ]),
            // What each account lists, as the broker reads it from Anthropic;
            // an outage is scripted by the test.
            modelCatalog: async subscriptionId => {
              if (knobs.catalogDown) throw Error('provider catalog down');
              return harden({
                accounts: ['first', 'second']
                  .filter(
                    id => subscriptionId === undefined || id === subscriptionId,
                  )
                  .map(id => ({
                    subscriptionId: id,
                    state: 'current',
                    observedAt: 1,
                    models: [
                      'claude-sonnet-4-6',
                      'claude-haiku-4-5-20251001',
                      'claude-opus-5',
                    ].map(model => ({
                      id: model,
                      title: model,
                      description: '',
                      default: false,
                      defaultReasoningEffort: null,
                      reasoningEfforts: [],
                    })),
                  })),
              });
            },
          });
        },
        async diagnostics() {
          return harden({ getFormula: async id => formulas.get(id) });
        },
        async getFormulaEnvironment(id) {
          return environments.get(id);
        },
        async provideSessionOwner(recordsPath, specifier) {
          ownerRequests.push({ recordsPath, specifier });
          return owner;
        },
      })
    )
  );
  const env = harden({
    CLAUDE_WORKSPACE_BASE_DIR: roots.workspaceDir,
    CLAUDE_MCP_DIR: roots.mcpDir,
  });
  const exists = async directory =>
    access(directory).then(
      () => true,
      () => false,
    );
  return {
    base,
    roots,
    env,
    host,
    owner,
    records,
    log,
    facet,
    knobs,
    ownerRequests,
    bindings,
    environments,
    exists,
  };
};

test('Claude advertises only the network authority recorded by its broker', async t => {
  const f = await fixture(t);
  f.environments.set(
    'broker-id',
    harden({ CLAUDE_BROKER_CONFIG: brokerConfig({ publicInternet: false }) }),
  );
  const factory = await make(f.host, undefined, { env: f.env });
  t.deepEqual((await E(factory).describe()).supportedNetworkPolicies, ['off']);
  // What a reopen of a session here may be authorized to rebind, as the
  // provisioner names it.
  t.deepEqual((await E(factory).describe()).rebindableBindings, [
    'image',
    'credential kind',
    'provider',
  ]);
});

test('a recorded Claude subscription pin is revised on reopen; auto drops it', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const spec = harden({ sessionId: 'pinned', subscription: 'first' });
  await E(factory).create(spec, makeToolSet());
  const plan = () => JSON.parse(f.records.get('pinned')?.plan ?? '');
  t.is(plan().subscription, 'first');
  // The subscription is a binding of the incarnation, not of the
  // conversation: a reopen naming another account is served from it, and
  // one naming none is left to the pool again. Neither destroys the session.
  const before = f.log.length;
  await E(factory).create(
    harden({ ...spec, subscription: 'second' }),
    makeToolSet(),
  );
  t.deepEqual(
    f.log.slice(before).map(entry => entry[0]),
    ['stop', 'inspect', 'stop', 'revise', 'start'],
  );
  t.is(plan().subscription, 'second');
  await E(factory).create(
    harden({ ...spec, subscription: 'auto' }),
    makeToolSet(),
  );
  t.false('subscription' in plan());
  t.is(f.records.size, 1, 'the same record throughout');
});

test('resolveBackendConfig defaults nothing', t => {
  const env = {
    CLAUDE_WORKSPACE_BASE_DIR: '/srv/ws',
    CLAUDE_MCP_DIR: '/srv/private',
  };
  const config = resolveBackendConfig(env);
  t.false(Object.hasOwn(config, 'mounterEnv'));
  // The image and the credential kind come from the recorded broker, never
  // from this environment.
  t.deepEqual(Object.keys(config).sort(), ['mcpBaseDir', 'workspaceBaseDir']);
  t.deepEqual(
    resolveBackendConfig({
      ...env,
      CLAUDE_MOUNTER_ENV: JSON.stringify({ NINEP_SUDO: '1' }),
    }).mounterEnv,
    { NINEP_SUDO: '1' },
  );
  /** @type {[string, string | undefined, RegExp][]} */
  const invalid = [
    [
      'CLAUDE_WORKSPACE_BASE_DIR',
      'relative',
      /CLAUDE_WORKSPACE_BASE_DIR must be/,
    ],
    ['CLAUDE_MCP_DIR', '/srv/private/', /CLAUDE_MCP_DIR must be/],
    [
      'CLAUDE_MOUNTER_ENV',
      JSON.stringify({ NINEP_MOUNT_PROGRAM: 'rm' }),
      /"NINEP_MOUNT_PROGRAM" must invoke "mount"/,
    ],
  ];
  for (const [name, value, message] of invalid) {
    t.throws(() => resolveBackendConfig({ ...env, [name]: value }), {
      message,
    });
  }
});

test('make() configures the owner on the records path over verified service identities', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  t.deepEqual(f.ownerRequests, [
    { recordsPath: SESSION_RECORDS_PATH, specifier: controllerSpecifier },
  ]);
  t.is((await E(factory).describe()).id, 'claude');
  // Roots that differ from the recorded storage owner's are refused.
  await t.throwsAsync(
    make(f.host, undefined, {
      env: harden({ ...f.env, CLAUDE_MCP_DIR: path.join(f.base, 'other') }),
    }),
    { message: /Backend roots must equal the recorded session storage owner/ },
  );
  // A broker profile naming an unknown credential kind is refused before
  // any record: the plan would otherwise record a kind no env var maps.
  f.environments.set(
    'broker-id',
    harden({ CLAUDE_BROKER_CONFIG: brokerConfig({ credentialKind: 'jwt' }) }),
  );
  await t.throwsAsync(make(f.host, undefined, { env: f.env }), {
    message: /Invalid Claude broker configuration/,
  });
  // A missing or foreign broker formula is refused before any record.
  f.bindings.delete(key('claude-sandbox', 'broker-service'));
  await t.throwsAsync(make(f.host, undefined, { env: f.env }), {
    message: /Cannot identify Claude "broker-service"/,
  });
  t.is(f.ownerRequests.length, 1);
});

test('create() records the plan under the sandbox id with exact dependencies, then starts with the tool set', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const toolSet = makeToolSet();
  const { run } = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'max',
      systemPrompt: 'You are Floot.',
    }),
    toolSet,
  );
  const sid = makeSandboxSessionId('session-a');
  const [, name, planText, references] =
    f.log.find(([kind]) => kind === 'create') ?? [];
  t.is(name, 'session-a');
  t.deepEqual(JSON.parse(planText), {
    sessionId: 'session-a',
    sandboxSessionId: sid,
    rootfs,
    networkPolicy: 'off',
    credentialKind: 'oauthToken',
    workspaceDir: path.join(f.roots.workspaceDir, sid),
    workspaceMountPoint: path.join(f.roots.mcpDir, sid, 'workspace'),
    mcpDir: path.join(f.roots.mcpDir, sid, 'mcp'),
    mounterSocketDir: path.join(f.roots.mcpDir, sid, '9p'),
    model: 'claude-sonnet-4-6',
    reasoningEffort: 'max',
    systemPrompt: 'You are Floot.',
  });
  t.deepEqual(references, {
    sandboxService: 'native-id',
    brokerService: 'broker-id',
    stateProvider: 'state-id',
    storage: 'storage-id',
  });
  t.deepEqual(
    f.log.map(entry => entry[0]),
    ['inspect', 'create', 'start'],
  );
  t.deepEqual(f.log[2][2], { dynamicTools: [], toolSetId: 'tools-v1' });
  for (const directory of [
    path.join(f.roots.workspaceDir, sid),
    path.join(f.roots.mcpDir, sid, 'mcp'),
    path.join(f.roots.mcpDir, sid, '9p'),
  ]) {
    // eslint-disable-next-line no-await-in-loop
    t.true(await f.exists(directory), directory);
  }
  t.false(
    await f.exists(path.join(f.roots.mcpDir, sid, 'workspace')),
    'the mount point is the mounter’s to create',
  );
  t.like(await E(run).status(), { ready: true });
});

test('an operator-supplied workspace is recorded and served but never owned', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const worktree = path.join(f.base, 'worktree-a');
  await mkdir(worktree, { recursive: true });
  await E(factory).create(
    harden({ sessionId: 'session-a', workspaceHostPath: worktree }),
    makeToolSet(),
  );
  const plan = JSON.parse(f.records.get('session-a')?.plan ?? '');
  t.is(plan.workspaceHostPath, worktree);
  t.false(Object.hasOwn(plan, 'workspaceDir'));
  t.false(
    await f.exists(
      path.join(f.roots.workspaceDir, makeSandboxSessionId('session-a')),
    ),
  );
  // It must exist as a real directory, disjoint from both roots, in its
  // canonical spelling.
  const create = workspaceHostPath =>
    E(factory).create(
      harden({ sessionId: 'session-b', workspaceHostPath }),
      makeToolSet(),
    );
  await t.throwsAsync(create(path.join(f.base, 'missing')), {
    message: /must be an existing directory/,
  });
  await t.throwsAsync(create(f.roots.workspaceDir), {
    message: /must be disjoint from the session storage roots/,
  });
  await symlink(f.base, path.join(f.base, 'alias'));
  await t.throwsAsync(create(path.join(f.base, 'alias', 'worktree-a')), {
    message: /must be a canonical path/,
  });
  t.is(f.log.filter(([kind]) => kind === 'create').length, 1);
});

test('a later create stops and revises a record in place and refuses a changed workspace, image, or layout', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a', systemPrompt: 'old persona' }),
    makeToolSet(),
  );
  await E(admin).terminate();
  const before = f.log.length;
  await E(factory).create(
    harden({ sessionId: 'session-a', systemPrompt: 'new persona' }),
    makeToolSet(),
  );
  t.deepEqual(
    f.log.slice(before).map(entry => entry[0]),
    ['inspect', 'stop', 'revise', 'start'],
  );
  t.is(
    JSON.parse(f.records.get('session-a')?.plan ?? '').systemPrompt,
    'new persona',
  );
  const worktree = path.join(f.base, 'other');
  await mkdir(worktree);
  const refused = f.log.length;
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', workspaceHostPath: worktree }),
      makeToolSet(),
    ),
    { message: /workspace cannot change; destroy the session first/ },
  );
  t.deepEqual(
    f.log.slice(refused).map(entry => entry[0]),
    ['stop', 'inspect'],
    'the factory stopped the live predecessor; the owner refused before any revision',
  );
  // A broker re-minted over a re-pinned image refuses too, as does one over
  // a credential of another kind, until a request authorizes rebinding that
  // binding; the network policy may change.
  const repinned = `sha256:${'b'.repeat(64)}`;
  f.environments.set(
    'broker-id',
    harden({
      CLAUDE_BROKER_CONFIG: brokerConfig({
        imageRef: `localhost/claude@${repinned}`,
        imageDigest: repinned,
      }),
    }),
  );
  const other = await make(f.host, undefined, { env: f.env });
  await t.throwsAsync(
    E(other).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    {
      message:
        /image cannot change without a reopen that authorizes rebinding it/,
    },
  );
  f.environments.set(
    'broker-id',
    harden({
      CLAUDE_BROKER_CONFIG: brokerConfig({ credentialKind: 'apiKey' }),
    }),
  );
  const rekeyed = await make(f.host, undefined, { env: f.env });
  await t.throwsAsync(
    E(rekeyed).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    {
      message:
        /credential kind cannot change without a reopen that authorizes rebinding it/,
    },
  );
  // Authorized, the record rebinds to the re-pinned image after a stop and
  // keeps its identity and workspace; the broker it was created under is
  // then the one refused, until the record is rebound back.
  const rebound = f.log.length;
  const onRepinned = await E(other).create(
    harden({ sessionId: 'session-a', rebind: ['image'] }),
    makeToolSet(),
  );
  t.deepEqual(
    f.log
      .slice(rebound)
      .map(entry => entry[0])
      .slice(-4),
    ['inspect', 'stop', 'revise', 'start'],
    'the owner stops the record before revising it',
  );
  await E(onRepinned.admin).terminate();
  t.is(
    JSON.parse(f.records.get('session-a')?.plan ?? '').rootfs,
    `oci:localhost/claude@${repinned}`,
  );
  await t.throwsAsync(
    E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    {
      message:
        /image cannot change without a reopen that authorizes rebinding it/,
    },
  );
  const back = await E(factory).create(
    harden({ sessionId: 'session-a', rebind: ['image'] }),
    makeToolSet(),
  );
  await E(back.admin).terminate();
  t.is(
    JSON.parse(f.records.get('session-a')?.plan ?? '').rootfs,
    `oci:localhost/claude@${digest}`,
  );
  f.environments.set(
    'broker-id',
    harden({ CLAUDE_BROKER_CONFIG: brokerConfig() }),
  );
  const revised = f.log.length;
  await E(factory).create(
    harden({ sessionId: 'session-a', networkPolicy: 'public-internet' }),
    makeToolSet(),
  );
  t.deepEqual(
    f.log.slice(revised).map(entry => entry[0]),
    ['inspect', 'stop', 'revise', 'start'],
  );
  t.is(
    JSON.parse(f.records.get('session-a')?.plan ?? '').networkPolicy,
    'public-internet',
  );
});

test('terminate and destroy reach the owner, which removes the record', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(admin).terminate();
  t.is(f.records.get('session-a')?.phase, 'stopped');
  await E(factory).destroy(harden({ sessionId: 'session-a' }));
  t.false(f.records.has('session-a'));
  t.deepEqual(
    f.log.map(entry => entry[0]),
    ['inspect', 'create', 'start', 'stop', 'remove'],
    'a terminated session is not stopped again before removal',
  );
});

test('a refused record leaves no session directories behind; a record heals its directories on the next start', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  f.knobs.createError = Error('owner refused the record');
  await t.throwsAsync(
    E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /owner refused the record/ },
  );
  const sid = makeSandboxSessionId('session-a');
  t.false(await f.exists(path.join(f.roots.mcpDir, sid)));
  t.false(await f.exists(path.join(f.roots.workspaceDir, sid)));
  f.knobs.createError = undefined;
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(admin).terminate();
  await rm(path.join(f.roots.mcpDir, sid, '9p'), { recursive: true });
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  t.true(await f.exists(path.join(f.roots.mcpDir, sid, '9p')));
  t.is(f.log.filter(([kind]) => kind === 'create').length, 2);
});

test('recorded mounter settings reach every plan', async t => {
  const f = await fixture(t);
  const mounterEnv = {
    NINEP_SUDO: '1',
    NINEP_UMOUNT_PROGRAM: 'sudo -n umount',
  };
  const factory = await make(f.host, undefined, {
    env: harden({ ...f.env, CLAUDE_MOUNTER_ENV: JSON.stringify(mounterEnv) }),
  });
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  const [, , planText] = f.log.find(([kind]) => kind === 'create') ?? [];
  t.deepEqual(JSON.parse(planText).mounterEnv, mounterEnv);
});

test('a recorded pin is kept when the provider cannot be read; a new pin is refused then, and admitted against the catalog otherwise', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const first = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'claude-sonnet-4-6',
      reasoningEffort: 'high',
    }),
    makeToolSet(),
  );
  await E(first.admin).terminate();
  const plan = () => JSON.parse(f.records.get('session-a')?.plan ?? '');
  t.like(plan(), { model: 'claude-sonnet-4-6', reasoningEffort: 'high' });
  f.knobs.catalogDown = true;
  // Floot's reopen names the persisted pin, or its empty spelling; either
  // keeps the record, without asking the provider.
  for (const spec of [
    { model: 'claude-sonnet-4-6', reasoningEffort: 'high' },
    { model: '', reasoningEffort: '' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const again = await E(factory).create(
      harden({ sessionId: 'session-a', ...spec }),
      makeToolSet(),
    );
    // eslint-disable-next-line no-await-in-loop
    await E(again.admin).terminate();
    t.like(plan(), { model: 'claude-sonnet-4-6', reasoningEffort: 'high' });
  }
  // A changed pin, or a new session, is a new pin: refused while the
  // catalog cannot be read, and no other model is put in its place.
  for (const spec of [
    { sessionId: 'session-a', model: 'claude-opus-5' },
    { sessionId: 'session-b', model: 'claude-sonnet-4-6' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(factory).create(harden(spec), makeToolSet()), {
      message: /"Claude" model catalog is unavailable/,
    });
  }
  t.like(plan(), { model: 'claude-sonnet-4-6', reasoningEffort: 'high' });
  t.false(f.records.has('session-b'));
  f.knobs.catalogDown = false;
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-b', model: 'claude-zzz' }),
      makeToolSet(),
    ),
    { message: /Unknown "Claude" model "claude-zzz"/ },
  );
  // The runtime drives Haiku at no effort: an effort with it is refused
  // against the catalog's projection, not by a table in the factory.
  await t.throwsAsync(
    E(factory).create(
      harden({
        sessionId: 'session-b',
        model: 'claude-haiku-4-5-20251001',
        reasoningEffort: 'high',
      }),
      makeToolSet(),
    ),
    { message: /Unsupported "Claude" reasoning effort/ },
  );
  t.false(f.records.has('session-b'));
  const named = await E(factory).create(
    harden({ sessionId: 'session-b', model: 'claude-opus-5' }),
    makeToolSet(),
  );
  await E(named.admin).terminate();
  // An unnamed effort is the model's default from the runtime's table.
  const planB = () => JSON.parse(f.records.get('session-b')?.plan ?? '');
  t.like(planB(), { model: 'claude-opus-5', reasoningEffort: 'max' });
  // An effort changed on its own keeps the recorded model: it is admitted
  // against that model's efforts, and no other model is put in its place.
  const lowered = await E(factory).create(
    harden({ sessionId: 'session-b', reasoningEffort: 'low' }),
    makeToolSet(),
  );
  await E(lowered.admin).terminate();
  t.like(planB(), { model: 'claude-opus-5', reasoningEffort: 'low' });
  // Sonnet 4.6 takes every effort but `xhigh`, by the runtime's table.
  await t.throwsAsync(
    E(factory).create(
      harden({
        sessionId: 'session-c',
        model: 'claude-sonnet-4-6',
        reasoningEffort: 'xhigh',
      }),
      makeToolSet(),
    ),
    { message: /Unsupported "Claude" reasoning effort "xhigh"/ },
  );
  t.false(f.records.has('session-c'));
});

test('a session that names no model runs the runtime’s own default, unpinned; nobody picks one from the list', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  // The catalog is not consulted for it, so it starts through an outage.
  f.knobs.catalogDown = true;
  const plain = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(plain.admin).terminate();
  const plan = () => JSON.parse(f.records.get('session-a')?.plan ?? '');
  t.false('model' in plan());
  t.false('reasoningEffort' in plan());
  // An effort without a model is the runtime's own axis, checked as such.
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', reasoningEffort: 'ultra' }),
      makeToolSet(),
    ),
    { message: /Unsupported Claude reasoning effort "ultra"/ },
  );
  const effortful = await E(factory).create(
    harden({ sessionId: 'session-a', reasoningEffort: 'high' }),
    makeToolSet(),
  );
  await E(effortful.admin).terminate();
  t.false('model' in plan());
  t.is(plan().reasoningEffort, 'high');
  // Naming a model later is a new pin, admitted by the catalog.
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', model: 'claude-opus-5' }),
      makeToolSet(),
    ),
    { message: /"Claude" model catalog is unavailable/ },
  );
  f.knobs.catalogDown = false;
  const pinned = await E(factory).create(
    harden({ sessionId: 'session-a', model: 'claude-opus-5' }),
    makeToolSet(),
  );
  await E(pinned.admin).terminate();
  t.like(plan(), { model: 'claude-opus-5', reasoningEffort: 'max' });
});
