// @ts-check
import { E } from '@endo/far';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import test from '@endo/ses-ava/test.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';

import { makeTestOcapn } from '../_util.js';
import { makeFixture } from './_fixture.js';

/** @param {Awaited<ReturnType<typeof makeFixture>>} fixture */
const parkWorkers = async fixture => {
  // Startup replays pending journals, and parking one vat can deliver traffic
  // that wakes another. Drain transport queues until the whole graph is asleep.
  for (let pass = 0; pass < 10; pass += 1) {
    for (const id of fixture.daemon.listWorkerIds()) {
      // eslint-disable-next-line no-await-in-loop
      await fixture.daemon.getWorker(id).sleep();
    }
    if (fixture.daemon.inspectReachability().workers.every(node => !node.awake))
      return;
  }
  throw Error('Workers did not quiesce after parking');
};

test.serial(
  'reachability explains publication and cross-vat roots, then collects the unrooted island across restart',
  async t => {
    t.timeout(120_000);
    const fixture = await makeFixture(t);
    await fixture.restart();
    // Recovery may already have awakened the owner. Exercise that condition
    // explicitly so this test does not depend on random worker iteration order.
    await fixture.daemon.getWorker(fixture.ownerId).wake();
    await parkWorkers(fixture);
    const report = fixture.daemon.inspectReachability();
    t.deepEqual(report.collectible, []);
    t.deepEqual(
      report.workers.find(node => node.workerId === fixture.guestId).roots,
      [{ kind: 'publication' }],
    );
    t.deepEqual(
      report.workers.find(node => node.workerId === fixture.ownerId).path,
      [fixture.guestId, fixture.ownerId],
    );
    t.true(
      report.workers.every(node => !node.awake),
      'inspection never wakes a vat',
    );
    t.deepEqual(await fixture.daemon.collectVats(), []);
    fixture.daemon.unpublish(fixture.publication);
    await fixture.restart();
    await parkWorkers(fixture);
    const snapshotPaths = [fixture.guestId, fixture.ownerId].map(id => {
      const snapshot = fixture.store.provideWorkerStore(id).getMeta().snapshot;
      if (!snapshot) throw Error('Expected a persisted heap snapshot');
      return join(
        fixture.statePath,
        'heaps',
        'snapshots',
        `${snapshot.ref}.sqlite`,
      );
    });
    t.deepEqual(
      fixture.daemon.inspectReachability().collectible,
      [fixture.guestId, fixture.ownerId].sort(),
    );
    // Retirement traffic can wake another candidate. Subsequent quiescent passes
    // must still remove the complete island without resurrecting deleted stores.
    for (let pass = 0; pass < 3; pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      await parkWorkers(fixture);
      // eslint-disable-next-line no-await-in-loop
      await fixture.daemon.collectVats();
      // eslint-disable-next-line no-await-in-loop
      await fixture.restart(true);
    }
    t.deepEqual(fixture.daemon.listWorkerIds(), []);
    t.deepEqual(
      fixture.store.listWorkerIds(),
      ['e'.repeat(32)],
      'only endpoint session metadata remains',
    );
    for (const path of snapshotPaths) {
      // eslint-disable-next-line no-await-in-loop
      await t.throwsAsync(() => access(path), { code: 'ENOENT' });
    }
  },
);

test.serial(
  'a live remote connection retains an unpublished vat until disconnect',
  async t => {
    t.timeout(120_000);
    const fixture = await makeFixture(t);
    const peer = await makeTestOcapn({
      codec: syrupCodec,
      network: (handlers, logger) => makeTcpNetLayer({ handlers, logger }),
    });
    t.teardown(() => peer.shutdown());
    const root = await peer.enlivenSturdyRef(
      peer.makeSturdyRef(fixture.daemon.location, fixture.publication),
    );
    t.is(await E(root).read(), 0n);
    fixture.daemon.unpublish(fixture.publication);
    await parkWorkers(fixture);
    const report = fixture.daemon.inspectReachability();
    t.true(
      report.workers
        .find(node => node.workerId === fixture.guestId)
        .roots.some(
          reason =>
            reason.kind === 'remote-session' &&
            reason.connected &&
            !reason.durable,
        ),
    );
    t.deepEqual(await fixture.daemon.collectVats(), []);
    peer.shutdown();
    let disconnected = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      await setImmediate();
      if (
        fixture.daemon
          .inspectReachability()
          .workers.every(node =>
            node.roots.every(reason => reason.kind !== 'remote-session'),
          )
      ) {
        disconnected = true;
        break;
      }
    }
    t.true(disconnected);
    await fixture.restart();
    await parkWorkers(fixture);
    t.deepEqual(
      fixture.daemon.inspectReachability().collectible,
      [fixture.ownerId, fixture.guestId].sort(),
    );
  },
);

test.serial(
  'a retained worker facade protects a sleeping vat before it exports an application object',
  async t => {
    t.timeout(120_000);
    const fixture = await makeFixture(t);
    const guest = fixture.daemon.getWorker(fixture.guestId);
    const controller = fixture.daemon.makeResource('worker-controller');
    const facadeId = await guest.evaluate(
      "(async () => { globalThis.onlyFacade = await E(controller).createWorker('facade-only'); return E(onlyFacade).getId(); })()",
      { controller },
    );
    await fixture.restart();
    const report = fixture.daemon.inspectReachability();
    t.true(
      report.references.some(
        edge =>
          edge.holder === fixture.guestId &&
          edge.target === facadeId &&
          edge.kind === 'worker-facade' &&
          edge.retaining,
      ),
    );
    t.false(report.collectible.includes(facadeId));
    await fixture.daemon.collectVats();
    t.true(fixture.daemon.listWorkerIds().includes(facadeId));
    const result = await fixture.daemon
      .getWorker(fixture.guestId)
      .evaluate("E(onlyFacade).evaluate('42n')");
    t.is(result, 42n);
    t.is(await E(await fixture.guest()).read(), 0n);
  },
);

test.serial(
  'a pending host answer retains a sleeping vat and releases it after settlement',
  async t => {
    t.timeout(60_000);
    const fixture = await makeFixture(t);
    const worker = await fixture.daemon.createWorker({
      debugLabel: 'pending-host-answer',
    });
    await worker.evaluate(
      'globalThis.waiting = new Promise(resolve => { globalThis.finish = resolve; }); undefined',
    );
    const pending = worker.evaluate('waiting');
    // Register rejection handling immediately; teardown may close a regressed call.
    void pending.catch(() => {});
    // A later evaluation is a delivery barrier for the pending call.
    t.is(await worker.evaluate('17n'), 17n);
    await worker.sleep();
    t.false(worker.isAwake());
    const report = fixture.daemon.inspectReachability();
    t.true(
      report.workers
        .find(node => node.workerId === worker.workerId)
        .roots.some(reason => reason.kind === 'host-operation'),
    );
    t.false((await fixture.daemon.collectVats()).includes(worker.workerId));
    await worker.evaluate('finish(42n); undefined');
    t.is(await pending, 42n);
    await worker.sleep();
    const settled = fixture.daemon.inspectReachability();
    t.true(
      settled.collectible.includes(worker.workerId),
      'settled cached answers and shell imports do not retain the vat',
    );
    t.true((await fixture.daemon.collectVats()).includes(worker.workerId));
  },
);
