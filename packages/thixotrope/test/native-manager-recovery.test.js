// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';

import { installNative, removeInstallation } from '../src/control/install.js';
import { makeInstallations } from '../src/control/installations.js';
import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerSnapshottingReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeMemoryStore } from '../src/store/store-memory.js';

const powers = makeNodePowers();
const bundle = `(() => {
  globalThis.loads = (globalThis.loads ?? 0) + 1;
  return { make: () => {
    globalThis.factories = (globalThis.factories ?? 0) + 1;
    let starts = 0;
    return harden({
      facet: Far('Registration', { loads: () => loads, factories: () => factories, starts: () => starts }),
      lifecycle: Far('Lifecycle', { started: () => { starts += 1; } }),
      // Implementation helpers need not be passable across vats.
      helper: () => undefined,
    });
  }};
})()`;
const options = harden({
  name: 'resource',
  digest: 'pinned-code',
  allocationKey: '1'.repeat(32),
  bundle,
  makeAdapters: () => Far('UnusedAdapters', {}),
});

/** @param {ReturnType<typeof makeMemoryStore>} store */
const start = store =>
  makeThixotropeDaemon(powers, {
    store,
    engine: makePeerSnapshottingReplayEngine(powers),
    codec: syrupCodec,
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });

for (const phase of [
  'allocation',
  'attachment',
  'initialization',
  'notice',
  'inventory',
]) {
  test.serial(`native installation resumes after ${phase} commits`, async t => {
    t.timeout(30_000);
    const store = makeMemoryStore();
    const first = await start(store);
    t.teardown(() => first.crash());
    const workspace = await first.createWorker({ debugLabel: 'workspace' });
    const root = await workspace.evaluate(`(() => {
      globalThis.inventory = new Map();
      globalThis.installations = (${makeInstallations.toString()})(inventory);
      return Far('Workspace', {});
    })()`);
    first.publish(root, 'workspace');
    const interrupted = () => {
      throw Error('interrupted after commit');
    };
    const wrap = manager =>
      harden({
        ...manager,
        evaluate: async (source, endowments) => {
          const result = await manager.evaluate(source, endowments);
          if (
            phase === 'initialization' &&
            source.includes('globalThis.eval(source)')
          )
            interrupted();
          return result;
        },
        notifyOnStart: target => {
          const result = manager.notifyOnStart(target);
          if (phase === 'notice') interrupted();
          return result;
        },
      });
    const installingDaemon = harden({
      ...first,
      createWorker: async config => {
        const manager = await first.createWorker(config);
        if (phase === 'allocation') interrupted();
        return wrap(manager);
      },
      getWorker: id => wrap(first.getWorker(id)),
    });
    const installingWorkspace = harden({
      ...workspace,
      evaluate: async (source, endowments) => {
        const result = await workspace.evaluate(source, endowments);
        if (
          (phase === 'attachment' && source.includes('installations.attach')) ||
          (phase === 'inventory' && source.includes('installations.finish'))
        )
          interrupted();
        return result;
      },
    });
    await t.throwsAsync(
      () => installNative(installingDaemon, installingWorkspace, options),
      {
        message: 'interrupted after commit',
      },
    );
    const managerId = first
      .inspectWorkers()
      .find(worker => worker.debugLabel === 'native:resource')?.workerId;
    t.truthy(managerId);
    if (managerId === undefined) throw Error('Manager was not allocated');
    await first.crash();

    const second = await start(store);
    t.teardown(() => second.shutdown());
    const restored = second.getWorker(workspace.workerId);
    await installNative(second, restored, {
      ...options,
      allocationKey: '2'.repeat(32),
    });
    const managers = second
      .inspectWorkers()
      .filter(worker => worker.debugLabel === 'native:resource');
    t.is(managers.length, 1);
    t.is(managers[0].workerId, managerId);
    const registration = await restored.evaluate("inventory.get('resource')");
    t.is(await E(registration).loads(), 1);
    t.is(await E(registration).factories(), 1);
    const manager = second.getWorker(managers[0].workerId);
    await manager.sleep();
    await restored.sleep();
    t.false((await second.collectVats()).includes(managers[0].workerId));
    // Its own lifecycle publication keeps the manager recoverable even when
    // the workspace is no longer present to dispatch anything.
    await restored.retire();
    await second.crash();
    const third = await start(store);
    t.teardown(() => third.shutdown());
    t.true(
      await third
        .getWorker(managers[0].workerId)
        .evaluate(
          'E(nativeManager.kit.facet).starts().then(count => count >= 1)',
        ),
    );
  });
}

