// @ts-check
/**
 * Start notices, and the residency an ephemeral vat gets for free.
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
import { makePeerSnapshottingReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeFsStore } from '../src/store/store-fs.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { parkWorkers } from './_park-workers.js';

const nodePowers = makeNodePowers();
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

/** @param {() => Promise<boolean>} predicate */
const tickUntil = async predicate => {
  for (let i = 0; i < 500; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await macrotask();
  }
  return false;
};

/** @param {string} statePath @param {number} [idleSleepMs] */
const makeDaemon = (statePath, idleSleepMs) =>
  makeThixotropeDaemon(nodePowers, {
    store: makeFsStore(nodePowers, statePath),
    engine: makePeerSnapshottingReplayEngine(nodePowers),
    codec: syrupCodec,
    ...(idleSleepMs === undefined ? {} : { idleSleepMs }),
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });

/** Records that `started()` was delivered, and survives restart to say so. */
const NOTICED_SOURCE = `
  (() => {
    let starts = 0;
    return Far('Noticed', {
      started: () => { starts += 1; },
      starts: () => starts,
    });
  })()
`;

/**
 * @param {Awaited<ReturnType<typeof makeDaemon>>} daemon
 * @param {string} workerId
 */
const workerMeta = (daemon, workerId) => {
  const meta = daemon.inspectWorkers().find(w => w.workerId === workerId);
  if (meta === undefined) throw Error(`no worker ${workerId}`);
  return meta;
};

test.serial('a start notice is delivered at every daemon startup', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-start-notice-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  {
    const d1 = await makeDaemon(statePath);
    t.teardown(() => d1.shutdown().catch(() => {}));
    const worker = await d1.createWorker({ debugLabel: 'noticed' });
    const root = await worker.evaluate(NOTICED_SOURCE);
    // The test's own publication, so later daemons can reach the root;
    // the start notice itself no longer needs one.
    d1.publish(root, 'noticed-cap');
    worker.notifyOnStart(root);
    t.true(workerMeta(d1, worker.workerId).startNotice);
    t.false(
      'startNotify' in workerMeta(d1, worker.workerId),
      'the publication secret never leaves the daemon',
    );
    t.is(await E(root).starts(), 0, 'nothing delivered yet');
    await parkWorkers(d1);
    await d1.crash();
  }

  {
    const d2 = await makeDaemon(statePath);
    t.teardown(() => d2.shutdown());
    const root = await d2.lookup('noticed-cap');
    // The delivery is the wake: nothing woke this vat first.
    t.true(await tickUntil(async () => (await E(root).starts()) === 1));
    await parkWorkers(d2);
    await d2.crash();
  }

  {
    // Every startup, not just the first.
    const d3 = await makeDaemon(statePath);
    t.teardown(() => d3.shutdown());
    const root = await d3.lookup('noticed-cap');
    t.true(await tickUntil(async () => (await E(root).starts()) === 2));
  }
});

test.serial('clearing the notice stops the delivery', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-notice-clear-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  {
    const d1 = await makeDaemon(statePath);
    t.teardown(() => d1.shutdown().catch(() => {}));
    const worker = await d1.createWorker({ debugLabel: 'noticed' });
    const root = await worker.evaluate(NOTICED_SOURCE);
    d1.publish(root, 'noticed-cap');
    worker.notifyOnStart(root);
    t.is(worker.clearStartNotice(), undefined);
    t.false(workerMeta(d1, worker.workerId).startNotice);
    await parkWorkers(d1);
    await d1.crash();
  }

  {
    const d2 = await makeDaemon(statePath);
    t.teardown(() => d2.shutdown());
    const root = await d2.lookup('noticed-cap');
    t.is(await E(root).starts(), 0, 'no start was delivered');
  }
});

test.serial('an ephemeral vat is resident without asking', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-resident-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  // Idle sleep on a very short fuse, so the difference shows quickly.
  const daemon = await makeDaemon(statePath, 20);
  t.teardown(() => daemon.shutdown());

  const ephemeral = await daemon.createWorker({
    debugLabel: 'adapter',
    ephemeral: true,
  });
  const durable = await daemon.createWorker({ debugLabel: 'plain' });
  await ephemeral.evaluate('1n');
  await durable.evaluate('1n');

  t.true(await tickUntil(async () => !durable.isAwake()));
  t.true(
    ephemeral.isAwake(),
    'the ephemeral vat did not idle out: its state is disposable anyway, and a ' +
      'resource adapter that sleeps is woken by the traffic it exists to absorb',
  );

  // Residency is the host declining to park on its own initiative, not a
  // refusal to obey a request.
  await ephemeral.sleep();
  t.false(ephemeral.isAwake(), 'an explicit sleep is still honoured');
});

test.serial(
  'retiring a noticed worker withdraws its start-notice publication',
  async t => {
    t.timeout(30_000);
    const statePath = await mkdtemp(
      join(tmpdir(), 'thixotrope-notice-retire-'),
    );
    t.teardown(() => rm(statePath, { recursive: true, force: true }));
    const d1 = await makeDaemon(statePath);
    t.teardown(() => d1.shutdown().catch(() => {}));
    const worker = await d1.createWorker({ debugLabel: 'noticed' });
    const root = await worker.evaluate(NOTICED_SOURCE);
    worker.notifyOnStart(root);
    const publications = () =>
      Object.keys(
        makeFsStore(nodePowers, statePath).getHubState().publications,
      );
    t.is(
      publications().length,
      1,
      'the daemon holds the notice under its own secret',
    );
    await worker.retire();
    t.deepEqual(
      publications(),
      [],
      'nothing is left pinned for a worker no later process could release',
    );
    t.deepEqual(d1.listWorkerIds(), []);
  },
);
