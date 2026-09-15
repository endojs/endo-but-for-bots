// @ts-check
/**
 * Pins: wakefulness the host owes a vat.
 * See designs/manual-persistence-vats.md.
 */
import test from '@endo/ses-ava/test.js';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';

import { makeThixotropeDaemon } from '../src/core/daemon.js';
import { makePeerSnapshottingReplayEngine } from '../src/core/peer-replay-engine.js';
import { makeFsStore } from '../src/store/store-fs.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { parkWorkers } from './_park-workers.js';

const nodePowers = makeNodePowers();
const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));

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

test.serial('an eager pin wakes a vat with nothing pending', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-pin-eager-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  /** @type {string} */
  let pinnedId;
  /** @type {string} */
  let plainId;

  {
    const d1 = await makeDaemon(statePath);
    t.teardown(() => d1.shutdown().catch(() => {}));
    const pinned = await d1.createWorker({ debugLabel: 'pinned' });
    const plain = await d1.createWorker({ debugLabel: 'plain' });
    pinnedId = pinned.workerId;
    plainId = plain.workerId;
    await pinned.evaluate('1n');
    await plain.evaluate('1n');
    t.is(pinned.pin('eager'), 'eager');
    t.is(pinned.getPin(), 'eager');

    // Both fully checkpointed: without the pin, neither would be woken.
    await parkWorkers(d1);
    await d1.crash();
  }

  {
    const d2 = await makeDaemon(statePath);
    t.teardown(() => d2.shutdown());
    t.true(d2.getWorker(pinnedId).isAwake(), 'the pinned vat was woken');
    t.false(d2.getWorker(plainId).isAwake(), 'the unpinned one was not');
    t.is(d2.getWorker(pinnedId).getPin(), 'eager', 'the pin is durable');
  }
});

test.serial('unpin stops the next startup waking it', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-pin-unpin-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  /** @type {string} */
  let workerId;
  {
    const d1 = await makeDaemon(statePath);
    t.teardown(() => d1.shutdown().catch(() => {}));
    const worker = await d1.createWorker({
      debugLabel: 'pinned',
      pin: 'eager',
    });
    workerId = worker.workerId;
    await worker.evaluate('1n');
    t.is(worker.getPin(), 'eager', 'createWorker took the pin');
    worker.unpin();
    t.is(worker.getPin(), undefined);
    await parkWorkers(d1);
    await d1.crash();
  }
  {
    const d2 = await makeDaemon(statePath);
    t.teardown(() => d2.shutdown());
    t.false(d2.getWorker(workerId).isAwake());
  }
});

test.serial('a resident vat is exempt from idle sleep', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-pin-resident-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  // Idle sleep on a very short fuse, so the difference is visible quickly.
  const daemon = await makeDaemon(statePath, 20);
  t.teardown(() => daemon.shutdown());

  const resident = await daemon.createWorker({
    debugLabel: 'resident',
    pin: 'resident',
  });
  const plain = await daemon.createWorker({ debugLabel: 'plain' });
  await resident.evaluate('1n');
  await plain.evaluate('1n');

  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await macrotask();
    if (!plain.isAwake()) break;
  }
  t.false(plain.isAwake(), 'the unpinned vat idled out');
  t.true(resident.isAwake(), 'the resident vat did not');

  // Residency declines to park on the host's initiative; it does not refuse
  // an explicit request.
  await resident.sleep();
  t.false(resident.isAwake(), 'an explicit sleep is still honoured');
});

test.serial('a pinned vat is a retention root', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-pin-gc-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  const daemon = await makeDaemon(statePath);
  t.teardown(() => daemon.shutdown());

  // Nothing refers to either: only the pin distinguishes them.
  const pinned = await daemon.createWorker({
    debugLabel: 'pinned',
    pin: 'eager',
  });
  const plain = await daemon.createWorker({ debugLabel: 'plain' });
  await pinned.evaluate('1n');
  await plain.evaluate('1n');
  await parkWorkers(daemon);

  const collected = await daemon.collectVats();
  t.true(
    collected.includes(plain.workerId),
    'the unreferenced vat was collected',
  );
  t.false(
    collected.includes(pinned.workerId),
    'the pinned vat was not: waking one the collector may retire is incoherent',
  );
  t.true(
    daemon.listWorkerIds().includes(pinned.workerId),
    'and it is still there',
  );
});
