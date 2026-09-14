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

const planFor = id =>
  harden({
    sessionId: id,
    sandboxSessionId: `sandbox-${id}`,
    rootfs: `oci:example@sha256:${'a'.repeat(64)}`,
    network: 'private',
    workspaceDir: `/workspaces/${id}`,
    workspaceMountPoint: `/private/${id}/workspace`,
    mcpDir: `/private/${id}/mcp`,
    mounterSocketDir: `/private/${id}/9p`,
    nativeProfile,
    model: 'claude-sonnet-4',
    systemPrompt: 'You are Floot.',
  });

const fixture = (t, { kind = 'apiKey', realClient = false } = {}) => {
  /** @type {any[]} */
  const events = [];
  const scopes = new Map();
  /** @type {any[]} */
  const clients = [];
  const faults = {
    sandboxClose: false,
    mcpClose: false,
    mountWait: false,
    revokeFail: false,
    materialiseWait: false,
    materialiseFail: false,
  };
  const mountEntered = gate();
  const mountReleased = gate();
  const materialiseEntered = gate();
  const materialiseReleased = gate();
  const sandboxClosed = gate();
  const revoked = gate();
  const cleanupReported = gate();
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
  const stateProvider = Far('State', {
    async prepareSessionDirectory(id) {
      events.push(`state ${id}`);
      return harden({ directory: `/state/${id}` });
    },
  });
  const credentials = Far('ClaudeCredentials', {
    async kind() {
      return kind;
    },
    async issue(tag) {
      events.push(`issue ${tag}`);
      return Far('IssuedCredential', {
        async materialise() {
          await null;
          events.push(`materialise ${tag}`);
          if (faults.materialiseWait) {
            materialiseEntered.resolve();
            await materialiseReleased.promise;
          }
          if (faults.materialiseFail) throw Error('materialise failed');
          return `secret-for-${tag}`;
        },
      });
    },
    async revoke(tag) {
      events.push(`revoke ${tag}`);
      if (faults.revokeFail) throw Error('revoke failed');
      revoked.resolve();
    },
  });
  const roles = { sandboxService, stateProvider, credentials, tools };
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
    mountReleased.resolve();
    materialiseReleased.resolve();
  });
  return {
    events,
    scopes,
    clients,
    faults,
    resolver,
    makeController,
    mountEntered,
    mountReleased,
    materialiseEntered,
    materialiseReleased,
    sandboxClosed,
    revoked,
    cleanupReported,
    tools,
  };
};

test('activation acquires the scope, state, credential, workspace mount, and tool bridge before the slice and client', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  t.deepEqual(f.events, []);
  const plan = planFor('a');
  await E(controller).activate(JSON.stringify(plan), f.resolver);
  t.is(f.clients.length, 1);
  t.false(f.events.some(event => Array.isArray(event) && event[0] === 'send'));
  const [, , options] = f.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  t.deepEqual(
    options.mounts.map(mount => [mount.hostPath, mount.innerPath, mount.mode]),
    [
      [plan.workspaceMountPoint, '/workspace', 'rw'],
      ['/state/sandbox-a', '/claude-config', 'rw'],
      [plan.mcpDir, '/endo-mcp', 'ro'],
    ],
  );
  t.is(options.network, 'private');
  t.is(options.cwd, '/workspace');
  t.deepEqual(options.env, { ANTHROPIC_API_KEY: 'secret-for-a' });
  t.is(options.nativeProfile.memoryBytes, 536_870_912n);
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
  // The credential is issued and materialised once, before the slice.
  const order = f.events.filter(
    event =>
      typeof event === 'string' ||
      (Array.isArray(event) && event[0] === 'slice'),
  );
  t.deepEqual(
    order.map(event => (Array.isArray(event) ? 'slice' : event)),
    [
      'resolve sandboxService',
      'provide sandbox sandbox-a',
      'resolve stateProvider',
      'state sandbox-a',
      'resolve credentials',
      'issue a',
      'materialise a',
      'resolve tools',
      'slice',
    ],
  );
  const status = await E(controller).status();
  t.like(status, { sessionId: 'a', stopping: false, stopped: false });
});

