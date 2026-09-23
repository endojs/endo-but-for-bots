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
// The route every session here is pinned to: the runtime cannot run
// without one, and OpenRouter marks no default to pick.
const FREE = 'openrouter/openrouter/free';

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
      accountAuthority: 'openrouter-main',
      publicInternet: true,
    }),
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
        async lookup() {
          // The broker's catalog: what the OpenRouter account lists, in the
          // provider's own spelling; the backend adds opencode's prefix.
          return harden({
            modelCatalog: async () => {
              if (knobs.catalogDown) throw Error('provider catalog down');
              return harden({
                accounts: [
                  {
                    subscriptionId: 'default',
                    state: 'current',
                    observedAt: 1,
                    // One id opencode's config could not name, as a
                    // provider may list.
                    models: [
                      'deepseek/deepseek-v4.1-flash',
                      'openrouter/free',
                      'odd+vendor/model',
                    ].map(id => ({
                      id,
                      title: id,
                      description: '',
                      default: false,
                      defaultReasoningEffort: null,
                      reasoningEfforts: [],
                    })),
                  },
                ],
              });
            },
          });
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

test('OpenCode advertises only the network authority recorded by its broker', async t => {
  const f = await fixture(t);
  const config = JSON.parse(
    f.environments.get('broker-id').OPENCODE_BROKER_CONFIG,
  );
  delete config.publicInternet;
  f.environments.set(
    'broker-id',
    harden({ OPENCODE_BROKER_CONFIG: JSON.stringify(config) }),
  );
  const factory = await make(f.host, undefined, { env: f.env });
  t.deepEqual((await E(factory).describe()).supportedNetworkPolicies, ['off']);
});

test('resolveBackendConfig defaults nothing', t => {
  const env = {
    OPENCODE_WORKSPACE_BASE_DIR: '/srv/ws',
    OPENCODE_MCP_DIR: '/srv/private',
  };
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
    accountRef: 'openrouter-main',
    networkPolicy: 'public-internet',
    workspaceDir: path.join(f.roots.workspaceDir, sid),
    workspaceMountPoint: path.join(f.roots.mcpDir, sid, 'workspace'),
    mcpDir: path.join(f.roots.mcpDir, sid, 'mcp'),
    mounterSocketDir: path.join(f.roots.mcpDir, sid, '9p'),
    model: 'openrouter/deepseek/deepseek-v4.1-flash',
    systemPrompt: 'You are Floot.',
  });
  t.deepEqual(references, {
    sandboxService: 'native-id',
    brokerService: 'broker-id',
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
    harden({
      sessionId: 'session-a',
      model: FREE,
      workspaceHostPath: worktree,
    }),
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
        model: FREE,
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
    harden({ sessionId: 'session-a', model: FREE }),
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
      harden({ sessionId: 'session-a', model: FREE, workspaceHostPath }),
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

test('a broker re-pinned to a different image refuses an existing session until a request authorizes rebinding it', async t => {
  const f = await fixture(t);
  const first = await make(f.host, undefined, { env: f.env });
  const { admin } = await E(first).create(
    harden({ sessionId: 'session-a', model: FREE }),
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
  t.deepEqual((await E(second).describe()).rebindableBindings, [
    'image',
    'account',
    'provider',
  ]);
  const before = f.log.length;
  await t.throwsAsync(
    E(second).create(
      harden({ sessionId: 'session-a', model: FREE }),
      makeToolSet(),
    ),
    {
      message:
        /image cannot change without a reopen that authorizes rebinding it/,
    },
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
  // Authorized, the record rebinds to the re-pinned image after a stop and
  // keeps its identity, workspace and pin.
  const rebound = f.log.length;
  await E(second).create(
    harden({ sessionId: 'session-a', model: FREE, rebind: ['image'] }),
    makeToolSet(),
  );
  t.deepEqual(
    f.log.slice(rebound).map(entry => entry[0]),
    ['inspect', 'stop', 'revise', 'start'],
  );
  t.like(JSON.parse(f.records.get('session-a')?.plan ?? ''), {
    sessionId: 'session-a',
    rootfs: `oci:localhost/opencode@${other}`,
    model: FREE,
  });
});

test('a refused record leaves no session directories behind', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  f.knobs.createError = Error('owner refused the record');
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', model: FREE }),
      makeToolSet(),
    ),
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
      harden({
        sessionId: 'session-a',
        model: FREE,
        workspaceHostPath: aliased,
      }),
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
    harden({ sessionId: 'session-a', model: FREE }),
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
    E(second).create(
      harden({ sessionId: 'session-a', model: FREE }),
      makeToolSet(),
    ),
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
    harden({ sessionId: 'session-a', model: FREE }),
    makeToolSet(),
  );
  await E(admin).terminate();
  const [, , planText] = f.log.find(([kind]) => kind === 'create') ?? [];
  const plan = JSON.parse(planText);
  await rm(plan.mounterSocketDir, { recursive: true, force: true });
  await rm(plan.workspaceDir, { recursive: true, force: true });
  await E(factory).create(
    harden({ sessionId: 'session-a', model: FREE }),
    makeToolSet(),
  );
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
    harden({
      sessionId: 'session-a',
      model: FREE,
      workspaceHostPath: worktree,
    }),
    makeToolSet(),
  );
  await E(admin).terminate();
  await rm(worktree, { recursive: true, force: true });
  const before = f.log.length;
  await t.throwsAsync(
    E(factory).create(
      harden({
        sessionId: 'session-a',
        model: FREE,
        workspaceHostPath: worktree,
      }),
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
  await E(factory).create(
    harden({ sessionId: 'session-a', model: FREE }),
    makeToolSet(),
  );
  const [, , planText] = f.log.find(([kind]) => kind === 'create') ?? [];
  t.deepEqual(JSON.parse(planText).mounterEnv, mounterEnv);
});

test('a recorded pin is kept when the provider cannot be read; a new pin is refused then, and admitted against the catalog otherwise', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const first = await E(factory).create(
    harden({ sessionId: 'session-a', model: 'openrouter/openrouter/free' }),
    makeToolSet(),
  );
  await E(first.admin).terminate();
  const plan = () => JSON.parse(f.records.get('session-a')?.plan ?? '');
  t.is(plan().model, 'openrouter/openrouter/free');
  f.knobs.catalogDown = true;
  // Floot's reopen names the persisted pin, or its empty spelling; either
  // keeps the record, without asking the provider.
  for (const spec of [{ model: 'openrouter/openrouter/free' }, { model: '' }]) {
    // eslint-disable-next-line no-await-in-loop
    const again = await E(factory).create(
      harden({ sessionId: 'session-a', ...spec }),
      makeToolSet(),
    );
    // eslint-disable-next-line no-await-in-loop
    await E(again.admin).terminate();
    t.is(plan().model, 'openrouter/openrouter/free');
  }
  // A changed pin, or a new session, is a new pin: refused while the
  // catalog cannot be read, and no other model is put in its place.
  for (const spec of [
    {
      sessionId: 'session-a',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
    },
    { sessionId: 'session-b', model: 'openrouter/openrouter/free' },
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(factory).create(harden(spec), makeToolSet()), {
      message: /"OpenCode" model catalog is unavailable/,
    });
  }
  t.is(plan().model, 'openrouter/openrouter/free');
  t.false(f.records.has('session-b'));
  f.knobs.catalogDown = false;
  // The route is spelled opencode's way: the provider's own id is not
  // listed under this backend.
  for (const model of ['openrouter/free', 'openrouter/vendor/unknown']) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      E(factory).create(
        harden({ sessionId: 'session-b', model }),
        makeToolSet(),
      ),
      { message: /Unknown "OpenCode" model/ },
    );
  }
  t.false(f.records.has('session-b'));
  const named = await E(factory).create(
    harden({
      sessionId: 'session-b',
      model: 'openrouter/deepseek/deepseek-v4.1-flash',
    }),
    makeToolSet(),
  );
  await E(named.admin).terminate();
  t.is(
    JSON.parse(f.records.get('session-b')?.plan ?? '').model,
    'openrouter/deepseek/deepseek-v4.1-flash',
  );
});

