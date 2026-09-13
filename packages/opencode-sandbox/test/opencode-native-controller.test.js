// @ts-check

import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { assertCopyData } from '@endo/daemon/copy-data.js';

import {
  make,
  makeOpencodeNativeController,
} from '../src/opencode-native-controller.js';
import { makeOpencodeClient } from '../src/opencode-client.js';

const gate = () => {
  /** @type {(() => void) | undefined} */
  let resolve;
  const promise = new Promise(r => {
    resolve = () => r(undefined);
  });
  if (resolve === undefined) throw Error('Promise executor did not run');
  return { promise, resolve };
};
// As recorded: JSON has no bigint, so the OCI quantities are digit strings.
const nativeProfile = harden({
  uid: 1000,
  gid: 1000,
  memoryBytes: '536870912',
  cpuQuotaMicros: '200000',
  pids: 128,
  cpuPeriodMicros: 100_000,
  maxConcurrentOperations: 1,
});

const planFor = id =>
  harden({
    sessionId: id,
    sandboxSessionId: `sandbox-${id}`,
    rootfs: `oci:example@sha256:${'a'.repeat(64)}`,
    networkPolicy: 'off',
    workspaceDir: `/workspaces/${id}`,
    workspaceMountPoint: `/private/${id}/work-mount`,
    mcpDir: `/private/${id}/mcp`,
    mounterSocketDir: `/private/${id}/9p`,
    nativeProfile,
    model: 'openrouter/anthropic/claude-sonnet-4',
    initialPrompt: 'must never run',
  });

