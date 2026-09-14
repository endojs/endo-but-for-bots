// @ts-check

import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import { assertCopyData } from '@endo/daemon/copy-data.js';

import { makeClaudeClient } from '../src/claude-client.js';
import {
  make,
  makeClaudeNativeController,
} from '../src/claude-native-controller.js';

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

const digest = `sha256:${'a'.repeat(64)}`;

const planFor = (id, overrides = {}) =>
  harden({
    sessionId: id,
    sandboxSessionId: `sandbox-${id}`,
    rootfs: `oci:example@${digest}`,
    networkPolicy: 'off',
    credentialKind: 'apiKey',
    workspaceDir: `/workspaces/${id}`,
    workspaceMountPoint: `/private/${id}/workspace`,
    mcpDir: `/private/${id}/mcp`,
    mounterSocketDir: `/private/${id}/9p`,
    nativeProfile,
    model: 'claude-sonnet-4',
    systemPrompt: 'You are Floot.',
    ...overrides,
  });

const fixture = (t, { realClient = false } = {}) => {
  /** @type {any[]} */
  const events = [];
  const scopes = new Map();
  const grants = new Map();
  /** @type {any[]} */
  const clients = [];
  const faults = {
    sandboxClose: false,
    mcpClose: false,
    mountWait: false,
    grantWait: false,
    revokeFail: false,
    badEvidence: false,
    missingPublic: false,
    wrongImage: false,
  };
  const mountEntered = gate();
  const mountReleased = gate();
  const grantEntered = gate();
  const grantReleased = gate();
  const sandboxClosed = gate();
  const revoked = gate();
  const cleanupReported = gate();
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
          return Far('NativeSlice', {
            async dispose() {
              events.push(`dispose slice ${id}`);
            },
          });
        },
        async close() {
          events.push(`close sandbox ${id}`);
          sandboxClosed.resolve();
          if (faults.sandboxClose) throw Error('sandbox close failed');
          closed = true;
          if (scopes.get(id) === scope) scopes.delete(id);
        },
      });
      scopes.set(id, scope);
      return scope;
    },
    lookupScope(id) {
      events.push(`lookup sandbox ${id}`);
      return scopes.get(id);
    },
  });
  // The provider broker: an inert grant per session that starts, attests the
  // listener endpoint, and reports the sidecar the slice joins.
  const brokerService = Far('BrokerService', {
    async provideScope(id, spec) {
      events.push(['grant', id, spec]);
      let closed = false;
      const scope = Far('Grant', {
        async start() {
          events.push(`start grant ${id}`);
          if (faults.grantWait) {
            grantEntered.resolve();
            await grantReleased.promise;
          }
          if (closed) throw Error('grant closed');
        },
        async attestation() {
          return harden({
            endpoint: 'http://127.0.0.1:9000',
            imageDigest: digest,
          });
        },
        async sandboxEvidence() {
          return harden({
            brokerSidecar: { container: `sidecar-${id}` },
            imageDigest: faults.wrongImage
              ? `sha256:${'b'.repeat(64)}`
              : digest,
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
          events.push(`revoke ${id}`);
          if (faults.revokeFail) throw Error('revoke failed');
          closed = true;
          grantReleased.resolve();
          revoked.resolve();
          if (grants.get(id) === scope) grants.delete(id);
        },
      });
      grants.set(id, scope);
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
  const roles = { sandboxService, brokerService, stateProvider, tools };
  const resolver = Far('Resolver', {
    async get(role) {
      events.push(`resolve ${role}`);
      if (!(role in roles)) throw Error(`no role ${role}`);
      return roles[role];
    },
  });
  /** @param {any} [context] */
  const makeController = (context = undefined) => {
    const controller = makeClaudeNativeController({
      context,
      reportError: error => {
        events.push(['cleanup error', error]);
        cleanupReported.resolve();
      },
      env: { XDG_RUNTIME_DIR: '/wrong-global' },
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
              await null;
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
      async startMcp(options) {
        events.push(['mcp', options.socketDir]);
        return harden({
          socketDir: options.socketDir,
          socketPath: `${options.socketDir}/mcp.sock`,
          socketName: 'mcp.sock',
          stdioBridgeName: 'mcp-stdio-bridge.mjs',
          configFileName: 'mcp.json',
          innerDir: '/endo-mcp',
          innerConfigPath: '/endo-mcp/mcp.json',
          async close() {
            events.push('close mcp');
            if (faults.mcpClose) throw Error('mcp close failed');
          },
        });
      },
      makeResume(directory, options) {
        events.push(['resume', directory, options]);
        return harden({
          listTranscripts: () => [],
          resolveResumeSessionId: () => undefined,
          detectPriorConversation: () => false,
        });
      },
      makeClient(options) {
        clients.push(options);
        if (realClient) return makeClaudeClient(options);
        const { slice } = options;
        if (slice === undefined) throw Error('Missing slice');
        // A test double: only the methods the controller drives.
        return /** @type {any} */ (
          Far('Client', {
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
                workspaceMountPoint: options.workspaceMountPoint,
                model: options.model || '',
                terminated: false,
              });
            },
            async terminate() {
              // As the real client does: dispose the slice, best-effort.
              events.push('client terminate');
              await E(slice).dispose();
            },
            help: () => 'Injected client',
          })
        );
      },
    });
    return controller;
  };
  t.teardown(() => {
    faults.sandboxClose = false;
    faults.mcpClose = false;
    faults.revokeFail = false;
    mountReleased.resolve();
    grantReleased.resolve();
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
    mountReleased,
    grantEntered,
    grantReleased,
    sandboxClosed,
    revoked,
    cleanupReported,
    tools,
  };
};

const sliceOptions = f => {
  const [, , options] =
    f.events.find(event => Array.isArray(event) && event[0] === 'slice') ?? [];
  return options;
};

test('activation acquires the scope, the broker grant, state, workspace mount, and tool bridge before the slice and client', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  t.deepEqual(f.events, []);
  const plan = planFor('a');
  await E(controller).activate(JSON.stringify(plan), f.resolver);
  t.is(f.clients.length, 1);
  t.false(f.events.some(event => Array.isArray(event) && event[0] === 'send'));
  const options = sliceOptions(f);
  t.deepEqual(
    options.mounts.map(mount => [mount.hostPath, mount.innerPath, mount.mode]),
    [
      [plan.workspaceMountPoint, '/workspace', 'rw'],
      ['/state/sandbox-a', '/claude-config', 'rw'],
      [plan.mcpDir, '/endo-mcp', 'ro'],
    ],
  );
  // The slice joins the broker sidecar's network namespace; only the
  // listener's loopback endpoint and a placeholder credential reach it.
  t.is(options.network, 'join');
  t.is(options.networkRef, 'sidecar-sandbox-a');
  t.is(options.cwd, '/workspace');
  t.deepEqual(options.env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
    ANTHROPIC_API_KEY: 'claude-broker-placeholder',
  });
  t.false('generatedFiles' in options);
  t.is(options.nativeProfile.memoryBytes, 536_870_912n);
  t.false('limits' in options);
  t.false('policy' in options);
  // The grant names the Anthropic account and the recorded policy and model.
  const [, grantId, spec] = f.events.find(
    event => Array.isArray(event) && event[0] === 'grant',
  );
  t.is(grantId, 'sandbox-a');
  t.deepEqual(spec, {
    providerOrigin: 'https://api.anthropic.com',
    accountRef: 'anthropic',
    networkPolicy: 'off',
    model: 'claude-sonnet-4',
  });
  const [, mounterEnv] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mounter',
  );
  t.deepEqual(mounterEnv, {
    XDG_RUNTIME_DIR: plan.mounterSocketDir,
    NINEP_SOCKET_DIR: plan.mounterSocketDir,
  });
  const [, , mountPoint, mountOptions] = f.events.find(
    event => Array.isArray(event) && event[0] === 'mount',
  );
  t.is(mountPoint, plan.workspaceMountPoint);
  t.deepEqual(mountOptions, { removeMountPointOnUnmount: true });
  t.deepEqual(
    f.events.find(event => Array.isArray(event) && event[0] === 'filesystem'),
    ['filesystem', plan.workspaceDir],
  );
  const client = f.clients[0];
  t.is(client.mcpConfigPath, '/endo-mcp/mcp.json');
  t.is(client.env.CLAUDE_CONFIG_DIR, '/claude-config');
  t.is(client.env.IS_SANDBOX, '1');
  t.is(client.model, plan.model);
  t.is(client.systemPrompt, plan.systemPrompt);
  t.false(client.resumePriorConversation);
  t.false(Object.hasOwn(client, 'initialPrompt'));
  t.deepEqual(
    f.events.find(event => Array.isArray(event) && event[0] === 'resume'),
    ['resume', '/state/sandbox-a', { debug: false }],
  );
  // The grant is started and its evidence checked before any local effect.
  const order = f.events.filter(
    event =>
      typeof event === 'string' ||
      (Array.isArray(event) && ['grant', 'slice'].includes(event[0])),
  );
  t.deepEqual(
    order.map(event => (Array.isArray(event) ? event[0] : event)),
    [
      'resolve sandboxService',
      'provide sandbox sandbox-a',
      'resolve brokerService',
      'grant',
      'start grant sandbox-a',
      'resolve stateProvider',
      'state sandbox-a',
      'resolve tools',
      'slice',
    ],
  );
  const status = await E(controller).status();
  t.like(status, { sessionId: 'a', stopping: false, stopped: false });
});

