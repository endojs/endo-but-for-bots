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
  brokerServiceSpecifier,
  nativeSandboxSpecifier,
  sessionStorageSpecifier,
  stateProviderSpecifier,
} from '../src/hosted-runtime-setup.js';
import {
  SESSION_RECORDS_PATH,
  controllerSpecifier,
  make,
  resolveBackendConfig,
} from '../src/opencode-backend-module.js';
import { makeSandboxSessionId } from '../src/opencode-session-plan.js';

/** @import { EndoHost } from '@endo/daemon' */

const key = (...parts) => JSON.stringify(parts.flat());
const digest = `sha256:${'a'.repeat(64)}`;

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
    await mkdtemp(path.join(os.tmpdir(), 'endo-backend-')),
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
  const seed = (name, id, specifier, env) => {
    bindings.set(key('opencode-sandbox', name), id);
    formulas.set(
      id,
      harden({
        type: 'make-unconfined',
        properties: { specifier: { kind: 'literal', value: specifier } },
      }),
    );
    environments.set(id, harden(env));
  };
  seed('native-sandbox', 'native-id', nativeSandboxSpecifier, {
    ENDO_SANDBOX_RUNTIME_DIR: path.join(base, 'runtime', 'native'),
    ENDO_SANDBOX_OWNER_ID: 'owner-native',
    ENDO_SANDBOX_GENERATED_MAX_BYTES: '4096',
    ENDO_SANDBOX_GENERATED_MAX_ENTRIES: '16',
  });
  seed('broker-service', 'broker-id', brokerServiceSpecifier, {
    OPENCODE_BROKER_CONFIG: JSON.stringify({
      ownerId: 'broker-owner',
      directory: path.join(base, 'broker'),
      imageRef: `localhost/opencode@${digest}`,
      imageDigest: digest,
      listenerImageRef: `localhost/listener@${digest}`,
      models: ['deepseek/deepseek-v4.1-flash'],
    }),
  });
  seed('state-provider', 'state-id', stateProviderSpecifier, {
    ENDO_OPENCODE_STATE_DIR: path.join(base, 'state'),
  });
  seed('session-storage', 'storage-id', sessionStorageSpecifier, {
    OPENCODE_WORKSPACE_BASE_DIR: roots.workspaceDir,
    OPENCODE_MCP_DIR: roots.mcpDir,
  });
  /** @type {any[]} */
  const mints = [];
  /** @type {string[][]} */
  const removed = [];
  /** @type {any[]} */
  const ownerRequests = [];
  let counter = 0;
  const host = /** @type {EndoHost} */ (
    /** @type {unknown} */ (
      harden({
        async identify(...parts) {
          return bindings.get(key(...parts));
        },
        async has(...parts) {
          return bindings.has(key(...parts));
        },
        async remove(...parts) {
          removed.push(parts);
          bindings.delete(key(...parts));
        },
        async diagnostics() {
          return harden({ getFormula: async id => formulas.get(id) });
        },
        async getFormulaEnvironment(id) {
          return environments.get(id);
        },
        async makeUnconfined(worker, specifier, options) {
          counter += 1;
          mints.push({ worker, specifier, options });
          bindings.set(key(options.resultName), `formula-${counter}`);
        },
        async provideSessionOwner(recordsPath, specifier) {
          ownerRequests.push({ recordsPath, specifier });
          return owner;
        },
      })
    )
  );
  const env = harden({
    OPENCODE_WORKSPACE_BASE_DIR: roots.workspaceDir,
    OPENCODE_MCP_DIR: roots.mcpDir,
    OPENCODE_NATIVE_PROFILE: JSON.stringify(profile),
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
    mints,
    removed,
    ownerRequests,
    bindings,
    environments,
    exists,
  };
};

