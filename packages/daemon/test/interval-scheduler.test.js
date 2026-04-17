import test from '@endo/ses-ava/prepare-endo.js';

import { makeIntervalSchedulerKit } from '../src/interval-scheduler.js';

test('makeInterval creates an active interval', async t => {
  const { scheduler } = makeIntervalSchedulerKit({ minPeriodMs: 1000 });
  const interval = await scheduler.makeInterval('test', 5000);

  t.is(interval.label(), 'test');
  t.is(interval.period(), 5000);

  const info = interval.info();
  t.is(info.status, 'active');
  t.is(info.label, 'test');
  t.is(info.periodMs, 5000);
  t.is(info.tickCount, 0);

  await interval.cancel();
});

test('makeInterval enforces minPeriodMs', async t => {
  const { scheduler } = makeIntervalSchedulerKit({ minPeriodMs: 5000 });

  await t.throwsAsync(() => scheduler.makeInterval('fast', 1000), {
    message: /below minimum/,
  });
});

test('makeInterval enforces maxActive', async t => {
  const { scheduler } = makeIntervalSchedulerKit({
    maxActive: 2,
    minPeriodMs: 1000,
  });

  const i1 = await scheduler.makeInterval('a', 5000);
  const i2 = await scheduler.makeInterval('b', 5000);

  await t.throwsAsync(() => scheduler.makeInterval('c', 5000), {
    message: /Maximum active intervals/,
  });

  // After cancelling one, we can create a new one.
  await i1.cancel();
  const i3 = await scheduler.makeInterval('c', 5000);
  t.is(i3.label(), 'c');

  await i2.cancel();
  await i3.cancel();
});

test('list returns active intervals', async t => {
  const { scheduler } = makeIntervalSchedulerKit({ minPeriodMs: 1000 });

  const i1 = await scheduler.makeInterval('alpha', 5000);
  const i2 = await scheduler.makeInterval('beta', 10000);

  const list = await scheduler.list();
  t.is(list.length, 2);
  t.is(list[0].label, 'alpha');
  t.is(list[1].label, 'beta');

  await i1.cancel();

  const listAfter = await scheduler.list();
  t.is(listAfter.length, 1);
  t.is(listAfter[0].label, 'beta');

  await i2.cancel();
});

test('cancel marks interval as cancelled', async t => {
  const { scheduler } = makeIntervalSchedulerKit({ minPeriodMs: 1000 });
  const interval = await scheduler.makeInterval('temp', 5000);

  t.is(interval.info().status, 'active');
  await interval.cancel();
  t.is(interval.info().status, 'cancelled');
});

test('setPeriod updates the interval period', async t => {
  const { scheduler } = makeIntervalSchedulerKit({ minPeriodMs: 1000 });
  const interval = await scheduler.makeInterval('adj', 5000);

  t.is(interval.period(), 5000);
  await interval.setPeriod(10000);
  t.is(interval.period(), 10000);

  await t.throwsAsync(() => interval.setPeriod(500), {
    message: /below minimum/,
  });

  await interval.cancel();
});

test('control setMaxActive and setMinPeriodMs', t => {
  const { scheduler, control } = makeIntervalSchedulerKit({
    minPeriodMs: 1000,
  });
  void scheduler;

  control.setMaxActive(10);
  control.setMinPeriodMs(2000);

  t.throws(() => control.setMaxActive(0), { message: /must be >= 1/ });
  t.throws(() => control.setMinPeriodMs(500), { message: /must be >= 1000/ });
  t.pass();
});

test('control pause and resume', async t => {
  const ticks = [];
  const { scheduler, control } = makeIntervalSchedulerKit({
    minPeriodMs: 1,
    onTick: (entry, tickNumber) => ticks.push({ label: entry.label, tickNumber }),
  });

  // Create interval with immediate first tick (firstDelayMs=0)
  const interval = await scheduler.makeInterval('pulse', 50, {
    firstDelayMs: 0,
    tickTimeoutMs: 25,
  });

  // Wait for at least one tick
  await new Promise(resolve => setTimeout(resolve, 80));
  const ticksBefore = ticks.length;
  t.true(ticksBefore >= 1, `Expected at least 1 tick, got ${ticksBefore}`);

  // Pause
  control.pause();
  const ticksAtPause = ticks.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  t.is(ticks.length, ticksAtPause, 'No ticks during pause');

  // Resume
  control.resume();
  await new Promise(resolve => setTimeout(resolve, 80));
  t.true(ticks.length > ticksAtPause, 'Ticks resume after resume()');

  await interval.cancel();
});

test('control revoke makes scheduler inert', async t => {
  const { scheduler, control } = makeIntervalSchedulerKit({
    minPeriodMs: 1000,
  });

  const interval = await scheduler.makeInterval('doomed', 5000);
  control.revoke();

  t.is(interval.info().status, 'cancelled');
  await t.throwsAsync(() => scheduler.makeInterval('new', 5000), {
    message: /revoked/,
  });
});

test('control listAll includes all statuses', async t => {
  const { scheduler, control } = makeIntervalSchedulerKit({
    minPeriodMs: 1000,
  });

  const i1 = await scheduler.makeInterval('alive', 5000);
  const i2 = await scheduler.makeInterval('dead', 5000);
  await i2.cancel();

  const all = await control.listAll();
  t.is(all.length, 2);
  t.is(all.find(e => e.label === 'alive').status, 'active');
  t.is(all.find(e => e.label === 'dead').status, 'cancelled');

  await i1.cancel();
});

test('onTick callback fires', async t => {
  const ticks = [];
  const { scheduler } = makeIntervalSchedulerKit({
    minPeriodMs: 1,
    onTick: (entry, tickNumber) => ticks.push({ id: entry.id, tickNumber }),
  });

  // First tick fires immediately (firstDelayMs=0)
  await scheduler.makeInterval('cb', 50, {
    firstDelayMs: 0,
    tickTimeoutMs: 25,
  });

  // Wait for a tick
  await new Promise(resolve => setTimeout(resolve, 30));
  t.true(ticks.length >= 1, 'onTick should have fired');
  t.is(ticks[0].tickNumber, 1);
});

test('help returns documentation', async t => {
  const { scheduler, control } = makeIntervalSchedulerKit();

  t.true(scheduler.help().includes('IntervalScheduler'));
  t.true(control.help().includes('IntervalControl'));

  const interval = await scheduler.makeInterval('doc', 60000);
  t.true(interval.help().includes('Interval'));

  await interval.cancel();
});