const fixture = (t, { realClient = false } = {}) => {
  const events = [];
  const scopes = new Map();
  const grants = new Map();
  const clients = [];
  const faults = {
    sandboxClose: false,
    mcpClose: false,
    mcpStart: false,
    mountWait: false,
    grantWait: false,
    badEvidence: false,
    missingPublic: false,
    wrongImage: false,
    lateScope: '',
  };
  const mountEntered = gate();
  const mountReleased = gate();
  const grantEntered = gate();
  const grantReleased = gate();
  const sandboxClosed = gate();
  const scopeEntered = gate();
  const scopeReleased = gate();
  const foreign = Far('Filesystem', {});
  const tools = Far('JournaledTools', {});
  const sandboxService = Far('SandboxService', {
    async provideScope(id) {
      events.push(`provide sandbox ${id}`);
      if (scopes.has(id)) return scopes.get(id);
      let closed = false;
      const scope = Far('Scope', {
        async makeResolved(options) {
          if (closed) throw Error('scope closed');
          assertCopyData(options);
          events.push(['slice', id, options]);
          return Far('NativeSlice', {});
        },
        async close() {
          events.push(`close sandbox ${id}`);
          if (faults.sandboxClose) throw Error('sandbox close failed');
          closed = true;
          if (scopes.get(id) === scope) scopes.delete(id);
          sandboxClosed.resolve();
        },
      });
      scopes.set(id, scope);
      if (faults.lateScope === 'sandbox' && id === 'sandbox-a') {
        scopeEntered.resolve();
        await scopeReleased.promise;
      }
      return scope;
    },
    lookupScope(id) {
      events.push(`lookup sandbox ${id}`);
      return scopes.get(id);
    },
  });
  const brokerService = Far('BrokerService', {
    async provideScope(id, spec) {
      events.push(['grant', id, spec]);
      let closed = false;
      const scope = Far('Grant', {
        async start() {
          if (faults.grantWait) {
            grantEntered.resolve();
            await grantReleased.promise;
          }
          if (closed) throw Error('grant closed');
        },
        async attestation() {
          return harden({
            endpoint: 'http://127.0.0.1:9000',
            imageDigest: `sha256:${'a'.repeat(64)}`,
          });
        },
        async sandboxEvidence() {
          return harden({
            brokerSidecar: { container: id },
            imageDigest: `sha256:${(faults.wrongImage ? 'b' : 'a').repeat(64)}`,
            ...(spec.networkPolicy === 'public-internet' &&
            !faults.missingPublic
              ? {
                  network: {
                    policy: 'public-internet',
                    proxyUrl: 'http://127.0.0.1:9001',
                    dnsHost: '127.0.0.53',
                    resolverConfigPath: '/operator/public-resolv.conf',
                  },
                }
              : {}),
            ...(faults.badEvidence ? { unexpected: foreign } : {}),
          });
        },
        async revoke() {
          closed = true;
          grantReleased.resolve();
          events.push(`revoke ${id}`);
          if (grants.get(id) === scope) grants.delete(id);
        },
      });
      grants.set(id, scope);
      if (faults.lateScope === 'broker' && id === 'sandbox-a') {
        scopeEntered.resolve();
        await scopeReleased.promise;
      }
      return scope;
    },
    lookupScope(id) {
      events.push(`lookup grant ${id}`);
      return grants.get(id);
    },
  });
  const stateProvider = Far('State', {
    async prepareSessionDirectory(id) {
      events.push(`state ${id}`);
      return harden({ directory: `/state/${id}` });
    },
  });
  const roles = {
    sandboxService,
    brokerService,
    stateProvider,
    tools,
  };
  const resolver = Far('Resolver', {
    async get(role) {
      events.push(`resolve ${role}`);
      return roles[role];
    },
  });
  /** @param {any} [context] */
  const makeController = (context = undefined) => {
    const controller = makeOpencodeNativeController({
      context,
      reportError: error => events.push(['cleanup error', error]),
      env: { XDG_RUNTIME_DIR: '/wrong-global' },
      makePassword: () => 'fresh-password',
      makeFilesystem(rootPath) {
        events.push(['filesystem', rootPath]);
        return Far('Filesystem', {});
      },
      makeMounter(env) {
        let closed = false;
        events.push(['mounter', env]);
        return harden({
          mounter: Far('Mounter', {
            async mount(fs, destination, options) {
              events.push(['mount', fs, destination, options]);
              if (faults.mountWait) {
                mountEntered.resolve();
                await mountReleased.promise;
              }
              if (closed) throw Error('mounter closed');
              return Far('Mount', {});
            },
            list: () => [],
            help: () => 'Injected mounter',
          }),
          async close() {
            closed = true;
            events.push('close mounter');
            mountReleased.resolve();
          },
        });
      },
      async makeBridge(cap) {
        t.is(cap, tools);
        return harden({
          handleMessage: async () => undefined,
          toolNames: [],
          pendingCalls: () => 0,
        });
      },
      makeMcp(options) {
        events.push(['mcp', options.socketDir]);
        return harden({
          ...options,
          socketPath: `${options.socketDir}/mcp.sock`,
          socketName: 'mcp.sock',
          stdioBridgeName: 'mcp-stdio-bridge.mjs',
          configFileName: 'mcp.json',
          innerDir: '/endo-mcp',
          innerConfigPath: '/endo-mcp/mcp.json',
          async start() {
            events.push('start mcp');
            if (faults.mcpStart) throw Error('mcp startup failed');
          },
          async close() {
            events.push('close mcp');
            if (faults.mcpClose) throw Error('mcp close failed');
          },
        });
      },
      makeClient(options) {
        clients.push(options);
        if (realClient) return makeOpencodeClient(options);
        const cleanup = options.cleanupProvision;
        if (cleanup === undefined) throw Error('Missing cleanup owner');
        return Far('Client', {
          async send(prompt) {
            events.push(['send', prompt]);
            return Far('ReplyReader', {});
          },
          async interrupt() {
            events.push('interrupt');
          },
          async status() {
            return harden({
              sessionId: options.sessionId,
              createdAt: options.createdAt,
              workspaceMountPoint: options.workspaceMountPoint,
              statePath: '/opencode-state',
              backend: 'podman',
              rootfs: options.rootfsLabel || '',
              model: options.model || '',
              network: 'join',
              opencodeSessionId: '',
              terminated: false,
              stopped: false,
              bridgeRunning: false,
              bridgeExited: false,
              pendingPrompts: 0,
              turnActive: false,
            });
          },
          async terminate() {
            await cleanup();
          },
          async destroy() {
            throw Error('Controller must not delete durable state');
          },
          help: () => 'Injected client',
        });
      },
    });
    return controller;
  };
  t.teardown(async () => {
    faults.sandboxClose = false;
    faults.mcpClose = false;
    mountReleased.resolve();
    grantReleased.resolve();
    scopeReleased.resolve();
  });
  return {
    events,
    scopes,
    grants,
    clients,
    faults,
    resolver,
    makeController,
    mountEntered,
    grantEntered,
    sandboxService,
    sandboxClosed,
    scopeEntered,
    scopeReleased,
    tools,
  };
};

