// @ts-check
import '@endo/init';
import test from 'ava';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  assertGuestRootsDisjoint,
  bindFlootBackend,
  provideBackendCaplet,
  provideBrokerService,
  readHostedBackendEnvironment,
  readRetainedBroker,
  requireProvisioned,
  resolveMintedBrokerIdentity,
  resolveSessionStorageRoots,
} from '../src/hosted-backend-setup.js';
import { readMounterEnv } from '../src/session-plan.js';

const key = (...parts) => JSON.stringify(parts.flat());
const digest = `sha256:${'a'.repeat(64)}`;
const rootfs = `oci:localhost/x@${digest}`;
const listenerImageRef = `localhost/listener@sha256:${'c'.repeat(64)}`;
/**
 * A pinned image is never inspected.
 * @param {string} file
 * @param {string[]} args
 */
const refuseInspect = async (file, args) => {
  throw Error(`unexpected exec ${file} ${args.join(' ')}`);
};

/**
 * @param {{ hostId?: string, failMint?: (specifier: string) => boolean, failCopy?: (to: string[]) => boolean }} [options]
 */
const makeFakeHost = ({ hostId = 'fake-host-id', failMint, failCopy } = {}) => {
  const bindings = new Map();
  const formulas = new Map();
  /** @type {any[]} */
  const calls = [];
  const host = harden({
    async identify(...parts) {
      if (parts[0] === '@agent') return hostId;
      return bindings.get(key(...parts));
    },
    async has(...parts) {
      return bindings.has(key(...parts));
    },
    async copy(from, to) {
      calls.push(['copy', from, to]);
      if (failCopy && failCopy(to)) throw Error('copy failed');
      bindings.set(key(...to), bindings.get(key(...from)) ?? 'cap');
    },
    async remove(...parts) {
      calls.push(['remove', parts]);
      bindings.delete(key(...parts));
    },
    async makeUnconfined(worker, specifier, options) {
      calls.push(['mint', worker, specifier, options]);
      if (failMint && failMint(specifier)) throw Error('mint failed');
      bindings.set(key(options.resultName), `minted-${specifier}`);
      formulas.set(`minted-${specifier}`, { specifier, env: options.env });
    },
    diagnostics: () =>
      harden({
        getFormula: async identifier => ({
          type: 'make-unconfined',
          properties: {
            specifier: {
              kind: 'literal',
              value: formulas.get(identifier).specifier,
            },
          },
        }),
      }),
    getFormulaEnvironment: async identifier => formulas.get(identifier).env,
    async lookup(...parts) {
      calls.push(['lookup', parts.flat()]);
      return harden({
        configure: async settings => {
          calls.push(['configure', settings]);
        },
      });
    },
  });
  return { host, bindings, calls };
};

const spec = harden({
  label: 'Adapter',
  prefix: 'ENDO_X',
  defaultBackendName: 'x-backend',
  defaultRootfs: 'oci:localhost/x:latest',
  brokerDirName: 'x-broker',
});

test('the environment is read under the backend prefix', t => {
  const env = {
    ENDO_X_ACCOUNT_AUTHORITY: 'x-main',
    ENDO_X_BROKER_LISTENER_IMAGE: listenerImageRef,
    ENDO_X_BROKER_DIR: '/srv/x-broker',
    ENDO_X_MAX_SESSIONS: '4',
    ENDO_X_PUBLIC_INTERNET: '1',
    // The ENDO_ spelling wins over the mounter's own.
    ENDO_NINEP_SUDO: '1',
    NINEP_SUDO: 'no',
    FLOOT_DIR: 'my-floot',
  };
  const read = readHostedBackendEnvironment(env, spec);
  t.like(read, {
    accountAuthority: 'x-main',
    backendName: 'x-backend',
    rootfs: 'oci:localhost/x:latest',
    listenerImageRef,
    brokerDir: '/srv/x-broker',
    brokerOwnerId: '',
    brokerSettings: {
      maxSessions: 4,
      publicInternet: true,
      diagnostics: false,
    },
    flootDir: 'my-floot',
  });
  t.deepEqual(
    JSON.parse(/** @type {string} */ (read.mounterEnvText)),
    readMounterEnv({ NINEP_SUDO: '1' }),
  );
  const bare = readHostedBackendEnvironment(
    {
      ENDO_X_ACCOUNT_AUTHORITY: 'x-main',
      ENDO_X_BROKER_OWNER_ID: 'named',
      ENDO_FLOOT_DIR: 'floot-a',
      FLOOT_DIR: 'floot-b',
    },
    spec,
  );
  t.like(bare, {
    brokerDir: path.join(os.homedir(), 'x-broker'),
    brokerOwnerId: 'named',
    listenerImageRef: '',
    mounterEnvText: undefined,
    flootDir: 'floot-a',
    brokerSettings: { publicInternet: false, diagnostics: false },
  });
  t.false('maxSessions' in bare.brokerSettings);
  t.throws(() => readHostedBackendEnvironment({}, spec), {
    message: /ENDO_X_ACCOUNT_AUTHORITY is required/,
  });
  t.throws(
    () =>
      readHostedBackendEnvironment(
        { ENDO_X_ACCOUNT_AUTHORITY: 'x-main', ENDO_X_MAX_SESSIONS: '0' },
        spec,
      ),
    { message: /ENDO_X_MAX_SESSIONS must be an integer from 1 to 256/ },
  );
  // A renamed backend is honored (and warned about, on the console).
  t.is(
    readHostedBackendEnvironment(
      { ENDO_X_ACCOUNT_AUTHORITY: 'x-main', ENDO_X_BACKEND_NAME: 'renamed' },
      spec,
    ).backendName,
    'renamed',
  );
});

