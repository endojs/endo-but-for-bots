// @ts-check
/**
 * Node microbenchmark of the session channels (M1a W1a.3; milestones.md M1a
 * perf check `turn.delta`: adapter chunk to subscriber <= 5 ms, 0 vat
 * deliveries per delta). No vat and no Ironhorse workload, so it needs no
 * run lock. Rows are JSON lines through `perf/_harness.mjs` (`PERF_OUT`
 * appends them to a file), with commit, crank budget (not applicable here:
 * recorded as the harness's default) and load average.
 *
 *   node test/adapter/m1a-channels.bench.mjs
 *
 * Metrics:
 * - `channels.delta.e2e` (subscribers 1, 3, 10): one delta published while
 *   every subscriber has a `next()` waiting through `E()`; time until every
 *   subscriber's promise has settled with it. Budget: median 5 ms.
 * - `channels.delta.publish` (subscribers 0, 1, 3, 10): the synchronous cost
 *   of `publishDelta` (shape check, harden, fold, fan-out, taps), per delta,
 *   from blocks of 1,000 deltas.
 * - `channels.fold.turn5000`: a whole turn of 5,000 deltas (plus turn-start,
 *   2 tool rounds and the settle batch) through the channel with no
 *   subscriber; `channels.fold.perDelta` the same per delta;
 *   `channels.snapshot.turn5000` the snapshot of that turn.
 * - `channels.next.batch256`: one `next()` returning 256 queued deliveries
 *   (the return guard checks each).
 *
 * BENCH_ROUNDS (default 200) sets the samples of the e2e and publish rows.
 */
import '../../scripts/_init.mjs';

import { performance } from 'node:perf_hooks';

// After lockdown (a static import would evaluate before _init's await).
const { installGuestPrelude } = await import('../../scripts/guest-prelude.js');
installGuestPrelude();

const { stats, single } = await import('../../perf/_harness.mjs');
const { makeChannelRegistry } =
  await import('../../resources/agent-host/impl/channels.js');

const { E, Far } = /** @type {any} */ (globalThis);

const rounds = Number(process.env.BENCH_ROUNDS ?? 200);
const chunk = 'The quick brown fox jumps. '; // 27 units, a typical SSE text delta

/** @param {number} i */
const delta = i =>
  harden({ type: 'delta', turnId: 't1', round: 0, text: `${chunk}${i}` });

const startTurn = (/** @type {any} */ channel, rev = 1) =>
  channel.publisher.publish(
    harden({
      rev,
      events: [
        { type: 'turn-start', turnId: 't1', input: 'hi', at: 1 },
        { type: 'phase', turnId: 't1', phase: 'thinking' },
      ],
    }),
  );

const extra = { deliveriesPerDelta: 0, note: 'in-process; no vat involved' };

// ---- end to end: publish -> every waiting next() settled
for (const n of [1, 3, 10]) {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  startTurn(channel);
  const subscriptions = Array.from({ length: n }, () => channel.subscribe(1));
  // eslint-disable-next-line no-await-in-loop
  await Promise.all(subscriptions.map(s => E(s).next())); // snapshots
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < rounds + 20; i += 1) {
    const waiting = subscriptions.map(s => E(s).next());
    // let the eventual sends arrive so each next() is waiting
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
    const t0 = performance.now();
    channel.publishDelta(delta(i));
    // eslint-disable-next-line no-await-in-loop
    const batches = await Promise.all(waiting);
    const t1 = performance.now();
    if (batches.some(b => b.deliveries.length !== 1)) {
      throw Error('expected one delivery per batch');
    }
    if (i >= 20) samples.push(t1 - t0); // 20 warm-up rounds
  }
  // eslint-disable-next-line no-await-in-loop
  await stats('channels.delta.e2e', samples, {
    budget: { median: 5 },
    extra: { ...extra, subscribers: n },
  });
}

// ---- synchronous publish cost per delta
for (const n of [0, 1, 3, 10]) {
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  startTurn(channel);
  const subscriptions = Array.from({ length: n }, () => channel.subscribe(1));
  /** @type {number[]} */
  const samples = [];
  const block = 1000;
  for (let r = 0; r < Math.max(20, rounds / 10) + 2; r += 1) {
    const t0 = performance.now();
    for (let i = 0; i < block; i += 1) channel.publishDelta(delta(i));
    const t1 = performance.now();
    if (r >= 2) samples.push((t1 - t0) / block);
    // empty the queues so nobody is dropped (each holds < 4,096)
    for (const s of subscriptions) {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await E(s).next();
        if (batch.deliveries.length < 256) break;
      }
    }
    // a fresh turn keeps the folded text small between blocks
    startTurn(channel);
  }
  // eslint-disable-next-line no-await-in-loop
  await stats('channels.delta.publish', samples, {
    budget: { median: 5 },
    extra: { ...extra, subscribers: n, deltasPerSample: block },
  });
}

