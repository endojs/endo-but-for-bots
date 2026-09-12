// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeOpencodeSessionProvisioner } from '../src/opencode-session-provisioner.js';
import { makeOpencodeBackendFactory } from '../src/opencode-backend-factory.js';

const keyFor = names => names.join('/');

/**
 * A recording host: pet names live in a map keyed by their joined path, and
 * the calls a provisioner makes beyond `has`/`lookup`/`remove` are logged.
 */
const makeRecordingHost = () => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  names.set('opencode-sandbox', harden({ kind: 'directory' }));
  /** @type {string[][]} */
  const directories = [];
  /** @type {Array<{ path: string[], reason: string }>} */
  const cancelled = [];
  const hostAgent = harden({
    async has(...path) {
      for (let length = 1; length < path.length; length += 1) {
        if (!names.has(keyFor(path.slice(0, length)))) {
          throw Error('Missing intermediate directory');
        }
      }
      return names.has(keyFor(path));
    },
    async lookup(...args) {
      if (args.length !== 1) throw Error('lookup requires one name or path');
      const [nameOrPath] = args;
      return names.get(
        keyFor(Array.isArray(nameOrPath) ? nameOrPath : [nameOrPath]),
      );
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
    async makeDirectory(path) {
      directories.push([...path]);
      // The daemon replaces a directory, including its reachable subtree.
      for (const name of names.keys()) {
        if (name.startsWith(`${keyFor(path)}/`)) names.delete(name);
      }
      names.set(keyFor(path), harden({ kind: 'directory' }));
    },
    async cancel(path, reason) {
      cancelled.push({ path: [...path], reason: reason.message });
    },
  });
  return { hostAgent, names, directories, cancelled };
};

const baseConfig = harden({
  clientBase: 'opencode-client',
  credentialsName: 'opencode-creds',
  workspaceBaseDir: '/workspaces',
  rootfs: 'oci:test',
});

test('removes an unprovisioned session without creating the sessions directory', async t => {
  const { hostAgent, directories } = makeRecordingHost();
  const removedDirectories = [];
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async removeDirectory(directory) {
      removedDirectories.push(directory);
    },
  });
  await E(provisioner).remove('never-started');
  t.deepEqual(directories, []);
  t.deepEqual(removedDirectories, [
    '/workspaces/never-started',
    '/opencode-configs/never-started',
  ]);
});

test('provisions and removes one isolated client per Floot session', async t => {
  const { hostAgent, names, directories } = makeRecordingHost();
  const filesystemCalls = [];
  const provisionCalls = [];
  const removedDirectories = [];
  const destroyed = [];
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name, directory) {
      filesystemCalls.push({ name, directory });
      names.set(name, harden({}));
    },
    async provisionSession(_host, spec, options = {}) {
      provisionCalls.push({ spec, options });
      const resultName = /** @type {string[]} */ (options.resultName);
      names.set(
        keyFor(resultName),
        Far('FakeOpencodeClient', {
          async destroy() {
            destroyed.push(spec.name);
          },
          help: () => `fake client ${spec.name}`,
        }),
      );
      for (const name of options.removeNames || []) {
        names.delete(keyFor(Array.isArray(name) ? name : [name]));
      }
      return harden({
        client: names.get(keyFor(resultName)),
        sessionId: 'sandbox-session',
        hostMountPoint: '/mount',
        rootfsLabel: 'test',
      });
    },
    async removeDirectory(directory, options) {
      removedDirectories.push({ directory, options });
    },
  });

  t.is(await E(provisioner).lookup('session-a'), undefined);
  const [first, second] = await Promise.all([
    E(provisioner).provision('session-a'),
    E(provisioner).provision('session-a'),
  ]);
  t.is(first, 'opencode-client-session-a');
  t.is(second, first);
  // The sessions directory is created on first use.
  t.deepEqual(directories, [['opencode-sandbox', 'sessions']]);
  // Two filesystems: the user-facing workspace and the dedicated config dir
  // (a sibling of the workspace base by default).
  t.deepEqual(filesystemCalls, [
    {
      name: 'opencode-workspace-session-a',
      directory: '/workspaces/session-a',
    },
    {
      name: 'opencode-config-session-a',
      directory: '/opencode-configs/session-a',
    },
  ]);
  t.is(provisionCalls.length, 1);
  t.deepEqual(provisionCalls[0].options.resultName, [
    'opencode-sandbox',
    'sessions',
    'opencode-client-session-a',
  ]);
  // The config filesystem and the state provider name are forwarded.
  t.is(
    provisionCalls[0].spec.configFilesystemName,
    'opencode-config-session-a',
  );
  t.is(provisionCalls[0].spec.configHostDir, '/opencode-configs/session-a');
  t.is(provisionCalls[0].spec.stateProviderName, 'state-provider');
  t.true(names.has('opencode-sandbox/sessions/opencode-client-session-a'));
  const lookedUp = await E(provisioner).lookup('session-a');
  t.is(await E(lookedUp).help(), 'fake client opencode-client-session-a');
  t.deepEqual(destroyed, []);

  await E(provisioner).remove('session-a');
  // `remove` destroys through the live client first, then drops the formula
  // and both backing directories.
  t.deepEqual(destroyed, ['opencode-client-session-a']);
  t.false(names.has('opencode-sandbox/sessions/opencode-client-session-a'));
  t.deepEqual(removedDirectories, [
    {
      directory: '/workspaces/session-a',
      options: { recursive: true, force: true },
    },
    {
      directory: '/opencode-configs/session-a',
      options: { recursive: true, force: true },
    },
  ]);
});

