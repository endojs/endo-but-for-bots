// @ts-check
/* eslint-disable no-empty-function */

// End-to-end contract for designs/runtime-container-fs-mount.md across the
// three real pieces, with nothing mocked between them: the floot attach
// registrar, `@endo/claude-sandbox`'s 9P bridge provider, and a real
// `ClaudeClient` caplet. Only the outermost edges are fakes — the daemon host
// agent, the 9P mounter, and the sandbox factory — so what these tests pin is
// exactly the wiring the design promises: a capability a session holds
// becomes a bind under `/mnt/` in the slice's mount list, survives an attach
// restart, and is released when the last reference goes away.
//
// `packages/floot/test/container-mounts.test.js` covers the registrar's own
// behavior against fakes; this file covers the seams between packages.

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import { makeContainerMountBridgeProvider } from '@endo/claude-sandbox/src/container-mount-bridge.js';
import { make as makeClaudeClientCaplet } from '@endo/claude-sandbox/src/claude-client-module.js';

import { makeContainerMountRegistrar } from '../src/container-mounts.js';

const CLIENT_ENV = harden({
  SESSION_ID: 'sess-mnt',
  CREATED_AT: '2026-01-01T00:00:00.000Z',
  WORKSPACE_MOUNT_POINT: '/host/mounts/sess-mnt-workspace',
  WORKSPACE_PATH: '/workspace',
  BACKEND: 'podman',
  NETWORK: 'private',
  CLAUDE_ROOTFS: 'oci:example/claude:latest',
});

/**
 * The host's side of the world: a daemon host agent (formula ids, mount pet
 * names), a 9P mounter, a sandbox factory, and the factory petstore the
 * registrar persists into. Everything between them — the bridge provider, the
 * registrar, and the ClaudeClient — is the real implementation.
 */
