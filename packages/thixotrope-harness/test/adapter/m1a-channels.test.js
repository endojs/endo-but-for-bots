// @ts-check
// M1a W1a.3: session channels, the Live service and the fold
// (resources/agent-host/impl/{channels,channel-taps,live-service}.js;
// designs/m1a-interfaces.md sections 3.2 and 5). Node adapter tests with a
// fake Session presence; no vat.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { limits } from '../../guest/lib/limits.js';
import {
  makeFoldableStatus,
  makeReplyFold,
} from '../../guest/lib/reply-fold.js';
import { shapes } from '../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */
import {
  makeChannelRegistry,
  SUBSCRIBER_QUEUE_LIMIT,
} from '../../resources/agent-host/impl/channels.js';
import { channelTaps } from '../../resources/agent-host/impl/channel-taps.js';
import { makeLive } from '../../resources/agent-host/impl/live-service.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, matches } = /** @type {GuestGlobals} */ (globalThis);

const usage = harden({
  inputTokens: 10,
  outputTokens: 20,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  reasoningOutputTokens: 0,
  context: { usedTokens: 30, windowTokens: 1000 },
  turns: 1,
  incompleteTurns: 0,
});

/**
 * A turn as the vat and the provider publish it, in order: entries are
 * either `{ batch: { rev, events } }` (vat publish) or `{ delta }`.
 * @param {string} turnId
 * @param {number} rev0 the rev of the turn's first batch
 */
const scriptedTurn = (turnId, rev0) => [
  {
    batch: {
      rev: rev0,
      events: [
        { type: 'turn-start', turnId, input: 'hi', at: 1 },
        { type: 'phase', turnId, phase: 'thinking' },
      ],
    },
  },
  { delta: { type: 'delta', turnId, round: 0, text: 'Let me ' } },
  { delta: { type: 'delta', turnId, round: 0, text: 'check.' } },
  {
    batch: {
      rev: rev0 + 1,
      events: [
        { type: 'phase', turnId, phase: 'using tools' },
        {
          type: 'tool_call',
          turnId,
          id: `${turnId}/r0/c0`,
          name: 'echo',
          args: '{"text":"a"}',
        },
        {
          type: 'tool_call',
          turnId,
          id: `${turnId}/r0/c1`,
          name: 'echo',
          args: '{"text":"b"}',
        },
      ],
    },
  },
  // results arrive out of call order
  {
    batch: {
      rev: rev0 + 2,
      events: [
        {
          type: 'tool_result',
          turnId,
          id: `${turnId}/r0/c1`,
          name: 'echo',
          result: 'b',
          failed: false,
        },
      ],
    },
  },
  {
    batch: {
      rev: rev0 + 3,
      events: [
        {
          type: 'tool_result',
          turnId,
          id: `${turnId}/r0/c0`,
          name: 'echo',
          result: 'a',
          failed: false,
        },
        { type: 'phase', turnId, phase: 'thinking' },
      ],
    },
  },
  { delta: { type: 'delta', turnId, round: 1, text: 'Done: ' } },
  { delta: { type: 'delta', turnId, round: 1, text: 'a and b.' } },
  {
    batch: {
      rev: rev0 + 4,
      events: [
        { type: 'final', turnId, text: 'Done: a and b.' },
        { type: 'usage', turnId, ...usage },
        { type: 'end', turnId, status: 'completed' },
      ],
    },
  },
];

/**
 * @param {ReturnType<ReturnType<typeof makeChannelRegistry>['channelFor']>} channel
 * @param {any[]} steps
 */
const play = (channel, steps) => {
  for (const step of steps) {
    if (step.batch) channel.publisher.publish(harden(step.batch));
    else channel.publishDelta(harden(step.delta));
  }
};

/**
 * Read every delivery queued so far (at least one must be queued; a batch
 * shorter than the maximum means the queue is empty).
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

/**
 * Replay deliveries on a client: adopt the snapshot, then fold the events
 * of its turn, as a browser does with Fae's fold.
 * @param {any[]} deliveries
 */
