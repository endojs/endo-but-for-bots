// @ts-check
import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeClaudeSessionProvisioner } from '../src/claude-session-provisioner.js';

const keyFor = names => names.join('/');

/**
 * `EndoHost.lookup` takes ONE name-or-path argument. A fake that accepted the
 * rest-args form instead would let a two-argument call pass here and fail
 * against the daemon, so the fakes below hold the real arity.
 *
 * @param {...unknown} args
 */
const lookupKeyFor = (...args) => {
  if (args.length !== 1) {
    throw Error(
      `lookup takes one name-or-path argument, got ${args.length}: ${JSON.stringify(args)}`,
    );
  }
  const [nameOrPath] = args;
  return keyFor(
    Array.isArray(nameOrPath)
      ? nameOrPath
      : [/** @type {string} */ (nameOrPath)],
  );
};

test('provisions and removes one isolated client per Floot session', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const hostAgent = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async lookup(...path) {
      return names.get(lookupKeyFor(...path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
  });
  const filesystemCalls = [];
  const provisionCalls = [];
  const removedDirectories = [];
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem(name, directory) {
        filesystemCalls.push({ name, directory });
        names.set(name, harden({}));
      },
      // The real signature declares `options` optional; mirror its defaults
      // (the provisioner always passes it).
      async provisionSession(_host, spec, options = {}) {
        provisionCalls.push({ spec, options });
        names.set(keyFor(options.resultName), harden({ client: spec.name }));
        for (const name of options.removeNames ?? []) {
          names.delete(keyFor(Array.isArray(name) ? name : [name]));
        }
        return harden({
          client: names.get(keyFor(options.resultName)),
          sessionId: 'sandbox-session',
          hostMountPoint: '/mount',
          rootfsLabel: 'test',
        });
      },
      async removeDirectory(directory, options) {
        removedDirectories.push({ directory, options });
      },
    },
  );

  const [first, second] = await Promise.all([
    E(provisioner).provision('session-a'),
    E(provisioner).provision('session-a'),
  ]);
  t.is(first, 'claude-client-session-a');
  t.is(second, first);
  // Two filesystems: the user-facing workspace and the dedicated persistent
  // Claude config dir (a sibling of the workspace base by default).
  t.deepEqual(filesystemCalls, [
    {
      name: 'claude-workspace-session-a',
      directory: '/workspaces/session-a',
    },
    {
      name: 'claude-config-session-a',
      directory: '/claude-configs/session-a',
    },
  ]);
  t.is(provisionCalls.length, 1);
  t.deepEqual(provisionCalls[0].options.resultName, [
    'floot',
    'controller-profile',
    'claude-client-session-a',
  ]);
  // The config filesystem is forwarded so the client can mount it and detect a
  // pre-restart transcript.
  t.is(provisionCalls[0].spec.configFilesystemName, 'claude-config-session-a');
  t.is(provisionCalls[0].spec.configHostDir, '/claude-configs/session-a');
  t.true(names.has('floot/controller-profile/claude-client-session-a'));

  await E(provisioner).remove('session-a');
  t.false(names.has('floot/controller-profile/claude-client-session-a'));
  // Both the workspace and the (always-private) config dir are deleted.
  t.deepEqual(removedDirectories, [
    {
      directory: '/workspaces/session-a',
      options: { recursive: true, force: true },
    },
    {
      directory: '/claude-configs/session-a',
      options: { recursive: true, force: true },
    },
  ]);
});

test('forwards the MCP tool-bridge mount options to the session provisioner', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const hostAgent = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async lookup(...path) {
      return names.get(lookupKeyFor(...path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
  });
  const provisionCalls = [];
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem(name) {
        names.set(name, harden({}));
      },
      // Optional `options` mirrors the real signature; the provisioner
      // ignores the result, so a bare client stub suffices.
      async provisionSession(_host, spec, options = {}) {
        provisionCalls.push({ spec, options });
        names.set(keyFor(options.resultName), harden({ client: spec.name }));
        return /** @type {any} */ (harden({ client: spec.name }));
      },
    },
  );

  const mcp = {
    socketDir: '/tmp/floot-mcp/session-b',
    innerDir: '/endo-mcp',
    configPath: '/endo-mcp/mcp.json',
  };
  await E(provisioner).provision('session-b', harden({ mcp }));
  t.is(provisionCalls.length, 1);
  t.deepEqual(provisionCalls[0].spec.mcp, mcp);
});