test.serial(
  'failed native factory stays in its manager and does not rerun',
  async t => {
    t.timeout(30_000);
    const daemon = await start(makeMemoryStore());
    t.teardown(() => daemon.shutdown());
    const workspace = await daemon.createWorker({ debugLabel: 'workspace' });
    await workspace.evaluate(`(globalThis.inventory = new Map(),
    globalThis.installations = (${makeInstallations.toString()})(inventory), true)`);
    const broken = {
      ...options,
      bundle: `({make: () => {
    globalThis.attempts = (globalThis.attempts ?? 0) + 1;
    throw Error('factory failed');
  }})`,
    };
    await t.throwsAsync(() => installNative(daemon, workspace, broken), {
      message: /factory failed/,
    });
    await t.throwsAsync(() => installNative(daemon, workspace, broken), {
      message: /factory failed/,
    });
    t.is(await workspace.evaluate('6 * 7'), 42);
    t.is(await workspace.evaluate('typeof attempts'), 'undefined');
    const managers = daemon
      .inspectWorkers()
      .filter(worker => worker.debugLabel === 'native:resource');
    t.is(managers.length, 1);
    t.is(await daemon.getWorker(managers[0].workerId).evaluate('attempts'), 1);

    // The name is not lost to the failure: removal retires the manager and a
    // corrected package installs under the same name.
    t.true(await removeInstallation(daemon, workspace, 'resource'));
    t.false(daemon.listWorkerIds().includes(managers[0].workerId));
    t.is(
      await workspace.evaluate('installations.lookup(name)', {
        name: 'resource',
      }),
      undefined,
    );
    t.false(await removeInstallation(daemon, workspace, 'resource'));
    await installNative(daemon, workspace, {
      ...options,
      digest: 'corrected-code',
    });
    t.is(
      await workspace.evaluate("E(inventory.get('resource')).factories()"),
      1,
    );
    const replacements = daemon
      .inspectWorkers()
      .filter(worker => worker.debugLabel === 'native:resource');
    t.is(replacements.length, 1);
    t.not(replacements[0].workerId, managers[0].workerId);
  },
);

test.serial(
  'a removal interrupted after retiring the manager is finished by the next install',
  async t => {
    t.timeout(30_000);
    const daemon = await start(makeMemoryStore());
    t.teardown(() => daemon.shutdown());
    const workspace = await daemon.createWorker({ debugLabel: 'workspace' });
    await workspace.evaluate(`(globalThis.inventory = new Map(),
    globalThis.installations = (${makeInstallations.toString()})(inventory), true)`);
    await installNative(daemon, workspace, options);
    const { workerId } = await workspace.evaluate(
      'installations.lookup(name)',
      { name: 'resource' },
    );
    // The removal's first step, with nothing after it.
    await daemon.getWorker(workerId).retire();
    t.true(await workspace.evaluate("inventory.has('resource')"));
    // A corrected package is the usual reason to remove; it must not be
    // refused as a different installation of the stale entry.
    await installNative(daemon, workspace, {
      ...options,
      digest: 'corrected-code',
    });
    const managers = daemon
      .inspectWorkers()
      .filter(worker => worker.debugLabel === 'native:resource');
    t.is(managers.length, 1);
    t.not(managers[0].workerId, workerId);
    t.is(await workspace.evaluate("E(inventory.get('resource')).starts()"), 0);
    t.deepEqual(
      await workspace.evaluate('installations.lookup(name)', {
        name: 'resource',
      }),
      { kind: 'native', workerId: managers[0].workerId, complete: true },
    );
    // The same interruption, retried by a removal rather than an install.
    await daemon.getWorker(managers[0].workerId).retire();
    t.true(await removeInstallation(daemon, workspace, 'resource'));
    t.false(await workspace.evaluate("inventory.has('resource')"));
    t.is(
      await workspace.evaluate('installations.lookup(name)', {
        name: 'resource',
      }),
      undefined,
    );
  },
);

test.serial(
  'allocation retries validate options and do not alias diagnostic labels',
  async t => {
    const daemon = await start(makeMemoryStore());
    t.teardown(() => daemon.shutdown());
    const first = await daemon.createWorker({
      debugLabel: 'same label',
      allocationKey: 'a'.repeat(32),
    });
    const second = await daemon.createWorker({
      debugLabel: 'same label',
      allocationKey: 'b'.repeat(32),
    });
    t.not(first.workerId, second.workerId);
    t.is(
      (
        await daemon.createWorker({
          debugLabel: 'same label',
          allocationKey: 'a'.repeat(32),
        })
      ).workerId,
      first.workerId,
    );
    await t.throwsAsync(
      () =>
        daemon.createWorker({
          debugLabel: 'changed label',
          allocationKey: 'a'.repeat(32),
        }),
      {
        message: /allocation options changed/,
      },
    );
    await t.throwsAsync(
      () =>
        daemon.createWorker({
          debugLabel: 'same label',
          ephemeral: true,
          allocationKey: 'a'.repeat(32),
        }),
      {
        message: /allocation options changed/,
      },
    );
  },
);
