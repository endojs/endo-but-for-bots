// @ts-check
// spell-out-exempt: NaN is the standard JavaScript numeric global.
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

test('Timer rejects and clears the host timer when the cancellation token fulfills', async t => {
  /** @type {unknown[]} */
  const cleared = [];
  const handle = harden({});
  const timer = makeTimer({
    setTimeout: () => handle,
    clearTimeout: candidate => cleared.push(candidate),
  });
  await t.throwsAsync(
    () =>
      timer.delay(
        10,
        // A token that fulfills breaks the cancellation contract on purpose.
        /** @type {Promise<never>} */ (
          /** @type {unknown} */ (Promise.resolve('done'))
        ),
      ),
    {
      message: /must not fulfill/,
    },
  );
  t.deepEqual(cleared, [handle]);
});

test('Timer over the ambient host powers resolves a delay and honors cancellation', async t => {
  const timer = makeTimer();
  const delayed = await timer.delay(0);
  t.is(delayed, undefined);

  const { cancelled, cancel } = makeCancelKit();
  const pending = timer.delay(MAX_TIMER_DELAY_MILLISECONDS, cancelled);
  cancel(Error('stop'));
  await t.throwsAsync(() => pending, { message: 'stop' });
  t.true(Math.abs((await timer.now()) - Date.now()) < 60_000);
});

test('Timer accepts exactly the documented integer delay range', async t => {
  /** @type {number[]} */
  const scheduled = [];
  const timer = makeTimer({
    setTimeout: (callback, milliseconds) => {
      scheduled.push(milliseconds);
      callback();
      return harden({});
    },
    clearTimeout: () => {},
  });
  t.is(await timer.delay(0), undefined);
  t.is(await timer.delay(MAX_TIMER_DELAY_MILLISECONDS), undefined);
  t.deepEqual(scheduled, [0, MAX_TIMER_DELAY_MILLISECONDS]);

  for (const milliseconds of [-1, 0.5, NaN, Infinity, -Infinity]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => timer.delay(milliseconds),
      { message: /must be an integer between/ },
      String(milliseconds),
    );
  }
  t.deepEqual(scheduled, [0, MAX_TIMER_DELAY_MILLISECONDS]);
});