const replay = deliveries => {
  const [first, ...rest] = deliveries;
  const fold = makeReplyFold();
  const status = makeFoldableStatus();
  let turnId = first.event.turn?.turnId;
  if (first.event.turn) fold.adopt(status, first.event.turn.status);
  let settled = first.event.turn?.settled ?? false;
  /** @type {any} */
  let folded = status;
  let foldInstance = fold;
  for (const { event } of rest) {
    if (event.type === 'turn-start') {
      turnId = event.turnId;
      folded = makeFoldableStatus();
      foldInstance = makeReplyFold();
      settled = false;
    } else if (event.type !== 'pending' && event.turnId === turnId) {
      const { turnId: _t, round: _r, ...plain } = event;
      foldInstance.apply(folded, plain);
      if (event.type === 'end' || event.type === 'abort') {
        foldInstance.finish(folded);
        settled = true;
      }
    }
  }
  return { turnId, settled, status: JSON.parse(JSON.stringify(folded)) };
};

const session = Far('Session', {});

test('one channel per Session presence', t => {
  const registry = makeChannelRegistry();
  const other = Far('Session', {});
  t.is(registry.channelFor(session), registry.channelFor(session));
  t.not(registry.channelFor(session), registry.channelFor(other));
});

test('a fresh subscription starts with an empty snapshot at seq 0', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe(0);
  const batch = await E(subscription).next();
  t.deepEqual(batch, {
    deliveries: [{ seq: 0, rev: 0, event: { type: 'snapshot' } }],
  });
  t.true(matches(batch, shapes.LiveBatch));
});

test('publish batch order: seq numbers every delivery; rev per batch', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe();
  play(channel, scriptedTurn('t1', 1));
  const deliveries = await drain(subscription);
  t.true(matches(harden({ deliveries }), shapes.LiveBatch));
  const steps = scriptedTurn('t1', 1);
  /** @type {{ type: string, rev: number }[]} */
  const expected = [];
  let rev = 0;
  for (const step of steps) {
    if (step.batch) {
      rev = step.batch.rev;
      for (const event of step.batch.events) {
        expected.push({ type: event.type, rev });
      }
    } else {
      expected.push({ type: 'delta', rev });
    }
  }
  t.deepEqual(
    deliveries
      .slice(1)
      .map(({ event, rev: r }) => ({ type: event.type, rev: r })),
    expected,
  );
  t.deepEqual(
    deliveries.map(({ seq }) => seq),
    deliveries.map((_, index) => index),
  );
  t.is(channel.latestRev(), 5);
});

test('fold equals replay: early, mid-turn and late subscribers', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const steps = scriptedTurn('t1', 1);
  const early = channel.subscribe();
  play(channel, steps.slice(0, 4));
  const middle = channel.subscribe();
  play(channel, steps.slice(4));
  const late = channel.subscribe();

  const snapshot = channel.snapshot();
  t.true(matches(snapshot, shapes.SnapshotEvent));
  const turn = /** @type {any} */ (snapshot).turn;
  t.is(turn.turnId, 't1');
  t.true(turn.settled);
  t.is(turn.status.phase, 'thinking');
  t.deepEqual(
    turn.status.messages.map((/** @type {any} */ m) => [
      m.role,
      m.result ?? m.text,
    ]),
    [
      ['assistant', 'Let me check.'],
      ['tool', 'a'],
      ['tool', 'b'],
      ['assistant', 'Done: a and b.'],
    ],
  );
  t.deepEqual(turn.status.usage, usage);

  const expected = JSON.parse(JSON.stringify(turn));
  for (const subscription of [early, middle, late]) {
    // eslint-disable-next-line no-await-in-loop
    const deliveries = await drain(subscription);
    // seq continues from the snapshot's without a gap
    deliveries.forEach((delivery, index) =>
      t.is(delivery.seq, deliveries[0].seq + index),
    );
    t.deepEqual(replay(deliveries), expected);
  }
  // the middle subscriber's snapshot accounted for exactly the first 4 steps (5 deliveries)
  t.is(steps.slice(0, 4).length, 4);
});

