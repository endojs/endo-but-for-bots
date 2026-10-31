// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { makeCancelKit } from '@endo/cancel';

import { MAX_TIMER_DELAY_MILLISECONDS, makeTimer } from '../src/timer.js';

test('Timer clears the host timer when cancellation wins', async t => {
  /** @type {() => void} */
  let expire = () => {};
  /** @type {unknown[]} */
  const cleared = [];
  const handle = harden({});
  const timer = makeTimer({
    setTimeout: callback => {
      expire = callback;
      return handle;
    },
    clearTimeout: candidate => cleared.push(candidate),
    now: () => 123,
  });
  const { cancelled, cancel } = makeCancelKit();
  const pending = timer.delay(10, cancelled);

  cancel(Error('stop'));
  await t.throwsAsync(() => pending, { message: 'stop' });
  t.deepEqual(cleared, [handle]);

  expire();
  t.deepEqual(cleared, [handle]);
  t.is(await timer.now(), 123);
});

test('Timer rejects delays that the host would clamp', async t => {
  const timer = makeTimer();
  await t.throwsAsync(() => timer.delay(MAX_TIMER_DELAY_MILLISECONDS + 1), {
    message: /must be an integer between/,
  });
});
