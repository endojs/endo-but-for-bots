/* global setTimeout */
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
    onTick: (entry, tickNumber) =>
      ticks.push({ label: entry.label, tickNumber }),
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

test('cancel during active tick disarms deadline timer', async t => {
  const ticks = [];
  const { scheduler } = makeIntervalSchedulerKit({
    minPeriodMs: 1,
    onTick: (entry, tickNumber) => ticks.push(tickNumber),
  });

  // Create interval with immediate tick and long timeout
  const interval = await scheduler.makeInterval('deadline-test', 200, {
    firstDelayMs: 0,
    tickTimeoutMs: 5000,
  });

  // Wait for first tick to fire (creates a deadline timer)
  await new Promise(resolve => setTimeout(resolve, 30));
  t.true(ticks.length >= 1, 'tick should have fired');

  // Cancel while the deadline timer is active — should disarm it
  await interval.cancel();
  t.is(interval.info().status, 'cancelled');
});

test('help returns documentation', async t => {
  const { scheduler, control } = makeIntervalSchedulerKit();

  t.true(scheduler.help().includes('IntervalScheduler'));
  t.true(control.help().includes('IntervalControl'));

  const interval = await scheduler.makeInterval('doc', 60000);
  t.true(interval.help().includes('Interval'));

  await interval.cancel();
});

test('cancel-during-tick: late resolve() must not mutate or re-persist the entry', async t => {
  // Capture every tickResponse so the test can call resolve() after
  // the entry is cancelled, simulating the network round-trip race
  // (onTick fires, agent receives the tick, agent calls cancel(),
  // agent then calls resolve() before the daemon learns of cancel).
  /** @type {Array<{ entryId: string, tickResponse: object }>} */
  const responses = [];
  const ticks = [];
  /** @type {Array<{ id: string, status: string, nextTickAt: number }>} */
  const persisted = [];
  const { scheduler } = makeIntervalSchedulerKit({
    minPeriodMs: 1,
    onTick: (entry, tickNumber, tickResponse) => {
      ticks.push(tickNumber);
      responses.push({ entryId: entry.id, tickResponse });
    },
    onEntryChange: entry => {
      persisted.push({
        id: entry.id,
        status: entry.status,
        nextTickAt: entry.nextTickAt,
      });
    },
  });

  const interval = await scheduler.makeInterval('race', 5000, {
    firstDelayMs: 0,
    tickTimeoutMs: 60_000,
  });

  // Wait for the first tick to fire (firstDelayMs=0 schedules a 0-ms timeout).
  await new Promise(resolve => setTimeout(resolve, 30));
  t.is(ticks.length, 1, 'first tick fired');
  t.is(responses.length, 1, 'one tickResponse handed to onTick');

  // Snapshot the persistence trace at the cancel point.  After
  // cancel(), the only persistence write that may follow is one
  // identifying the entry as cancelled; under the race fix, late
  // resolve() must not produce any further onEntryChange for this
  // entry.
  await interval.cancel();
  t.is(interval.info().status, 'cancelled');
  const persistedAtCancel = persisted.length;
  const cancelledEntry = persisted[persisted.length - 1];
  t.is(cancelledEntry.status, 'cancelled');
  const nextTickAtCancel = cancelledEntry.nextTickAt;

  // Late resolve: must drop on the floor; must not re-arm and must
  // not produce a new persistence write that reflects an advanced
  // nextTickAt (which would corrupt the on-disk state and make a
  // restart try to revive the cancelled entry).
  responses[0].tickResponse.resolve();

  // Wait long enough that the interval, were it re-armed, would fire
  // a second tick.  No additional tick may arrive.
  await new Promise(resolve => setTimeout(resolve, 80));
  t.is(ticks.length, 1, 'late resolve() must not revive a cancelled interval');
  t.is(
    persisted.length,
    persistedAtCancel,
    'late resolve() must not produce a new onEntryChange for a cancelled entry',
  );
  // The entry's nextTickAt must not have advanced as a side effect
  // of the late resolve.
  t.is(
    interval.info().nextTickAt,
    nextTickAtCancel,
    'late resolve() must not advance nextTickAt on a cancelled entry',
  );
});

test('loadEntry seeds nextId so post-restart makeInterval ids do not collide', async t => {
  // Simulate a restart: a fresh kit loads a previously persisted entry
  // with id `interval-7`, then makeInterval is called.  Without the
  // nextId seeding, the newly generated id would be `interval-1`,
  // ..., colliding with the loaded entry once nextId reaches 7 and
  // silently overwriting it via `entries.set(entry.id, ...)`.  After
  // the fix, the loader seeds nextId so the next id is `interval-8`.
  const { scheduler, loadEntry } = makeIntervalSchedulerKit({
    minPeriodMs: 1000,
  });
  loadEntry({
    id: 'interval-7',
    label: 'persisted',
    periodMs: 5000,
    firstDelayMs: 50_000,
    tickTimeoutMs: 2500,
    nextTickAt: Date.now() + 50_000,
    createdAt: Date.now(),
    tickCount: 0,
    status: 'active',
  });

  const fresh = await scheduler.makeInterval('fresh', 5000, {
    firstDelayMs: 50_000,
  });
  const freshInfo = fresh.info();
  t.not(freshInfo.id, 'interval-7', 'new id must not collide with loaded id');
  t.is(freshInfo.id, 'interval-8', 'new id must follow the highest loaded id');

  // Both entries should appear in list().
  const list = await scheduler.list();
  t.is(list.length, 2, 'loaded and fresh both visible after seeding');
  await fresh.cancel();
});

