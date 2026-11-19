// @ts-check
// M1a follow-ups (JOURNAL J-9170..J-9189): the channel's ordering rule (vat
// batches in rev order, a late older batch reordered, duplicates dropped,
// gaps detected), the subscriber bounds (bytes, count) with their close
// reasons, the cheap `next()` return guard, and the live probe
// (resources/agent-host/impl/channels.js). Node adapter tests with a fake
// Session presence and hand-fired timers; no vat.
import '../unit/_m1a-prelude.js';

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import { shapes } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import { channelLimits } from '../../config/defaults.js';
import {
  closeReasons,
  LIVE_SUBSCRIPTION_GUARD,
  LIVE_PROBE_VARIABLE,
  liveProbeFromEnv,
  makeChannelRegistry,
  makeLiveProbe,
} from '../../resources/agent-host/impl/channels.js';
import { harnessRoot } from '../_helpers.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

/** Timers fired by hand. */
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

/**
 * @param {Parameters<typeof makeChannelRegistry>[0]} [options]
 */
const freshChannel = (options = {}) => {
  const manual = makeManualSchedule();
  const channel = makeChannelRegistry({
    schedule: manual.schedule,
    probe: null,
    ...options,
  }).channelFor(Far('Session', {}));
  return { channel, manual };
};

/** @param {number} rev */
const pendingBatch = rev =>
  harden({ rev, events: [{ type: 'pending', pending: { entries: [] } }] });

/** @param {string} text */
const delta = text => harden({ type: 'delta', turnId: 't1', round: 0, text });

/**
 * Every delivery queued so far.
 * @param {any} subscription
 */
const drain = async subscription => {
  /** @type {any[]} */
  const all = [];
  for (;;) {
    /** @type {{ deliveries: any[] }} */
    // eslint-disable-next-line no-await-in-loop
    const batch = await E(subscription).next();
    all.push(...batch.deliveries);
    if (batch.deliveries.length < limits.liveBatchDeliveries) return all;
  }
};

/** @param {any[]} deliveries */
const revsAndTypes = deliveries =>
  deliveries.map(({ rev, event }) => `${rev}:${event.type}`);

test('a late older batch is delivered before the newer one it overtook', async t => {
  const { channel, manual } = freshChannel();
  const subscription = channel.subscribe();
  channel.publisher.publish(pendingBatch(3));
  // The next turn's in-turn batch (rev 5) and its deltas arrive before the
  // outside publish of rev 4, which first fetched a publisher.
  channel.publisher.publish(
    harden({
      rev: 5,
      events: [{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }],
    }),
  );
  channel.publishDelta(delta('a'));
  t.is(channel.latestRev(), 3, 'rev 5 is held, not delivered');
  t.deepEqual(manual.armed(), [channelLimits.reorderWaitMs]);
  channel.publisher.publish(pendingBatch(4));
  const deliveries = await drain(subscription);
  t.deepEqual(revsAndTypes(deliveries), [
    '0:snapshot',
    '3:pending',
    '4:pending',
    '5:turn-start',
    '5:delta',
  ]);
  t.deepEqual(
    deliveries.map(d => d.seq),
    [0, 1, 2, 3, 4],
  );
  t.is(channel.latestRev(), 5);
  t.like(channel.ordering(), { reordered: 1, gaps: 0, dropped: 0 });
  t.deepEqual(manual.armed(), [], 'the wait is cancelled once nothing is held');
  t.is(
    /** @type {any} */ (channel.snapshot()).turn.status.streamingText,
    'a',
    'the held delta was folded after its turn-start',
  );
});

test('duplicates and batches older than the delivered rev are dropped', async t => {
  const { channel } = freshChannel();
  const subscription = channel.subscribe();
  channel.publisher.publish(pendingBatch(3));
  channel.publisher.publish(pendingBatch(3));
  channel.publisher.publish(pendingBatch(2));
  channel.publisher.publish(pendingBatch(5));
  channel.publisher.publish(pendingBatch(5));
  channel.publisher.publish(pendingBatch(4));
  const deliveries = await drain(subscription);
  t.deepEqual(
    deliveries.slice(1).map(d => d.rev),
    [3, 4, 5],
  );
  t.like(channel.ordering(), { dropped: 3, reordered: 1, gaps: 0 });
});

test('a missing rev that never comes is a gap after the wait', async t => {
  const { channel, manual } = freshChannel();
  const subscription = channel.subscribe();
  channel.publisher.publish(pendingBatch(1));
  channel.publisher.publish(pendingBatch(4));
  channel.publisher.publish(pendingBatch(3));
  channel.publishDelta(delta('x'));
  t.is((await drain(subscription)).length, 2, 'snapshot and rev 1 only');
  manual.fire();
  const after = await drain(subscription);
  t.deepEqual(revsAndTypes(after), ['3:pending', '4:pending', '4:delta']);
  t.like(channel.ordering(), {
    gaps: 1,
    missingRevs: 1,
    expectedRev: 5,
    heldBatches: 0,
  });
  // rev 2 finally arrives: too late, dropped, never out of order.
  channel.publisher.publish(pendingBatch(2));
  channel.publisher.publish(pendingBatch(5));
  t.deepEqual(
    (await drain(subscription)).map(d => d.rev),
    [5],
  );
  t.like(channel.ordering(), { dropped: 1 });
});