/**
 * A `provisionSession` stand-in that only records the client under its
 * result name.
 *
 * @param {Map<string, unknown>} names
 * @param {Array<{ spec: any, options: any }>} [provisionCalls]
 */
const makeFakeProvisionSession =
  (names, provisionCalls = []) =>
  async (_host, spec, options = {}) => {
    provisionCalls.push({ spec, options });
    const resultName = /** @type {string[]} */ (options.resultName);
    names.set(
      keyFor(resultName),
      Far('FakeOpencodeClient', {
        async terminate() {
          await null;
        },
        async destroy() {
          await null;
        },
        help: () => `fake client ${spec.name}`,
      }),
    );
    return harden({
      client: spec.name,
      sessionId: 'sandbox-session',
      hostMountPoint: '/mount',
      rootfsLabel: 'test',
    });
  };

test('different first sessions share namespace initialization', async t => {
  t.timeout(2000);
  const { hostAgent, names, directories } = makeRecordingHost();
  let release = () => {};
  const held = new Promise(resolve => {
    release = () => resolve(undefined);
  });
  let entered = () => {};
  const creating = new Promise(resolve => {
    entered = () => resolve(undefined);
  });
  const host = harden({
    ...hostAgent,
    async makeDirectory(path) {
      entered();
      await held;
      return E(hostAgent).makeDirectory(path);
    },
  });
  const provisioner = makeOpencodeSessionProvisioner(host, baseConfig, {
    async makeFilesystem(name) {
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names),
  });
  const first = E(provisioner).provision('first');
  const second = E(provisioner).provision('second');
  await creating;
  release();
  await Promise.all([first, second]);
  t.deepEqual(directories, [['opencode-sandbox', 'sessions']]);
  t.is(
    await E(await E(provisioner).lookup('first')).help(),
    'fake client opencode-client-first',
  );
  t.is(
    await E(await E(provisioner).lookup('second')).help(),
    'fake client opencode-client-second',
  );
});

test('namespace initialization can retry after failure', async t => {
  const { hostAgent, names } = makeRecordingHost();
  let fail = true;
  const host = harden({
    ...hostAgent,
    async makeDirectory(path) {
      if (fail) {
        fail = false;
        throw Error('directory unavailable');
      }
      return E(hostAgent).makeDirectory(path);
    },
  });
  const provisioner = makeOpencodeSessionProvisioner(host, baseConfig, {
    async makeFilesystem(name) {
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names),
  });
  await t.throwsAsync(() => E(provisioner).provision('retry'), {
    message: /directory unavailable/,
  });
  t.is(await E(provisioner).provision('retry'), 'opencode-client-retry');
});

