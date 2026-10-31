// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';

import {
  HOSTED_TURN_CHANNEL_BOUNDS,
  awaitBarrier,
  makeHostedTurnChannel,
  weighHostedEvent,
} from '../src/turn-channel.js';

test('a channel delivers events to its reader and settles its terminal once', async t => {
  const channel = makeHostedTurnChannel();
  channel.push({ type: 'text-delta', text: 'a' });
  // A terminal event ends the reader by itself.
  channel.push({ type: 'end' });
  const events = [];
  for await (const event of iterateReader(channel.reader)) events.push(event);
  t.deepEqual(events, [{ type: 'text-delta', text: 'a' }, { type: 'end' }]);
  t.false(channel.isSettled());
  channel.settle();
  channel.settle();
  t.true(channel.isSettled());
  await channel.terminal;
  t.false(
    channel.isClosed(),
    'closing from the producer side is not consumer closure',
  );
});

test('a consumer closing the reader early is reported once, and is not the terminal', async t => {
  let closures = 0;
  const channel = makeHostedTurnChannel({
    onConsumerClosed: () => {
      closures += 1;
    },
  });
  channel.push({ type: 'text-delta', text: 'a' });
  const iterator = iterateReader(channel.reader);
  await iterator.next();
  await iterator.return?.(undefined);
  t.is(closures, 1);
  t.true(channel.isClosed());
  t.false(channel.isSettled(), 'the producer has not ended');
  // Pushing into a closed reader is a no-op, not an error.
  channel.push({ type: 'end' });
  channel.settle();
  await channel.terminal;
});

test('the bounds are the ones every adapter used', t => {
  t.deepEqual(HOSTED_TURN_CHANNEL_BOUNDS, {
    maxItems: 1024,
    maxWeight: 16 * 1024 * 1024,
  });
  t.is(weighHostedEvent({ type: 'end' }), 64 + '{"type":"end"}'.length * 2);
});

test('awaitBarrier returns the barrier, or fails by the deadline with the caller’s error', async t => {
  t.is(
    await awaitBarrier(Promise.resolve('done'), {
      deadlineMs: 1000,
      makeFailure: () => Error('late'),
    }),
    'done',
  );
  await t.throwsAsync(
    awaitBarrier(new Promise(() => {}), {
      deadlineMs: 10,
      makeFailure: () => Error('late'),
    }),
    { message: 'late' },
  );
  await t.throwsAsync(
    awaitBarrier(Promise.resolve(), {
      deadlineMs: 0,
      makeFailure: () => Error('x'),
    }),
    { message: /positive deadline/ },
  );
});

test('close from the producer side ends a reader that will get no terminal', async t => {
  const channel = makeHostedTurnChannel();
  channel.push({ type: 'text-delta', text: 'a' });
  channel.close();
  const events = [];
  for await (const event of iterateReader(channel.reader)) events.push(event);
  t.deepEqual(
    events,
    [],
    'undelivered events are discarded, not delivered late',
  );
});
