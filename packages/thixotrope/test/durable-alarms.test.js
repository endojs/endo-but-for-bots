// @ts-check
/**
 * The manual-persistence alarm: a guest waits on a host promise, the host dies,
 * and the wait survives it. See designs/manual-persistence-vats.md.
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
import { makeFileSyncStringAtom } from '../src/store/file-sync-string-atom.js';
import { makeDurableAlarms } from '../src/alarms/durable-alarms.js';
import { makeGuestClock } from '../src/alarms/guest-clock.js';
import { makeNodePowers } from '../src/platform/node/powers.js';
import { parkWorkers } from './_park-workers.js';

const nodePowers = makeNodePowers();

const macrotask = () => new Promise(resolve => setTimeout(resolve, 0));
/** @param {() => Promise<boolean>} predicate */
const tickUntil = async predicate => {
  for (let i = 0; i < 1000; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await macrotask();
  }
  return false;
};

/**
 * Wall time is held by the caller so a test can step past a deadline without
 * waiting for it.
 * @param {string} statePath
 * @param {() => bigint} now
 */
const makeHost = async (statePath, now) => {
  /** @type {any} */
  let daemonRef;
  const alarms = makeDurableAlarms(nodePowers, {
    storage: makeFileSyncStringAtom(
      nodePowers.syncFiles,
      join(statePath, 'alarms.json'),
    ),
    makeResource: (name, description) =>
      daemonRef.makeResource(name, description),
    now,
  });
  const daemon = await makeThixotropeDaemon(nodePowers, {
    store: makeFsStore(nodePowers, statePath),
    engine: makePeerSnapshottingReplayEngine(nodePowers),
    codec: syrupCodec,
    resources: { alarm: alarms.resource, alarms: alarms.clockResource },
    makeNetlayer: ({ handlers, logger }) =>
      makeTcpNetLayer({ handlers, logger }),
  });
  daemonRef = daemon;
  // Sessions are restored by the time the daemon resolves; only then is it
  // safe to settle an alarm whose deadline has already passed.
  alarms.start();
  return { alarms, daemon };
};

test.serial(
  'a guest alarm survives a daemon restart and settles after it',
  async t => {
    t.timeout(30_000);
    const statePath = await mkdtemp(
      join(tmpdir(), 'thixotrope-durable-alarms-'),
    );
    t.teardown(() => rm(statePath, { recursive: true, force: true }));

    let clockNow = 1000n;
    const now = () => clockNow;

    {
      const { alarms, daemon } = await makeHost(statePath, now);
      const worker = await daemon.createWorker({ debugLabel: 'waiter' });
      const facet = daemon.makeResource('alarms', {
        workerId: worker.workerId,
      });

      const waiter = await worker.evaluate(
        `
      (() => {
        const clock = (${makeGuestClock.toString()})(alarms);
        let got = null;
        return Far('Waiter', {
          arm: async deadline => {
            const { settlement } = await E(clock).arm(deadline);
            Promise.resolve(settlement).then(
              at => { got = ['settled', String(at)]; },
              error => { got = ['broken', String((error && error.message) || error)]; },
            );
            return true;
          },
          getGot: () => got,
          pending: () => E(clock).pending(),
        });
      })()
      `,
        { alarms: facet },
      );

      t.true(await E(waiter).arm(5000n));
      t.is(await E(waiter).getGot(), null, 'pending before the deadline');
      t.is(alarms.status().armed, 1n, 'the host holds one durable row');

      daemon.publish(waiter, 'waiter-cap');
      await worker.sleep();
      alarms.shutdown();
      await daemon.crash();
    }

    {
      // A new process: the previous alarm's promise and resolver are both gone.
      const { alarms, daemon } = await makeHost(statePath, now);
      t.teardown(() => daemon.shutdown());
      t.teardown(() => alarms.shutdown());

      t.is(alarms.status().armed, 1n, 'the row reloaded from disk');
      const waiter = await daemon.lookup('waiter-cap');
      t.is(await E(waiter).getGot(), null, 'still pending after the restart');

      // Step past the deadline; the host re-arms and settles.
      clockNow = 6000n;
      alarms.start();

      /** @type {any} */
      let got = null;
      const ok = await tickUntil(async () => {
        got = await E(waiter).getGot();
        return got !== null;
      });
      t.true(ok, 'the guest listener settled after the restart');
      t.deepEqual(got, ['settled', '6000']);
      t.is(alarms.status().armed, 0n, 'the durable row was released');
    }
  },
);

