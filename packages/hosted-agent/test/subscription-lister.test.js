// @ts-check
import '@endo/init';
import test from 'ava';

import { makeSubscriptionLister } from '../src/subscription-lister.js';

test('“could not ask” is not “none”: the broker’s list is cached, bounded and outlives an outage', async t => {
  let clock = 0;
  let asks = 0;
  /** @type {() => Promise<any>} */
  let answer = async () => [{ id: 'work', label: 'Work Pro' }];
  const list = makeSubscriptionLister(
    () => {
      asks += 1;
      return answer();
    },
    { now: () => clock },
  );
  t.deepEqual(await list(), [{ id: 'work', label: 'Work Pro' }]);
  // Asked again within half a minute: not a second call.
  await list();
  t.is(asks, 1);
  // An outage later leaves the last answer standing.
  clock += 31_000;
  answer = async () => {
    throw Error('broker worker is restarting');
  };
  t.deepEqual(await list(), [{ id: 'work', label: 'Work Pro' }]);
  t.is(asks, 2);

  // With no answer yet, the failure is the caller's to see.
  const never = makeSubscriptionLister(async () => {
    throw Error('broker worker is restarting');
  });
  await t.throwsAsync(never(), { message: /restarting/ });
});

test('missing broker methods are unavailable, not an empty subscription list', async t => {
  for (const message of [
    'target has no method "subscriptions"',
    'subscriptions is not a function',
  ]) {
    const list = makeSubscriptionLister(async () => {
      throw Error(message);
    });
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(list(), { message });
  }
});

test('a broker explicitly reporting no subscriptions is cached', async t => {
  let asks = 0;
  const list = makeSubscriptionLister(async () => {
    asks += 1;
    return [];
  });
  t.deepEqual(await list(), []);
  t.deepEqual(await list(), []);
  t.is(asks, 1);
});