test('a subscription token kind lands its placeholder under its own variable; an unknown kind is refused before any acquisition', async t => {
  const oauth = fixture(t);
  await E(oauth.makeController()).activate(
    JSON.stringify(planFor('a', { credentialKind: 'oauthToken' })),
    oauth.resolver,
  );
  t.deepEqual(sliceOptions(oauth).env, {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
    CLAUDE_CODE_OAUTH_TOKEN: 'claude-broker-placeholder',
  });
  const unknown = fixture(t);
  await t.throwsAsync(
    E(unknown.makeController()).activate(
      JSON.stringify(planFor('a', { credentialKind: 'password' })),
      unknown.resolver,
    ),
    { message: /Claude credential kind must be one of/ },
  );
  t.deepEqual(unknown.events, [], 'refused before any acquisition');
});

test('a public-internet plan uses the attested proxy environment and literal resolver contents', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify(
    planFor('a', { networkPolicy: 'public-internet' }),
  );
  await E(controller).activate(text, f.resolver);
  const options = sliceOptions(f);
  t.is(options.env.HTTP_PROXY, 'http://127.0.0.1:9001');
  t.is(options.env.NO_PROXY, '127.0.0.1');
  t.is(options.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9000');
  t.deepEqual(options.generatedFiles, [
    { innerPath: '/etc/resolv.conf', contents: 'nameserver 127.0.0.53\n' },
  ]);
  const [, , spec] = f.events.find(
    event => Array.isArray(event) && event[0] === 'grant',
  );
  t.is(spec.networkPolicy, 'public-internet');
  await E(controller).terminate(text, f.resolver);
});

