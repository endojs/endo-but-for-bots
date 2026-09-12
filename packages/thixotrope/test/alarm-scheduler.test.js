// @ts-check
import test from '@endo/ses-ava/test.js';
import { Far } from '@endo/far';

import { makeAlarmScheduler } from '../src/alarms/alarm-scheduler.js';
import { makeDurableClock } from '../src/alarms/durable-clock.js';

import { makeNodePowers } from '../src/platform/node-powers.js';

const nodePowers = makeNodePowers();

/** @import {ExecutionContext} from 'ava' */
const flush = async () => {
  for (let index = 0; index < 30; index += 1) {
    // Drain only promise jobs: the scheduler's wall clock remains explicit.
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
};
/** @param {ExecutionContext} t */
const setup = t => {
  let current = 0n;
  let nextTimer = 0;
  /** @type {Map<number, {at: bigint, fn: () => void}>} */
  const timers = new Map();
  let active = 0;
  let lostAck = false;
  let hang = false;
  let failClose = false;
  const delivered = [];
  let control;
  const scheduler = makeAlarmScheduler(nodePowers.timers, {
    secret: 'private-clock',
    now: () => current,
    retryMs: 10,
    requestTimeoutMs: 10,
    setTimer: (fn, ms) => {
      nextTimer += 1;
      timers.set(nextTimer, { at: current + BigInt(ms), fn });
      return nextTimer;
    },
    clearTimer: handle => timers.delete(handle),
    openClient: async () => {
      active += 1;
      let closed = false;
      return {
        lookup: async () => control,
        close: () => {
          if (failClose) throw Error('Injected cleanup failure');
          if (!closed) active -= 1;
          closed = true;
        },
      };
    },
  });
  const kit = makeDurableClock(
    Far('FailedRegistration', {
      schedule: () => {
        throw Error('Registration lost');
      },
      now: () => current,
    }),
  );
  const guest = kit.getControl();
  control = Far('TestControl', {
    pending: () => guest.pending(),
    fire: (id, deadline, timestamp) => {
      if (hang) return new Promise(() => {});
      delivered.push(id);
      const result = guest.fire(id, deadline, timestamp);
      if (lostAck) {
        lostAck = false;
        throw Error('Acknowledgment lost');
      }
      return result;
    },
  });
  t.teardown(() => scheduler.shutdown());
  const advance = async value => {
    current = value;
    // Existing OS timers do not follow a backwards wall-clock jump. Tests
    // explicitly trigger a monitoring tick with advance at its prior due time.
    const due = [...timers].filter(([, entry]) => entry.at <= current);
    for (const [id, entry] of due) {
      if (timers.delete(id)) {
        entry.fn();
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
    }
    await flush();
  };
  return {
    scheduler,
    clock: kit.getClock(),
    timers,
    delivered,
    advance,
    active: () => active,
    failClose: value => {
      failClose = value;
    },
    loseAck: () => {
      lostAck = true;
    },
    hang: value => {
      hang = value;
    },
  };
};

test('startup and periodic reconciliation repair registrations; firing is idempotent', async t => {
  t.timeout(10_000);
  const env = setup(t);
  const first = env.clock.when(20n);
  env.loseAck();
  await env.scheduler.start();
  t.is(env.scheduler.status().pending, 1);
  await env.advance(20n);
  t.is(await first, 20n);
  t.is(
    env.scheduler.status().pending,
    1,
    'lost acknowledgment keeps retry record',
  );
  await env.advance(30n);
  t.deepEqual(env.delivered, [1n, 1n]);
  t.is(env.scheduler.status().pending, 0);
  const second = env.clock.when(45n);
  await env.advance(40n);
  t.is(
    env.scheduler.status().pending,
    1,
    'periodic scan repairs a live lost registration',
  );
  await env.advance(50n);
  t.is(await second, 50n);
  t.is(env.active(), 0);
});

test('clock jumps do not fire early and distant alarms use bounded OS timers', async t => {
  t.timeout(10_000);
  const env = setup(t);
  const soon = env.clock.when(100n);
  env.clock.when(2n ** 63n - 1n);
  await env.scheduler.start();
  await env.advance(90n);
  await env.advance(10n);
  t.deepEqual(env.delivered, []);
  await env.advance(200n);
  t.is(await soon, 200n);
  t.deepEqual(env.delivered, [1n]);
  t.true([...env.timers.values()].every(entry => entry.at <= 210n));
});

test('timed out observations close their clients and remain retryable', async t => {
  t.timeout(10_000);
  const env = setup(t);
  const result = env.clock.when(10n);
  await env.scheduler.start();
  env.hang(true);
  await env.advance(10n);
  t.is(env.active(), 1);
  await env.advance(20n);
  t.is(env.active(), 0);
  t.is(env.scheduler.status().pending, 1);
  env.hang(false);
  await env.advance(30n);
  t.is(await result, 30n);
  t.is(env.active(), 0);
  await env.scheduler.shutdown();
  t.is(env.timers.size, 0);
});

test('shutdown rejects startup and closes a client that opens late', async t => {
  t.timeout(10_000);
  /** @type {(value: any) => void} */
  let open = () => {
    throw Error('Opening promise not initialized');
  };
  let closed = 0;
  const opening = new Promise(resolve => {
    open = resolve;
  });
  const scheduler = makeAlarmScheduler(nodePowers.timers, {
    openClient: () => opening,
    secret: 'clock',
  });
  t.teardown(() => scheduler.shutdown());
  const first = scheduler.start();
  const second = scheduler.start();
  const firstRejected = t.throwsAsync(first, { message: /scheduler stopped/ });
  const secondRejected = t.throwsAsync(second, {
    message: /scheduler stopped/,
  });
  let shutdownFinished = false;
  const stopping = scheduler.shutdown().then(() => {
    shutdownFinished = true;
  });
  await Promise.all([firstRejected, secondRejected]);
  t.false(shutdownFinished, 'shutdown waits for local client initialization');
  open({
    close: () => {
      closed += 1;
    },
    lookup: () => {
      throw Error('must not lookup after close');
    },
  });
  await stopping;
  t.is(closed, 1, 'concurrent starts share one observation');
  t.is(scheduler.status().observations, 0);
});

test('failed observation cleanup is retried before opening more clients', async t => {
  t.timeout(10_000);
  const env = setup(t);
  await env.scheduler.start();
  await flush();
  env.failClose(true);
  await env.advance(10n);
  t.is(env.scheduler.status().pendingCleanups, 1);
  t.is(env.active(), 1);
  await env.advance(20n);
  t.is(env.active(), 1, 'cleanup failure cannot accumulate more clients');
  env.failClose(false);
  await env.advance(30n);
  t.is(env.active(), 0);
  t.is(env.scheduler.status().pendingCleanups, 0);
});

test('shutdown drains observation cleanup without waiting for a guest promise', async t => {
  t.timeout(10_000);
  const env = setup(t);
  env.clock.when(10n);
  await env.scheduler.start();
  env.hang(true);
  await env.advance(10n);
  t.is(env.active(), 1);
  await env.scheduler.shutdown();
  t.is(env.active(), 0);
  t.is(env.scheduler.status().observations, 0);
  t.is(env.timers.size, 0);
});

test('shutdown surfaces cleanup failure instead of releasing ownership silently', async t => {
  t.timeout(10_000);
  let failClose = false;
  let closes = 0;
  /** @type {() => void} */
  let enter = () => {};
  const entered = new Promise(resolve => {
    enter = () => resolve(undefined);
  });
  const scheduler = makeAlarmScheduler(nodePowers.timers, {
    secret: 'clock',
    openClient: async () => ({
      lookup: async () =>
        Far('PendingControl', {
          pending: () => {
            enter();
            return new Promise(() => {});
          },
        }),
      close: () => {
        closes += 1;
        if (failClose) throw Error('Cannot commit cleanup');
      },
    }),
  });
  // This test intentionally rejects shutdown; observe that rejection at teardown.
  t.teardown(() => scheduler.shutdown().catch(() => {}));
  const started = scheduler.start();
  const startRejected = t.throwsAsync(started, {
    message: /Cannot commit cleanup/,
  });
  await entered;
  failClose = true;
  await t.throwsAsync(() => scheduler.shutdown(), {
    message: /Cannot commit cleanup/,
  });
  await startRejected;
  t.is(closes, 2, 'shutdown retries failed observation-finally cleanup once');
  t.is(scheduler.status().pendingCleanups, 1);
});
