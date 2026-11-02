// @ts-check
import test from '@endo/ses-ava/test.js';

import { makeSerialQueue } from '../src/serial-queue.js';

test('operations run one after another, each starting once the previous settled', async t => {
  const enqueue = makeSerialQueue();
  /** @type {string[]} */
  const log = [];
  const first = enqueue(async () => {
    log.push('first starts');
    await null;
    await null;
    log.push('first ends');
    return 1;
  });
  const second = enqueue(() => {
    log.push('second');
    return 2;
  });
  t.deepEqual(await Promise.all([first, second]), [1, 2]);
  t.deepEqual(log, ['first starts', 'first ends', 'second']);
});

test('a failure is its caller’s and does not stop the queue', async t => {
  const enqueue = makeSerialQueue();
  await t.throwsAsync(
    enqueue(() => {
      throw Error('sync failure');
    }),
    { message: 'sync failure' },
    'a synchronous throw becomes a rejection of the operation’s own promise',
  );
  await t.throwsAsync(
    enqueue(() => Promise.reject(Error('async failure'))),
    {
      message: 'async failure',
    },
  );
  t.is(await enqueue(() => 'still running'), 'still running');
});