for (const [fault, message] of /** @type {const} */ ([
  ['missingPublic', /network evidence/],
  ['wrongImage', /pinned image/],
  ['badEvidence', /copy data/],
])) {
  test(`the controller refuses ${fault} broker evidence before any local effect`, async t => {
    const f = fixture(t);
    f.faults[fault] = true;
    const controller = f.makeController();
    const text = JSON.stringify(
      planFor('a', { networkPolicy: 'public-internet' }),
    );
    await t.throwsAsync(E(controller).activate(text, f.resolver), { message });
    t.false(
      f.events.some(
        event =>
          Array.isArray(event) &&
          ['mounter', 'mcp', 'slice'].includes(event[0]),
      ),
    );
    t.is(f.clients.length, 0);
    await E(controller).terminate(text, f.resolver);
    t.is(f.scopes.size, 0);
    t.is(f.grants.size, 0);
    t.like(await E(controller).status(), { stopped: true });
  });
}

test('recorded mounter settings reach the session mounter beneath its own socket directory', async t => {
  const f = fixture(t);
  const plan = harden({
    ...planFor('a'),
    mounterEnv: { NINEP_SUDO: '1', NINEP_MOUNT_PROGRAM: 'sudo -n mount' },
  });
  await E(f.makeController()).activate(JSON.stringify(plan), f.resolver);
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

test('terminate releases the slice, sandbox, mounter, bridge, and broker grant, and is idempotent', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  const before = f.events.length;
  await E(controller).terminate(text, f.resolver);
  const after = f.events.slice(before).filter(e => typeof e === 'string');
  t.deepEqual(
    [...after].sort(),
    [
      'client terminate',
      'close mcp',
      'close mounter',
      'close sandbox sandbox-a',
      'dispose slice sandbox-a',
      'revoke sandbox-a',
    ],
    'every owner is released exactly once',
  );
  t.is(
    after[0],
    'client terminate',
    'the client stops before any owner is released',
  );
  t.true(
    after.indexOf('dispose slice sandbox-a') <
      after.indexOf('close sandbox sandbox-a'),
    'the client disposes its slice before the scope closes',
  );
  t.true(
    after.indexOf('close sandbox sandbox-a') < after.indexOf('close mounter'),
    'the mounter closes only after the sandbox acknowledges stop',
  );
  t.like(await E(controller).status(), { stopping: true, stopped: true });
  await E(controller).terminate(text, f.resolver);
  t.is(f.events.length, before + after.length, 'a repeated terminate is inert');
  await t.throwsAsync(E(controller).send('hello'), {
    message: /is stopping/,
  });
  await t.throwsAsync(E(controller).terminate('{}', f.resolver), {
    message: /Cleanup must use the original native plan/,
  });
});

test('a terminate during activation fences the acquisition and releases what was acquired', async t => {
  const f = fixture(t);
  f.faults.mountWait = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  const activation = E(controller).activate(text, f.resolver);
  await f.mountEntered.promise;
  const termination = E(controller).terminate(text, f.resolver);
  await t.throwsAsync(activation, { message: /is stopping|mounter closed/ });
  await termination;
  t.true(f.events.includes('close sandbox sandbox-a'));
  t.true(f.events.includes('close mounter'));
  t.true(f.events.includes('revoke sandbox-a'), 'the grant is revoked');
  t.is(f.clients.length, 0, 'no client was constructed');
});

test('a terminate while the broker grant is starting revokes it and refuses the activation', async t => {
  t.timeout(3000);
  const f = fixture(t);
  f.faults.grantWait = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  const failed = t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /closed|stopping/,
  });
  await f.grantEntered.promise;
  await E(controller).terminate(text, f.resolver);
  await failed;
  t.true(f.events.includes('revoke sandbox-a'));
  t.true((await E(controller).status()).stopped);
  t.false(
    f.events.some(event => Array.isArray(event) && event[0] === 'mounter'),
    'no mounter was made',
  );
  t.is(f.clients.length, 0);
});

