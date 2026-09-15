// @ts-check
import test from '@endo/ses-ava/test.js';
import { E, Far } from '@endo/far';

import { makeDurableClock } from '../src/alarms/durable-clock.js';

const scheduler = Far('TestScheduler', {
  now: () => 15n,
  schedule: () => {
    throw Error('Registration acknowledgment lost');
  },
});

test('clock retains failed registrations and resolves each listener once', async t => {
  t.timeout(10_000);
  const kit = makeDurableClock(scheduler);
  const clock = kit.getClock();
  const control = kit.getControl();
  t.is(await E(clock).now(), 15n);
  let settlements = 0;
  const result = clock.when(20n).then(value => {
    settlements += 1;
    return value;
  });
  await Promise.resolve();
  t.deepEqual(control.pending(), [{ id: 1n, deadline: 20n }]);
  t.throws(() => control.fire(1n, 20n, 19n), { message: /not due/ });
  t.throws(() => control.fire(1n, 21n, 21n), { message: /mismatch/ });
  t.true(control.fire(1n, 20n, 25n));
  t.true(control.fire(1n, 20n, 26n));
  t.is(await result, 25n);
  t.is(settlements, 1);
  t.deepEqual(control.pending(), []);
  t.false('fire' in clock);
  t.false('pending' in clock);
  t.throws(() => control.fire(2n, 20n, 25n), { message: /Unknown alarm/ });
});

test('clock validates deadline range and bounds its pending registrations', t => {
  const kit = makeDurableClock(scheduler);
  const clock = kit.getClock();
  const control = kit.getControl();
  t.throws(() => clock.when(-1n), { message: /64-bit/ });
  t.throws(() => clock.when(2n ** 63n), { message: /64-bit/ });
  for (let index = 0; index < 1024; index += 1) clock.when(0n);
  t.throws(() => clock.when(0n), { message: /Too many/ });
  t.true(control.fire(1n, 0n, 0n));
  clock.when(2n ** 63n - 1n);
  t.is(control.pending().at(-1)?.id, 1025n);
});