test('setup-host.js artifacts are required, in order', async t => {
  const { host, bindings } = makeFakeHost();
  const names = ['state-provider', 'native-sandbox'];
  await t.throwsAsync(requireProvisioned(host, 'x', names), {
    message: /"x\/state-provider" is missing — run setup-host.js first/,
  });
  bindings.set(key('x', 'state-provider'), 'id');
  await t.throwsAsync(requireProvisioned(host, 'x', names), {
    message: /"x\/native-sandbox" is missing — run setup-host.js first/,
  });
  bindings.set(key('x', 'native-sandbox'), 'id');
  await t.notThrowsAsync(requireProvisioned(host, 'x', names));
});

test('retained storage roots are the effective ones, and both must be normalized', async t => {
  await null;
  const { host, bindings } = makeFakeHost();
  let reads = 0;
  const readSessionStorage = async () => {
    reads += 1;
    return { roots: { workspaceDir: '/srv/kept-ws', mcpDir: '/srv/kept-mcp' } };
  };
  const options = {
    prefix: 'ENDO_X',
    sandboxDir: 'x',
    requestedRoots: { workspaceDir: '/srv/req-ws', mcpDir: '/srv/req-mcp' },
    readSessionStorage,
  };
  t.deepEqual(await resolveSessionStorageRoots(host, options), {
    existingStorage: false,
    workspaceDir: '/srv/req-ws',
    mcpDir: '/srv/req-mcp',
  });
  t.is(reads, 0);
  bindings.set(key('x', 'session-storage'), 'id');
  t.deepEqual(await resolveSessionStorageRoots(host, options), {
    existingStorage: true,
    workspaceDir: '/srv/kept-ws',
    mcpDir: '/srv/kept-mcp',
  });
  t.is(reads, 1);
  bindings.delete(key('x', 'session-storage'));
  await t.throwsAsync(
    resolveSessionStorageRoots(host, {
      ...options,
      requestedRoots: { workspaceDir: 'relative', mcpDir: '/srv/mcp' },
    }),
    {
      message:
        /ENDO_X_WORKSPACE_DIR \(or the retained storage owner's root\) must be a normalized absolute path: "relative"/,
    },
  );
  await t.throwsAsync(
    resolveSessionStorageRoots(host, {
      ...options,
      requestedRoots: { workspaceDir: '/srv/ws', mcpDir: '/srv/../mcp' },
    }),
    { message: /ENDO_X_MCP_DIR \(or the retained storage owner's root\)/ },
  );
});

test('a retained broker is read with its account checked; none is read when none exists', async t => {
  await null;
  const { host, bindings } = makeFakeHost();
  let reads = 0;
  const retainedConfig = harden({
    directory: '/srv/kept-broker',
    accountAuthority: 'x-main',
    imageDigest: digest,
    listenerImageRef,
  });
  const readBrokerService = async () => {
    reads += 1;
    return { config: retainedConfig };
  };
  const options = {
    sandboxDir: 'x',
    accountAuthority: 'x-main',
    readBrokerService,
  };
  t.is(await readRetainedBroker(host, options), undefined);
  t.is(reads, 0);
  bindings.set(key('x', 'broker-service'), 'broker-id');
  t.is(await readRetainedBroker(host, options), retainedConfig);
  t.is(reads, 1);
  await t.throwsAsync(
    readRetainedBroker(host, { ...options, accountAuthority: 'other' }),
    {
      message:
        /The retained "x\/broker-service" serves account authority "x-main" but the configuration now names "other"; retire it deliberately/,
    },
  );
});

test('a minted broker derives its owner from the host, or keeps the operator’s label', async t => {
  await null;
  const { host } = makeFakeHost();
  const base = {
    label: 'Adapter',
    prefix: 'ENDO_X',
    ownerPrefix: 'adapter',
    brokerDir: '/srv/x-broker',
    brokerOwnerId: '',
    rootfs,
    listenerImageRef,
  };
  t.is(
    await resolveMintedBrokerIdentity(host, base),
    `adapter-${createHash('sha256').update('fake-host-id').digest('hex').slice(0, 48)}`,
  );
  t.is(
    await resolveMintedBrokerIdentity(host, {
      ...base,
      brokerOwnerId: 'named',
    }),
    'named',
  );
  // An unpinned image is only spelled-checked here; Podman is asked at the mint.
  t.is(
    await resolveMintedBrokerIdentity(host, {
      ...base,
      brokerOwnerId: 'named',
      rootfs: 'oci:localhost/x:latest',
    }),
    'named',
  );
  for (const [overrides, message] of [
    [{ brokerOwnerId: 'Bad Owner' }, /ENDO_X_BROKER_OWNER_ID must match/],
    [{ listenerImageRef: '' }, /ENDO_X_BROKER_LISTENER_IMAGE is required/],
    [
      { listenerImageRef: 'localhost/listener:latest' },
      /ENDO_X_BROKER_LISTENER_IMAGE must be a lowercase, digest-pinned image reference/,
    ],
    [
      { brokerDir: 'relative' },
      /ENDO_X_BROKER_DIR must be a normalized absolute path/,
    ],
    [{ rootfs: 'oci:-rm' }, /Invalid Adapter sandbox image/],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      resolveMintedBrokerIdentity(host, { ...base, ...overrides }),
      { message },
      JSON.stringify(overrides),
    );
  }
  const { host: anonymous } = makeFakeHost({ hostId: '' });
  await t.throwsAsync(resolveMintedBrokerIdentity(anonymous, base), {
    message: /Cannot identify the Adapter broker host/,
  });
});

/** @param {import('ava').ExecutionContext} t */
const tmp = async t => {
  const base = await realpath(
    await mkdtemp(path.join(os.tmpdir(), 'hosted-backend-setup-')),
  );
  t.teardown(() => rm(base, { recursive: true, force: true }));
  return base;
};

test('guest roots must be disjoint from every protected root', async t => {
  const base = await tmp(t);
  const ok = {
    label: 'Adapter',
    prefix: 'ENDO_X',
    workspaceDir: path.join(base, 'ws'),
    mcpDir: path.join(base, 'mcp'),
    effectiveBrokerDir: path.join(base, 'broker'),
    protectedRoots: [path.join(base, 'broker'), path.join(base, 'runtime')],
    protectedDescription: 'the broker directory and the runtime directory',
  };
  await t.notThrowsAsync(assertGuestRootsDisjoint(ok));
  await t.throwsAsync(
    assertGuestRootsDisjoint({ ...ok, mcpDir: path.join(base, 'ws', 'mcp') }),
    {
      message:
        'Adapter guest roots overlap protected storage: the workspace and MCP roots must be disjoint from each other, the broker directory and the runtime directory',
    },
  );
  await t.throwsAsync(
    assertGuestRootsDisjoint({
      ...ok,
      workspaceDir: path.join(base, 'runtime', 'ws'),
    }),
    { message: /overlap protected storage/ },
  );
  // The adapter's wording is printed verbatim, punctuation included.
  await t.throwsAsync(
    assertGuestRootsDisjoint({
      ...ok,
      workspaceDir: path.join(base, 'broker', 'ws'),
      protectedRoots: [
        path.join(base, 'state'),
        path.join(base, 'broker'),
        path.join(base, 'runtime'),
      ],
      protectedDescription:
        'the state directory, the broker directory and the runtime directory',
    }),
    {
      message:
        'Adapter guest roots overlap protected storage: the workspace and MCP roots must be disjoint from each other, the state directory, the broker directory and the runtime directory',
    },
  );
  await t.throwsAsync(
    assertGuestRootsDisjoint({ ...ok, effectiveBrokerDir: 'relative' }),
    {
      message:
        /ENDO_X_BROKER_DIR \(or the retained broker's directory\) must be a normalized absolute path: "relative"/,
    },
  );
});

test('a broker is minted over its credential with the identity in order, or retained; settings apply either way', async t => {
  const base = await tmp(t);
  const brokerDir = path.join(base, 'broker');
  const { host, calls, bindings } = makeFakeHost();
  bindings.set(key('secrets', 'x-creds'), 'secret-id');
  /** @type {any[]} */
  const seen = [];
  const options = {
    label: 'Adapter',
    prefix: 'ENDO_X',
    sandboxDir: 'x',
    existingBroker: false,
    rootfs,
    exec: refuseInspect,
    brokerDir,
    brokerOwnerId: 'owner',
    listenerImageRef,
    identity: {
      credentialKind: 'apiKey',
      accountAuthority: 'x-main',
      extra: 1,
    },
    brokerSettings: {
      maxSessions: 3,
      publicInternet: false,
      diagnostics: true,
    },
    configEnvName: 'X_BROKER_CONFIG',
    readBrokerConfig: env => {
      calls.push(['read-config']);
      seen.push(env);
    },
    specifier: 'file:///broker.js',
    powersPath: ['secrets', 'x-creds'],
    temporary: 'x-creds.broker-read',
    workloadEnv: {
      ENDO_PUBLIC_EGRESS_MAX_CONNECTIONS: '2048',
      ENDO_PROVIDER_REQUEST_TIMEOUT_MS: '7200000',
    },
  };
  await provideBrokerService(host, options);
  const config = JSON.parse(seen[0].X_BROKER_CONFIG);
  t.deepEqual(Object.keys(config), [
    'ownerId',
    'directory',
    'imageRef',
    'imageDigest',
    'listenerImageRef',
    'credentialKind',
    'accountAuthority',
    'extra',
    'maxSessions',
    'publicInternet',
    'diagnostics',
  ]);
  t.like(config, {
    ownerId: 'owner',
    directory: brokerDir,
    imageRef: `localhost/x@${digest}`,
    imageDigest: digest,
    listenerImageRef,
  });
  // The profile is checked before the mint that would persist it.
  t.deepEqual(
    calls.map(call => call[0]),
    ['read-config', 'copy', 'mint', 'remove', 'lookup', 'configure'],
  );
  const mint = calls[2];
  t.is(mint[2], 'file:///broker.js');
  t.like(mint[3], {
    powersName: 'x-creds.broker-read',
    resultName: ['x', 'broker-service'],
    env: { X_BROKER_CONFIG: seen[0].X_BROKER_CONFIG, ...options.workloadEnv },
  });
  t.deepEqual(calls[4][1], ['x', 'broker-service']);
  t.deepEqual(calls[5][1], options.brokerSettings);
  t.is((await stat(brokerDir)).mode % 0o1000, 0o700);

  calls.length = 0;
  seen.length = 0;
  await provideBrokerService(host, { ...options, existingBroker: true });
  t.deepEqual(
    calls.map(call => call[0]),
    ['lookup', 'configure'],
  );
  t.is(seen.length, 0);
  calls.length = 0;
  await t.throwsAsync(
    provideBrokerService(host, {
      ...options,
      existingBroker: true,
      workloadEnv: {},
    }),
    { message: /workload configuration changed/ },
  );
  t.is(calls.length, 0);
  await t.throwsAsync(
    provideBrokerService(host, {
      ...options,
      existingBroker: true,
      workloadEnv: {
        ...options.workloadEnv,
        ENDO_PROVIDER_REQUEST_TIMEOUT_MS: 'NaN',
      },
    }),
    { message: /Invalid workload limit/ },
  );
  t.is(calls.length, 0);
});

test('the backend caplet is minted beside the live one and swapped in; a failed mint leaves the live one', async t => {
  await null;
  const { host, calls, bindings } = makeFakeHost({
    failMint: specifier => specifier === 'file:///broken.js',
  });
  bindings.set(key('x', 'backend'), 'live');
  bindings.set(key('x', 'backend-next'), 'stale');
  const options = {
    label: 'Adapter',
    sandboxDir: 'x',
    specifier: 'file:///backend.js',
    envPrefix: 'X',
    workspaceDir: '/srv/ws',
    mcpDir: '/srv/mcp',
    mounterEnvText: '{"NINEP_SUDO":"1"}',
  };
  t.deepEqual(await provideBackendCaplet(host, options), ['x', 'backend']);
  // A stale replacement from an interrupted run goes first.
  t.deepEqual(
    calls.map(call => call[0]),
    ['remove', 'mint', 'copy', 'remove'],
  );
  t.deepEqual(calls[0][1], ['x', 'backend-next']);
  t.deepEqual(calls[1][3], {
    powersName: '@agent',
    resultName: ['x', 'backend-next'],
    env: {
      X_WORKSPACE_BASE_DIR: '/srv/ws',
      X_MCP_DIR: '/srv/mcp',
      X_MOUNTER_ENV: '{"NINEP_SUDO":"1"}',
    },
  });
  t.deepEqual(calls[2][2], ['x', 'backend']);
  t.is(bindings.get(key('x', 'backend')), 'minted-file:///backend.js');
  t.false(bindings.has(key('x', 'backend-next')));

  calls.length = 0;
  await provideBackendCaplet(host, { ...options, mounterEnvText: undefined });
  t.deepEqual(
    calls.map(call => call[0]),
    ['mint', 'copy', 'remove'],
  );
  t.deepEqual(Object.keys(calls[0][3].env), [
    'X_WORKSPACE_BASE_DIR',
    'X_MCP_DIR',
  ]);

  bindings.set(key('x', 'backend'), 'live');
  calls.length = 0;
  await t.throwsAsync(
    provideBackendCaplet(host, { ...options, specifier: 'file:///broken.js' }),
    { message: 'mint failed' },
  );
  t.is(bindings.get(key('x', 'backend')), 'live');
  t.deepEqual(
    calls.map(call => call[0]),
    ['mint'],
  );
});

test('a failed backend copy preserves the live binding and a later setup retries', async t => {
  await null;
  let refuseCopy = true;
  const { host, calls, bindings } = makeFakeHost({
    failCopy: to => refuseCopy && key(...to) === key('x', 'backend'),
  });
  bindings.set(key('x', 'backend'), 'live');
  const options = {
    label: 'Adapter',
    sandboxDir: 'x',
    specifier: 'file:///backend.js',
    envPrefix: 'X',
    workspaceDir: '/srv/ws',
    mcpDir: '/srv/mcp',
    mounterEnvText: undefined,
  };
  await t.throwsAsync(provideBackendCaplet(host, options), {
    message: 'copy failed',
  });
  t.is(bindings.get(key('x', 'backend')), 'live');
  t.is(bindings.get(key('x', 'backend-next')), 'minted-file:///backend.js');
  t.deepEqual(
    calls.map(call => call[0]),
    ['mint', 'copy'],
  );

  refuseCopy = false;
  calls.length = 0;
  await provideBackendCaplet(host, options);
  t.is(bindings.get(key('x', 'backend')), 'minted-file:///backend.js');
  t.false(bindings.has(key('x', 'backend-next')));
  t.deepEqual(
    calls.map(call => call[0]),
    ['remove', 'mint', 'copy', 'remove'],
  );
});

test("Floot's profile is bound in place, with the asset server when the adapter names one", async t => {
  await null;
  const { host, calls, bindings } = makeFakeHost();
  const options = {
    flootDir: 'floot',
    backendName: 'x-backend',
    backendPath: ['x', 'backend'],
  };
  t.false(await bindFlootBackend(host, options));
  t.deepEqual(calls, []);
  bindings.set(key('floot', 'controller-profile'), 'dir');
  bindings.set(key('x', 'backend'), 'cap');
  t.true(
    await bindFlootBackend(host, {
      ...options,
      assetServerName: 'asset-server',
    }),
  );
  t.deepEqual(calls, [
    ['copy', ['x', 'backend'], ['floot', 'controller-profile', 'x-backend']],
  ]);
  bindings.set(key('asset-server'), 'cap');
  calls.length = 0;
  t.true(
    await bindFlootBackend(host, {
      ...options,
      assetServerName: 'asset-server',
    }),
  );
  t.deepEqual(calls, [
    ['copy', ['x', 'backend'], ['floot', 'controller-profile', 'x-backend']],
    ['copy', ['asset-server'], ['floot', 'controller-profile', 'asset-server']],
  ]);
  calls.length = 0;
  t.true(await bindFlootBackend(host, options));
  t.is(calls.length, 1, 'no asset server unless the adapter names one');
});