test('events of another turn and pending events are delivered, not folded', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe();
  play(channel, scriptedTurn('t1', 1).slice(0, 2));
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't0', round: 0, text: 'stale' }),
  );
  channel.publisher.publish(
    harden({
      rev: 2,
      events: [
        { type: 'pending', pending: { entries: [] } },
        { type: 'phase', turnId: 't0', phase: 'cancelling' },
      ],
    }),
  );
  const deliveries = await drain(subscription);
  t.deepEqual(
    deliveries.map(({ event }) => event.type),
    ['snapshot', 'turn-start', 'phase', 'delta', 'delta', 'pending', 'phase'],
  );
  const turn = /** @type {any} */ (channel.snapshot()).turn;
  t.is(turn.status.streamingText, 'Let me ');
  t.is(turn.status.phase, 'thinking');
  t.false(turn.settled);
});

test('a turn-start replaces the folded turn; an abort settles it with the error', t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  play(channel, scriptedTurn('t1', 1));
  channel.publisher.publish(
    harden({
      rev: 6,
      events: [
        { type: 'turn-start', turnId: 't2', input: 'again', at: 2 },
        { type: 'phase', turnId: 't2', phase: 'thinking' },
      ],
    }),
  );
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't2', round: 0, text: 'partial' }),
  );
  channel.publisher.publish(
    harden({
      rev: 7,
      events: [
        {
          type: 'abort',
          turnId: 't2',
          reason: "round output exceeds this build's frame limit",
        },
      ],
    }),
  );
  const turn = /** @type {any} */ (channel.snapshot()).turn;
  t.is(turn.turnId, 't2');
  t.true(turn.settled);
  t.is(turn.status.error, "round output exceeds this build's frame limit");
  t.deepEqual(turn.status.messages, [{ role: 'assistant', text: 'partial' }]);
  t.is(turn.status.streamingText, '');
});

test('a waiting next() gets one batch per synchronous burst', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe();
  await E(subscription).next(); // the snapshot
  const pending = E(subscription).next();
  play(channel, scriptedTurn('t1', 1).slice(0, 1));
  const batch = await pending;
  t.deepEqual(
    batch.deliveries.map((/** @type {any} */ d) => [d.seq, d.event.type]),
    [
      [1, 'turn-start'],
      [2, 'phase'],
    ],
  );
});

test('a batch carries at most liveBatchDeliveries', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe();
  const n = limits.liveBatchDeliveries + 10;
  for (let i = 0; i < n; i += 1) {
    channel.publishDelta(
      harden({ type: 'delta', turnId: 't1', round: 0, text: 'x' }),
    );
  }
  const first = await E(subscription).next();
  t.is(first.deliveries.length, limits.liveBatchDeliveries);
  const second = await E(subscription).next();
  t.is(second.deliveries.length, n + 1 - limits.liveBatchDeliveries);
});

test('a subscriber that falls behind is dropped; others keep receiving', async t => {
  const channel = makeChannelRegistry({ subscriberQueueLimit: 10 }).channelFor(
    Far('Session', {}),
  );
  const slow = channel.subscribe();
  const fast = channel.subscribe();
  t.is(channel.subscriberCount(), 2);
  /** @type {any[]} */
  const fastSeen = [];
  for (let i = 0; i < 20; i += 1) {
    channel.publishDelta(
      harden({ type: 'delta', turnId: 't1', round: 0, text: `${i}` }),
    );
    // eslint-disable-next-line no-await-in-loop
    fastSeen.push(...(await E(fast).next()).deliveries);
  }
  t.is(fastSeen.length, 21);
  t.is(channel.subscriberCount(), 1);
  // M1b (W1b.1): a closed batch carries its reason.
  const dropped = { deliveries: [], closed: true, reason: 'queueDeliveries' };
  t.deepEqual(await E(slow).next(), dropped);
  t.deepEqual(await E(slow).next(), dropped);
});

test('the default drop bound is 4,096 undelivered deliveries', async t => {
  t.is(SUBSCRIBER_QUEUE_LIMIT, 4096);
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe(); // 1 queued: the snapshot
  for (let i = 0; i < SUBSCRIBER_QUEUE_LIMIT - 1; i += 1) {
    channel.publishDelta(
      harden({ type: 'delta', turnId: 't1', round: 0, text: 'x' }),
    );
  }
  t.is(channel.subscriberCount(), 1);
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't1', round: 0, text: 'x' }),
  );
  t.is(channel.subscriberCount(), 0);
  t.true((await E(subscription).next()).closed);
});

