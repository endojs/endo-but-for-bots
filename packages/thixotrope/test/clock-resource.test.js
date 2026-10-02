// @ts-check
import { E, Far } from '@endo/far';
import harden from '@endo/harden';
import test from '@endo/ses-ava/test.js';

import { makeAdapterKeeper } from '../src/adapter-keeper.js';
import { guestPrelude } from '../src/guest/prelude.js';
import { makeManager } from '../src/native/manager-kit.js';
import { makeClockAdapter } from '../resources/clock/ephemeral.js';

// The durable module reads the guest prelude off globalThis, as it would in
// its vat. This test runs it in the host, so the names the host lacks are
// installed first; AVA gives each test file an isolate of its own.
for (const [name, value] of Object.entries(guestPrelude)) {
  if (!(name in globalThis))
    Object.defineProperty(globalThis, name, { value, configurable: true });
}
const { make: makeClock } = await import('../resources/clock/durable.js');

/**
 * A clock and timers the test advances by hand. Timers fire in deadline
 * order when the clock passes them; a zero-delay timer fires on the next
 * advance, as a turn away.
 */
const makeFakeTime = () => {
  let clock = 1000n;
  /** @type {Array<{due: bigint, callback: () => void}>} */
  const armed = [];
  const run = () => {
    for (;;) {
      const next = armed
        .filter(({ due }) => due <= clock)
        .sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0))[0];
      if (next === undefined) return;
      armed.splice(armed.indexOf(next), 1);
      next.callback();
    }
  };
  return {
    now: () => clock,
    /**
     * @param {() => void} callback
     * @param {number} delayMs
     */
    setTimer: (callback, delayMs) => {
      const handle = { due: clock + BigInt(delayMs), callback };
      armed.push(handle);
      return handle;
    },
    /** @param {unknown} handle */
    clearTimer: handle => {
      const index = armed.indexOf(/** @type {any} */ (handle));
      if (index >= 0) armed.splice(index, 1);
    },
    /**
     * Move the clock and fire what came due.
     * @param {bigint} ms
     */
    advance: ms => {
      clock += ms;
      run();
    },
    armed: () => armed.length,
  };
};

/** Let every microtask and immediate queued so far run. */
const settled = () => new Promise(resolve => setImmediate(resolve));

/**
 * The durable clock over the real adapter, both in this process, with fake
 * time. Each incarnation the launcher hands out is mortal: killed, it
 * answers nothing, as a dead process does, and the timers it armed are gone.
 */
const fixture = () => {
  const time = makeFakeTime();
  let incarnations = 0;
  /** @type {(() => void) | undefined} */
  let killCurrent;
  const adapters = Far('Launcher', {
    create: () => {
      incarnations += 1;
      let dead = false;
      /** @type {Set<unknown>} */
      const handles = new Set();
      const adapter = makeClockAdapter({
        now: time.now,
        setTimer: (callback, delayMs) => {
          /** @type {unknown} */
          const handle = time.setTimer(() => {
            handles.delete(handle);
            if (!dead) callback();
          }, delayMs);
          handles.add(handle);
          return handle;
        },
        clearTimer: handle => {
          handles.delete(handle);
          time.clearTimer(handle);
        },
      });
      const alive = () => {
        if (dead) throw Error('Adapter process is gone');
      };
      const root = Far('AdapterRoot', {
        __getMethodNames__: () => {
          alive();
          return harden(['bind', 'keys', 'restore', 'unbind']);
        },
        /**
         * @param {unknown} key
         * @param {any} spec
         * @param {bigint} epoch
         */
        bind: (key, spec, epoch) => {
          alive();
          return E(adapter).bind(key, spec, epoch);
        },
        /** @param {unknown} key */
        unbind: key => {
          alive();
          return E(adapter).unbind(key);
        },
        /** @param {Array<[unknown, any, bigint]>} entries */
        restore: entries => {
          alive();
          return E(adapter).restore(entries);
        },
      });
      const kill = () => {
        dead = true;
        for (const handle of handles) time.clearTimer(handle);
        handles.clear();
      };
      killCurrent = kill;
      return Far('Incarnation', { getRoot: () => root, retire: kill });
    },
  });
  const kit = makeClock({
    makeManager: options =>
      makeManager({ adapters, makeKeeper: makeAdapterKeeper }, options),
  });
  return {
    time,
    clock: kit.facet,
    lifecycle: kit.lifecycle,
    incarnations: () => incarnations,
    /** The process dies: its timers are gone and the next use builds anew. */
    killAdapter: () => killCurrent?.(),
  };
};