test('a workspaceDir override roots the filesystem at a shared worktree', async t => {
  /** @type {Map<string, unknown>} */
  const names = new Map();
  const hostAgent = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async lookup(...path) {
      return names.get(lookupKeyFor(...path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
  });
  const filesystemCalls = [];
  const removedDirectories = [];
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem(name, directory) {
        filesystemCalls.push({ name, directory });
        names.set(name, harden({}));
      },
      // Optional `options` mirrors the real signature; the provisioner
      // ignores the result, so a bare client stub suffices.
      async provisionSession(_host, spec, options = {}) {
        names.set(keyFor(options.resultName), harden({ client: spec.name }));
        return /** @type {any} */ (harden({ client: spec.name }));
      },
      async removeDirectory(directory, options) {
        removedDirectories.push({ directory, options });
      },
    },
  );

  await E(provisioner).provision(
    'session-c',
    harden({ workspaceDir: '/git/worktrees/session-c' }),
  );
  // The workspace filesystem is rooted at the shared worktree, not the private
  // per-session scratch directory. The config dir is ALWAYS the private path,
  // so the transcript never lands in the shared worktree.
  t.deepEqual(filesystemCalls, [
    {
      name: 'claude-workspace-session-c',
      directory: '/git/worktrees/session-c',
    },
    {
      name: 'claude-config-session-c',
      directory: '/claude-configs/session-c',
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
      directory: '/claude-configs/session-c',
      options: { recursive: true, force: true },
    },
  ]);
});

test('rejects session ids that could escape its namespace', async t => {
  const hostAgent = harden({});
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
    },
    {
      async makeFilesystem() {
        return undefined;
      },
      async provisionSession() {
        throw Error('must not provision');
      },
    },
  );

  await t.throwsAsync(() => E(provisioner).provision('../escape'), {
    message: /Invalid Floot session id/,
  });
});

// ---------------------------------------------------------------------------
// Container mount bridges (designs/runtime-container-fs-mount.md)
// ---------------------------------------------------------------------------

/**
 * Harness for the bridge methods: a Map-backed host agent with
 * `lookupById` / `provideMount`, an injectable fake 9P mounter, and caps of
 * each shape the bridge must recognise.
 *
 * @param {object} [options]
 * @param {boolean} [options.resolveFsMounterByName] Withhold the injected
 *   mounter and publish it under its namespaced pet name instead, so the
 *   provisioner's own resolution runs — the path production takes.
 */
const makeBridgeHarness = (options = {}) => {
  const { resolveFsMounterByName = false } = options;
  /** @type {Map<string, unknown>} */
  const names = new Map();
  /** @type {Map<string, unknown>} */
  const byId = new Map();
  const provideMountCalls = [];
  const hostAgent = harden({
    async has(...path) {
      return names.has(keyFor(path));
    },
    async lookup(...path) {
      return names.get(lookupKeyFor(...path));
    },
    async remove(...path) {
      names.delete(keyFor(path));
    },
    async lookupById(id) {
      if (!byId.has(id)) throw Error(`unknown id ${id}`);
      return byId.get(id);
    },
    async provideMount(path, name, opts) {
      const cap = harden({ kind: 'attach-mount', path, name });
      provideMountCalls.push({ path, name, opts });
      names.set(name, cap);
      return cap;
    },
  });
  const mountCalls = [];
  const unmounts = [];
  const fsMounter = harden({
    async mount(fs, mountPoint, opts) {
      // A real 9P handle is an exo; the guard on the bridge result demands a
      // declared remotable, so the fake must be Far too.
      const handle = Far('FakeFs9pMountHandle', {
        async unmount() {
          unmounts.push(mountPoint);
        },
      });
      mountCalls.push({ fs, mountPoint, opts, handle });
      return handle;
    },
  });
  if (resolveFsMounterByName) {
    names.set(keyFor(['claude-sandbox', 'fs-mounter']), fsMounter);
  }
  const provisioner = makeClaudeSessionProvisioner(
    hostAgent,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
      attachMountBaseDir: '/attach-mounts',
    },
    {
      async makeFilesystem() {
        return undefined;
      },
      async provisionSession() {
        throw Error('unused in bridge tests');
      },
      ...(resolveFsMounterByName
        ? {}
        : { getFsMounter: async () => fsMounter }),
    },
  );
  return {
    names,
    byId,
    provideMountCalls,
    mountCalls,
    unmounts,
    provisioner,
  };
};

