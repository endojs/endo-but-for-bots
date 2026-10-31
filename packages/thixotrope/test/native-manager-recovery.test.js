// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { PENDING_ANSWER_ABORTED_MESSAGE } from '@endo/ocapn';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { makePromiseKit } from '@endo/promise-kit';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { makeInstallationIndex } from '../src/control/installation-index.js';
import { makeInstaller } from '../src/control/installer.js';
import { makeRegistry } from '../src/control/registry.js';
import { makeWorkspaceAccess } from '../src/control/workspace-access.js';
import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerSnapshottingReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeSerialQueue } from '../src/serial-queue.js';
import { makeMemoryStore } from '../src/store/store-memory.js';

const powers = makeNodePowers();
const durableBundle = `(() => {
  globalThis.loads = (globalThis.loads ?? 0) + 1;
  return { make: () => {
    globalThis.factories = (globalThis.factories ?? 0) + 1;
    let starts = 0;
    return harden({
      facet: Far('Registration', { loads: () => loads, factories: () => factories, starts: () => starts }),
      lifecycle: Far('Lifecycle', { started: () => { starts += 1; }, exited: () => {} }),
      // Implementation helpers need not be passable across vats.
      helper: () => undefined,
    });
  }};
})()`;
const ephemeralPath = fileURLToPath(
  new URL('./fixtures/native-resource/ephemeral.js', import.meta.url),
);

/** A string atom in memory, for the index. */
const makeMemoryAtom = () => {
  /** @type {string | undefined} */
  let text;
  return harden({
    read: () => text,
    /** @param {string} next */
    write: next => {
      text = next;
    },
  });
};

/**
 * A daemon with the registry's host resources, as the supervisor wires
 * them, whose installer can be told to end the daemon right after one of
 * its operations has taken effect and before its answer is delivered: the
 * host restart the registry vat's driver is written to survive.
 *
 * @param {ReturnType<typeof makeMemoryStore>} store
 * @param {ReturnType<typeof makeInstallationIndex>} index
 * @param {{ after?: 'allocate' | 'installNativeModule' | 'record', collectAfterAllocate?: boolean }} [interrupt]
 */
const start = async (store, index, { after, collectAfterAllocate } = {}) => {
  /** @type {any} */
  let daemon;
  const daemonKit = makePromiseKit();
  /** @type {Promise<void> | undefined} */
  let crashed;
  // As the supervisor wires them: allocation and collection take turns, and
  // a vat handed out is kept until the registry names it again.
  const serialized = makeSerialQueue();
  /** @type {Set<string>} */
  const allocating = new Set();
  const kept = () =>
    [...allocating].filter(id => daemon.listWorkerIds().includes(id));
  /** @type {Promise<string[]> | undefined} */
  let collected;
  const never = new Promise(() => {});
  /**
   * @param {string} operation
   * @param {() => Promise<unknown>} run
   */
  const interrupting = async (operation, run) => {
    const result = await run();
    if (operation === after) {
      // The crash is made out of band, so the delivery in progress is one
      // the restart breaks rather than one that ends the daemon itself.
      crashed = setTimeout(0).then(() => daemon.crash());
      await never;
    }
    return result;
  };
  daemon = await makeThixotropeDaemon(powers, {
    store,
    engine: makePeerSnapshottingReplayEngine(powers),
    codec: syrupCodec,
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
    resources: {
      installer: () => {
        const installer = makeInstaller({
          daemon: daemonKit.promise,
          store,
          serialize: serialized,
          allocating,
        });
        return Far('InterruptibleInstaller', {
          /**
           * @param {string} label
           * @param {string} allocationKey
           */
          allocate: (label, allocationKey) => {
            // Called directly, so its serialised turn is queued now, and a
            // collection queued right behind it runs once the vat exists
            // and before its facade has reached the registry vat: where the
            // supervisor's `collect` can land.
            const allocated = installer.allocate(label, allocationKey);
            if (collectAfterAllocate)
              collected = serialized(() =>
                daemon.collectVats({ keep: kept() }),
              );
            return interrupting('allocate', () => allocated);
          },
          /**
           * @param {string} workerId
           * @param {string} bundleDigest
           */
          stage: (workerId, bundleDigest) =>
            E(installer).stage(workerId, bundleDigest),
          /**
           * @param {string} workerId
           * @param {string} durableDigest
           * @param {string} ephemeralDigest
           */
          installNativeModule: (workerId, durableDigest, ephemeralDigest) =>
            interrupting('installNativeModule', () =>
              E(installer).installNativeModule(
                workerId,
                durableDigest,
                ephemeralDigest,
              ),
            ),
          /** @param {string} workerId */
          retire: workerId => E(installer).retire(workerId),
        });
      },
      'installation-index': () => {
        const facet = index.resource();
        return Far('InterruptibleIndex', {
          /**
           * @param {string | undefined} workspace
           * @param {string} name
           * @param {any} entry
           */
          record: (workspace, name, entry) =>
            interrupting('record', async () =>
              E(facet).record(workspace, name, entry),
            ),
          /**
           * @param {string | undefined} workspace
           * @param {string} name
           */
          forget: (workspace, name) => E(facet).forget(workspace, name),
        });
      },
    },
  });
  daemonKit.resolve(daemon);
  return harden({
    daemon,
    crashed: () => crashed,
    collected: () => collected,
  });
};