test('failed cleanup is retained and retried, never reported as release', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  f.faults.sandboxClose = true;
  f.faults.revokeFail = true;
  await t.throwsAsync(E(controller).terminate(text, f.resolver), {
    message: /Claude native cleanup pending/,
  });
  t.like(await E(controller).status(), { stopping: true, stopped: false });
  t.false(
    f.events.includes('close mounter'),
    'the mounter waits for the sandbox',
  );
  f.faults.sandboxClose = false;
  f.faults.revokeFail = false;
  await E(controller).terminate(text, f.resolver);
  t.like(await E(controller).status(), { stopped: true });
  t.is(
    f.events.filter(e => e === 'revoke sandbox-a').length,
    2,
    'revoke retried',
  );
  t.true(f.events.includes('close mounter'));
  t.is(f.grants.size, 0);
});

test('reconstruction refuses to invent local cleanup ownership but releases the shared scope and grant', async t => {
  const f = fixture(t);
  const text = JSON.stringify(planFor('a'));
  const sandbox = await E(f.resolver).get('sandboxService');
  t.truthy(await E(sandbox).provideScope('sandbox-a'));
  const broker = await E(f.resolver).get('brokerService');
  t.truthy(await E(broker).provideScope('sandbox-a', harden({})));
  const revived = f.makeController();
  await t.throwsAsync(E(revived).terminate(text, f.resolver), {
    message: /Original local 9P\/MCP cleanup ownership is unavailable/,
  });
  t.true(f.events.includes('lookup sandbox sandbox-a'));
  t.true(f.events.includes('lookup grant sandbox-a'));
  t.true(f.events.includes('close sandbox sandbox-a'));
  t.true(f.events.includes('revoke sandbox-a'));
  t.is(f.scopes.size, 0);
  t.is(f.grants.size, 0);
  t.false((await E(revived).status()).stopped);
});