test('resolveBackendConfig defaults nothing', t => {
  const env = {
    OPENCODE_WORKSPACE_BASE_DIR: '/srv/ws',
    OPENCODE_MCP_DIR: '/srv/private',
    OPENCODE_NATIVE_PROFILE: JSON.stringify(profile),
  };
  t.deepEqual(resolveBackendConfig(env).nativeProfile, profile);
  t.false(Object.hasOwn(resolveBackendConfig(env), 'mounterEnv'));
  t.deepEqual(
    resolveBackendConfig({
      ...env,
      OPENCODE_MOUNTER_ENV: JSON.stringify({ NINEP_SUDO: '1' }),
    }).mounterEnv,
    { NINEP_SUDO: '1' },
  );
  /** @type {[string, string | undefined, RegExp][]} */
  const invalid = [
    [
      'OPENCODE_MOUNTER_ENV',
      JSON.stringify({ NINEP_MOUNT_PROGRAM: 'rm' }),
      /"NINEP_MOUNT_PROGRAM" must invoke "mount"/,
    ],
    [
      'OPENCODE_WORKSPACE_BASE_DIR',
      'relative',
      /OPENCODE_WORKSPACE_BASE_DIR must be a normalized absolute path/,
    ],
    [
      'OPENCODE_MCP_DIR',
      '/srv/private/',
      /OPENCODE_MCP_DIR must be a normalized absolute path/,
    ],
    [
      'OPENCODE_NATIVE_PROFILE',
      undefined,
      /OPENCODE_NATIVE_PROFILE is required/,
    ],
    [
      'OPENCODE_NATIVE_PROFILE',
      JSON.stringify({ ...profile, uid: 'root' }),
      /uid: .* Must be a number/,
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
  t.is((await E(factory).describe()).id, 'opencode');
  // Roots that differ from the recorded storage owner's are refused.
  await t.throwsAsync(
    make(f.host, undefined, {
      env: { ...f.env, OPENCODE_MCP_DIR: path.join(f.base, 'elsewhere') },
    }),
    { message: /must equal the recorded session storage owner's roots/ },
  );
  // A missing service is refused by its reader, before any owner is provided.
  f.bindings.delete(key('opencode-sandbox', 'broker-service'));
  await t.throwsAsync(make(f.host, undefined, { env: f.env }), {
    message: /Cannot identify OpenCode "broker-service"/,
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
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
      systemPrompt: 'You are Floot.',
      networkPolicy: 'public-internet',
    }),
    toolSet,
  );
  const sid = makeSandboxSessionId('session-a');
  const [, name, planText, references] =
    f.log.find(([kind]) => kind === 'create') ?? [];
  t.is(name, 'session-a');
  const plan = JSON.parse(planText);
  t.deepEqual(plan, {
    sessionId: 'session-a',
    sandboxSessionId: sid,
    rootfs: `oci:localhost/opencode@${digest}`,
    networkPolicy: 'public-internet',
    workspaceDir: path.join(f.roots.workspaceDir, sid),
    workspaceMountPoint: path.join(f.roots.mcpDir, sid, 'workspace'),
    mcpDir: path.join(f.roots.mcpDir, sid, 'mcp'),
    mounterSocketDir: path.join(f.roots.mcpDir, sid, '9p'),
    nativeProfile: profile,
    model: 'openrouter/deepseek/deepseek-v4.1-flash',
    systemPrompt: 'You are Floot.',
  });
  t.deepEqual(references, {
    sandboxService: 'native-id',
    brokerService: 'broker-id',
    stateProvider: 'state-id',
    storage: 'storage-id',
  });
  // No formula is minted for the workspace: the controller projects the
  // recorded directory itself, so this caplet never holds a disposable
  // capability the daemon could later collect out from under it.
  t.deepEqual(f.mints, []);
  for (const directory of [
    plan.workspaceDir,
    plan.mcpDir,
    plan.mounterSocketDir,
  ]) {
    // eslint-disable-next-line no-await-in-loop
    t.true(await f.exists(directory), directory);
  }
  t.false(
    await f.exists(plan.workspaceMountPoint),
    'the mounter creates the mount point',
  );
  t.deepEqual(f.log.at(-1)?.slice(0, 2), ['start', 'session-a']);
  t.deepEqual(f.log.at(-1)?.[2], { dynamicTools: [], toolSetId: 'tools-v1' });
  t.deepEqual(await E(run).status(), { ready: true });
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
  const [, , planText] = f.log.find(([kind]) => kind === 'create') ?? [];
  const plan = JSON.parse(planText);
  t.is(plan.workspaceHostPath, worktree);
  t.false('workspaceDir' in plan);
  t.false(
    await f.exists(path.join(f.roots.workspaceDir, plan.sandboxSessionId)),
  );
});

test('a later create revises a stopped record in place and refuses a changed workspace', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const first = await E(factory).create(
    harden({
      sessionId: 'session-a',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
    }),
    makeToolSet(),
  );
  await E(first.admin).terminate();
  const before = f.log.length;
  await E(factory).create(
    harden({ sessionId: 'session-a', systemPrompt: 'new persona' }),
    makeToolSet(),
  );
  t.deepEqual(
    f.log.slice(before).map(entry => entry[0]),
    ['inspect', 'stop', 'revise', 'start'],
    'no second record',
  );
  t.is(
    JSON.parse(f.records.get('session-a')?.plan ?? '').systemPrompt,
    'new persona',
  );
  const refused = f.log.length;
  await t.throwsAsync(
    E(factory).create(
      harden({
        sessionId: 'session-a',
        workspaceHostPath: path.join(f.base, 'other'),
      }),
      makeToolSet(),
    ),
    { message: /workspace cannot change; destroy the session first/ },
  );
  // The factory stopped the live predecessor before the owner refused the
  // request; the record is intact and stopped.
  t.deepEqual(
    f.log.slice(refused).map(entry => entry[0]),
    ['stop', 'inspect'],
  );
  t.is(f.records.get('session-a')?.phase, 'stopped');
  // An unchanged plan is stopped and restarted without a revision: within one
  // daemon incarnation, a record left in an interrupted start, or live under
  // an earlier backend, is retried through its own cleanup rather than
  // refused until deletion. After a daemon restart this stop reaches the
  // revived controller, whose terminate refuses because its original local
  // 9P/MCP cleanup ownership is gone; the owner persists `stopping` first and
  // `start` refuses that phase, so a formerly live session stays stuck until
  // native recovery exists, as it already did at destroy.
  const again = f.log.length;
  await E(factory).create(
    harden({ sessionId: 'session-a', systemPrompt: 'new persona' }),
    makeToolSet(),
  );
  t.deepEqual(
    f.log.slice(again).map(entry => entry[0]),
    ['inspect', 'stop', 'start'],
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
  // A released terminate is not re-run by destroy: one stop, then removal.
  t.deepEqual(f.log.map(entry => entry[0]).slice(-3), [
    'start',
    'stop',
    'remove',
  ]);
});

test('a foreign workspace must exist as a real directory outside both roots', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const create = workspaceHostPath =>
    E(factory).create(
      harden({ sessionId: 'session-a', workspaceHostPath }),
      makeToolSet(),
    );
  await t.throwsAsync(create(path.join(f.base, 'missing')), {
    message: /must be an existing directory/,
  });
  const target = path.join(f.base, 'target');
  await mkdir(target);
  await symlink(target, path.join(f.base, 'link'));
  await t.throwsAsync(create(path.join(f.base, 'link')), {
    message: /must be an existing directory/,
  });
  await t.throwsAsync(create('/'), {
    message: /must be a normalized absolute path/,
  });
  await t.throwsAsync(create(`${f.base}/`), {
    message: /must be a normalized absolute path/,
  });
  await t.throwsAsync(create(f.roots.workspaceDir), {
    message: /must be disjoint from the session storage roots/,
  });
  await t.throwsAsync(create(path.join(f.roots.mcpDir, 'x')), {
    message: /must be disjoint from the session storage roots/,
  });
  t.false(
    f.log.some(([kind]) => kind === 'create'),
    'nothing was recorded',
  );
});

test('a broker re-pinned to a different image refuses an existing session rather than rebinding it', async t => {
  const f = await fixture(t);
  const first = await make(f.host, undefined, { env: f.env });
  const { admin } = await E(first).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(admin).terminate();
  const other = `sha256:${'b'.repeat(64)}`;
  f.environments.set(
    'broker-id',
    harden({
      OPENCODE_BROKER_CONFIG: JSON.stringify({
        ...JSON.parse(
          f.environments.get('broker-id')?.OPENCODE_BROKER_CONFIG ?? '{}',
        ),
        imageRef: `localhost/opencode@${other}`,
        imageDigest: other,
      }),
    }),
  );
  const second = await make(f.host, undefined, { env: f.env });
  const before = f.log.length;
  await t.throwsAsync(
    E(second).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /image cannot change; destroy the session first/ },
  );
  t.deepEqual(
    f.log.slice(before).map(entry => entry[0]),
    ['inspect'],
    'refused before any stop or revision',
  );
  t.is(
    JSON.parse(f.records.get('session-a')?.plan ?? '').rootfs,
    `oci:localhost/opencode@${digest}`,
    'the recorded plan is untouched',
  );
});