test('cancel stops a provisioned client without deleting it', async t => {
  const { hostAgent, names, cancelled } = makeRecordingHost();
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name) {
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names),
  });
  // Nothing to stop before provisioning: cancel is a no-op, not an error.
  await E(provisioner).cancel('session-b');
  t.deepEqual(cancelled, []);

  await E(provisioner).provision('session-b');
  await E(provisioner).cancel('session-b');
  t.deepEqual(cancelled, [
    {
      path: ['opencode-sandbox', 'sessions', 'opencode-client-session-b'],
      reason: 'OpenCode session session-b stopped',
    },
  ]);
  // The formula is still there for the next lookup to reincarnate.
  t.true(names.has('opencode-sandbox/sessions/opencode-client-session-b'));
});

test('remove deletes durable state through the bound state provider', async t => {
  const { hostAgent, names } = makeRecordingHost();
  const removedSessions = [];
  names.set(
    'opencode-sandbox/state-provider',
    Far('FakeStateProvider', {
      async removeSession(sessionId) {
        removedSessions.push(sessionId);
      },
    }),
  );
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name) {
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names),
    async removeDirectory() {
      // nothing on disk in this fake
      await null;
    },
  });
  await E(provisioner).remove('session-state');
  // The backstop uses the sandbox session id generated by the provisioner so
  // the provider deletes the directory it actually minted.
  t.is(removedSessions.length, 1);
  t.regex(removedSessions[0], /^session-state-[0-9a-f]{12}$/);
});

test('forwards the MCP tool-bridge mount options to the session provisioner', async t => {
  const { hostAgent, names } = makeRecordingHost();
  /** @type {Array<{ spec: any, options: any }>} */
  const provisionCalls = [];
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name) {
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names, provisionCalls),
  });

  const mcp = {
    socketDir: '/tmp/opencode-mcp/session-b',
    innerDir: '/endo-mcp',
    configPath: '/endo-mcp/mcp.json',
    socketName: 'mcp.sock',
    stdioBridgeName: 'mcp-stdio-bridge.mjs',
    serverName: 'endo',
  };
  await E(provisioner).provision('session-b', harden({ mcp }));
  t.is(provisionCalls.length, 1);
  t.deepEqual(provisionCalls[0].spec.mcp, mcp);
});

test('a workspaceDir override roots the filesystem at a shared worktree', async t => {
  const { hostAgent, names } = makeRecordingHost();
  const filesystemCalls = [];
  const removedDirectories = [];
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name, directory) {
      filesystemCalls.push({ name, directory });
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names),
    async removeDirectory(directory, options) {
      removedDirectories.push({ directory, options });
    },
  });

  await E(provisioner).provision(
    'session-c',
    harden({ workspaceDir: '/git/worktrees/session-c' }),
  );
  // The workspace filesystem is rooted at the shared worktree, not the
  // private per-session scratch directory. The config dir is ALWAYS the
  // private path.
  t.deepEqual(filesystemCalls, [
    {
      name: 'opencode-workspace-session-c',
      directory: '/git/worktrees/session-c',
    },
    {
      name: 'opencode-config-session-c',
      directory: '/opencode-configs/session-c',
    },
  ]);

  // remove() only deletes the private default paths, never the shared worktree.
  await E(provisioner).remove('session-c');
  t.deepEqual(removedDirectories, [
    {
      directory: '/workspaces/session-c',
      options: { recursive: true, force: true },
    },
    {
      directory: '/opencode-configs/session-c',
      options: { recursive: true, force: true },
    },
  ]);
});

test('rejects session ids that could escape its namespace', async t => {
  const hostAgent = harden({});
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem() {
      return undefined;
    },
    async provisionSession() {
      throw Error('must not provision');
    },
  });

  await t.throwsAsync(() => E(provisioner).provision('../escape'), {
    message: /Invalid Floot session id/,
  });
  await t.throwsAsync(() => E(provisioner).lookup('Not Valid'), {
    message: /Invalid Floot session id/,
  });
});