// ---- fold of a turn of 5,000 deltas
{
  /** @type {number[]} */
  const turnMs = [];
  /** @type {number[]} */
  const snapshotMs = [];
  let snapshotUnits = 0;
  for (let r = 0; r < 12; r += 1) {
    const channel = makeChannelRegistry().channelFor(Far('Session', {}));
    const t0 = performance.now();
    startTurn(channel);
    for (let round = 0; round < 3; round += 1) {
      for (let i = 0; i < (round === 2 ? 1666 : 1667); i += 1) {
        channel.publishDelta(
          harden({ type: 'delta', turnId: 't1', round, text: `${chunk}${i}` }),
        );
      }
      if (round < 2) {
        channel.publisher.publish(
          harden({
            rev: 2 + round * 2,
            events: [
              { type: 'phase', turnId: 't1', phase: 'using tools' },
              {
                type: 'tool_call',
                turnId: 't1',
                id: `t1/r${round}/c0`,
                name: 'echo',
                args: '{"text":"a"}',
              },
            ],
          }),
        );
        channel.publisher.publish(
          harden({
            rev: 3 + round * 2,
            events: [
              {
                type: 'tool_result',
                turnId: 't1',
                id: `t1/r${round}/c0`,
                name: 'echo',
                result: 'a',
                failed: false,
              },
              { type: 'phase', turnId: 't1', phase: 'thinking' },
            ],
          }),
        );
      }
    }
    channel.publisher.publish(
      harden({
        rev: 6,
        events: [
          { type: 'final', turnId: 't1', text: 'done' },
          {
            type: 'usage',
            turnId: 't1',
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
            context: { usedTokens: 2, windowTokens: 100 },
            turns: 1,
            incompleteTurns: 0,
          },
          { type: 'end', turnId: 't1', status: 'completed' },
        ],
      }),
    );
    const t1 = performance.now();
    const snapshot = channel.snapshot();
    const t2 = performance.now();
    snapshotUnits = JSON.stringify(snapshot).length;
    if (r >= 2) {
      turnMs.push(t1 - t0);
      snapshotMs.push(t2 - t1);
    }
  }
  await stats('channels.fold.turn5000', turnMs, {
    extra: { ...extra, deltas: 5000, toolRounds: 2 },
  });
  await stats(
    'channels.fold.perDelta',
    turnMs.map(ms => ms / 5000),
    { budget: { median: 5 }, extra: { ...extra, deltas: 5000 } },
  );
  await stats('channels.snapshot.turn5000', snapshotMs, {
    extra: { snapshotJsonUnits: snapshotUnits },
  });
  // a snapshot mid-turn (the streaming text not yet flushed)
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  startTurn(channel);
  for (let i = 0; i < 5000; i += 1) channel.publishDelta(delta(i));
  const t0 = performance.now();
  const midSnapshot = channel.snapshot();
  await single('channels.snapshot.midTurn5000', performance.now() - t0, {
    extra: {
      streamingTextUnits: /** @type {any} */ (midSnapshot).turn.status
        .streamingText.length,
    },
  });
}

// ---- one next() of 256 queued deliveries
{
  const channel = makeChannelRegistry().channelFor(Far('Session', {}));
  startTurn(channel);
  const subscription = channel.subscribe(1);
  await E(subscription).next();
  /** @type {number[]} */
  const samples = [];
  for (let r = 0; r < 52; r += 1) {
    for (let i = 0; i < 256; i += 1) channel.publishDelta(delta(i));
    const t0 = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const batch = await E(subscription).next();
    const t1 = performance.now();
    if (batch.deliveries.length !== 256) throw Error('expected 256');
    if (r >= 2) samples.push(t1 - t0);
    startTurn(channel);
    // eslint-disable-next-line no-await-in-loop
    await E(subscription).next(); // the turn-start batch
  }
  await stats('channels.next.batch256', samples, { extra });
}
