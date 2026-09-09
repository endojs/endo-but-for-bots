// @ts-check
import '@endo/init';
import test from 'ava';
import { Far } from '@endo/far';
import { whenHostStops } from '../src/host-lifecycle.js';

for (const reject of [true, false]) {
  test(`eventual daemon context ${reject ? 'rejection' : 'fulfillment'} stops the host`, async t => {
    t.timeout(1000);
    let settle = () => {};
    const cancelled = new Promise((resolve, rejectPromise) => {
      settle = () =>
        reject ? rejectPromise(Error('cancelled')) : resolve(undefined);
    });
    cancelled.catch(() => {});
    const context = Promise.resolve(
      Far('Remote context', { whenCancelled: () => cancelled }),
    );
    let stopped = 0;
    const done = whenHostStops(context, async () => {
      stopped += 1;
    });
    t.is(stopped, 0);
    settle();
    await done;
    t.is(stopped, 1);
  });
}

test('failed cleanup remains observable to the lifecycle owner', async t => {
  const context = Far('Cancelled context', {
    whenCancelled: () => Promise.reject(Error('cancelled')),
  });
  await t.throwsAsync(
    () =>
      whenHostStops(context, async () => {
        throw Error('pending tools');
      }),
    {
      message: 'pending tools',
    },
  );
});
