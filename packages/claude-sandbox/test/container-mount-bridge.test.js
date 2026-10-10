// @ts-nocheck

import '@endo/init';
import test from 'ava';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeContainerMountBridgeProvider } from '../src/container-mount-bridge.js';

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

/**
 * Build a mock root host plus the 9P mounter the bridge drives.
 *
 * @param {object} [options]
 * @param {boolean} [options.resolveFsMounterByName] Withhold the injected
 *   mounter and publish it under its namespaced pet name instead, so the
 *   bridge's own resolution runs — the path production takes.
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
  // Tests may make unmount reject, which is the failure the bridge must not
  // paper over: minting again at the same deterministic mountpoint would
  // stack a second 9P mount over the one still attached.
  let unmountFails = false;
  const fsMounter = harden({
    async mount(fs, mountPoint, opts) {
      // A real 9P handle is an exo; the guard on the bridge result demands a
      // declared remotable, so the fake must be Far too.
      const handle = Far('FakeFs9pMountHandle', {
        async unmount() {
          if (unmountFails) {
            throw Error('umount: target is busy');
          }
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
  const provider = makeContainerMountBridgeProvider(
    hostAgent,
    { mountBaseDir: '/attach-mounts' },
    resolveFsMounterByName ? {} : { getFsMounter: async () => fsMounter },
  );
  return {
    names,
    byId,
    provideMountCalls,
    mountCalls,
    unmounts,
    provider,
    failUnmounts: (/** @type {boolean} */ value) => {
      unmountFails = value;
    },
  };
};

