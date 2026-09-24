// @ts-check
import harden from '@endo/harden';
import { E, Far } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import test from '@endo/ses-ava/test.js';

import { makeDurableAlarms } from '../src/alarms/durable-alarms.js';
import { makeGuestClock } from '../src/alarms/guest-clock.js';

const restarted = () =>
  Error('session resumed after restart; pending answer aborted');

const makeFixture = () => {
  let saved;
  let now = 1000n;
  let failBefore = false;
  let failAfter = false;
  let fire = () => {};
  const storage = {
    read: () => saved,
    write: text => {
      if (failBefore) throw Error('storage unavailable');
      saved = text;
      if (failAfter) throw Error('crash after commit');
    },
  };
  const restore = () => {
    const alarms = makeDurableAlarms(
      {
        timers: {
          now: () => Number(now),
          monotonicNow: () => 0,
          setTimer: callback => {
            fire = callback;
            return 1;
          },
          clearTimer: () => {
            fire = () => {};
          },
        },
      },
      {
        storage,
        now: () => now,
        makeResource: (_name, description) => alarms.resource(description),
      },
    );
    return {
      alarms,
      clock: /** @type {any} */ (alarms.clockResource({ workerId: 'waiter' })),
    };
  };
  return {
    restore,
    fire: () => fire(),
    advance: () => {
      now = 3000n;
    },
    failBefore: value => {
      failBefore = value;
    },
    failAfter: value => {
      failAfter = value;
    },
    saved: () => JSON.parse(saved),
  };
};

test('release cleans an arm whose write published before throwing', async t => {
  const fixture = makeFixture();
  const { alarms, clock } = fixture.restore();
  t.teardown(() => alarms.shutdown());
  fixture.failAfter(true);
  await t.throwsAsync(() => E(clock).arm('1', 2000n), {
    message: 'crash after commit',
  });
  t.is(alarms.status().retained, 0n);
  t.is(fixture.saved().alarms.length, 1);
  fixture.failAfter(false);
  await E(clock).release('1');
  t.deepEqual(fixture.saved(), { version: 2, alarms: [] });
});

for (const cancelled of [false, true]) {
  test(`restores ${cancelled ? 'cancellation' : 'fulfillment'} committed before delivery`, async t => {
    const fixture = makeFixture();
    const first = fixture.restore();
    t.teardown(() => first.alarms.shutdown());
    await E(first.clock).arm('1', 2000n);
    fixture.advance();
    fixture.failAfter(true);
    if (cancelled) {
      await t.throwsAsync(() => E(first.clock).cancel('1'), {
        message: 'crash after commit',
      });
    } else {
      t.throws(() => fixture.fire(), { message: 'crash after commit' });
    }
    fixture.failAfter(false);
    const second = fixture.restore();
    t.teardown(() => second.alarms.shutdown());
    const settlement = second.alarms.resource({
      workerId: 'waiter',
      alarmId: '1',
    });
    if (cancelled)
      await t.throwsAsync(settlement, { message: 'Alarm cancelled' });
    else t.is(await settlement, 3000n);
    t.is(second.alarms.status().retained, 1n);
    t.is(second.alarms.status().armed, 0n);
    fixture.failBefore(true);
    await t.throwsAsync(() => E(second.clock).release('1'), {
      message: 'storage unavailable',
    });
    t.is(second.alarms.status().retained, 1n);
    t.is(fixture.saved().alarms.length, 1);
    fixture.failBefore(false);
    await E(second.clock).release('1');
    await E(second.clock).release('1');
    t.is(second.alarms.status().retained, 0n);
    t.deepEqual(fixture.saved(), { version: 2, alarms: [] });
  });
}

for (const applied of [false, true]) {
  test(`guest retries release interrupted ${applied ? 'after' : 'before'} effect`, async t => {
    t.timeout(5000);
    const host = makePromiseKit();
    const done = makePromiseKit();
    let calls = 0;
    let retained = true;
    const clock = makeGuestClock(
      Far('HostClock', {
        arm: () => harden({ settlement: host.promise }),
        release: () => {
          calls += 1;
          if (calls === 1) {
            if (applied) retained = false;
            throw restarted();
          }
          retained = false;
          done.resolve(undefined);
        },
      }),
    );
    const { settlement } = await E(clock).arm(2000n);
    t.not(settlement, host.promise, 'callers receive a guest-local promise');
    host.resolve(3000n);
    t.is(await settlement, 3000n);
    await done.promise;
    t.is(calls, 2);
    t.false(retained);
  });
}

test('guest abandons an interrupted arm and retries failed cleanup on use', async t => {
  t.timeout(5000);
  const attempted = makePromiseKit();
  let calls = 0;
  let retained = false;
  const clock = makeGuestClock(
    Far('HostClock', {
      arm: () => {
        retained = true;
        throw restarted();
      },
      release: () => {
        calls += 1;
        if (calls === 1) {
          attempted.resolve(undefined);
          throw Error('storage unavailable');
        }
        retained = false;
      },
      now: () => 3000n,
    }),
  );
  await t.throwsAsync(() => E(clock).arm(2000n), {
    message: restarted().message,
  });
  await attempted.promise;
  // Let the failed cleanup return to the retry queue.
  await new Promise(resolve => setTimeout(resolve, 0));
  t.is(calls, 1, 'permanent failure does not spin');
  t.true(retained);
  t.is(await E(clock).now(), 3000n);
  t.is(calls, 2);
  t.false(retained);
});