const makeWorld = () => {
  /** @type {Map<string, unknown>} */
  const hostNames = new Map();
  /** @type {Map<string, unknown>} */
  const capsById = new Map();
  /** @type {{ fs: unknown, mountPoint: string, opts: any }[]} */
  const nineP = [];
  /** @type {string[]} */
  const unmounted = [];

  const hostAgent = harden({
    async has(...path) {
      return hostNames.has(path.join('/'));
    },
    async lookup(nameOrPath) {
      return hostNames.get(
        Array.isArray(nameOrPath) ? nameOrPath.join('/') : nameOrPath,
      );
    },
    async remove(...path) {
      hostNames.delete(path.join('/'));
    },
    async lookupById(id) {
      if (!capsById.has(id)) throw Error(`unknown formula id ${id}`);
      return capsById.get(id);
    },
    async provideMount(mountPath, name, opts) {
      const cap = harden({
        kind: 'daemon-mount',
        mountPath,
        readOnly: !!opts?.readOnly,
      });
      hostNames.set(name, cap);
      return cap;
    },
  });

  const fsMounter = harden({
    async mount(fs, mountPoint, opts) {
      nineP.push({ fs, mountPoint, opts });
      return Far('FakeFs9pMountHandle', {
        async unmount() {
          unmounted.push(mountPoint);
        },
      });
    },
  });

  // The bridge provider is a caplet whose live-bridge map is worker-local, so
  // a daemon restart hands out a fresh one over the same host authority. The
  // registrar resolves it lazily per use, which is what lets a test swap it.
  const makeBridgeProvider = () =>
    makeContainerMountBridgeProvider(
      hostAgent,
      { mountBaseDir: '/host/mounts' },
      { getFsMounter: async () => fsMounter },
    );
  let bridgeProvider = makeBridgeProvider();

  // The registrar's own persistence lives in the floot factory's petstore.
  /** @type {Map<string, unknown>} */
  const factoryNames = new Map();
  const factoryPowers = harden({
    async list() {
      return harden([...factoryNames.keys()]);
    },
    async has(name) {
      return factoryNames.has(name);
    },
    async lookup(name) {
      if (!factoryNames.has(name)) throw Error(`missing ${name}`);
      return factoryNames.get(name);
    },
    async remove(name) {
      factoryNames.delete(name);
    },
    async storeValue(value, name) {
      if (factoryNames.has(name)) throw Error(`cannot overwrite ${name}`);
      factoryNames.set(name, value);
    },
  });

  // One incarnation of the sandbox slice + its ClaudeClient. A "daemon
  // restart" builds a second one over the same petstore, exactly as the
  // client formula reincarnates.
  const makeIncarnation = (/** @type {any} */ t) => {
    /** @type {any[][]} */
    const sliceMounts = [];
    let disposals = 0;
    const sandboxFactory = harden({
      async make(opts) {
        sliceMounts.push([...opts.mounts]);
        return harden({
          async spawn() {
            return harden({
              async stdout() {
                return harden({ kind: 'fake-stdout' });
              },
              async kill() {},
              async wait() {
                return harden({ code: 0, signal: null });
              },
            });
          },
          async dispose() {
            disposals += 1;
          },
        });
      },
    });
    // The per-session powers cap the claude-sandbox factory mints: the four
    // caps by reference plus a provideMount bounded to this session's
    // workspace mountpoint. No `lookup`.
    const sessionPowers = harden({
      async sandboxFactory() {
        return sandboxFactory;
      },
      async fsMounter() {
        return fsMounter;
      },
      async filesystem() {
        return harden({ kind: 'workspace-fs' });
      },
      async credentials() {
        return null;
      },
      async provideMount(mountPath, petName) {
        return harden({ kind: 'workspace-mount', mountPath, petName });
      },
      async removeMount() {},
    });
    const client = makeClaudeClientCaplet(
      /** @type {any} */ (sessionPowers),
      undefined,
      { env: CLIENT_ENV },
    );
    // A ClaudeClient owns a slice and its 9P mounts; release them with the
    // test that minted it, whether or not the test terminates it itself.
    t.teardown(() => client.terminate());
    return {
      client,
      sliceMounts,
      disposals: () => disposals,
      /** The bind list of the most recent slice, as innerPath→mode. */
      lastBinds: () =>
        Object.fromEntries(
          (sliceMounts[sliceMounts.length - 1] || []).map(mount => [
            mount.innerPath,
            mount.mode,
          ]),
        ),
    };
  };

  const makeRegistrar = () =>
    makeContainerMountRegistrar({
      powers: factoryPowers,
      getBridgeProvider: async () => bridgeProvider,
    });

  /**
   * A session guest whose petstore resolves pet names to cap formula ids.
   *
   * @param {[string, string][]} entries - pet name → cap formula id
   */
  const makeGuest = entries =>
    harden({
      async identify(...path) {
        return new Map(entries).get(path.join('/'));
      },
    });

  return {
    capsById,
    hostNames,
    nineP,
    unmounted,
    factoryNames,
    /** The records in the newest attach-journal snapshot, or undefined. */
    storedRecords: () => {
      const journal = [...factoryNames.keys()]
        .filter(name => name.startsWith('floot-container-mounts-v1-'))
        .sort();
      if (journal.length === 0) return undefined;
      return /** @type {any} */ (
        factoryNames.get(/** @type {string} */ (journal.at(-1)))
      ).records;
    },
    makeIncarnation,
    makeRegistrar,
    makeGuest,
    /** Drop the worker-local bridge state, as a daemon restart does. */
    restartHostServices: () => {
      bridgeProvider = makeBridgeProvider();
    },
    // The workspace 9P mount is remounted on every slice recreate, so the
    // assertions below read the attach bridges alone — the host names them
    // under the bridge's own prefix.
    attachMounts: () =>
      nineP.filter(mount => mount.mountPoint.includes('/claude-attach-')),
    attachUnmounts: () =>
      unmounted.filter(mountPoint => mountPoint.includes('/claude-attach-')),
    attachMountNames: () =>
      [...hostNames.keys()].filter(name => name.startsWith('claude-attach-')),
  };
};

/**
 * Run one turn to completion. `send()` returns its reply reader before the
 * turn has run, and it is the turn that provisions the slice, so a test that
 * only awaited `send()` would assert against a slice that does not exist yet.
 * The fake stdout is not a real byte stream, so the turn ends in an `abort`;
 * what these tests read is the mount list it provisioned with.
 *
 * @param {any} client
 * @param {string} prompt
 */
const runTurn = async (client, prompt) => {
  for await (const event of iterateReader(await client.send(prompt))) {
    void event;
  }
};

/** A daemon `Mount`-shaped capability, the common attach subject. */
const mountShapedCap = () =>
  harden({
    __getMethodNames__: () => ['entry', 'has', 'list', 'readText', 'writeText'],
  });