test('a refused record leaves no session directories behind', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  f.knobs.createError = Error('owner refused the record');
  await t.throwsAsync(
    E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /owner refused the record/ },
  );
  const privateDir = path.join(
    f.roots.mcpDir,
    makeSandboxSessionId('session-a'),
  );
  t.false(await f.exists(privateDir), 'no private directory');
  t.false(
    await f.exists(
      path.join(f.roots.workspaceDir, makeSandboxSessionId('session-a')),
    ),
    'no owned workspace',
  );
  t.is(f.records.get('session-a'), undefined);
});

test('a foreign workspace spelled through an alias of a storage root is refused as non-canonical', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  // `<base>/alias` -> `<base>`: the spelling clears the string check while
  // the directory is one session's owned workspace under the workspace root.
  await symlink(f.base, path.join(f.base, 'alias'));
  const victim = path.join(f.roots.workspaceDir, 'victim');
  await mkdir(victim, { recursive: true });
  const aliased = path.join(f.base, 'alias', 'workspaces', 'victim');
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', workspaceHostPath: aliased }),
      makeToolSet(),
    ),
    { message: /must be a canonical path; it resolves to/ },
  );
  t.false(
    f.log.some(([kind]) => kind === 'create'),
    'nothing was recorded',
  );
});

test('a backend re-rooted under a different private root refuses an existing session', async t => {
  const f = await fixture(t);
  const first = await make(f.host, undefined, { env: f.env });
  const { admin } = await E(first).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(admin).terminate();
  const otherMcpDir = path.join(f.base, 'private-2');
  f.environments.set(
    'storage-id',
    harden({
      OPENCODE_WORKSPACE_BASE_DIR: f.roots.workspaceDir,
      OPENCODE_MCP_DIR: otherMcpDir,
    }),
  );
  const second = await make(f.host, undefined, {
    env: harden({ ...f.env, OPENCODE_MCP_DIR: otherMcpDir }),
  });
  const before = f.log.length;
  await t.throwsAsync(
    E(second).create(harden({ sessionId: 'session-a' }), makeToolSet()),
    { message: /private directories cannot change; destroy the session first/ },
  );
  t.deepEqual(
    f.log.slice(before).map(entry => entry[0]),
    ['inspect'],
    'refused before any stop or revision',
  );
  t.false(await f.exists(otherMcpDir), 'nothing created under the new root');
});