test('a provider id opencode cannot name is left out of the catalog, not a reason to lose the rest', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const { accounts } = await E(factory).modelCatalog();
  t.deepEqual(
    accounts.map(account => account.models.map(model => model.id)),
    [['openrouter/deepseek/deepseek-v4.1-flash', 'openrouter/openrouter/free']],
  );
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', model: 'openrouter/odd+vendor/model' }),
      makeToolSet(),
    ),
    { message: /Unknown "OpenCode" model/ },
  );
  t.false(f.records.has('session-a'));
});

test('a record from before pins were required is a new pin: asked for, never run without a model', async t => {
  const f = await fixture(t);
  const factory = await make(f.host, undefined, { env: f.env });
  const first = await E(factory).create(
    harden({ sessionId: 'session-a', model: FREE }),
    makeToolSet(),
  );
  await E(first.admin).terminate();
  const record = f.records.get('session-a');
  if (!record) throw Error('no record');
  const { model: _recorded, ...unpinned } = JSON.parse(record.plan);
  record.plan = JSON.stringify(unpinned);
  // The runtime cannot run without a model, and OpenRouter marks no default:
  // a reopen naming none is refused, and nothing arbitrary is recorded.
  await t.throwsAsync(
    E(factory).create(
      harden({ sessionId: 'session-a', model: '' }),
      makeToolSet(),
    ),
    { message: /No "OpenCode" model named, and the account marks no default/ },
  );
  t.false('model' in JSON.parse(f.records.get('session-a')?.plan ?? ''));
  const pinned = await E(factory).create(
    harden({ sessionId: 'session-a', model: FREE }),
    makeToolSet(),
  );
  await E(pinned.admin).terminate();
  t.is(JSON.parse(f.records.get('session-a')?.plan ?? '').model, FREE);
});
