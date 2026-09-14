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
    models: ['claude-sonnet-4-6'],
    credentialKind: 'oauthToken',
    ...overrides,
  });
const profile = harden({
  uid: 1000,
  gid: 1000,
  memoryBytes: '536870912',
  cpuQuotaMicros: '200000',
  pids: 128,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 1,
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
  const knobs = { createError: undefined };
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
    CLAUDE_NATIVE_PROFILE: JSON.stringify(profile),
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

test('resolveBackendConfig defaults nothing', t => {
  const env = {
    CLAUDE_WORKSPACE_BASE_DIR: '/srv/ws',
    CLAUDE_MCP_DIR: '/srv/private',
    CLAUDE_NATIVE_PROFILE: JSON.stringify(profile),
  };
  const config = resolveBackendConfig(env);
  t.deepEqual(config.nativeProfile, profile);
  t.false(Object.hasOwn(config, 'mounterEnv'));
  // The image and the credential kind come from the recorded broker, never
  // from this environment.
  t.deepEqual(Object.keys(config).sort(), [
    'mcpBaseDir',
    'nativeProfile',
    'workspaceBaseDir',
  ]);
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
    ['CLAUDE_NATIVE_PROFILE', undefined, /CLAUDE_NATIVE_PROFILE is required/],
    [
      'CLAUDE_NATIVE_PROFILE',
      JSON.stringify({ ...profile, uid: 'root' }),
      /uid: .* Must be a number/,
    ],
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
    nativeProfile: profile,
    model: 'claude-sonnet-4-6',
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
  // a credential of another kind; the network policy may change.
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
    { message: /image cannot change; destroy the session first/ },
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
    { message: /credential kind cannot change; destroy the session first/ },
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