test('resolves the namespaced 9P mounter through the host agent', async t => {
  // Every other bridge test hands the mounter in directly, which skips the
  // resolution production performs — and that resolution must ask for the
  // namespace and the name as ONE path argument, since `lookup` rejects two.
  const h = makeBridgeHarness({ resolveFsMounterByName: true });
  h.byId.set(
    'cap-1',
    harden({
      __getMethodNames__: () => ['entry', 'list', 'readText', 'writeText'],
    }),
  );

  await E(h.provider).provideContainerMountBridge(
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

  const bridge = await E(h.provider).provideContainerMountBridge(
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
  // The host mountpoint is reported for a runtime that binds by declared
  // path: it is host layout the bridge chose, never anything a guest wrote.
  t.is(bridge.mountPoint, '/attach-mounts/claude-attach-abc123');

  // Idempotent per key: a replay reuses the live bridge.
  const again = await E(h.provider).provideContainerMountBridge(
    harden({ key: 'abc123', capId: 'cap-1', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);
  t.is(again.mountCap, bridge.mountCap);
  t.is(again.mountPoint, bridge.mountPoint);

  await E(h.provider).releaseContainerMountBridge('abc123');
  t.deepEqual(h.unmounts, ['/attach-mounts/claude-attach-abc123']);
  t.false(h.names.has('claude-attach-abc123'));

  // Releasing again is a no-op, not an error.
  await E(h.provider).releaseContainerMountBridge('abc123');
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

  await E(h.provider).provideContainerMountBridge(
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

  await E(h.provider).provideContainerMountBridge(
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
      E(h.provider).provideContainerMountBridge(
        harden({ key: 'k1', capId: 'opaque-1' }),
      ),
    { message: /not filesystem-like/ },
  );
  // A failed resolution leaves no bridge behind.
  t.is(h.mountCalls.length, 0);

  await t.throwsAsync(
    () =>
      E(h.provider).provideContainerMountBridge(
        harden({ key: '../escape', capId: 'opaque-1' }),
      ),
    { message: /Invalid container mount bridge key/ },
  );
  await t.throwsAsync(
    () =>
      E(h.provider).provideContainerMountBridge(
        harden({ key: 'k1', capId: 'opaque-1', mode: 'rwx' }),
      ),
    { message: /mode must be/ },
  );
  await t.throwsAsync(
    () => E(h.provider).provideContainerMountBridge(harden({ key: 'k1' })),
    { message: /capId must be/ },
  );
});

test('a provideMount failure unmounts the fresh 9P bridge', async t => {
  const byId = new Map([
    ['cap-2', harden({ __getMethodNames__: () => ['entry', 'readText'] })],
  ]);
  const failingHost = harden({
    async has() {
      return false;
    },
    async lookupById(id) {
      return byId.get(id);
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
  const provider = makeContainerMountBridgeProvider(
    failingHost,
    { mountBaseDir: '/attach-mounts' },
    { getFsMounter: async () => fsMounter },
  );

  await t.throwsAsync(
    () =>
      E(provider).provideContainerMountBridge(
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

  const first = await E(h.provider).provideContainerMountBridge(
    harden({ key: 'modekey', capId: 'cap-m', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);
  t.false(h.mountCalls[0].opts.readOnly);

  // Same key, different mode (a detach whose release was swallowed followed
  // by a re-attach): serving the cached rw bridge would leave the kernel
  // mount and daemon Mount cap enforcing the WRONG mode. It must be torn
  // down and re-minted read-only.
  const second = await E(h.provider).provideContainerMountBridge(
    harden({ key: 'modekey', capId: 'cap-m', mode: 'ro' }),
  );
  t.is(h.unmounts.length, 1); // the stale rw bridge was unmounted
  t.is(h.mountCalls.length, 2);
  t.true(h.mountCalls[1].opts.readOnly);
  t.true(h.provideMountCalls[1].opts.readOnly);
  t.not(second.handle, first.handle);

  // Now cached under the new mode: a matching replay reuses it.
  await E(h.provider).provideContainerMountBridge(
    harden({ key: 'modekey', capId: 'cap-m', mode: 'ro' }),
  );
  t.is(h.mountCalls.length, 2);
});

test('concurrent provides for one key mint a single 9P mount', async t => {
  const h = makeBridgeHarness();
  h.byId.set(
    'cap-c',
    harden({ __getMethodNames__: () => ['entry', 'readText', 'writeText'] }),
  );

  // Two provides in flight at once: the per-key lock must serialize them so
  // the second finds the first's bridge in the cache rather than stacking a
  // second mount on the same mountpoint (leaking the loser).
  const [a, b] = await Promise.all([
    E(h.provider).provideContainerMountBridge(
      harden({ key: 'conc', capId: 'cap-c', mode: 'rw' }),
    ),
    E(h.provider).provideContainerMountBridge(
      harden({ key: 'conc', capId: 'cap-c', mode: 'rw' }),
    ),
  ]);
  t.is(h.mountCalls.length, 1);
  t.is(a.mountCap, b.mountCap);
  t.is(a.handle, b.handle);
});

test('a re-mint whose stale teardown fails is refused, not stacked', async t => {
  const h = makeBridgeHarness();
  h.byId.set(
    'cap-s',
    harden({ __getMethodNames__: () => ['entry', 'readText', 'writeText'] }),
  );
  await E(h.provider).provideContainerMountBridge(
    harden({ key: 'stale', capId: 'cap-s', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);

  // The same key with a different mode has to tear the stale bridge down
  // first. If that unmount fails, the mountpoint is still attached — minting
  // over it would stack two 9P mounts and leak the one underneath along with
  // its bridge server and socket.
  h.failUnmounts(true);
  await t.throwsAsync(
    () =>
      E(h.provider).provideContainerMountBridge(
        harden({ key: 'stale', capId: 'cap-s', mode: 'ro' }),
      ),
    { message: /could not release the stale bridge/ },
  );
  t.is(h.mountCalls.length, 1);

  // The cache entry was put back, so the bridge is still reachable — a
  // release can find it once the mountpoint frees up, and a matching
  // request still gets the live bridge rather than a second mount.
  h.failUnmounts(false);
  await E(h.provider).provideContainerMountBridge(
    harden({ key: 'stale', capId: 'cap-s', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 1);
  await E(h.provider).releaseContainerMountBridge('stale');
  t.deepEqual(h.unmounts, ['/attach-mounts/claude-attach-stale']);
});

test('a release whose unmount fails still drops the pet name', async t => {
  const h = makeBridgeHarness();
  h.byId.set(
    'cap-r',
    harden({ __getMethodNames__: () => ['entry', 'readText'] }),
  );
  await E(h.provider).provideContainerMountBridge(
    harden({ key: 'relfail', capId: 'cap-r', mode: 'rw' }),
  );
  t.true(h.names.has('claude-attach-relfail'));

  // The caller has already dropped whatever referenced this bridge, so
  // refusing would only strand it silently. The name goes; the still-live
  // mount is reported for an operator to reap.
  h.failUnmounts(true);
  await E(h.provider).releaseContainerMountBridge('relfail');
  t.deepEqual(h.unmounts, []);
  t.false(h.names.has('claude-attach-relfail'));

  // And the key is free again: a later provide mints a fresh bridge rather
  // than serving the one whose unmount failed.
  h.failUnmounts(false);
  await E(h.provider).provideContainerMountBridge(
    harden({ key: 'relfail', capId: 'cap-r', mode: 'rw' }),
  );
  t.is(h.mountCalls.length, 2);
});

test('a provide and a release for one key do not interleave', async t => {
  const h = makeBridgeHarness();
  h.byId.set(
    'cap-pr',
    harden({ __getMethodNames__: () => ['entry', 'readText'] }),
  );
  await E(h.provider).provideContainerMountBridge(
    harden({ key: 'prkey', capId: 'cap-pr', mode: 'rw' }),
  );

  // Issued together: without the per-key lock the release could remove the
  // pet name the provide just registered, cancelling a Mount formula the
  // cache still pointed at.
  await Promise.all([
    E(h.provider).releaseContainerMountBridge('prkey'),
    E(h.provider).provideContainerMountBridge(
      harden({ key: 'prkey', capId: 'cap-pr', mode: 'rw' }),
    ),
  ]);
  // Whichever order they ran in, the surviving state is coherent: the live
  // bridge's mountpoint is registered, and no mount is left without a name.
  const registered = h.names.has('claude-attach-prkey');
  const liveMounts = h.mountCalls.length - h.unmounts.length;
  t.is(registered ? 1 : 0, liveMounts);
});