test('native controller construction is inert; activation uses copy paths and no initial turn', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  t.deepEqual(f.events, []);
  const plan = planFor('a');
  await E(controller).activate(JSON.stringify(plan), f.resolver);
  t.is(f.clients.length, 1);
  t.false(Object.hasOwn(f.clients[0], 'initialPrompt'));
  t.false(f.events.some(event => Array.isArray(event) && event[0] === 'send'));
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  t.deepEqual(
    options.mounts.map(mount => mount.hostPath),
    [plan.workspaceMountPoint, '/state/sandbox-a', plan.mcpDir],
  );
  t.is(options.env.OPENROUTER_API_KEY, 'opencode-broker-placeholder');
  t.is(
    JSON.parse(options.env.OPENCODE_CONFIG_CONTENT).mcp.endo.command[2],
    '/endo-mcp/mcp.sock',
  );
  const [, mounterEnv] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mounter',
  );
  t.is(mounterEnv.XDG_RUNTIME_DIR, plan.mounterSocketDir);
  // The workspace is projected from the recorded directory in this worker,
  // and its mount point is the mounter's to remove on unmount.
  t.deepEqual(
    f.events.find(event => Array.isArray(event) && event[0] === 'filesystem'),
    ['filesystem', plan.workspaceDir],
  );
  t.false(f.events.includes('resolve filesystem'));
  const [, , mountPoint, mountOptions] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mount',
  );
  t.is(mountPoint, plan.workspaceMountPoint);
  t.deepEqual(mountOptions, { removeMountPointOnUnmount: true });
  await E(controller).send('recorded foreground turn');
  await E(controller).interrupt();
  t.is((await E(controller).status()).sessionId, 'a');
  await E(controller).terminate(JSON.stringify(plan), f.resolver);
  t.true((await E(controller).status()).stopped);
});

test('recorded mounter settings reach the session mounter beneath its own socket directory', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const plan = harden({
    ...planFor('a'),
    mounterEnv: { NINEP_SUDO: '1', NINEP_MOUNT_PROGRAM: 'sudo -n mount' },
  });
  await E(controller).activate(JSON.stringify(plan), f.resolver);
  const [, mounterEnv] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mounter',
  );
  t.deepEqual(mounterEnv, {
    NINEP_SUDO: '1',
    NINEP_MOUNT_PROGRAM: 'sudo -n mount',
    XDG_RUNTIME_DIR: plan.mounterSocketDir,
    NINEP_SOCKET_DIR: plan.mounterSocketDir,
  });
});

test('scope cleanup failure retains mounts and permits sibling progress before retry', async t => {
  const f = fixture(t);
  const a = f.makeController();
  const b = f.makeController();
  await E(a).activate(JSON.stringify(planFor('a')), f.resolver);
  await E(b).activate(JSON.stringify(planFor('b')), f.resolver);
  f.faults.sandboxClose = true;
  await t.throwsAsync(
    E(a).terminate(JSON.stringify(planFor('a')), f.resolver),
    { message: /cleanup pending/ },
  );
  t.false(f.events.includes('close mounter'));
  t.true(f.grants.has('sandbox-b'));
  await E(b).send('sibling still works');
  f.faults.sandboxClose = false;
  await E(a).terminate(JSON.stringify(planFor('a')), f.resolver);
  t.true(f.scopes.has('sandbox-b'));
  await t.throwsAsync(E(a).send('stale'), { message: /stopping/ });
  await E(b).terminate(JSON.stringify(planFor('b')), f.resolver);
});

for (const kind of ['mount', 'grant']) {
  test(`termination reaches ${kind} acquisition that waits for cancellation`, async t => {
    t.timeout(3000);
    const f = fixture(t);
    f.faults[`${kind}Wait`] = true;
    const controller = f.makeController();
    const text = JSON.stringify(planFor('a'));
    const failed = t.throwsAsync(E(controller).activate(text, f.resolver), {
      message: /closed|stopping/,
    });
    await f[`${kind}Entered`].promise;
    await E(controller).terminate(text, f.resolver);
    await failed;
    t.true((await E(controller).status()).stopped);
    t.is(f.clients.length, 0);
  });
}