test('an alarm settles at or after its deadline with the host time, absolute or relative', async t => {
  const { time, clock } = fixture();
  /** @type {string[]} */
  const order = [];
  const absolute = E(clock)
    .at(1500n)
    .then(at => order.push(`at ${at}`));
  const relative = E(clock)
    .after(200n)
    .then(at => order.push(`after ${at}`));
  await settled();
  t.deepEqual(await E(clock).status(), { pending: 2, armed: 2 });
  time.advance(199n);
  await settled();
  t.deepEqual(order, []);
  time.advance(1n);
  await relative;
  t.deepEqual(order, ['after 1200']);
  time.advance(300n);
  await absolute;
  t.deepEqual(order, ['after 1200', 'at 1500']);
  t.deepEqual(await E(clock).status(), { pending: 0, armed: 0 });
  t.is(time.armed(), 0, 'a settled alarm holds no timer');
});

test('a deadline already past settles at once', async t => {
  const { time, clock } = fixture();
  const settlement = E(clock).at(10n);
  time.advance(0n);
  await settled();
  time.advance(0n);
  t.is(await settlement, 1000n);
});

test('a canceller rejects its own alarm and frees its timer; nothing else', async t => {
  const { time, clock } = fixture();
  const { settlement, canceller } = await E(clock).arm(harden({ after: 50n }));
  const other = E(clock).after(50n);
  await settled();
  t.true(await E(canceller).cancel());
  await t.throwsAsync(() => settlement, { message: /cancelled/ });
  t.false(await E(canceller).cancel(), 'once');
  t.deepEqual(await E(clock).status(), { pending: 1, armed: 1 });
  time.advance(50n);
  t.is(await other, 1050n);
});

test('a relative alarm restores as the deadline it resolved to, not the delay again', async t => {
  const { time, clock, lifecycle, killAdapter, incarnations } = fixture();
  const settlement = E(clock).after(1000n);
  await settled();
  t.is(incarnations(), 1);
  time.advance(400n);
  // The process dies; the host reports it and the manager rebuilds, handing
  // the new adapter the resolved deadline.
  killAdapter();
  await E(lifecycle).exited();
  t.is(incarnations(), 2);
  await settled();
  time.advance(599n);
  await settled();
  t.deepEqual(
    await E(clock).status(),
    { pending: 1, armed: 1 },
    'not yet: 1999 < 2000',
  );
  time.advance(1n);
  t.is(await settlement, 2000n, 'fired at the original deadline');
});

test('an overdue alarm fires once after a rebuild, even if reported twice', async t => {
  const { time, clock, lifecycle, killAdapter } = fixture();
  const settlement = E(clock).at(1100n);
  await settled();
  killAdapter();
  time.advance(500n);
  await E(lifecycle).started();
  await settled();
  time.advance(0n);
  t.is(await settlement, 1500n);
  // A second rebuild finds nothing desired and nothing to fire.
  killAdapter();
  await E(lifecycle).started();
  t.deepEqual(await E(clock).status(), { pending: 0, armed: 0 });
});

test('the facet refuses what is not a deadline or a delay', async t => {
  const { clock } = fixture();
  await t.throwsAsync(() => E(clock).at(-1n), { message: /Must be >= / });
  await t.throwsAsync(() => E(clock).after(2n ** 60n), {
    message: /Must be <= /,
  });
  await t.throwsAsync(() => E(clock).arm(harden({})), { message: /./ });
  await t.throwsAsync(() => E(clock).at(/** @type {any} */ (5)), {
    message: /bigint/,
  });
});

test('a far deadline is reached by re-arming within the timer limit', async t => {
  const { time, clock } = fixture();
  const far = 1000n + 3n * 2n ** 31n;
  const settlement = E(clock).at(far);
  await settled();
  time.advance(0n);
  t.is(time.armed(), 1);
  time.advance(2n ** 31n);
  t.is(time.armed(), 1, 're-armed, not fired');
  time.advance(2n ** 31n);
  time.advance(2n ** 31n);
  t.is(await settlement, far);
});