test('an oauth credential lands under its own variable; an unknown kind is refused before any grant', async t => {
  const oauth = fixture(t, { kind: 'oauthToken' });
  await E(oauth.makeController()).activate(
    JSON.stringify(planFor('a')),
    oauth.resolver,
  );
  const [, , options] = oauth.events.find(
    event => Array.isArray(event) && event[0] === 'slice',
  );
  t.deepEqual(options.env, { CLAUDE_CODE_OAUTH_TOKEN: 'secret-for-a' });
  const unknown = fixture(t, { kind: 'password' });
  await t.throwsAsync(
    E(unknown.makeController()).activate(
      JSON.stringify(planFor('a')),
      unknown.resolver,
    ),
    { message: /Unknown credential kind "password"/ },
  );
  t.false(unknown.events.some(event => event === 'issue a'));
  t.false(
    unknown.events.some(event => Array.isArray(event) && event[0] === 'slice'),
  );
});

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

test('terminate releases the slice, sandbox, mounter, bridge, and credential grant, and is idempotent', async t => {
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
      'revoke a',
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
  t.true(f.events.includes('revoke a'), 'the issued grant is revoked');
  t.is(f.clients.length, 0, 'no client was constructed');
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
  f.faults.sandboxClose = false;
  f.faults.revokeFail = false;
  await E(controller).terminate(text, f.resolver);
  t.like(await E(controller).status(), { stopped: true });
  t.is(f.events.filter(e => e === 'revoke a').length, 2, 'revoke retried');
});

test('reconstruction refuses to invent local cleanup ownership but releases the shared scope', async t => {
  const f = fixture(t);
  const text = JSON.stringify(planFor('a'));
  const scope = await E(f.resolver)
    .get('sandboxService')
    .then(service => E(service).provideScope('sandbox-a'));
  t.truthy(scope);
  const revived = f.makeController();
  await t.throwsAsync(E(revived).terminate(text, f.resolver), {
    message: /Original local 9P\/MCP cleanup ownership is unavailable/,
  });
  t.true(f.events.includes('lookup sandbox sandbox-a'));
  t.true(f.events.includes('close sandbox sandbox-a'));
  t.false(f.events.includes('revoke a'), 'no grant was issued to revoke');
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
    'revoke a',
  ]);
  t.true(
    after.indexOf('dispose slice sandbox-a') <
      after.indexOf('close sandbox sandbox-a'),
  );
  t.like(await E(controller).status(), { stopped: true, terminated: true });
});

test('a revoked grant is not revoked again when another release is retried', async t => {
  const f = fixture(t);
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await E(controller).activate(text, f.resolver);
  f.faults.sandboxClose = true;
  await t.throwsAsync(E(controller).terminate(text, f.resolver), {
    message: /Claude native cleanup pending/,
  });
  t.is(f.events.filter(e => e === 'revoke a').length, 1);
  t.false(
    f.events.includes('close mounter'),
    'the mounter waits for the sandbox',
  );
  f.faults.sandboxClose = false;
  await E(controller).terminate(text, f.resolver);
  t.is(f.events.filter(e => e === 'revoke a').length, 1, 'revoked once');
  t.true(f.events.includes('close mounter'));
  t.like(await E(controller).status(), { stopped: true });
});

test('a failed materialisation leaves the grant to terminate, which revokes it', async t => {
  const f = fixture(t);
  f.faults.materialiseFail = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  await t.throwsAsync(E(controller).activate(text, f.resolver), {
    message: /materialise failed/,
  });
  t.true(f.events.includes('issue a'));
  t.false(f.events.includes('revoke a'), 'nothing is released until terminate');
  t.is(f.clients.length, 0);
  await E(controller).terminate(text, f.resolver);
  t.true(f.events.includes('revoke a'));
  t.true(f.events.includes('close sandbox sandbox-a'));
  t.like(await E(controller).status(), { stopped: true });
});

test('a stop between issue and materialise still revokes the grant', async t => {
  const f = fixture(t);
  f.faults.materialiseWait = true;
  const controller = f.makeController();
  const text = JSON.stringify(planFor('a'));
  const activation = E(controller).activate(text, f.resolver);
  await f.materialiseEntered.promise;
  const termination = E(controller).terminate(text, f.resolver);
  // The grant is revoked while materialise is still pending: a stalled
  // credentials capability cannot keep an issued grant alive.
  await f.revoked.promise;
  t.true(f.events.includes('revoke a'), 'revoked while materialise is pending');
  f.materialiseReleased.resolve();
  await t.throwsAsync(activation, { message: /is stopping/ });
  await termination;
  t.false(
    f.events.some(event => Array.isArray(event) && event[0] === 'mounter'),
    'no mounter was made',
  );
  t.is(f.clients.length, 0);
});
