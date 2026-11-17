// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeBoundedReader } from '../bounded-channel.js';
import { iterateReader } from '../iterate-reader.js';

const options = harden({ maxItems: 2, maxWeight: 20, weigh: () => 10 });

test('writes apply backpressure and preserve a long stream without increasing bounds', async t => {
  t.timeout(10_000);
  const channel = makeBoundedReader(options);
  await channel.write('a');
  await channel.write('b');
  let accepted = false;
  const waiting = channel.write('c').then(ok => {
    accepted = ok;
  });
  await null;
  t.false(accepted);
  t.is(channel.buffered(), 2);
  await t.throwsAsync(channel.write('concurrent'), {
    message: /one pending write/,
  });
  const iterator = iterateReader(channel.reader, { buffer: 0 });
  t.is((await iterator.next()).value, 'a');
  await waiting;
  t.true(accepted);
  const producer = (async () => {
    for (let i = 0; i < 5000; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await channel.write(i))) throw Error('Unexpected close');
    }
    channel.push(harden({ type: 'end' }));
  })();
  const remaining = [];
  for await (const item of iterator) remaining.push(item);
  await producer;
  t.deepEqual(remaining.slice(0, 2), ['b', 'c']);
  t.deepEqual(
    remaining.slice(2, -1),
    Array.from({ length: 5000 }, (_, i) => i),
  );
});

test('closing a full queue releases its waiting writer', async t => {
  t.timeout(5000);
  const channel = makeBoundedReader(options);
  channel.push('a');
  channel.push('b');
  const waiting = channel.write('c');
  channel.close();
  t.false(await waiting);
});

test('overflow diagnostics identify the bound and accounting without event contents', async t => {
  const channel = makeBoundedReader({ ...options, name: 'test-raw' });
  channel.push('SECRET a');
  channel.push('SECRET b');
  channel.push('SECRET c');
  const error = await t.throwsAsync(iterateReader(channel.reader).next());
  t.regex(
    error.message,
    /channel=test-raw, reason=item-limit, queuedItems=2, maxItems=2, queuedWeight=20, incomingWeight=10, maxWeight=20/,
  );
  t.false(error.message.includes('SECRET'));
  const oversized = makeBoundedReader({ ...options, weigh: () => 21 });
  t.false(await oversized.write('SECRET'));
  await t.throwsAsync(iterateReader(oversized.reader).next(), {
    message: /reason=oversized-event/,
  });
});

test('terminal delivery has reserved capacity and preserves queued data', async t => {
  let closed = 0;
  const channel = makeBoundedReader({
    ...options,
    onClose: () => {
      closed += 1;
    },
  });
  channel.push('a');
  channel.push('b');
  channel.push(harden({ type: 'end' }));
  const events = [];
  for await (const event of iterateReader(channel.reader, { buffer: 0 }))
    events.push(event);
  t.deepEqual(events, ['a', 'b', { type: 'end' }]);
  t.is(closed, 0);
});

test('overflow reports failure rather than silently dropping evidence', async t => {
  let closed = 0;
  const channel = makeBoundedReader({
    ...options,
    onClose: () => {
      closed += 1;
    },
  });
  channel.push('a');
  channel.push('b');
  channel.push('overflow');
  t.true(channel.isClosed());
  t.is(closed, 1);
  channel.push(harden({ type: 'end' }));
  channel.close();
  t.is(closed, 1);
  const reader = iterateReader(channel.reader, { buffer: 0 });
  await t.throwsAsync(reader.next(), { message: /queue capacity exceeded/ });
});

test('byte weight bounds large entries independently of item count', async t => {
  const channel = makeBoundedReader({ ...options, maxItems: 10 });
  channel.push('a');
  channel.push('b');
  channel.push('c');
  await t.throwsAsync(iterateReader(channel.reader).next(), {
    message: /queue capacity exceeded/,
  });
  const oversized = makeBoundedReader({ ...options, weigh: () => 21 });
  oversized.push(harden({ type: 'end' }));
  await t.throwsAsync(iterateReader(oversized.reader).next(), {
    message: /queue capacity exceeded/,
  });
});

test('consumed traffic releases queue charges across a long healthy stream', async t => {
  t.timeout(10_000);
  const channel = makeBoundedReader({ ...options, maxItems: 1, maxWeight: 10 });
  const reader = iterateReader(channel.reader, { buffer: 0 });
  for (let n = 0; n < 20_000; n += 1) {
    channel.push(n);
    // eslint-disable-next-line no-await-in-loop
    t.deepEqual(await reader.next(), { value: n, done: false });
  }
  channel.push(harden({ type: 'end' }));
  t.deepEqual(await reader.next(), { value: { type: 'end' }, done: false });
  t.true((await reader.next()).done);
});

test('a stalled consumer does not drain the local queue into an eager ack chain', async t => {
  t.timeout(5000);
  const channel = makeBoundedReader(options);
  const reader = iterateReader(channel.reader, { buffer: 0 });
  channel.push('initial');
  await reader.next();
  // With zero prefetch, the consumer has not granted the next value's credit.
  channel.push('a');
  channel.push('b');
  await new Promise(resolve => setTimeout(resolve, 0));
  channel.push('overflow');
  await t.throwsAsync(reader.next(), { message: /queue capacity exceeded/ });
});

test('consumer cancellation closes an idle producer without more events', async t => {
  t.timeout(5000);
  let closed = 0;
  const channel = makeBoundedReader({
    ...options,
    onClose: () => {
      closed += 1;
    },
  });
  const reader = iterateReader(channel.reader, { buffer: 0 });
  channel.push('initial');
  await reader.next();
  await reader.return();
  t.is(closed, 1);
  t.true(channel.isClosed());
});