for (const kind of ['sandbox', 'broker']) {
  test(`termination retains the original late ${kind} scope before acknowledging release`, async t => {
    t.timeout(3000);
    const f = fixture(t);
    f.faults.lateScope = kind;
    const a = f.makeController();
    const b = f.makeController();
    const text = JSON.stringify(planFor('a'));
    const failed = t.throwsAsync(E(a).activate(text, f.resolver), {
      message: /stopping/,
    });
    await f.scopeEntered.promise;
    let closed = false;
    const stopping = E(a)
      .terminate(text, f.resolver)
      .then(() => {
        closed = true;
      });
    await E(b).activate(JSON.stringify(planFor('b')), f.resolver);
    t.false(closed);
    t.true(
      kind === 'sandbox'
        ? f.scopes.has('sandbox-a')
        : f.grants.has('sandbox-a'),
    );
    f.scopeReleased.resolve();
    await Promise.all([failed, stopping]);
    t.false(f.scopes.has('sandbox-a'));
    t.false(f.grants.has('sandbox-a'));
    t.true(f.scopes.has('sandbox-b'));
    t.true(f.grants.has('sandbox-b'));
    await E(b).terminate(JSON.stringify(planFor('b')), f.resolver);
  });
}

test('reconstruction uses lookup and refuses to invent local cleanup ownership', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  await t.throwsAsync(
    E(controller).terminate(JSON.stringify(planFor('old')), f.resolver),
    { message: /Original local 9P\/MCP cleanup ownership is unavailable/ },
  );
  t.true(f.events.includes('lookup sandbox sandbox-old'));
  t.true(f.events.includes('lookup grant sandbox-old'));
  t.false(f.events.some(event => Array.isArray(event)));
  t.false((await E(controller).status()).stopped);
});

test('MCP drain failure remains retryable after the sandbox has closed', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  f.faults.mcpClose = true;
  await t.throwsAsync(E(controller).terminate(text, f.resolver), {
    message: /cleanup pending/,
  });
  t.false((await E(controller).status()).stopped);
  f.faults.mcpClose = false;
  await E(controller).terminate(text, f.resolver);
  t.true((await E(controller).status()).stopped);
});

test('native entrypoint validates the promised powers supplied by the daemon', async t => {
  await t.throwsAsync(
    Reflect.apply(make, undefined, [
      Promise.resolve(Far('Host', {})),
      undefined,
    ]),
    {
      message: /null powers/,
    },
  );
  const controller = await make(Promise.resolve(null), undefined);
  t.deepEqual(await E(controller).status(), {
    stopping: false,
    stopped: false,
  });
});

test('rejected initial plan is an observed activation, not lost cleanup ownership', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  for (const text of ['null', '"plan"', '[]']) {
    // Copy data, but not a record: refused structurally, not by a stray
    // property read. Each controller admits one plan text, so use a fresh one.
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(E(f.makeController()).activate(text, f.resolver), {
      message: /plan must be a record/,
    });
  }
  const invalid = JSON.stringify({ sessionId: 'a' });
  await t.throwsAsync(E(controller).activate(invalid, f.resolver), {
    message: /Missing session plan field/,
  });
  await E(controller).terminate(invalid, f.resolver);
  t.deepEqual(f.events, []);
  t.true((await E(controller).status()).stopped);
});

test('real eager client delegates cleanup and never starts the discarded initial prompt', async t => {
  const f = fixture(t, { realClient: true });
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  t.is((await E(controller).status()).opencodeSessionId, '');
  await E(controller).terminate(text, f.resolver);
  t.like(await E(controller).status(), { terminated: true, stopped: true });
  t.is(f.scopes.size, 0);
});

test('failed MCP startup retains cleanup before its rejection', async t => {
  const f = fixture(t);
  f.faults.mcpStart = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /mcp startup failed/,
  });
  await E(controller).terminate(text, f.resolver);
  t.true(f.events.includes('close mcp'));
  t.true(f.events.includes('close mounter'));
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
});

test('noncopy service evidence cannot enter shared native acquisition', async t => {
  const f = fixture(t);
  f.faults.badEvidence = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /copy data/,
  });
  t.false(f.events.some(event => Array.isArray(event) && event[0] === 'slice'));
  await E(controller).terminate(text, f.resolver);
  t.is(f.scopes.size, 0);
});

