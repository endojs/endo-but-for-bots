// @ts-check

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/test.js';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makePromiseKit } from '@endo/promise-kit';

import { makeSendQueue } from '../src/client/send-queue.js';
import { encodeSwissnum } from '../src/client/util.js';
import { makeTestClientPair, test as netTest, waitUntilTrue } from './_util.js';
import { makeManualTimer } from './_manual-timer.js';
import { makeStallInjector } from './_stall-injector.js';

const bytesOf = n => new Uint8Array([n]);
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

const makeUnitKit = () => {
  /** @type {number[]} */
  const written = [];
  /** @type {Error[]} */
  const errors = [];
  const injector = makeStallInjector();
  const queue = makeSendQueue({
    write: injector.wrap(bytes => {
      written.push(bytes[0]);
    }),
    onError: error => errors.push(error),
  });
  return { written, errors, injector, queue };
};

test('writes through while the transport is not stalled', t => {
  const { written, queue } = makeUnitKit();
  queue.write(bytesOf(1));
  queue.write(bytesOf(2));
  t.deepEqual(written, [1, 2]);
  t.is(queue.getPendingCount(), 0);
  t.false(queue.isStalled());
  t.is(queue.getEpoch(), 0n);
});

test('a synchronous write failure reaches the caller', t => {
  const queue = makeSendQueue({
    write: () => {
      throw Error('write failed');
    },
  });
  t.throws(() => queue.write(bytesOf(1)), { message: 'write failed' });
  t.is(queue.getPendingCount(), 0);
});

test('accumulates operations behind a stalled write and replays them in order', async t => {
  const { written, errors, injector, queue } = makeUnitKit();
  queue.write(bytesOf(1));
  injector.stall();
  queue.write(bytesOf(2));
  queue.write(bytesOf(3));
  queue.write(bytesOf(4));
  t.deepEqual(written, [1]);
  t.true(queue.isStalled());
  t.is(queue.getPendingCount(), 3);
  // Only the in-flight write reached the stalled transport.
  t.is(injector.getStalledWrites(), 1);

  injector.release();
  await flush();
  t.deepEqual(written, [1, 2, 3, 4]);
  t.is(queue.getPendingCount(), 0);
  t.false(queue.isStalled());
  t.deepEqual(errors, []);
});

test('operations enqueued while draining keep their order', async t => {
  const { written, injector, queue } = makeUnitKit();
  injector.stall();
  queue.write(bytesOf(1));
  queue.write(bytesOf(2));
  injector.release();
  queue.write(bytesOf(3));
  injector.stall();
  await flush();
  // 1 was released, 2 stalled again on the way out, 3 waits behind it.
  t.deepEqual(written, [1]);
  t.is(queue.getPendingCount(), 2);
  injector.release();
  await flush();
  t.deepEqual(written, [1, 2, 3]);
});

test('a failed write during a drain closes the queue once', async t => {
  /** @type {Error[]} */
  const errors = [];
  const stalled = makePromiseKit();
  let calls = 0;
  const queue = makeSendQueue({
    write: () => {
      calls += 1;
      return stalled.promise;
    },
    onError: error => errors.push(error),
  });
  queue.write(bytesOf(1));
  queue.write(bytesOf(2));
  stalled.reject(Error('socket reset'));
  await flush();
  t.is(errors.length, 1);
  t.is(errors[0].message, 'socket reset');
  t.is(queue.getPendingCount(), 0);
  queue.write(bytesOf(3));
  t.is(calls, 1, 'a closed queue refuses further writes');
});

test('a synchronous write failure during a drain closes the queue once', async t => {
  /** @type {Error[]} */
  const errors = [];
  const stalled = makePromiseKit();
  let calls = 0;
  const queue = makeSendQueue({
    write: () => {
      calls += 1;
      if (calls === 1) {
        return stalled.promise;
      }
      throw Error('socket closed');
    },
    onError: error => errors.push(error),
  });
  queue.write(bytesOf(1));
  queue.write(bytesOf(2));
  queue.write(bytesOf(3));
  stalled.resolve(undefined);
  await flush();
  t.is(calls, 2, 'the drain stops at the throwing write');
  t.is(errors.length, 1);
  t.is(errors[0].message, 'socket closed');
  t.is(queue.getPendingCount(), 0);
  queue.write(bytesOf(4));
  t.is(calls, 2, 'a closed queue refuses further writes');
});

test('close drops pending operations and ignores the late settlement', async t => {
  const { written, errors, injector, queue } = makeUnitKit();
  injector.stall();
  queue.write(bytesOf(1));
  queue.write(bytesOf(2));
  queue.close();
  t.is(queue.getPendingCount(), 0);
  injector.release();
  await flush();
  // The in-flight bytes left at release; the queued ones did not.
  t.deepEqual(written, [1]);
  t.deepEqual(errors, []);
  queue.close();
});