test('resolves the namespaced 9P mounter through the host agent', async t => {
  // Every other bridge test hands the mounter in directly, which skips the
  // resolution production performs — and that resolution asked for the
  // namespace and the name as two arguments, which `lookup` rejects, so every
  // attach failed before it reached a bind.
  const h = makeBridgeHarness({ resolveFsMounterByName: true });
  h.byId.set(
    'cap-1',
    harden({
      __getMethodNames__: () => ['entry', 'list', 'readText', 'writeText'],
    }),
  );

  await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'abc123', capId: 'cap-1', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);
  t.is(h.mountCalls[0].mountPoint, '/attach-mounts/claude-attach-abc123');
});

test('bridges a Mount-shaped cap over 9P at a host-picked layout', async t => {
  const h = makeBridgeHarness();
  // A daemon Mount surface: readText + entry (among others).
  h.byId.set(
    'cap-1',
    harden({
      __getMethodNames__: () => [
        'entry',
        'has',
        'list',
        'lookup',
        'readText',
        'writeText',
      ],
    }),
  );

  const bridge = await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'abc123', capId: 'cap-1', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);
  t.is(h.mountCalls[0].mountPoint, '/attach-mounts/claude-attach-abc123');
  t.true(h.mountCalls[0].opts.lazyUnmount);
  t.false(h.mountCalls[0].opts.readOnly);
  // The Mount cap is wrapped as a Filesystem before serving (not passed raw).
  t.not(h.mountCalls[0].fs, h.byId.get('cap-1'));
  t.deepEqual(h.provideMountCalls, [
    {
      path: '/attach-mounts/claude-attach-abc123',
      name: 'claude-attach-abc123',
      opts: { readOnly: false },
    },
  ]);
  t.is(bridge.mountCap, h.names.get('claude-attach-abc123'));
  t.truthy(bridge.handle);

  // Idempotent per key: a replay reuses the live bridge.
  const again = await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'abc123', capId: 'cap-1', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);
  t.is(again.mountCap, bridge.mountCap);

  await E(h.provisioner).releaseContainerMountBridge('abc123');
  t.deepEqual(h.unmounts, ['/attach-mounts/claude-attach-abc123']);
  t.false(h.names.has('claude-attach-abc123'));

  // Releasing again is a no-op, not an error.
  await E(h.provisioner).releaseContainerMountBridge('abc123');
  t.is(h.unmounts.length, 1);
});

test('an EndoGit cap attaches its worktree', async t => {
  const h = makeBridgeHarness();
  let worktreeCalls = 0;
  const worktree = harden({
    __getMethodNames__: () => ['entry', 'readText', 'writeText'],
  });
  h.byId.set(
    'git-1',
    harden({
      __getMethodNames__: () => ['worktree', 'status', 'diff', 'add', 'commit'],
      async worktree() {
        worktreeCalls += 1;
        return worktree;
      },
    }),
  );

  await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'gitkey', capId: 'git-1', mode: 'rw' }),
  );
  t.is(worktreeCalls, 1);
  t.is(h.mountCalls.length, 1);
  // The served filesystem must derive from the WORKTREE, not the git cap
  // itself (serving the repo object would break in-container git).
  t.not(h.mountCalls[0].fs, h.byId.get('git-1'));
});

test('a Filesystem cap is served as-is, and ro mode pins every layer', async t => {
  const h = makeBridgeHarness();
  const filesystem = harden({
    __getMethodNames__: () => ['root', 'named', 'statfs', 'brands', 'help'],
  });
  h.byId.set('fs-1', filesystem);

  await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'fskey', capId: 'fs-1', mode: 'ro' }),
  );
  t.is(h.mountCalls[0].fs, filesystem);
  t.true(h.mountCalls[0].opts.readOnly);
  t.true(h.provideMountCalls[0].opts.readOnly);
});

