// @ts-check

import baseTest from '@endo/ses-ava/test.js';
import { makeHeartbeat } from '../src/client/heartbeat.js';
import { test, waitUntilTrue, makeTestClientPair } from './_util.js';

/**
 * A manual clock: timers fire only when the test advances time.
 */
const makeManualTimers = () => {
  let now = 0;
  let nextId = 0;
  /** @type {Map<number, { at: number, callback: () => void }>} */
  const pending = new Map();
  const timers = {
    /**
     * @param {() => void} callback
     * @param {number} ms
     */
    setTimeout: (callback, ms) => {
      nextId += 1;
      pending.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    /** @param {any} id */
    clearTimeout: id => {
      pending.delete(id);
    },
  };
  /** @param {number} ms */
  const advance = ms => {
    const until = now + ms;
    for (;;) {
      let nextKey;
      let nextAt = Infinity;
      for (const [key, { at }] of pending) {
        if (at <= until && at < nextAt) {
          nextAt = at;
          nextKey = key;
        }
      }
      if (nextKey === undefined) {
        break;
      }
      const { callback } = /** @type {{ callback: () => void }} */ (
        pending.get(nextKey)
      );
      pending.delete(nextKey);
      now = nextAt;
      callback();
    }
    now = until;
  };
  return { timers, advance, pendingCount: () => pending.size };
};

/**
 * @param {Partial<Parameters<typeof makeHeartbeat>[0]['options']>} [options]
 */
const makeHarness = (options = {}) => {
  const { timers, advance, pendingCount } = makeManualTimers();
  /** @type {any[]} */
  const sent = [];
  /** @type {Error[]} */
  const losses = [];
  let recvNonce = 0n;
  const heartbeat = makeHeartbeat({
    options: { intervalMs: 100, timeoutMs: 300, ...options },
    sendPing: message => sent.push(message),
    sendPong: message => sent.push(message),
    getLastAckedRecvNonce: () => recvNonce,
    onLoss: reason => losses.push(reason),
    timers,
  });
  return {
    heartbeat,
    sent,
    losses,
    advance,
    pendingCount,
    /** @param {bigint} n */
    setRecvNonce: n => {
      recvNonce = n;
    },
  };
};

baseTest('heartbeat emits op:ping and op:pong on schedule', t => {
  const { sent, advance, setRecvNonce, heartbeat } = makeHarness();
  advance(99);
  t.deepEqual(sent, [], 'nothing before the first interval');
  setRecvNonce(5n);
  advance(1);
  t.deepEqual(sent, [
    { type: 'op:ping', epoch: 0n, sequence: 0n },
    { type: 'op:pong', epoch: 0n, sequence: 0n, lastAckedRecvNonce: 5n },
  ]);
  heartbeat.noteActivity();
  advance(100);
  t.deepEqual(sent.slice(2), [
    { type: 'op:ping', epoch: 0n, sequence: 1n },
    { type: 'op:pong', epoch: 0n, sequence: 1n, lastAckedRecvNonce: 5n },
  ]);
  heartbeat.stop();
});

baseTest('heartbeat declares loss after the session timeout of silence', t => {
  const { losses, advance, pendingCount } = makeHarness();
  advance(299);
  t.is(losses.length, 0);
  advance(1);
  t.is(losses.length, 1);
  t.regex(losses[0].message, /heartbeat timeout/);
  t.is(pendingCount(), 0, 'loss cancels the emission timer');
  advance(10_000);
  t.is(losses.length, 1, 'loss is reported once');
});

baseTest('any incoming traffic resets the liveness deadline', t => {
  const { heartbeat, losses, advance } = makeHarness();
  for (let i = 0; i < 20; i += 1) {
    advance(250);
    heartbeat.noteActivity();
  }
  t.is(losses.length, 0, 'session stays alive while the peer is heard');
  advance(300);
  t.is(losses.length, 1, 'session is lost once the peer falls silent');
});

baseTest('stop cancels the heartbeat without reporting loss', t => {
  const { heartbeat, sent, losses, advance, pendingCount } = makeHarness();
  heartbeat.stop();
  heartbeat.stop();
  t.is(pendingCount(), 0);
  advance(10_000);
  t.deepEqual(sent, []);
  t.is(losses.length, 0);
  heartbeat.noteActivity();
  t.is(pendingCount(), 0, 'activity after stop does not re-arm');
});

baseTest('op:pong acknowledgment never rewinds', t => {
  const { heartbeat } = makeHarness();
  t.is(heartbeat.getPeerAckedRecvNonce(), 0n);
  heartbeat.notePong({ epoch: 0n, sequence: 0n, lastAckedRecvNonce: 9n });
  t.is(heartbeat.getPeerAckedRecvNonce(), 9n);
  // Replayed or reordered pong.
  heartbeat.notePong({ epoch: 0n, sequence: 0n, lastAckedRecvNonce: 4n });
  t.is(heartbeat.getPeerAckedRecvNonce(), 9n);
  heartbeat.notePong({ epoch: 0n, sequence: 1n, lastAckedRecvNonce: 12n });
  t.is(heartbeat.getPeerAckedRecvNonce(), 12n);
  heartbeat.stop();
});

baseTest('heartbeat rejects a timeout shorter than three intervals', t => {
  t.throws(() => makeHarness({ intervalMs: 100, timeoutMs: 299 }), {
    instanceOf: RangeError,
  });
  t.throws(() => makeHarness({ intervalMs: 0 }), { instanceOf: RangeError });
  t.throws(() => makeHarness({ intervalMs: NaN }), { instanceOf: RangeError });
});

// Generous margins: coverage instrumentation can stall the event loop
// for well over 100ms on a loaded CI runner.
const heartbeat = { intervalMs: 50, timeoutMs: 1000 };

test('heartbeat keeps an idle session alive when both peers beat', async t => {
  const { establishSession, shutdownBoth, getConnectionAtoB } =
    await makeTestClientPair({
      clientAOptions: { heartbeat },
      clientBOptions: { heartbeat },
    });
  t.teardown(shutdownBoth);
  const { sessionA, sessionB } = await establishSession();
  // eslint-disable-next-line no-underscore-dangle
  const debugA = sessionA.ocapn._debug;
  // eslint-disable-next-line no-underscore-dangle
  const debugB = sessionB.ocapn._debug;
  assert(debugA && debugB);
  t.truthy(debugA.heartbeat);
  t.truthy(debugB.heartbeat);
  /** @type {Set<string>} */
  const receivedByA = new Set();
  debugA.subscribeMessages((direction, message) => {
    if (direction === 'receive') {
      receivedByA.add(message.type);
    }
  });
  const connection = getConnectionAtoB();
  t.truthy(connection);

  await waitUntilTrue(
    () =>
      receivedByA.has('op:ping') &&
      receivedByA.has('op:pong') &&
      /** @type {bigint} */ (debugA.heartbeat?.getPeerAckedRecvNonce()) > 0n,
    10_000,
  );
  t.pass('op:ping and op:pong arrive, carrying peer acknowledgments');

  // Idle past the session timeout; only heartbeats flow.
  await new Promise(resolve => setTimeout(resolve, heartbeat.timeoutMs * 1.5));

  t.is(getConnectionAtoB(), connection, 'session survives idle');
  t.false(connection?.isDestroyed);
});

test('heartbeat detects a silent peer within the session timeout', async t => {
  // B runs without a heartbeat, so once the handshake settles it never
  // sends anything: from A's vantage the TCP pipe is open but the peer
  // is unreachable.
  const { establishSession, shutdownBoth, getConnectionAtoB } =
    await makeTestClientPair({
      clientAOptions: { heartbeat },
    });
  t.teardown(shutdownBoth);
  const started = Date.now();
  await establishSession();
  t.truthy(getConnectionAtoB());

  await waitUntilTrue(() => getConnectionAtoB() === undefined, 10_000);
  const elapsed = Date.now() - started;
  t.true(
    elapsed < 5000,
    `silent peer detected in ${elapsed}ms, seconds rather than hours`,
  );
});