test('the plan cannot change under a live activation, and the caplet requires null powers', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  await E(controller).activate(JSON.stringify(planFor('a')), f.resolver);
  await t.throwsAsync(
    E(controller).activate(JSON.stringify(planFor('b')), f.resolver),
    { message: /plan cannot change/ },
  );
  await t.throwsAsync(
    make(/** @type {any} */ (Promise.resolve(Far('Powers', {}))), undefined),
    { message: /requires null powers/ },
  );
  const inert = await make(Promise.resolve(null), undefined);
  await t.throwsAsync(E(inert).send('hello'), { message: /is not active/ });
});

test('lost daemon context fences and releases without claiming completion', async t => {
  const f = fixture(t);
  /** @type {((reason: Error) => void) | undefined} */
  let cancel;
  const context = Far('Context', {
    whenCancelled: () =>
      new Promise((_, reject) => {
        cancel = reject;
      }),
  });
  const controller = f.makeController(context);
  await E(controller).activate(JSON.stringify(planFor('a')), f.resolver);
  if (cancel === undefined) throw Error('context was never observed');
  f.faults.mcpClose = true;
  cancel(Error('context lost'));
  await f.sandboxClosed.promise;
  await t.throwsAsync(E(controller).send('hello'), { message: /is stopping/ });
  // The failed release is reported once it settles, never swallowed.
  await f.cleanupReported.promise;
  t.true(
    f.events.some(
      event => Array.isArray(event) && event[0] === 'cleanup error',
    ),
    'the failed release is reported, not swallowed',
  );
  t.true(f.events.includes('revoke sandbox-a'));
  t.like(await E(controller).status(), { stopping: true, stopped: false });
});

test('the real client over a resolved slice disposes it on terminate and leaves release to the controller', async t => {
  const f = fixture(t, { realClient: true });
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  t.is(f.clients.length, 1);
  t.false(Object.hasOwn(f.clients[0], 'mountHandle'));
  t.false(Object.hasOwn(f.clients[0], 'provision'));
  const status = await E(controller).status();
  t.like(status, {
    sessionId: 'a',
    workspaceMountPoint: planFor('a').workspaceMountPoint,
    stopping: false,
  });
  const before = f.events.length;
  await E(controller).terminate(text, f.resolver);
  const after = f.events.slice(before).filter(e => typeof e === 'string');
  t.deepEqual([...after].sort(), [
    'close mcp',
    'close mounter',
    'close sandbox sandbox-a',
    'dispose slice sandbox-a',
    'revoke sandbox-a',
  ]);
  t.true(
    after.indexOf('dispose slice sandbox-a') <
      after.indexOf('close sandbox sandbox-a'),
  );
  t.like(await E(controller).status(), { stopped: true, terminated: true });
});