test('public network uses approved proxy environment and literal resolver contents', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify({
    ...planFor('a'),
    networkPolicy: 'public-internet',
  });
  await E(controller).activate(text, f.resolver);
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  t.is(options.env.HTTP_PROXY, 'http://127.0.0.1:9001');
  t.is(options.env.NO_PROXY, '127.0.0.1');
  t.deepEqual(options.generatedFiles, [
    { innerPath: '/etc/resolv.conf', contents: 'nameserver 127.0.0.53\n' },
  ]);
  // The recorded profile reaches native acquisition widened, with no legacy
  // rlimit or attestation policy beside it.
  t.deepEqual(options.nativeProfile, {
    ...nativeProfile,
    memoryBytes: 536_870_912n,
    cpuQuotaMicros: 200_000n,
  });
  t.is(options.backend, 'podman');
  t.false('limits' in options);
  t.false('policy' in options);
  await E(controller).terminate(text, f.resolver);
});

/** @type {readonly [string, (profile: any) => unknown, RegExp][]} */
const refusedProfiles = harden([
  ['missing', () => undefined, /Missing native profile/],
  [
    'a non-decimal quantity',
    profile => ({ ...profile, memoryBytes: '512M' }),
    /decimal digit strings/,
  ],
  [
    'an unmapped identity',
    profile => ({ ...profile, uid: 0xffff_ffff }),
    /Invalid native process identity/,
  ],
  [
    'an unexpected field',
    profile => ({ ...profile, seccomp: 'unconfined' }),
    /native Podman profile/,
  ],
  ['a zero count', profile => ({ ...profile, pids: 0 }), /positive uint32/],
]);

for (const [name, mutate, message] of refusedProfiles) {
  test(`controller refuses a plan with ${name} native profile before any acquisition`, async t => {
    const f = fixture(t);
    const controller = f.makeController();
    const { nativeProfile: recorded, ...rest } = planFor('a');
    const profile = mutate(recorded);
    const text = JSON.stringify({
      ...rest,
      ...(profile === undefined ? {} : { nativeProfile: profile }),
    });
    await t.throwsAsync(E(controller).activate(text, f.resolver), { message });
    t.false(f.events.some(event => `${event}`.startsWith('provide ')));
    t.false(f.events.some(event => `${event}`.startsWith('resolve ')));
    await E(controller).terminate(text, f.resolver);
    t.is(f.scopes.size, 0);
    t.is(f.grants.size, 0);
  });
}

for (const [fault, message] of /** @type {const} */ ([
  ['missingPublic', /network evidence/],
  ['wrongImage', /pinned image/],
])) {
  test(`controller refuses ${fault} before native filesystem effects`, async t => {
    const f = fixture(t);
    f.faults[fault] = true;
    const controller = f.makeController();
    const text = JSON.stringify({
      ...planFor('a'),
      networkPolicy: 'public-internet',
    });
    await t.throwsAsync(E(controller).activate(text, f.resolver), { message });
    t.false(
      f.events.some(event => Array.isArray(event) && event[0] === 'mount'),
    );
    await E(controller).terminate(text, f.resolver);
    t.is(f.scopes.size, 0);
    t.is(f.grants.size, 0);
  });
}

test('context loss fences the active client and starts retained cleanup', async t => {
  t.timeout(3000);
  const f = fixture(t);
  const cancelled = gate();
  const context = Far('Context', { whenCancelled: () => cancelled.promise });
  const controller = f.makeController(context);
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  cancelled.resolve();
  await f.sandboxClosed.promise;
  await t.throwsAsync(E(controller).send('after cancellation'), {
    message: /stopping/,
  });
  await E(controller).terminate(text, f.resolver);
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
});

test('reconstructed cleanup releases known shared scopes but still refuses local proof', async t => {
  const f = fixture(t);
  const old = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(old).activate(text, f.resolver);
  const reconstructed = f.makeController();
  const boundary = f.events.length;
  await t.throwsAsync(E(reconstructed).terminate(text, f.resolver), {
    message: /Original local 9P\/MCP cleanup ownership is unavailable/,
  });
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
  t.false(f.events.slice(boundary).includes('close mounter'));
  t.false(f.events.slice(boundary).includes('close mcp'));
  await E(old).terminate(text, f.resolver);
});