test('a record whose directories are gone heals them on the next start', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a' }),
    makeToolSet(),
  );
  await E(admin).terminate();
  const [, , planText] = f.log.find(([kind]) => kind === 'create') ?? [];
  const plan = JSON.parse(planText);
  await rm(plan.mounterSocketDir, { recursive: true, force: true });
  await rm(plan.workspaceDir, { recursive: true, force: true });
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  t.true(await f.exists(plan.mounterSocketDir), 'socket directory recreated');
  t.true(await f.exists(plan.workspaceDir), 'owned workspace recreated');
  t.deepEqual(
    f.log.filter(([kind]) => kind === 'create').length,
    1,
    'the record itself was reused',
  );
});

test('a foreign workspace that vanished is refused on the next start rather than projected', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const worktree = path.join(f.base, 'worktree-b');
  await mkdir(worktree, { recursive: true });
  const { admin } = await E(factory).create(
    harden({ sessionId: 'session-a', workspaceHostPath: worktree }),
    makeToolSet(),
  );
  await E(admin).terminate();
  await rm(worktree, { recursive: true, force: true });
  const before = f.log.length;
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', workspaceHostPath: worktree }),
      makeToolSet(),
    ),
    { message: /must be an existing directory/ },
  );
  t.deepEqual(
    f.log.slice(before).map(entry => entry[0]),
    ['inspect'],
    'refused before any stop or revision',
  );
});

test('recorded mounter settings reach every plan', async t => {
  const f = await fixture(t);
  const mounterEnv = {
    NINEP_SUDO: '1',
    NINEP_UMOUNT_PROGRAM: 'sudo -n umount',
  };
  const factory = await make(f.host, undefined, {
    env: harden({ ...f.env, OPENCODE_MOUNTER_ENV: JSON.stringify(mounterEnv) }),
  });
  await E(factory).create(harden({ sessionId: 'session-a' }), makeToolSet());
  const [, , planText] = f.log.find(([kind]) => kind === 'create') ?? [];
  t.deepEqual(JSON.parse(planText).mounterEnv, mounterEnv);
});