/**
 * The registry vat, the workspace vat and the bundles, made once in a fresh
 * store; found again after a restart through the publications.
 * @param {any} daemon
 * @param {ReturnType<typeof makeMemoryStore>} store
 */
const bootstrap = async (daemon, store) => {
  const workspace = await daemon.createWorker({ debugLabel: 'workspace' });
  const access = await workspace.evaluate(`(() => {
    globalThis.inventory = new Map();
    return (globalThis.workspaceAccess = (${makeWorkspaceAccess.toString()})(inventory));
  })()`);
  daemon.publish(access, 'workspace');
  const registryVat = await daemon.createWorker({ debugLabel: 'registry' });
  const registry = await registryVat.evaluate(
    `(globalThis.registry ??= (${makeRegistry.toString()})({ installer, index, restartMessage }))`,
    {
      installer: daemon.makeResource('installer'),
      index: daemon.makeResource('installation-index'),
      restartMessage: PENDING_ANSWER_ABORTED_MESSAGE,
    },
  );
  daemon.publish(registry, 'registry');
  const durableDigest = store.putBundle(durableBundle);
  const ephemeralDigest = store.putBundle(
    await powers.bundler.bundleNative(ephemeralPath),
  );
  return harden({
    workspace,
    registry,
    access,
    durableDigest,
    ephemeralDigest,
  });
};

/**
 * @param {any} registry
 * @param {string} name
 * @param {string} status
 */
const waitForStatus = async (registry, name, status) => {
  let found;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    found = await E(registry).lookup(name, 'main');
    if (found?.status === status) return found;
    // eslint-disable-next-line no-await-in-loop
    await setTimeout(25);
  }
  const listed = (await E(registry).list()).find(entry => entry.name === name);
  throw Error(
    `${name} never became ${status}: ${found?.status} ${listed?.error ?? ''}`,
  );
};

for (const after of /** @type {const} */ ([
  'allocate',
  'installNativeModule',
  'record',
])) {
  test.serial(
    `a native installation resumes by itself after a host restart during ${after}`,
    async t => {
      t.timeout(60_000);
      const store = makeMemoryStore();
      const index = makeInstallationIndex(makeMemoryAtom());
      const first = await start(store, index, { after });
      t.teardown(() => first.daemon.crash().catch(() => {}));
      const { workspace, registry, access, durableDigest, ephemeralDigest } =
        await bootstrap(first.daemon, store);
      const request = harden({
        name: 'resource',
        kind: 'native',
        digest: 'pinned-code',
        allocationKey: '1'.repeat(32),
        workspace: 'main',
        access,
        durableDigest,
        ephemeralDigest,
      });
      // The host ends before this answer: the call is never answered by
      // this daemon, and its rejection, if any, is the session's to make.
      const installing = E(registry).install(request);
      void installing.catch(() => {});
      for (let i = 0; i < 400 && first.crashed() === undefined; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await setTimeout(25);
      }
      t.truthy(first.crashed(), 'the installer interrupted the daemon');
      await first.crashed();

      // The registry vat's driver resumes on its own: no retry from anyone.
      const second = await start(store, index);
      t.teardown(() => second.daemon.shutdown().catch(() => {}));
      const restoredRegistry = await second.daemon.lookup('registry');
      // The start's sweep, as the supervisor makes it: the resuming
      // installation's bundles are named, so none is freed from under it.
      second.daemon.sweepBundles(await E(restoredRegistry).bundles());
      t.like(await waitForStatus(restoredRegistry, 'resource', 'ready'), {
        kind: 'native',
      });
      const managers = second.daemon
        .inspectWorkers()
        .filter(
          (/** @type {{debugLabel?: string}} */ worker) =>
            worker.debugLabel === 'native:resource',
        );
      t.is(managers.length, 1, 'one manager vat, found again under its key');
      const restoredWorkspace = second.daemon.getWorker(workspace.workerId);
      const registration = await restoredWorkspace.evaluate(
        "inventory.get('resource')",
      );
      t.is(await E(registration).loads(), 1);
      t.is(await E(registration).factories(), 1);
      t.like(index.get('main', 'resource'), {
        status: 'ready',
        workerId: managers[0].workerId,
      });
      const manager = second.daemon.getWorker(managers[0].workerId);
      await manager.sleep();
      await restoredWorkspace.sleep();
      t.false(
        (await second.daemon.collectVats()).includes(managers[0].workerId),
        'the installed vat is retained through the workspace',
      );
      // Its own lifecycle publication keeps the manager recoverable even when
      // the workspace is no longer present to dispatch anything.
      await restoredWorkspace.retire();
      await second.daemon.crash();
      const third = await start(store, index);
      t.teardown(() => third.daemon.shutdown());
      t.true(
        await third.daemon
          .getWorker(managers[0].workerId)
          .evaluate(
            'E(nativeManager.kit.facet).starts().then(count => count >= 1)',
          ),
      );
    },
  );
}