test('a full reorder window is a gap without waiting', async t => {
  const { channel } = freshChannel({ reorderWindowBatches: 2 });
  const subscription = channel.subscribe();
  channel.publisher.publish(pendingBatch(1));
  channel.publisher.publish(pendingBatch(3));
  channel.publisher.publish(pendingBatch(4));
  t.is(channel.latestRev(), 1);
  channel.publisher.publish(pendingBatch(6));
  t.deepEqual(
    (await drain(subscription)).slice(1).map(d => d.rev),
    [1, 3, 4],
    'rev 2 given up; 6 still waits for 5',
  );
  t.like(channel.ordering(), { gaps: 1, heldBatches: 1, expectedRev: 5 });
});

test('held deltas count toward the backlog bound', async t => {
  const { channel } = freshChannel({ reorderBacklogDeliveries: 3 });
  const subscription = channel.subscribe();
  channel.publisher.publish(pendingBatch(1));
  channel.publisher.publish(pendingBatch(3));
  channel.publishDelta(delta('a'));
  channel.publishDelta(delta('b'));
  t.is(channel.latestRev(), 1);
  channel.publishDelta(delta('c'));
  t.deepEqual(revsAndTypes((await drain(subscription)).slice(1)), [
    '1:pending',
    '3:pending',
    '3:delta',
    '3:delta',
    '3:delta',
  ]);
  t.like(channel.ordering(), { gaps: 1, heldDeliveries: 0 });
});

test('any arrival order within the window is delivered in rev order with no gap', async t => {
  // A deterministic shuffle (LCG) of revs 2..40 after rev 1.
  let state = 7;
  const random = () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
  for (let round = 0; round < 20; round += 1) {
    const { channel } = freshChannel({ reorderWindowBatches: 64 });
    const subscription = channel.subscribe();
    const revs = Array.from({ length: 39 }, (_, i) => i + 2);
    for (let i = revs.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [revs[i], revs[j]] = [revs[j], revs[i]];
    }
    channel.publisher.publish(pendingBatch(1));
    for (const rev of revs) {
      channel.publisher.publish(pendingBatch(rev));
      channel.publishDelta(delta(`${rev}`));
    }
    /** @type {{ seq: number, rev: number, event: any }[]} */
    // eslint-disable-next-line no-await-in-loop
    const deliveries = (await drain(subscription)).slice(1);
    const batchRevs = deliveries
      .filter(d => d.event.type === 'pending')
      .map(d => d.rev);
    t.deepEqual(
      batchRevs,
      Array.from({ length: 40 }, (_, i) => i + 1),
    );
    // A delivery's rev never decreases, and seq has no gap.
    for (let i = 1; i < deliveries.length; i += 1) {
      t.true(deliveries[i].rev >= deliveries[i - 1].rev);
      t.is(deliveries[i].seq, deliveries[i - 1].seq + 1);
    }
    t.like(channel.ordering(), { gaps: 0, dropped: 0, heldBatches: 0 });
  }
});

test('a subscriber over its queued bytes is dropped with the reason recorded', async t => {
  const { channel } = freshChannel({ subscriberQueueBytes: 400 });
  const slow = channel.subscribe();
  const fast = channel.subscribe();
  for (let i = 0; i < 20; i += 1) {
    channel.publishDelta(delta('y'.repeat(20)));
    // eslint-disable-next-line no-await-in-loop
    await E(fast).next();
  }
  t.is(channel.subscriberCount(), 1);
  t.deepEqual(await E(slow).next(), {
    deliveries: [],
    closed: true,
    reason: 'queueBytes',
  });
  t.deepEqual(channel.closes(), { queueBytes: 1 });
  // The snapshot is not counted: a subscriber whose only queued delivery
  // is a large snapshot stays.
  const { channel: other } = freshChannel({ subscriberQueueBytes: 400 });
  other.publisher.publish(
    harden({
      rev: 1,
      events: [{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }],
    }),
  );
  other.publishDelta(delta('z'.repeat(1000)));
  const late = other.subscribe();
  t.is(other.subscriberCount(), 1);
  const [snap] = (await E(late).next()).deliveries;
  t.is(snap.event.turn.status.streamingText.length, 1000);
});