test.serial('a due alarm wakes a sleeping vat', async t => {
  t.timeout(30_000);
  const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-alarm-wake-'));
  t.teardown(() => rm(statePath, { recursive: true, force: true }));

  let clockNow = 1000n;
  const { alarms, daemon } = await makeHost(statePath, () => clockNow);
  t.teardown(() => daemon.shutdown());
  t.teardown(() => alarms.shutdown());

  const worker = await daemon.createWorker({ debugLabel: 'sleeper' });
  const facet = daemon.makeResource('alarms', { workerId: worker.workerId });
  const waiter = await worker.evaluate(
    `
    (() => {
      const clock = (${makeGuestClock.toString()})(alarms);
      let got = null;
      return Far('Waiter', {
        arm: async deadline => {
          const { settlement } = await E(clock).arm(deadline);
          Promise.resolve(settlement).then(at => { got = String(at); });
          return true;
        },
        getGot: () => got,
      });
    })()
    `,
    { alarms: facet },
  );
  await E(waiter).arm(5000n);
  daemon.publish(waiter, 'waiter-cap');

  await parkWorkers(daemon);
  t.false(daemon.getWorker(worker.workerId).isAwake(), 'the vat is asleep');

  // Nothing calls into the vat. The settlement alone must wake it.
  clockNow = 6000n;
  alarms.start();

  const woke = await tickUntil(async () =>
    daemon.getWorker(worker.workerId).isAwake(),
  );
  t.true(woke, 'the settlement woke the sleeping vat');
  t.is(await E(waiter).getGot(), '6000');
});

test.serial(
  'an alarm already due at restart settles once the host starts',
  async t => {
    t.timeout(30_000);
    const statePath = await mkdtemp(
      join(tmpdir(), 'thixotrope-alarm-overdue-'),
    );
    t.teardown(() => rm(statePath, { recursive: true, force: true }));

    let clockNow = 1000n;
    const now = () => clockNow;

    {
      const { alarms, daemon } = await makeHost(statePath, now);
      const worker = await daemon.createWorker({ debugLabel: 'overdue' });
      const facet = daemon.makeResource('alarms', {
        workerId: worker.workerId,
      });
      const waiter = await worker.evaluate(
        `
      (() => {
        const clock = (${makeGuestClock.toString()})(alarms);
        let got = null;
        return Far('Waiter', {
          arm: async deadline => {
            const { settlement } = await E(clock).arm(deadline);
            Promise.resolve(settlement).then(at => { got = String(at); });
            return true;
          },
          getGot: () => got,
        });
      })()
      `,
        { alarms: facet },
      );
      await E(waiter).arm(5000n);
      daemon.publish(waiter, 'waiter-cap');
      await parkWorkers(daemon);
      alarms.shutdown();
      await daemon.crash();
    }

    // The deadline passes while no host is running at all.
    clockNow = 9000n;

    {
      const { alarms, daemon } = await makeHost(statePath, now);
      t.teardown(() => daemon.shutdown());
      t.teardown(() => alarms.shutdown());
      const waiter = await daemon.lookup('waiter-cap');
      /** @type {any} */
      let got = null;
      const ok = await tickUntil(async () => {
        got = await E(waiter).getGot();
        return got !== null;
      });
      t.true(ok, 'the overdue alarm settled on startup');
      t.is(got, '9000');
      t.is(alarms.status().armed, 0n);
    }
  },
);

test.serial(
  'cancel breaks the promise and releases the durable row',
  async t => {
    t.timeout(30_000);
    const statePath = await mkdtemp(join(tmpdir(), 'thixotrope-alarm-cancel-'));
    t.teardown(() => rm(statePath, { recursive: true, force: true }));

    const { alarms, daemon } = await makeHost(statePath, () => 1000n);
    t.teardown(() => daemon.shutdown());
    t.teardown(() => alarms.shutdown());

    const worker = await daemon.createWorker({ debugLabel: 'canceller' });
    const facet = daemon.makeResource('alarms', { workerId: worker.workerId });
    const waiter = await worker.evaluate(
      `
    (() => {
      const clock = (${makeGuestClock.toString()})(alarms);
      let got = null;
      let armedCanceller;
      return Far('Waiter', {
        arm: async deadline => {
          const { settlement, canceller } = await E(clock).arm(deadline);
          armedCanceller = canceller;
          Promise.resolve(settlement).then(
            at => { got = ['settled', String(at)]; },
            error => { got = ['broken', String((error && error.message) || error)]; },
          );
          return true;
        },
        drop: () => E(armedCanceller).cancel(),
        getGot: () => got,
      });
    })()
    `,
      { alarms: facet },
    );

    await E(waiter).arm(5000n);
    t.is(alarms.status().armed, 1n);
    t.true(await E(waiter).drop());
    t.is(alarms.status().armed, 0n, 'the durable row went with it');

    /** @type {any} */
    let got = null;
    const ok = await tickUntil(async () => {
      got = await E(waiter).getGot();
      return got !== null;
    });
    t.true(ok, 'the listener was broken');
    t.is(got[0], 'broken');
    t.regex(got[1], /cancelled/);
  },
);