test('close() drops the subscriber and answers a waiting next()', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe();
  await E(subscription).next();
  const waiting = E(subscription).next();
  await E(subscription).close();
  const closed = { deliveries: [], closed: true, reason: 'client' };
  t.deepEqual(await waiting, closed);
  t.is(channel.subscriberCount(), 0);
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't1', round: 0, text: 'x' }),
  );
  t.deepEqual(await E(subscription).next(), closed);
});

test('concurrent next() callers get disjoint batches in order', async t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  const subscription = channel.subscribe();
  await E(subscription).next();
  const a = E(subscription).next();
  const b = E(subscription).next();
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't1', round: 0, text: '1' }),
  );
  const first = await a;
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't1', round: 0, text: '2' }),
  );
  const second = await b;
  t.deepEqual(
    [...first.deliveries, ...second.deliveries].map(d => d.event.text),
    ['1', '2'],
  );
});

test('guards: publish and publishDelta refuse records outside the contract', t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  t.throws(() =>
    channel.publisher.publish(
      harden({
        rev: 1,
        events: [{ type: 'phase', turnId: 't1', phase: 'thinking', extra: 1 }],
      }),
    ),
  );
  t.throws(() =>
    channel.publisher.publish(
      harden({
        rev: 1,
        events: Array.from({ length: limits.publishBatchEvents + 1 }, () => ({
          type: 'phase',
          turnId: 't1',
          phase: 'thinking',
        })),
      }),
    ),
  );
  t.throws(() =>
    channel.publishDelta(
      harden({ type: 'delta', turnId: 't1', round: 0, text: 'x', extra: 1 }),
    ),
  );
  t.is(channel.latestRev(), 0);
});

test('the fold stays within foldTextUnits', t => {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  channel.publisher.publish(
    harden({
      rev: 1,
      events: [{ type: 'turn-start', turnId: 't1', input: 'big', at: 1 }],
    }),
  );
  const piece = 'y'.repeat(600_000);
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't1', round: 0, text: piece }),
  );
  channel.publishDelta(
    harden({ type: 'delta', turnId: 't1', round: 0, text: piece }),
  );
  const snapshot = /** @type {any} */ (channel.snapshot());
  t.is(snapshot.turn.status.streamingText.length, limits.foldTextUnits);
  t.true(matches(snapshot, shapes.SnapshotEvent));
});

test('channel taps see every numbered delivery; a throwing tap is ignored', async t => {
  /** @type {any[]} */
  const seen = [];
  const sessionA = Far('Session', {});
  const channel = makeChannelRegistry({
    taps: harden([
      () => {
        throw Error('tap failure');
      },
      (/** @type {any} */ s, /** @type {any} */ d) => seen.push([s, d.seq]),
    ]),
  }).channelFor(sessionA);
  const subscription = channel.subscribe();
  play(channel, scriptedTurn('t1', 1).slice(0, 3));
  t.deepEqual(
    seen.map(([s, seq]) => [s === sessionA, seq]),
    [
      [true, 1],
      [true, 2],
      [true, 3],
      [true, 4],
    ],
  );
  t.is((await drain(subscription)).length, 5);
  t.deepEqual(channelTaps, []);
});

test('Live.subscribe keys the channel by the Session presence', async t => {
  const channels = makeChannelRegistry();
  const live = makeLive({ channels });
  const sessionA = Far('Session', {});
  const subscription = await E(live).subscribe(sessionA, 0);
  channels.channelFor(sessionA).publisher.publish(
    harden({
      rev: 3,
      events: [{ type: 'turn-start', turnId: 't4', input: 'x', at: 9 }],
    }),
  );
  const deliveries = await drain(subscription);
  t.deepEqual(
    deliveries.map(({ seq, rev, event }) => [seq, rev, event.type]),
    [
      [0, 0, 'snapshot'],
      [1, 3, 'turn-start'],
    ],
  );
  const again = await E(live).subscribe(sessionA);
  const [snap] = (await E(again).next()).deliveries;
  t.like(snap, { seq: 1, rev: 3, event: { turn: { turnId: 't4' } } });
  await t.throwsAsync(() => E(live).subscribe(/** @type {any} */ ('s1')));
});
