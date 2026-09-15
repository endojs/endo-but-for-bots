// @ts-check
/**
 * The durable-manager / ephemeral-resource-vat pair.
 * See designs/manual-persistence-vats.md.
 */
import test from '@endo/ses-ava/test.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makeAdapterKeeper } from '../src/adapter-keeper.js';
import { makePeerSnapshottingReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeFsStore } from '../src/store/store-fs.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { parkWorkers } from './_park-workers.js';

const nodePowers = makeNodePowers();

/** @param {string} statePath */
const makeDaemon = statePath =>
  makeThixotropeDaemon(nodePowers, {
    store: makeFsStore(nodePowers, statePath),
    engine: makePeerSnapshottingReplayEngine(nodePowers),
    codec: syrupCodec,
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });

// The adapter: working state that must not outlive its process.
const ADAPTER_SOURCE = `
(() => {
  const open = new Map();
  return Far('Adapter', {
    restore: entries => {
      for (const [key, value] of entries) open.set(key, value);
      return open.size;
    },
    bind: (key, value) => { open.set(key, value); return open.size; },
    lookup: key => open.get(key),
    count: () => open.size,
  });
})()
`;

test.serial('an ephemeral worker is retired at the next startup', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-ephemeral-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  /** @type {string} */
  let durableId;
  /** @type {string} */
  let ephemeralId;

  {
    const d1 = await makeDaemon(statePath);
    t.teardown(() => d1.shutdown().catch(() => {}));
    const durable = await d1.createWorker({ debugLabel: 'manager' });
    const ephemeral = await d1.createWorker({
      debugLabel: 'adapter',
      ephemeral: true,
    });
    durableId = durable.workerId;
    ephemeralId = ephemeral.workerId;
    t.is(await ephemeral.evaluate('6n * 7n'), 42n);
    await parkWorkers(d1);
    await d1.crash();
  }

  {
    const d2 = await makeDaemon(statePath);
    t.teardown(() => d2.shutdown());
    const ids = d2.listWorkerIds();
    t.true(ids.includes(durableId), 'the durable worker came back');
    t.false(ids.includes(ephemeralId), 'the ephemeral worker did not');
  }
});

test.serial('a manager rebuilds its resource vat after a restart', async t => {
  t.timeout(60_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-keeper-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  // The manager's own source: durable desired state, plus a keeper for the
  // ephemeral adapter. Everything here survives; nothing in the adapter does.
  const managerSource = `
    (() => {
      const desired = new Map();
      const keeper = (${makeAdapterKeeper.toString()})({
        vats,
        source: ${JSON.stringify(ADAPTER_SOURCE)},
        debugLabel: 'adapter',
        restore: adapter => E(adapter).restore([...desired]),
      });
      return Far('Manager', {
        serve: async (key, value) => {
          desired.set(key, value);
          const adapter = await E(keeper).provide();
          return E(adapter).bind(key, value);
        },
        lookup: async key => {
          const adapter = await E(keeper).provide();
          return E(adapter).lookup(key);
        },
        reconcile: async () => {
          const adapter = await E(keeper).provide();
          return E(adapter).count();
        },
        desired: () => harden([...desired]),
        incarnations: async () => (await E(keeper).status()).incarnations,
      });
    })()
  `;

  /** @type {string} */
  let managerId;

  {
    const d1 = await makeDaemon(statePath);
    t.teardown(() => d1.shutdown().catch(() => {}));
    const manager = await d1.createWorker({ debugLabel: 'manager' });
    managerId = manager.workerId;
    const root = await manager.evaluate(managerSource, {
      vats: d1.makeResource('worker-controller'),
    });
    d1.publish(root, 'manager-cap');

    t.is(await E(root).serve('a', 'alpha'), 1);
    t.is(await E(root).serve('b', 'beta'), 2);
    t.is(await E(root).lookup('a'), 'alpha');
    t.is(await E(root).incarnations(), 1n, 'one adapter so far');
    t.is(d1.listWorkerIds().length, 2, 'manager plus adapter');

    await parkWorkers(d1);
    await d1.crash();
  }

  {
    const d2 = await makeDaemon(statePath);
    t.teardown(() => d2.shutdown());

    t.deepEqual(d2.listWorkerIds(), [managerId], 'the adapter is gone');

    const root = await d2.lookup('manager-cap');
    t.deepEqual(
      await E(root).desired(),
      [
        ['a', 'alpha'],
        ['b', 'beta'],
      ],
      'the manager still knows what it wanted',
    );

    // The manager's cached adapter reference is a tombstone now. `provide`
    // discovers that, builds a fresh vat, and restores the desired set into it
    // before answering.
    t.is(await E(root).reconcile(), 2, 'the new adapter holds both entries');
    t.is(await E(root).lookup('b'), 'beta');
    t.is(await E(root).incarnations(), 2n, 'a second incarnation was built');
    t.is(d2.listWorkerIds().length, 2, 'manager plus a new adapter');
  }
});

test.serial('retiring the adapter builds another on next use', async t => {
  t.timeout(60_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-keeper-retire-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  const daemon = await makeDaemon(statePath);
  t.teardown(() => daemon.shutdown());
  const manager = await daemon.createWorker({ debugLabel: 'manager' });
  const root = await manager.evaluate(
    `
    (() => {
      const desired = new Map();
      const keeper = (${makeAdapterKeeper.toString()})({
        vats,
        source: ${JSON.stringify(ADAPTER_SOURCE)},
        debugLabel: 'adapter',
        restore: adapter => E(adapter).restore([...desired]),
      });
      return Far('Manager', {
        serve: async (key, value) => {
          desired.set(key, value);
          const adapter = await E(keeper).provide();
          return E(adapter).bind(key, value);
        },
        count: async () => E(await E(keeper).provide()).count(),
        drop: () => E(keeper).retire(),
        incarnations: async () => (await E(keeper).status()).incarnations,
      });
    })()
    `,
    { vats: daemon.makeResource('worker-controller') },
  );

  await E(root).serve('a', 'alpha');
  t.is(await E(root).count(), 1);
  t.true(await E(root).drop(), 'the adapter was retired');
  t.is(daemon.listWorkerIds().length, 1, 'only the manager is left');

  t.is(await E(root).count(), 1, 'a fresh adapter was restored from desired');
  t.is(await E(root).incarnations(), 2n);
});
