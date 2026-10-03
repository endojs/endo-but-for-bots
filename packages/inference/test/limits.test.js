// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { MAX_TIMER_DELAY_MS } from '../src/guards.js';
import { makeLimitEnforcer, makeProcessGroupKiller } from '../src/limits.js';

/** A manual clock: timers fire only when the test calls `fire()`. */
const makeManualTimers = () => {
  /** @type {Map<number, () => void>} */
  const pending = new Map();
  let next = 0;
  return {
    pending,
    /**
     * @param {() => void} callback
     * @param {number} _delayMs
     */
    setTimeout: (callback, _delayMs) => {
      next += 1;
      pending.set(next, callback);
      return next;
    },
    /** @param {unknown} handle */
    clearTimeout: handle => {
      pending.delete(/** @type {number} */ (handle));
    },
    fire: () => {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
};

const limits = harden({ maxWallClockMs: 100, maxOutputBytes: 10, maxTurns: 2 });

/** @param {PromiseLike<unknown>} [cancelled] */
const setup = cancelled => {
  const timers = makeManualTimers();
  let terminations = 0;
  const enforcer = makeLimitEnforcer({
    limits,
    timers,
    terminate: () => {
      terminations += 1;
    },
    cancelled,
  });
  return { timers, enforcer, terminations: () => terminations };
};

test('wall clock trips limit-exceeded and terminates once', t => {
  const { timers, enforcer, terminations } = setup();
  t.is(timers.pending.size, 1);
  timers.fire();
  t.deepEqual(enforcer.outcome(), {
    type: 'limit-exceeded',
    which: 'wall-clock',
  });
  t.is(terminations(), 1);
  t.false(enforcer.countOutputBytes(100));
  t.is(terminations(), 1, 'a later limit does not terminate again');
  t.deepEqual(enforcer.outcome(), {
    type: 'limit-exceeded',
    which: 'wall-clock',
  });
});

test('output bytes trip only past the ceiling', t => {
  const { timers, enforcer, terminations } = setup();
  t.true(enforcer.countOutputBytes(6));
  t.true(enforcer.countOutputBytes(4), 'exactly at the ceiling continues');
  t.false(enforcer.countOutputBytes(1));
  t.deepEqual(enforcer.outcome(), {
    type: 'limit-exceeded',
    which: 'output-bytes',
  });
  t.is(terminations(), 1);
  t.is(timers.pending.size, 0, 'tripping clears the wall-clock timer');
});

test('turns trip only past maxTurns', t => {
  const { enforcer, terminations } = setup();
  t.true(enforcer.countTurn());
  t.true(enforcer.countTurn());
  t.false(enforcer.countTurn());
  t.deepEqual(enforcer.outcome(), {
    type: 'limit-exceeded',
    which: 'max-turns',
  });
  t.is(terminations(), 1);
});

test('cancellation trips cancelled', async t => {
  /** @type {(reason: unknown) => void} */
  let cancel = () => {};
  /** @type {Promise<never>} */
  const cancelled = new Promise((_resolve, reject) => {
    cancel = reject;
  });
  const { enforcer, terminations } = setup(cancelled);
  cancel(Error('caller cancelled'));
  await null;
  await null;
  t.deepEqual(enforcer.outcome(), { type: 'cancelled' });
  t.is(terminations(), 1);
});

test('abort records the plugin result first and later causes are ignored', t => {
  const { timers, enforcer, terminations } = setup();
  enforcer.abort(harden({ type: 'needs-auth' }));
  timers.fire();
  t.deepEqual(enforcer.outcome(), { type: 'needs-auth' });
  t.is(terminations(), 1);
  for (const result of [
    { type: 'bridge-down' },
    { type: 'ok', text: 'done' },
    { type: 'needs-containment' },
  ]) {
    t.throws(
      () => setup().enforcer.abort(/** @type {any} */ (harden(result))),
      undefined,
      result.type,
    );
  }
});

test('stop ends enforcement without terminating', t => {
  const { timers, enforcer, terminations } = setup();
  enforcer.stop();
  timers.fire();
  t.true(enforcer.countOutputBytes(1000));
  t.true(enforcer.countTurn());
  t.true(enforcer.countTurn());
  t.true(enforcer.countTurn());
  t.is(enforcer.outcome(), undefined);
  t.is(terminations(), 0);
});

test('stop is idempotent and stays quiet after an abort', t => {
  const { timers, enforcer, terminations } = setup();
  enforcer.stop();
  enforcer.stop();
  t.is(timers.pending.size, 0);
  t.is(terminations(), 0);

  const second = setup();
  second.enforcer.abort(harden({ type: 'cancelled' }));
  second.enforcer.stop();
  t.deepEqual(second.enforcer.outcome(), { type: 'cancelled' });
  t.is(second.terminations(), 1);
});

test('output byte counts must be non-negative safe integers', t => {
  const { enforcer, terminations } = setup();
  t.throws(() => enforcer.countOutputBytes(NaN));
  t.throws(() => enforcer.countOutputBytes(-1));
  t.throws(() => enforcer.countOutputBytes(1.5));
  t.true(enforcer.countOutputBytes(0));
  t.true(enforcer.countOutputBytes(-0));
  t.true(enforcer.countOutputBytes(10));
  t.false(enforcer.countOutputBytes(1));
  t.is(terminations(), 1);
});

test('wall-clock limits beyond the host timer range are refused', t => {
  const timers = makeManualTimers();
  for (const maxWallClockMs of [Infinity, 3e9, MAX_TIMER_DELAY_MS + 1]) {
    t.throws(
      () =>
        makeLimitEnforcer({
          limits: harden({ maxWallClockMs, maxOutputBytes: 1, maxTurns: 1 }),
          timers,
          terminate: () => {},
        }),
      undefined,
      String(maxWallClockMs),
    );
  }
  t.is(timers.pending.size, 0, 'no timer is armed for a refused limit');
  makeLimitEnforcer({
    limits: harden({
      maxWallClockMs: MAX_TIMER_DELAY_MS,
      maxOutputBytes: 1,
      maxTurns: 1,
    }),
    timers,
    terminate: () => {},
  }).stop();
  t.pass();
});

test('the longest admitted wall-clock limit does not trip early on real timers', async t => {
  let terminations = 0;
  const enforcer = makeLimitEnforcer({
    limits: harden({
      maxWallClockMs: MAX_TIMER_DELAY_MS,
      maxOutputBytes: 1,
      maxTurns: 1,
    }),
    timers: harden({ setTimeout, clearTimeout }),
    terminate: () => {
      terminations += 1;
    },
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  t.is(enforcer.outcome(), undefined);
  t.is(terminations, 0);
  enforcer.stop();
});

test('turn and byte limits must be safe integers', t => {
  for (const badLimits of [
    { maxWallClockMs: 1, maxOutputBytes: 1.5, maxTurns: 1 },
    { maxWallClockMs: 1, maxOutputBytes: 1, maxTurns: 1.5 },
    { maxWallClockMs: 1, maxOutputBytes: Infinity, maxTurns: 1 },
  ]) {
    t.throws(() =>
      makeLimitEnforcer({
        limits: harden(badLimits),
        timers: makeManualTimers(),
        terminate: () => {},
      }),
    );
  }
});

test('a throwing cancellation thenable cancels rather than leaking a timer', async t => {
  const timers = makeManualTimers();
  let terminations = 0;
  const enforcer = makeLimitEnforcer({
    limits,
    timers,
    terminate: () => {
      terminations += 1;
    },
    cancelled: /** @type {PromiseLike<unknown>} */ (
      harden({
        then: () => {
          throw Error('broken thenable');
        },
      })
    ),
  });
  await null;
  await null;
  await null;
  t.deepEqual(enforcer.outcome(), { type: 'cancelled' });
  t.is(terminations, 1);
  t.is(timers.pending.size, 0);
});

test('limits are checked at construction', t => {
  t.throws(() =>
    makeLimitEnforcer({
      limits: /** @type {any} */ ({
        wallClockMs: 1,
        outputBytes: 1,
        maxTurns: 1,
      }),
      timers: makeManualTimers(),
      terminate: () => {},
    }),
  );
});

test('the process group killer signals the negated pid it was made for', t => {
  /** @type {Array<[number, string]>} */
  const calls = [];
  const killProcessGroup = makeProcessGroupKiller({
    kill: (pid, signal) => {
      calls.push([pid, signal]);
    },
    pid: 1234,
    platform: 'linux',
  });
  t.true(killProcessGroup());
  t.deepEqual(calls, [[-1234, 'SIGKILL']]);
  t.false(
    makeProcessGroupKiller({
      kill: () => {},
      pid: undefined,
      platform: 'linux',
    })(),
  );
});

test('the process group killer refuses a pid that names no child group', t => {
  /** @type {number[]} */
  const calls = [];
  for (const pid of [0, 1, -1234, 1.5, NaN, 2 ** 31]) {
    t.throws(
      () =>
        makeProcessGroupKiller({
          kill: target => {
            calls.push(target);
          },
          pid,
          platform: 'linux',
        }),
      { message: /pid must be an integer from 2/ },
      String(pid),
    );
  }
  t.deepEqual(calls, []);
});

test('the process group killer tolerates a group that is already gone', t => {
  const gone = makeProcessGroupKiller({
    kill: () => {
      throw Object.assign(Error('no such process'), { code: 'ESRCH' });
    },
    pid: 1234,
    platform: 'linux',
  });
  t.false(gone());
  const denied = makeProcessGroupKiller({
    kill: () => {
      throw Object.assign(Error('not permitted'), { code: 'EPERM' });
    },
    pid: 1234,
    platform: 'linux',
  });
  t.throws(() => denied(), { message: 'not permitted' });
});

test('the process group killer signals the pid itself on win32', t => {
  /** @type {Array<[number, string]>} */
  const calls = [];
  const killProcessGroup = makeProcessGroupKiller({
    kill: (pid, signal) => calls.push([pid, signal]),
    pid: 1234,
    platform: 'win32',
  });
  t.true(killProcessGroup());
  t.deepEqual(calls, [[1234, 'SIGKILL']]);
});

test('the process group killer requires the platform power', t => {
  /** @type {number[]} */
  const calls = [];
  t.throws(
    () =>
      makeProcessGroupKiller(
        /** @type {any} */ ({
          kill: (/** @type {number} */ target) => {
            calls.push(target);
          },
          pid: 1234,
        }),
      ),
    { message: /platform must be a string/ },
  );
  t.deepEqual(calls, []);
});

test('a throwing terminate does not escape abort', t => {
  const timers = harden({
    setTimeout: () => undefined,
    clearTimeout: () => {},
  });
  /** @type {unknown[]} */
  const reported = [];
  const enforcer = makeLimitEnforcer({
    limits: harden({ maxWallClockMs: 1000, maxOutputBytes: 10, maxTurns: 1 }),
    timers,
    terminate: () => {
      throw Object.assign(Error('not permitted'), { code: 'EPERM' });
    },
    reportTerminateError: error => reported.push(error),
  });
  t.notThrows(() => enforcer.abort(harden({ type: 'cancelled' })));
  t.deepEqual(enforcer.outcome(), { type: 'cancelled' });
  t.is(reported.length, 1);
  t.is(/** @type {Error} */ (reported[0]).message, 'not permitted');
});