test('rejects caps that are not filesystem-like and malformed requests', async t => {
  const h = makeBridgeHarness();
  h.byId.set('opaque-1', harden({ __getMethodNames__: () => ['help'] }));

  await t.throwsAsync(
    () =>
      E(h.provisioner).provideContainerMountBridge(
        harden({ key: 'k1', capId: 'opaque-1' }),
      ),
    { message: /not filesystem-like/ },
  );
  // A failed resolution leaves no bridge behind.
  t.is(h.mountCalls.length, 0);

  await t.throwsAsync(
    () =>
      E(h.provisioner).provideContainerMountBridge(
        harden({ key: '../escape', capId: 'opaque-1' }),
      ),
    { message: /Invalid container mount bridge key/ },
  );
  await t.throwsAsync(
    () =>
      E(h.provisioner).provideContainerMountBridge(
        harden({ key: 'k1', capId: 'opaque-1', mode: 'rwx' }),
      ),
    { message: /mode must be/ },
  );
  await t.throwsAsync(
    () => E(h.provisioner).provideContainerMountBridge(harden({ key: 'k1' })),
    { message: /capId must be/ },
  );
});

test('a provideMount failure unmounts the fresh 9P bridge', async t => {
  const h = makeBridgeHarness();
  h.byId.set(
    'cap-2',
    harden({ __getMethodNames__: () => ['entry', 'readText'] }),
  );
  const failingHost = harden({
    async has() {
      return false;
    },
    async lookupById(id) {
      return h.byId.get(id);
    },
    async provideMount() {
      throw Error('mount registration failed');
    },
  });
  const unmounts = [];
  const fsMounter = harden({
    async mount(_fs, mountPoint) {
      return Far('FakeFs9pMountHandle', {
        async unmount() {
          unmounts.push(mountPoint);
        },
      });
    },
  });
  const provisioner = makeClaudeSessionProvisioner(
    failingHost,
    {
      flootDir: 'floot',
      clientBase: 'claude-client',
      credentialsName: 'claude-creds',
      workspaceBaseDir: '/workspaces',
      rootfs: 'oci:test',
      attachMountBaseDir: '/attach-mounts',
    },
    {
      async makeFilesystem() {
        return undefined;
      },
      async provisionSession() {
        throw Error('unused');
      },
      getFsMounter: async () => fsMounter,
    },
  );

  await t.throwsAsync(
    () =>
      E(provisioner).provideContainerMountBridge(
        harden({ key: 'k2', capId: 'cap-2' }),
      ),
    { message: /mount registration failed/ },
  );
  t.deepEqual(unmounts, ['/attach-mounts/claude-attach-k2']);
});

test('a cached bridge that does not match the requested capId/mode is re-minted', async t => {
  const h = makeBridgeHarness();
  h.byId.set(
    'cap-m',
    harden({ __getMethodNames__: () => ['entry', 'readText', 'writeText'] }),
  );

  const first = await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'modekey', capId: 'cap-m', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);
  t.false(h.mountCalls[0].opts.readOnly);

  // Same key, different mode (a detach whose release was swallowed followed
  // by a re-attach): serving the cached rw bridge would leave the kernel
  // mount and daemon Mount cap enforcing the WRONG mode. It must be torn
  // down and re-minted read-only.
  const second = await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'modekey', capId: 'cap-m', mode: 'ro' }),
  );
  t.is(h.unmounts.length, 1); // the stale rw bridge was unmounted
  t.is(h.mountCalls.length, 2);
  t.true(h.mountCalls[1].opts.readOnly);
  t.true(h.provideMountCalls[1].opts.readOnly);
  t.not(second.handle, first.handle);

  // Now cached under the new mode: a matching replay reuses it.
  await E(h.provisioner).provideContainerMountBridge(
    harden({ key: 'modekey', capId: 'cap-m', mode: 'ro' }),
  );
  t.is(h.mountCalls.length, 2);
});
