// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

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
    /** @param {number} handle */
    clearTimeout: handle => {
      pending.delete(handle);
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
  t.throws(() =>
    setup().enforcer.abort(
      /** @type {any} */ (harden({ type: 'bridge-down' })),
    ),
  );
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

test('the process group killer signals the negated pid', t => {
  /** @type {Array<[number, string]>} */
  const calls = [];
  const killProcessGroup = makeProcessGroupKiller({
    kill: (pid, signal) => {
      calls.push([pid, signal]);
    },
  });
  t.true(killProcessGroup(1234));
  t.false(killProcessGroup(undefined));
  t.deepEqual(calls, [[-1234, 'SIGKILL']]);
});

test('the process group killer tolerates a group that is already gone', t => {
  const gone = makeProcessGroupKiller({
    kill: () => {
      throw Object.assign(Error('no such process'), { code: 'ESRCH' });
    },
  });
  t.false(gone(1234));
  const denied = makeProcessGroupKiller({
    kill: () => {
      throw Object.assign(Error('not permitted'), { code: 'EPERM' });
    },
  });
  t.throws(() => denied(1234), { message: 'not permitted' });
});