test('re-provisions the client when the network policy changes', async t => {
  const { hostAgent, names } = makeRecordingHost();
  const provisionCalls = [];
  let terminated = 0;
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name) {
      names.set(name, harden({}));
    },
    async provisionSession(_host, spec, options = {}) {
      provisionCalls.push(spec);
      const resultName = /** @type {string[]} */ (options.resultName);
      names.set(
        keyFor(resultName),
        Far('FakeOpencodeClient', {
          async status() {
            return harden({ network: spec.network });
          },
          async terminate() {
            terminated += 1;
          },
          async destroy() {
            await null;
          },
          help: () => 'fake client',
        }),
      );
      for (const name of options.removeNames || []) {
        names.delete(keyFor(Array.isArray(name) ? name : [name]));
      }
      return harden({
        client: names.get(keyFor(resultName)),
        sessionId: 'sandbox-session',
        hostMountPoint: '/mount',
        rootfsLabel: 'test',
      });
    },
  });
  await E(provisioner).provision('session-state', { network: 'none' });
  await E(provisioner).provision('session-state', { network: 'none' });
  t.is(provisionCalls.length, 1);
  await E(provisioner).provision('session-state', { network: 'private' });
  t.is(terminated, 1);
  t.is(provisionCalls.length, 2);
  t.is(provisionCalls[1].network, 'private');
});

test('failed destroy preserves the client, filesystem names, and state for retry', async t => {
  const { hostAgent, names } = makeRecordingHost();
  const removedDirectories = [];
  const removedSessions = [];
  let destroys = 0;
  let destroyFails = true;
  names.set('opencode-sandbox/sessions', harden({ kind: 'directory' }));
  const clientPath = 'opencode-sandbox/sessions/opencode-client-stop-retry';
  const client = Far('RetryDestroyClient', {
    async destroy() {
      destroys += 1;
      if (destroyFails) throw Error('slice stop incomplete');
    },
  });
  names.set(clientPath, client);
  names.set('opencode-workspace-stop-retry', harden({}));
  names.set('opencode-config-stop-retry', harden({}));
  names.set(
    'opencode-sandbox/state-provider',
    Far('StateProvider', {
      async removeSession(sessionId) {
        removedSessions.push(sessionId);
      },
    }),
  );
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async removeDirectory(directory) {
      removedDirectories.push(directory);
    },
  });
  await t.throwsAsync(() => E(provisioner).remove('stop-retry'), {
    message: /slice stop incomplete/,
  });
  t.is(names.get(clientPath), client);
  t.true(names.has('opencode-workspace-stop-retry'));
  t.true(names.has('opencode-config-stop-retry'));
  t.deepEqual(removedDirectories, []);
  t.deepEqual(removedSessions, []);
  destroyFails = false;
  await E(provisioner).remove('stop-retry');
  t.is(destroys, 2);
  t.false(names.has(clientPath));
  t.false(names.has('opencode-workspace-stop-retry'));
  t.false(names.has('opencode-config-stop-retry'));
  t.deepEqual(removedDirectories, [
    '/workspaces/stop-retry',
    '/opencode-configs/stop-retry',
  ]);
  t.is(removedSessions.length, 1);
});

test('a network change retains its predecessor until direct stop succeeds', async t => {
  const { hostAgent, names } = makeRecordingHost();
  const filesystemCalls = [];
  const provisionCalls = [];
  let stopFails = true;
  let stops = 0;
  names.set('opencode-sandbox/sessions', harden({ kind: 'directory' }));
  const clientPath = 'opencode-sandbox/sessions/opencode-client-network-retry';
  const client = Far('RetryStopClient', {
    async status() {
      return harden({ network: 'none' });
    },
    async terminate() {
      stops += 1;
      if (stopFails) throw Error('slice stop incomplete');
    },
  });
  names.set(clientPath, client);
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name) {
      filesystemCalls.push(name);
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names, provisionCalls),
  });
  await t.throwsAsync(
    () =>
      E(provisioner).provision('network-retry', harden({ network: 'private' })),
    { message: /slice stop incomplete/ },
  );
  t.is(names.get(clientPath), client);
  t.deepEqual(filesystemCalls, []);
  t.deepEqual(provisionCalls, []);
  stopFails = false;
  await E(provisioner).provision(
    'network-retry',
    harden({ network: 'private' }),
  );
  t.is(stops, 2);
  t.is(provisionCalls.length, 1);
  t.is(provisionCalls[0].spec.network, 'private');
  t.not(names.get(clientPath), client);
});