test.serial(
  'failed native factory stays in its manager and does not rerun',
  async t => {
    t.timeout(30_000);
    const store = makeMemoryStore();
    const index = makeInstallationIndex(makeMemoryAtom());
    const { daemon } = await start(store, index);
    t.teardown(() => daemon.shutdown());
    const { workspace, registry, access, ephemeralDigest } = await bootstrap(
      daemon,
      store,
    );
    const brokenDigest = store.putBundle(`({make: () => {
      globalThis.attempts = (globalThis.attempts ?? 0) + 1;
      throw Error('factory failed');
    }})`);
    const request = harden({
      name: 'resource',
      kind: 'native',
      digest: 'broken-code',
      allocationKey: '2'.repeat(32),
      workspace: 'main',
      access,
      durableDigest: brokenDigest,
      ephemeralDigest,
    });
    const { result } = await E(registry).install(request);
    await t.throwsAsync(() => result, { message: /factory failed/ });
    const again = await E(registry).install(request);
    await t.throwsAsync(() => again.result, { message: /factory failed/ });
    t.is(await workspace.evaluate('typeof attempts'), 'undefined');
    const managers = daemon
      .inspectWorkers()
      .filter(
        (/** @type {{debugLabel?: string}} */ worker) =>
          worker.debugLabel === 'native:resource',
      );
    t.is(managers.length, 1);
    t.is(await daemon.getWorker(managers[0].workerId).evaluate('attempts'), 1);
    t.is(index.get('main', 'resource')?.status, 'failed');
    t.regex(index.get('main', 'resource')?.error ?? '', /factory failed/);

    // The name is not lost to the failure: removal retires the manager and a
    // corrected package installs under the same name.
    t.true(await E(registry).remove('resource', 'main'));
    t.false(daemon.listWorkerIds().includes(managers[0].workerId));
    t.is(await E(registry).lookup('resource', 'main'), undefined);
    t.is(index.get('main', 'resource'), undefined);
    t.false(await E(registry).remove('resource', 'main'));
    const corrected = await E(registry).install(
      harden({
        ...request,
        digest: 'corrected-code',
        allocationKey: '3'.repeat(32),
        durableDigest: store.putBundle(durableBundle),
        ephemeralDigest: store.putBundle(
          await powers.bundler.bundleNative(ephemeralPath),
        ),
      }),
    );
    const facet = await corrected.result;
    t.is(await E(facet).factories(), 1);
    t.is(
      await workspace.evaluate("inventory.get('resource') !== undefined"),
      true,
    );
  },
);

test.serial(
  'a collection queued behind an allocation keeps the vat for the registry',
  async t => {
    t.timeout(60_000);
    const store = makeMemoryStore();
    const index = makeInstallationIndex(makeMemoryAtom());
    const started = await start(store, index, { collectAfterAllocate: true });
    t.teardown(() => started.daemon.shutdown().catch(() => {}));
    const { registry, access, durableDigest, ephemeralDigest } =
      await bootstrap(started.daemon, store);
    const { result } = await E(registry).install(
      harden({
        name: 'resource',
        kind: 'native',
        digest: 'pinned-code',
        allocationKey: '2'.repeat(32),
        workspace: 'main',
        access,
        durableDigest,
        ephemeralDigest,
      }),
    );
    await result;
    // The facade was still on its way to the registry vat when the collection
    // ran: nothing but the host's keep rooted the new vat then.
    t.deepEqual(await started.collected(), []);
    const managers = started.daemon
      .inspectWorkers()
      .filter(
        (/** @type {{debugLabel?: string}} */ worker) =>
          worker.debugLabel === 'native:resource',
      );
    t.is(managers.length, 1);
    t.like(await E(registry).lookup('resource', 'main'), {
      status: 'ready',
      workerId: managers[0].workerId,
    });
  },
);