test('a held capability becomes a /mnt/ bind in the slice, and survives a restart', async t => {
  const world = makeWorld();
  world.capsById.set('cap-project', mountShapedCap());

  const registrar = world.makeRegistrar();
  const first = world.makeIncarnation(t);
  const kit = registrar.makeSessionKit({
    sessionId: 'sess-mnt',
    sessionGuest: world.makeGuest([['project', 'cap-project']]),
  });
  await kit.arm({ clientKey: 'client-formula-1', client: first.client });

  // A turn provisions the slice with the workspace alone.
  await runTurn(first.client, 'hello');
  t.deepEqual(first.lastBinds(), { '/workspace': 'rw' });

  // Attach: the registrar proves possession against the session guest's own
  // petstore, the bridge serves the cap over 9P at a HOST-picked mountpoint,
  // and the slice is recreated with the bind.
  const info = await kit.attach({
    petName: 'project',
    innerPath: '/mnt/project',
  });
  t.like(info, {
    innerPath: '/mnt/project',
    mode: 'rw',
    petName: 'project',
    heldByThisSession: true,
  });
  t.is(world.attachMounts().length, 1);
  t.true(
    world
      .attachMounts()[0]
      .mountPoint.startsWith('/host/mounts/claude-attach-'),
  );
  // The served filesystem is a projection OF the cap, never the raw host
  // path: the cap stays the policy.
  t.not(world.attachMounts()[0].fs, world.capsById.get('cap-project'));
  // The live slice was disposed and immediately re-minted with the bind.
  t.is(first.disposals(), 1);
  t.is(first.sliceMounts.length, 2);
  t.deepEqual(first.lastBinds(), {
    '/workspace': 'rw',
    '/mnt/project': 'rw',
  });
  // The bind carries the daemon Mount cap the bridge registered under its
  // deterministic host mount pet name, not some other object.
  const bound = first.sliceMounts[1].find(m => m.innerPath === '/mnt/project');
  t.is(world.attachMountNames().length, 1);
  t.is(bound.cap, world.hostNames.get(world.attachMountNames()[0]));

  // "Daemon restart": every worker-local map is gone — a fresh bridge
  // provider, a fresh registrar over the same factory petstore, and a fresh
  // client incarnation. Arming replays the persisted attach onto the same
  // deterministic host mountpoint, and the bind lands before any turn runs.
  world.restartHostServices();
  const restarted = world.makeRegistrar();
  const second = world.makeIncarnation(t);
  const kitAfter = restarted.makeSessionKit({
    sessionId: 'sess-mnt',
    sessionGuest: world.makeGuest([['project', 'cap-project']]),
  });
  await kitAfter.arm({ clientKey: 'client-formula-1', client: second.client });
  t.is(world.attachMounts().length, 2);
  t.is(world.attachMounts()[1].mountPoint, world.attachMounts()[0].mountPoint);

  // The replayed client had not provisioned yet, so the bind simply applies
  // on its first lazy provision rather than costing a recreate.
  t.is(second.sliceMounts.length, 0);
  await runTurn(second.client, 'after restart');
  t.deepEqual(second.lastBinds(), {
    '/workspace': 'rw',
    '/mnt/project': 'rw',
  });
  t.deepEqual(
    (await kitAfter.list()).map(record => record.innerPath),
    ['/mnt/project'],
  );
});

test('a read-only capability is bound read-only at every layer', async t => {
  const world = makeWorld();
  world.capsById.set('cap-src', mountShapedCap());
  const registrar = world.makeRegistrar();
  const incarnation = world.makeIncarnation(t);
  const kit = registrar.makeSessionKit({
    sessionId: 'sess-mnt',
    sessionGuest: world.makeGuest([['endo-src', 'cap-src']]),
  });
  await kit.arm({ clientKey: 'ck-ro', client: incarnation.client });

  await kit.attach({
    petName: 'endo-src',
    innerPath: '/mnt/endo-src',
    mode: 'ro',
  });
  // Kernel mount, daemon Mount cap, and slice bind all say read-only.
  t.true(world.attachMounts()[0].opts.readOnly);
  t.true(
    /** @type {any} */ (world.hostNames.get(world.attachMountNames()[0]))
      .readOnly,
  );
  await runTurn(incarnation.client, 'look');
  t.deepEqual(incarnation.lastBinds(), {
    '/workspace': 'rw',
    '/mnt/endo-src': 'ro',
  });
});