test('factory rollback preserves a predecessor whose policy-change stop failed', async t => {
  t.timeout(2000);
  const { hostAgent, names, cancelled } = makeRecordingHost();
  const filesystemCalls = [];
  const provisionCalls = [];
  const removedDirectories = [];
  let stopFails = true;
  let stops = 0;
  let bridges = 0;
  let closedBridges = 0;
  let grants = 0;
  let revocations = 0;
  names.set('opencode-sandbox/sessions', harden({ kind: 'directory' }));
  const clientPath = 'opencode-sandbox/sessions/opencode-client-policy-retry';
  const predecessor = Far('RetainedPredecessor', {
    async status() {
      return harden({ network: 'none' });
    },
    async terminate() {
      stops += 1;
      if (stopFails) throw Error('predecessor still live');
    },
  });
  names.set(clientPath, predecessor);
  const provisioner = makeOpencodeSessionProvisioner(hostAgent, baseConfig, {
    async makeFilesystem(name) {
      filesystemCalls.push(name);
      names.set(name, harden({}));
    },
    provisionSession: makeFakeProvisionSession(names, provisionCalls),
    async removeDirectory(directory) {
      removedDirectories.push(directory);
    },
  });
  const factory = makeOpencodeBackendFactory({
    async provisionClient(sessionId, options) {
      await E(provisioner).provision(sessionId, harden(options));
      return E(provisioner).lookup(sessionId);
    },
    cancelClient: sessionId => E(provisioner).cancel(sessionId),
    removeSession: sessionId => E(provisioner).remove(sessionId),
    async startToolBridge() {
      bridges += 1;
      return harden({
        socketDir: '/tmp/fake-policy-mcp',
        innerDir: '/endo-mcp',
        configPath: '/endo-mcp/mcp.json',
        pendingCalls: () => 0,
        async close() {
          closedBridges += 1;
        },
      });
    },
    async removeToolBridge() {
      throw Error('must not delete bridge storage before stop proof');
    },
    async broker() {
      grants += 1;
      return harden({
        async attestation() {
          return harden({ endpoint: 'http://127.0.0.1:41337' });
        },
        async sandboxEvidence() {
          return harden({ brokerSidecar: { container: 'provider-policy' } });
        },
        async revoke() {
          revocations += 1;
        },
      });
    },
  });
  const spec = harden({ sessionId: 'policy-retry' });
  const toolSet = Far('HostedToolSet', { help: () => 'test tool set' });
  await t.throwsAsync(() => E(factory).create(spec, toolSet), {
    instanceOf: AggregateError,
    message: /provisioning and rollback failed/,
  });
  t.is(stops, 2, 'both policy replacement and rollback require direct stop');
  t.is(names.get(clientPath), predecessor);
  t.deepEqual(cancelled, []);
  t.is(revocations, 1);
  t.is(closedBridges, 1);
  await t.throwsAsync(() => E(factory).create(spec, toolSet), {
    instanceOf: AggregateError,
    message: /cleanup remains pending/,
  });
  await t.throwsAsync(() => E(factory).destroy(spec), {
    instanceOf: AggregateError,
    message: /cleanup remains pending/,
  });
  t.is(stops, 4);
  t.is(bridges, 1);
  t.is(grants, 1);
  t.is(names.get(clientPath), predecessor);
  t.deepEqual(cancelled, []);
  t.deepEqual(filesystemCalls, []);
  t.deepEqual(provisionCalls, []);
  t.deepEqual(removedDirectories, []);

  stopFails = false;
  await E(factory).create(spec, toolSet);
  t.is(cancelled.length, 1);
  t.is(provisionCalls.length, 1);
  t.is(provisionCalls[0].spec.network, 'join');
  t.not(names.get(clientPath), predecessor);
  t.is(bridges, 2);
  t.is(grants, 2);
  t.is(revocations, 1, 'successful rollback releases are not repeated');
});