test('a subscribe beyond subscribersPerSession drops the slowest subscriber', async t => {
  const { channel } = freshChannel({ subscribersPerSession: 2 });
  const reading = channel.subscribe();
  const lagging = channel.subscribe();
  await E(reading).next();
  for (let i = 0; i < 5; i += 1) channel.publishDelta(delta(`${i}`));
  await E(reading).next();
  const newcomer = channel.subscribe();
  t.is(channel.subscriberCount(), 2);
  t.deepEqual(await E(lagging).next(), {
    deliveries: [],
    closed: true,
    reason: 'subscriberLimit',
  });
  t.deepEqual(channel.closes(), { subscriberLimit: 1 });
  channel.publishDelta(delta('after'));
  t.is((await E(reading).next()).deliveries[0].event.text, 'after');
  const [snap, next] = (await E(newcomer).next()).deliveries;
  t.is(snap.event.type, 'snapshot');
  t.is(next.event.text, 'after');
  await E(reading).close();
  t.deepEqual(channel.closes(), {
    subscriberLimit: 1,
    client: 1,
  });
  // Counted by close-reason key, the same key a closed `next()` answers.
  for (const key of Object.keys(channel.closes())) {
    t.true(Object.hasOwn(closeReasons, key), key);
  }
});

test('the default bounds are the named channelLimits', t => {
  t.like(channelLimits, {
    subscriberQueueDeliveries: 4096,
    subscriberQueueBytes: 2_097_152,
    subscribersPerSession: 32,
    reorderWindowBatches: 32,
    reorderBacklogDeliveries: 4096,
    reorderWaitMs: 1000,
  });
  const { channel } = freshChannel();
  const all = Array.from({ length: 33 }, () => channel.subscribe());
  t.is(channel.subscriberCount(), 32);
  t.truthy(all);
});

test('next() checks the envelope only; deliveries still match the contract', async t => {
  const { channel } = freshChannel();
  const subscription = channel.subscribe();
  channel.publisher.publish(
    harden({
      rev: 1,
      events: [
        { type: 'turn-start', turnId: 't1', input: 'hi', at: 1 },
        { type: 'phase', turnId: 't1', phase: 'thinking' },
      ],
    }),
  );
  for (let i = 0; i < 300; i += 1) channel.publishDelta(delta(`${i}`));
  const first = await E(subscription).next();
  t.is(first.deliveries.length, limits.liveBatchDeliveries);
  t.true(matches(first, shapes.LiveBatch));
  const second = await E(subscription).next();
  t.true(matches(second, shapes.LiveBatch));
  t.truthy(LIVE_SUBSCRIPTION_GUARD);
});

test('the live probe records publish-to-arrival per delta and writes at the turn end', async t => {
  const dir = await mkdtemp(path.join(harnessRoot, 'tmp', 'lp-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'probe.jsonl');
  let clock = 100;
  const probe = makeLiveProbe({ file, now: () => clock });
  const { channel } = freshChannel({ probe });
  t.is(channel.subscriberCount(), 1, 'the probe subscribed');
  channel.publisher.publish(
    harden({
      rev: 1,
      events: [{ type: 'turn-start', turnId: 't1', input: 'hi', at: 1 }],
    }),
  );
  channel.publishDelta(delta('a'));
  clock = 102.5;
  await new Promise(resolve => setImmediate(resolve));
  channel.publisher.publish(
    harden({
      rev: 2,
      events: [{ type: 'end', turnId: 't1', status: 'completed' }],
    }),
  );
  await new Promise(resolve => setImmediate(resolve));
  const lines = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  t.is(lines.length, 1);
  t.like(lines[0], {
    kind: 'live-probe',
    channel: 1,
    turnId: 't1',
    round: 0,
    seq: 2,
    ms: 2.5,
  });
});

test('HR-SYN-13: the default registry has no probe; one is injected, or named in the environment', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  t.is(channel.subscriberCount(), 0);
  // The environment names a directory: the probe writes <dir>/<pid>.jsonl.
  t.is(LIVE_PROBE_VARIABLE, 'THIX_HARNESS_LIVE_PROBE_DIR');
  t.is(liveProbeFromEnv({}), null);
  t.is(liveProbeFromEnv({ [LIVE_PROBE_VARIABLE]: 'relative/dir' }), null);
  const dir = await mkdtemp(path.join(harnessRoot, 'tmp', 'lp-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const probe = liveProbeFromEnv({ [LIVE_PROBE_VARIABLE]: dir });
  t.truthy(probe);
  const probed = makeChannelRegistry({ probe }).channelFor(Far('Session', {}));
  t.is(probed.subscriberCount(), 1);
});

test('HR-SYN-13: the adapter reads no switch file; the probe comes from its options or its environment', async t => {
  const source = await readFile(
    path.join(harnessRoot, 'resources', 'agent-host', 'impl', 'channels.js'),
    'utf8',
  );
  t.false(source.includes('existsSync'), 'nothing is looked for on disk');
  t.false(source.includes("'enabled'"));
});