test('the last detach recreates without the bind, then releases the 9P mount', async t => {
  const world = makeWorld();
  world.capsById.set('cap-work', mountShapedCap());
  const registrar = world.makeRegistrar();
  const incarnation = world.makeIncarnation(t);
  const kit = registrar.makeSessionKit({
    sessionId: 'sess-mnt',
    sessionGuest: world.makeGuest([['work', 'cap-work']]),
  });
  await kit.arm({ clientKey: 'ck-detach', client: incarnation.client });
  await kit.attach({ petName: 'work', innerPath: '/mnt/work' });
  await runTurn(incarnation.client, 'edit');
  t.deepEqual(incarnation.lastBinds(), {
    '/workspace': 'rw',
    '/mnt/work': 'rw',
  });
  t.deepEqual(world.attachUnmounts(), []);

  const result = await kit.detach({ innerPath: '/mnt/work' });
  t.true(result.released);
  // Ordering is load-bearing: the slice loses the bind first, and only then
  // is the 9P mount torn down — unmounting under a live container bind
  // would be busy.
  t.deepEqual(incarnation.lastBinds(), { '/workspace': 'rw' });
  t.deepEqual(world.attachUnmounts(), [world.attachMounts()[0].mountPoint]);
  t.deepEqual(world.attachMountNames(), []);
  t.deepEqual([...world.storedRecords()], []);
});

test('terminate leaves the bridges to the registrar that minted them', async t => {
  const world = makeWorld();
  world.capsById.set('cap-a', mountShapedCap());
  world.capsById.set('cap-b', mountShapedCap());
  const registrar = world.makeRegistrar();
  const incarnation = world.makeIncarnation(t);
  const kit = registrar.makeSessionKit({
    sessionId: 'sess-mnt',
    sessionGuest: world.makeGuest([
      ['a', 'cap-a'],
      ['b', 'cap-b'],
    ]),
  });
  await kit.arm({ clientKey: 'ck-term', client: incarnation.client });
  await kit.attach({ petName: 'a', innerPath: '/mnt/a' });
  await kit.attach({ petName: 'b', innerPath: '/mnt/b' });
  await runTurn(incarnation.client, 'work');
  t.deepEqual(incarnation.lastBinds(), {
    '/workspace': 'rw',
    '/mnt/a': 'rw',
    '/mnt/b': 'rw',
  });

  // A bridge is three things — a kernel mount, a daemon Mount pet name, and
  // the provider's cache entry — and only the provider drops all three
  // together. If terminate unmounted the handles here, the provider's cache
  // would still hold them under their DETERMINISTIC keys, and the next
  // request for the same key would be served a Mount cap over an empty
  // directory that the slice binds without complaint.
  await incarnation.client.terminate();
  t.deepEqual(world.attachUnmounts(), []);
  t.is(world.attachMountNames().length, 2);

  // The registrar is what releases them, and it still can.
  await registrar.releaseSession('sess-mnt');
  t.is(world.attachUnmounts().length, 2);
  t.deepEqual(world.attachMountNames(), []);
  t.deepEqual([...world.storedRecords()], []);
});

test('an attach the bridge refuses leaves no record and no bind', async t => {
  const world = makeWorld();
  // A capability that is not filesystem-like: the bridge cannot serve it.
  world.capsById.set(
    'cap-opaque',
    harden({ __getMethodNames__: () => ['help'] }),
  );
  const registrar = world.makeRegistrar();
  const incarnation = world.makeIncarnation(t);
  const kit = registrar.makeSessionKit({
    sessionId: 'sess-mnt',
    sessionGuest: world.makeGuest([['opaque', 'cap-opaque']]),
  });
  await kit.arm({ clientKey: 'ck-bad', client: incarnation.client });
  await runTurn(incarnation.client, 'hello');

  await t.throwsAsync(
    () => kit.attach({ petName: 'opaque', innerPath: '/mnt/opaque' }),
    { message: /not filesystem-like/ },
  );
  // No phantom record to poison every later replay, and the live slice was
  // never recreated.
  t.is(world.storedRecords(), undefined);
  t.is(incarnation.sliceMounts.length, 1);
  t.deepEqual(incarnation.lastBinds(), { '/workspace': 'rw' });
});