test('advancing the epoch replays pending operations on the next transport instance', async t => {
  const { written, injector, queue } = makeUnitKit();
  injector.stall();
  queue.write(bytesOf(1));
  queue.write(bytesOf(2));
  /** @type {number[]} */
  const second = [];
  t.is(
    queue.advanceEpoch(bytes => {
      second.push(bytes[0]);
    }),
    1n,
  );
  t.is(queue.getEpoch(), 1n);
  // The in-flight write's delivery is unknown, so it is replayed too.
  t.deepEqual(second, [1, 2]);
  t.is(queue.getPendingCount(), 0);
  // A late settlement from the obsolete instance does not disturb the
  // new one.
  injector.release();
  await flush();
  queue.write(bytesOf(3));
  t.deepEqual(second, [1, 2, 3]);
  t.deepEqual(written, [1]);
});

test('interposeWriter wraps the current transport instance', t => {
  /** @type {string[]} */
  const log = [];
  const queue = makeSendQueue({
    write: () => {
      log.push('base');
    },
  });
  queue.interposeWriter(write => bytes => {
    log.push('wrapper');
    return write(bytes);
  });
  queue.write(bytesOf(1));
  t.deepEqual(log, ['wrapper', 'base']);
});

const makeGreeterTable = () =>
  new Map([
    [
      'Greeter',
      makeExo(
        'Greeter',
        M.interface('Greeter', {
          greet: M.call(M.string()).returns(M.string()),
        }),
        {
          greet: name => `Hello ${name}`,
        },
      ),
    ],
  ]);

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

/**
 * Advance both clocks in heartbeat-interval steps, with real time
 * between steps for unstalled heartbeats to cross the socket.
 *
 * @param {Array<ReturnType<typeof makeManualTimer>>} clocks
 * @param {number} ms
 */
const advanceAll = async (clocks, ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed += 5000) {
    for (const clock of clocks) clock.advance(5000);
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }
};

/** @param {ExecutionContext} t */
const makeStalledPair = async t => {
  const clockA = makeManualTimer();
  const clockB = makeManualTimer();
  const kit = await makeTestClientPair({
    makeDefaultSwissnumTable: makeGreeterTable,
    clientAOptions: { heartbeat: { timer: clockA.timer } },
    clientBOptions: { heartbeat: { timer: clockB.timer } },
  });
  t.teardown(kit.shutdownBoth);
  const { sessionA } = await kit.establishSession();
  const ocapnA = sessionA.ocapn;
  const debugA = /** @type {NonNullable<typeof ocapnA._debug>} */ (
    // eslint-disable-next-line no-underscore-dangle
    ocapnA._debug
  );
  const injector = makeStallInjector();
  debugA.sendQueue.interposeWriter(injector.wrap);
  const greeter = E(ocapnA.getRemoteBootstrap()).fetch(
    encodeSwissnum('Greeter'),
  );
  t.is(await E(greeter).greet('before'), 'Hello before');
  const isActive = (from, to) =>
    !!from.debug.sessionManager.getActiveSession(to.locationId);
  return {
    ...kit,
    clocks: [clockA, clockB],
    queue: debugA.sendQueue,
    injector,
    greeter,
    bothActive: () =>
      isActive(kit.clientKitA, kit.clientKitB) &&
      isActive(kit.clientKitB, kit.clientKitA),
    isActive,
  };
};

netTest(
  'a write stall shorter than the session timeout queues and replays',
  async t => {
    const { clocks, queue, injector, greeter, bothActive } =
      await makeStalledPair(t);

    injector.stall();
    // A call issued during the stall: its op:deliver waits in A's queue.
    const during = E(greeter).greet('during');
    // Longer than HEARTBEAT_INTERVAL (5 s), shorter than SESSION_TIMEOUT
    // (30 s).
    await advanceAll(clocks, 20_000);
    t.true(queue.isStalled());
    const pendingCount = /** @type {number} */ (queue.getPendingCount());
    t.true(
      pendingCount > 2,
      'the deliver and the heartbeats accumulated behind the stalled write',
    );
    t.true(bothActive(), 'stall-with-recovery is not declared lost');

    injector.release();
    t.is(await during, 'Hello during');
    t.is(queue.getPendingCount(), 0);
    t.is(queue.getEpoch(), 0n, 'a single transport instance throughout');

    // The replayed heartbeats re-armed B's liveness window: another
    // stretch of idle time does not lose the session.
    await advanceAll(clocks, 20_000);
    t.true(bothActive());
    t.is(await E(greeter).greet('after'), 'Hello after');
  },
);

netTest('a write stall past the session timeout is true loss', async t => {
  const { clocks, queue, injector, clientKitA, clientKitB, isActive } =
    await makeStalledPair(t);

  injector.stall();
  await advanceAll(clocks, 25_000);
  t.true(isActive(clientKitB, clientKitA), 'not yet past the timeout');
  await advanceAll(clocks, 10_000);
  await waitUntilTrue(
    () =>
      !isActive(clientKitB, clientKitA) && !isActive(clientKitA, clientKitB),
  );
  t.is(queue.getPendingCount(), 0, 'the aborted session drops its queue');
  injector.release();
});
