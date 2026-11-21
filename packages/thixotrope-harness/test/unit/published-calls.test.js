// @ts-check
import './_m1a-prelude.js';
import test from '@endo/ses-ava/test.js';
/* eslint-disable import/no-relative-packages */
import { makePublications } from '../../guest/session/publications.js';
import { HUB_RETIRED_MESSAGE } from '../../guest/lib/retired.js';
import { limits } from '../../guest/lib/limits.js';
import { makeTimerFacet } from '../../resources/agent-host/impl/timers.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);
const drain = () => new Promise(resolve => setImmediate(resolve));

test('adapter alarm reports expiry and cancellation, whichever happened first', async t => {
  let cancels = 0;
  let fire = () => {};
  const timer = makeTimerFacet({
    delay: async () => {},
    after(ms, fn) {
      t.is(ms, 50);
      fire = fn;
      return () => {
        cancels += 1;
      };
    },
  });
  const first = await E(timer).alarm(50);
  const expiry = E(first).whenExpired();
  fire();
  await E(first).cancel();
  t.true(await expiry);
  const second = await E(timer).alarm(50);
  const cancelled = E(second).whenExpired();
  await E(second).cancel();
  fire();
  t.false(await cancelled);
  t.is(cancels, 2);
});

/** @param {boolean} [stale] */
const fixture = (stale = false) => {
  const expired = makePromiseKit();
  const reply = makePromiseKit();
  const invoked = makePromiseKit();
  const cancelled = makePromiseKit();
  /** @type {any[]} */
  const retired = [];
  /** @type {any[]} */
  const dispatches = [];
  /** @type {number[]} */
  const deadlines = [];
  let opens = 0;
  let staleCalls = 0;
  const alarm = Far('Alarm', {
    whenExpired: () => expired.promise,
    cancel: () => {
      cancelled.resolve(true);
    },
  });
  const timer = Far('Timer', {
    alarm: (/** @type {number} */ ms) => {
      deadlines.push(ms);
      return alarm;
    },
  });
  const staleTimer = Far('Old timer', {
    alarm: () => {
      staleCalls += 1;
      throw Error(HUB_RETIRED_MESSAGE);
    },
  });
  const scope = Far('Scope', {});
  /** @type {any} */
  const state = {
    scope,
    deadlineMs: 50,
    running: { scope, ports: { timer: stale ? staleTimer : timer } },
  };
  const host = Far('Host', {});
  const supervisor = makePublications({
    exec: { state: () => state },
    labels: { bindObject: () => {} },
    services: {
      host,
      execVat: Far('Exec handle', {
        retire: (/** @type {any} */ s) => {
          retired.push(s);
        },
      }),
      backend: Far('Backend', {
        open: (/** @type {any} */ h) => {
          if (h !== host) throw Error('wrong host');
          opens += 1;
          return harden({ timer });
        },
      }),
    },
  })(
    'counter',
    Far('Executor', {
      invoke: (/** @type {string} */ method, /** @type {string} */ args) => {
        dispatches.push([method, args]);
        invoked.resolve(true);
        return reply.promise;
      },
    }),
    Far('Counter', {}),
  );
  state.running = undefined;
  const invoke = () => E(supervisor).invoke('increment', '[]');
  return {
    scope,
    state,
    expired,
    reply,
    invoked,
    cancelled,
    invoke,
    retired,
    dispatches,
    deadlines,
    reopens: () => [staleCalls, opens],
  };
};

test('a stale undelivered alarm reopens the timer before exactly one model dispatch', async t => {
  const f = fixture(true);
  const done = f.invoke();
  await f.invoked.promise;
  f.reply.resolve('1');
  t.is(await done, '1');
  await f.cancelled.promise;
  t.deepEqual(f.reopens(), [1, 1]);
  t.deepEqual(f.deadlines, [50]);
  t.deepEqual(f.dispatches, [['increment', '[]']]);
  t.is(f.state.scope, f.scope);
});

test('expiry while the owner is idle retires exactly the originating scope', async t => {
  const f = fixture();
  const done = f.invoke();
  await f.invoked.promise;
  f.expired.resolve(true);
  await t.throwsAsync(done, { message: 'Published method timed out' });
  await f.cancelled.promise;
  await drain();
  t.is(f.state.scope, undefined);
  t.deepEqual(f.retired, [f.scope]);
  f.reply.resolve('1');
  await t.throwsAsync(f.invoke(), {
    message: 'The published exec scope has ended',
  });
  t.is(f.dispatches.length, 1);
});

for (const late of ['expiry', 'failure']) {
  test(`a late alarm ${late} after success preserves the idle scope`, async t => {
    const f = fixture();
    const done = f.invoke();
    await f.invoked.promise;
    f.reply.resolve('1');
    t.is(await done, '1');
    await f.cancelled.promise;
    if (late === 'expiry') f.expired.resolve(true);
    else f.expired.reject(Error('timer disconnected'));
    await drain();
    t.is(f.state.scope, f.scope);
    t.deepEqual(f.retired, []);
  });
}

test('parallel published calls release their window slots after completion', async t => {
  const f = fixture();
  const held = Array.from({ length: limits.callWindow }, f.invoke);
  await drain();
  t.is(f.dispatches.length, limits.callWindow);
  await t.throwsAsync(f.invoke(), {
    message: 'Too many pending published calls',
  });
  t.is(f.deadlines.length, limits.callWindow);
  f.reply.resolve('1');
  t.true((await Promise.all(held)).every(value => value === '1'));
  t.is(await f.invoke(), '1');
  t.is(f.dispatches.length, limits.callWindow + 1);
});