test('control.revoke() persists cancelled state via onEntryChange', async t => {
  // The daemon registers `context.onCancel(() => control.revoke())`,
  // so `revoke()` must notify the persistence layer or persisted
  // files stay marked `active` and get revived on next startup.
  /** @type {Array<{ id: string, status: string }>} */
  const persisted = [];
  const { scheduler, control } = makeIntervalSchedulerKit({
    minPeriodMs: 1000,
    onEntryChange: entry => {
      persisted.push({ id: entry.id, status: entry.status });
    },
  });

  const i1 = await scheduler.makeInterval('a', 5000, { firstDelayMs: 50_000 });
  const i2 = await scheduler.makeInterval('b', 5000, { firstDelayMs: 50_000 });
  void i1;
  void i2;

  // Drop the create-time persistence entries.
  persisted.length = 0;

  control.revoke();

  // Each revoked entry must produce an onEntryChange with cancelled status.
  t.is(persisted.length, 2, 'revoke() persists each entry');
  t.true(
    persisted.every(p => p.status === 'cancelled'),
    'all revoked entries persisted as cancelled',
  );
});

test('makeInterval rejects non-finite period (Infinity, NaN)', async t => {
  const { scheduler } = makeIntervalSchedulerKit({ minPeriodMs: 1000 });

  // `Infinity` is `> minPeriodMs` for every finite minimum, so the
  // `>= currentMinPeriodMs` check alone admits it; without the
  // explicit finite check, `nextTickAt` becomes `Infinity` and
  // `setTimeout(Infinity)` fires immediately.
  await t.throwsAsync(() => scheduler.makeInterval('inf', Infinity), {
    message: /must be a finite number/,
  });
  await t.throwsAsync(() => scheduler.makeInterval('nan', NaN), {
    // NaN fails both the finite check and the >= check; either is fine.
    message: /must be a finite number|below minimum/,
  });
});

test('setPeriod rejects non-finite period', async t => {
  const { scheduler } = makeIntervalSchedulerKit({ minPeriodMs: 1000 });
  const interval = await scheduler.makeInterval('finite', 5000);
  await t.throwsAsync(() => interval.setPeriod(Infinity), {
    message: /must be a finite number/,
  });
  await interval.cancel();
});

test('cancel-during-tick: late reschedule() must not mutate or re-persist the entry', async t => {
  /** @type {Array<{ tickResponse: object }>} */
  const responses = [];
  const ticks = [];
  /** @type {Array<{ id: string, status: string, nextTickAt: number }>} */
  const persisted = [];
  const { scheduler } = makeIntervalSchedulerKit({
    minPeriodMs: 1,
    onTick: (_entry, tickNumber, tickResponse) => {
      ticks.push(tickNumber);
      responses.push({ tickResponse });
    },
    onEntryChange: entry => {
      persisted.push({
        id: entry.id,
        status: entry.status,
        nextTickAt: entry.nextTickAt,
      });
    },
  });

  // periodMs/10 = 50 > tickTimeoutMs = 5, so reschedule's
  // `min(baseBackoff*..., tickTimeoutMs)` clamps backoffDelay to 5;
  // retryAt > deadline (current nextTickAt + 5), so reschedule takes
  // the auto-resolve-via-advanceToNextPeriod branch.  Under the old
  // racy code, that branch writes a fresh nextTickAt for an
  // already-cancelled entry; the fix drops on the floor.
  const interval = await scheduler.makeInterval('race-reschedule', 500, {
    firstDelayMs: 0,
    tickTimeoutMs: 5,
  });

  // Wait briefly so onTick fires and gives us a tickResponse, but
  // not so long that the 5ms deadline has already auto-resolved.
  // Capture the response synchronously the moment it arrives.
  const start = Date.now();
  while (responses.length === 0 && Date.now() - start < 50) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  t.is(responses.length, 1, 'one tickResponse handed to onTick');

  await interval.cancel();
  const persistedAtCancel = persisted.length;
  const cancelledNextTickAt = interval.info().nextTickAt;
  responses[0].tickResponse.reschedule();

  await new Promise(resolve => setTimeout(resolve, 80));
  t.is(
    persisted.length,
    persistedAtCancel,
    'late reschedule() (deadline-exceeded branch) must not produce ' +
      'a new onEntryChange for a cancelled entry',
  );
  t.is(
    interval.info().nextTickAt,
    cancelledNextTickAt,
    'late reschedule() must not advance nextTickAt on a cancelled entry',
  );
});
