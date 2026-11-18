// @ts-check
// The session list channel in the agent-host adapter (M1b W1b.5,
// resources/agent-host/impl/list-channel.js): the snapshot marker first,
// batches in rev order (late older batch reordered, duplicates dropped, a
// gap given up after the wait), two subscribers see the same deliveries, a
// closed subscriber is dropped and costs nothing more, and the subscriber
// bounds close with a reason. Node adapter tests with hand-fired timers.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { shapes } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { channelLimits } from '../../config/defaults.js';
import { makeListChannel } from '../../resources/agent-host/impl/list-channel.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const makeManualSchedule = () => {
  /** @type {Set<{ fn: () => void, ms: number }>} */
  const pending = new Set();
  return {
    /**
     * @param {() => void} fn
     * @param {number} ms
     */
    schedule: (fn, ms) => {
      const entry = { fn, ms };
      pending.add(entry);
      return () => {
        pending.delete(entry);
      };
    },
    armed: () => [...pending].map(entry => entry.ms),
    fire: () => {
      const all = [...pending];
      pending.clear();
      for (const entry of all) entry.fn();
    },
  };
};

const session = Far('Session', {});
/** @param {string} title */
const rowEvent = title =>
  harden({
    type: 'row',
    row: {
      session,
      key: 's1',
      title,
      state: 'ready',
      activity: 'passive',
      backendTitle: 'b',
      modelId: 'm',
      messageCount: 0,
      queuedCount: 0,
    },
  });

/**
 * @param {any} subscription
 */
const drain = async subscription => {
  const batch = await E(subscription).next();
  t0Check(batch);
  return batch;
};
/** @param {any} batch */
const t0Check = batch => {
  if (!matches(batch, shapes.ListBatch)) throw Error('not a ListBatch');
};

test('the first delivery is the list snapshot marker; batches follow in rev order', async t => {
  const manual = makeManualSchedule();
  const channel = makeListChannel({ schedule: manual.schedule });
  const a = channel.subscribe();
  const first = await drain(a);
  t.deepEqual(first.deliveries, [
    { seq: 0, rev: 0, event: { type: 'list-snapshot' } },
  ]);
  await E(channel.publisher).publish(
    harden({ rev: 1, events: [rowEvent('a')] }),
  );
  // rev 3 before rev 2: held until 2 arrives.
  await E(channel.publisher).publish(
    harden({ rev: 3, events: [rowEvent('c')] }),
  );
  t.deepEqual(manual.armed(), [channelLimits.reorderWaitMs]);
  await E(channel.publisher).publish(
    harden({ rev: 2, events: [rowEvent('b')] }),
  );
  t.deepEqual(manual.armed(), []);
  // A duplicate is dropped.
  await E(channel.publisher).publish(
    harden({ rev: 2, events: [rowEvent('b')] }),
  );
  const batch = await drain(a);
  t.deepEqual(
    batch.deliveries.map((/** @type {any} */ d) => [
      d.seq,
      d.rev,
      d.event.row.title,
    ]),
    [
      [1, 1, 'a'],
      [2, 2, 'b'],
      [3, 3, 'c'],
    ],
  );
  t.like(channel.ordering(), { reordered: 1, dropped: 1, gaps: 0 });
  t.is(channel.latestRev(), 3);
  // A later subscriber's marker carries the latest rev and seq.
  const b = channel.subscribe(3);
  t.deepEqual((await drain(b)).deliveries, [
    { seq: 3, rev: 3, event: { type: 'list-snapshot' } },
  ]);
});

test('a missing rev is given up after the wait (a gap)', async t => {
  const manual = makeManualSchedule();
  const channel = makeListChannel({ schedule: manual.schedule });
  const a = channel.subscribe();
  await drain(a);
  await E(channel.publisher).publish(
    harden({ rev: 5, events: [rowEvent('x')] }),
  );
  await E(channel.publisher).publish(
    harden({ rev: 7, events: [rowEvent('z')] }),
  );
  manual.fire();
  const batch = await drain(a);
  t.deepEqual(
    batch.deliveries.map((/** @type {any} */ d) => d.rev),
    [5, 7],
  );
  t.like(channel.ordering(), { gaps: 1, missingRevs: 1 });
});

test('two subscribers see the same deliveries; a closed one is dropped and gets nothing more', async t => {
  const channel = makeListChannel();
  const a = channel.subscribe();
  const b = channel.subscribe();
  await drain(a);
  await drain(b);
  t.is(channel.subscriberCount(), 2);
  await E(channel.publisher).publish(
    harden({ rev: 1, events: [rowEvent('one')] }),
  );
  const [ba, bb] = await Promise.all([drain(a), drain(b)]);
  t.deepEqual(ba.deliveries, bb.deliveries);
  // A waiting next() is answered when the subscriber is closed.
  const waiting = E(b).next();
  await E(b).close();
  t.deepEqual(await waiting, {
    deliveries: [],
    closed: true,
    reason: 'client',
  });
  t.is(channel.subscriberCount(), 1);
  await E(channel.publisher).publish(
    harden({ rev: 2, events: [rowEvent('two')] }),
  );
  t.deepEqual(await E(b).next(), {
    deliveries: [],
    closed: true,
    reason: 'client',
  });
  t.is((await drain(a)).deliveries[0].event.row.title, 'two');
  t.deepEqual(channel.closes(), { client: 1 });
});

test('subscriber bounds: deliveries, bytes and the subscriber limit close with a reason', async t => {
  const channel = makeListChannel({
    limits: {
      subscriberQueueDeliveries: 3,
      subscriberQueueBytes: 10_000,
      subscribersPerSession: 2,
    },
  });
  const slow = channel.subscribe();
  for (let rev = 1; rev <= 4; rev += 1) {
    // eslint-disable-next-line no-await-in-loop
    await E(channel.publisher).publish(
      harden({ rev, events: [rowEvent(`r${rev}`)] }),
    );
  }
  const closed = await E(slow).next();
  t.is(closed.closed, true);
  t.is(closed.reason, 'queueDeliveries');

  const wide = makeListChannel({
    limits: { subscriberQueueDeliveries: 1000, subscriberQueueBytes: 10_000 },
  });
  const big = wide.subscribe();
  await E(big).next();
  await E(wide.publisher).publish(
    harden({
      rev: 5,
      events: Array.from({ length: 64 }, (_, i) =>
        rowEvent(`${'x'.repeat(200)}${i}`),
      ),
    }),
  );
  t.is((await E(big).next()).reason, 'queueBytes');

  const c1 = channel.subscribe();
  const c2 = channel.subscribe();
  channel.subscribe();
  const dropped = [await E(c1).next(), await E(c2).next()].filter(
    batch => batch.closed,
  );
  t.is(dropped.length, 1);
  t.is(dropped[0].reason, 'subscriberLimit');
  t.is(channel.subscriberCount(), 2);
});

test('the publisher guard refuses an oversize batch and unknown keys', async t => {
  const channel = makeListChannel();
  await t.throwsAsync(() =>
    E(channel.publisher).publish(
      harden({
        rev: 1,
        events: Array.from({ length: 65 }, () => rowEvent('x')),
      }),
    ),
  );
  await t.throwsAsync(() =>
    E(channel.publisher).publish(
      /** @type {any} */ (harden({ rev: 1, events: [], extra: 1 })),
    ),
  );
});
