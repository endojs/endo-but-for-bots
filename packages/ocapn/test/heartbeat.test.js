// @ts-check

import test from '@endo/ses-ava/test.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';

import {
  makeHeartbeat,
  validateHeartbeatOptions,
} from '../src/client/heartbeat.js';
import { encodeSwissnum } from '../src/client/util.js';
import { makeTestClientPair, test as netTest, waitUntilTrue } from './_util.js';
import { makeManualTimer } from './_manual-timer.js';

const makeUnitKit = (options = {}) => {
  const clock = makeManualTimer();
  /** @type {any[]} */
  const sent = [];
  /** @type {Error[]} */
  const losses = [];
  let recvNonce = 0n;
  const heartbeat = makeHeartbeat({
    options: { timer: clock.timer, ...options },
    send: message => sent.push(message),
    onLoss: reason => losses.push(reason),
    getLastAckedRecvNonce: () => recvNonce,
  });
  return {
    ...clock,
    heartbeat,
    sent,
    losses,
    setRecvNonce: n => {
      recvNonce = n;
    },
  };
};

test('validates heartbeat options against the design ranges', t => {
  t.deepEqual(validateHeartbeatOptions(), {
    intervalMs: 5000,
    timeoutMs: 30_000,
  });
  t.deepEqual(validateHeartbeatOptions({ intervalMs: 20_000 }), {
    intervalMs: 20_000,
    timeoutMs: 60_000,
  });
  t.throws(() => validateHeartbeatOptions({ intervalMs: 999 }), {
    instanceOf: RangeError,
  });
  t.throws(() => validateHeartbeatOptions({ intervalMs: 60_001 }), {
    instanceOf: RangeError,
  });
  t.throws(
    () => validateHeartbeatOptions({ intervalMs: 5000, timeoutMs: 14_999 }),
    { instanceOf: RangeError },
  );
  t.notThrows(() =>
    validateHeartbeatOptions({ intervalMs: 5000, timeoutMs: 15_000 }),
  );
});

test('emits op:ping and op:pong on every interval', t => {
  const { heartbeat, advance, sent, setRecvNonce } = makeUnitKit();
  heartbeat.start();
  advance(4999);
  t.is(sent.length, 0);
  setRecvNonce(41n);
  advance(1);
  t.deepEqual(sent, [
    { type: 'op:ping', epoch: 0n, sequence: 0n },
    { type: 'op:pong', epoch: 0n, sequence: 0n, lastAckedRecvNonce: 41n },
  ]);
  advance(10_000);
  t.deepEqual(
    sent.map(({ type, sequence }) => [type, sequence]),
    [
      ['op:ping', 0n],
      ['op:pong', 0n],
      ['op:ping', 1n],
      ['op:pong', 1n],
      ['op:ping', 2n],
      ['op:pong', 2n],
    ],
  );
});

test('declares loss after the session timeout of silence', t => {
  const { heartbeat, advance, losses, pendingCount } = makeUnitKit();
  heartbeat.start();
  advance(29_999);
  t.is(losses.length, 0);
  advance(1);
  t.is(losses.length, 1);
  t.regex(losses[0].message, /session timeout/);
  t.is(pendingCount(), 0, 'loss disarms every timer');
  advance(60_000);
  t.is(losses.length, 1, 'loss is reported once');
});

test('any incoming operation resets the liveness window', t => {
  const { heartbeat, advance, losses } = makeUnitKit();
  heartbeat.start();
  for (let i = 0; i < 10; i += 1) {
    advance(20_000);
    t.true(heartbeat.observe({ type: 'op:deliver' }));
  }
  t.is(losses.length, 0);
  advance(30_000);
  t.is(losses.length, 1);
});

test('a current-epoch heartbeat counts as liveness', t => {
  // The epoch stays at 0 until reconnect lands, so no heartbeat is
  // stale yet.
  const { heartbeat, advance, losses } = makeUnitKit();
  heartbeat.start();
  advance(20_000);
  t.true(heartbeat.observe({ type: 'op:ping', epoch: 0n, sequence: 3n }));
  advance(20_000);
  t.is(losses.length, 0);
  t.is(heartbeat.getEpoch(), 0n);
});

test('op:pong acknowledgment only moves forward', t => {
  const { heartbeat } = makeUnitKit();
  heartbeat.start();
  const pong = n => ({
    type: 'op:pong',
    epoch: 0n,
    sequence: 0n,
    lastAckedRecvNonce: n,
  });
  heartbeat.observe(pong(10n));
  t.is(heartbeat.getPeerAckedRecvNonce(), 10n);
  heartbeat.observe(pong(4n));
  t.is(heartbeat.getPeerAckedRecvNonce(), 10n, 'a replayed pong cannot rewind');
  heartbeat.observe(pong(12n));
  t.is(heartbeat.getPeerAckedRecvNonce(), 12n);
  heartbeat.stop();
});

test('a send failure does not stop the heartbeat', t => {
  const clock = makeManualTimer();
  let calls = 0;
  const heartbeat = makeHeartbeat({
    options: { timer: clock.timer },
    send: () => {
      calls += 1;
      throw Error('write failed');
    },
    onLoss: () => {},
  });
  heartbeat.start();
  clock.advance(10_000);
  t.is(calls, 4);
  heartbeat.stop();
  t.is(clock.pendingCount(), 0);
});

const makeGreeterTable = () =>
  new Map([
    [
      'Greeter',
      Far('Greeter', {
        greet: name => `Hello ${name}`,
      }),
    ],
  ]);

const settle = () => new Promise(resolve => setTimeout(resolve, 50));

netTest('heartbeats keep an idle session alive past the timeout', async t => {
  const clockA = makeManualTimer();
  const clockB = makeManualTimer();
  const { establishSession, shutdownBoth, clientKitA, clientKitB } =
    await makeTestClientPair({
      makeDefaultSwissnumTable: makeGreeterTable,
      clientAOptions: { heartbeat: { timer: clockA.timer } },
      clientBOptions: { heartbeat: { timer: clockB.timer } },
    });
  t.teardown(shutdownBoth);
  const {
    sessionA: { ocapn: ocapnA },
  } = await establishSession();

  // Two minutes of idle time, four session timeouts' worth, in
  // heartbeat-interval steps with real time between steps for the
  // heartbeats to cross the socket.
  for (let i = 0; i < 24; i += 1) {
    clockA.advance(5000);
    clockB.advance(5000);
    // eslint-disable-next-line no-await-in-loop
    await settle();
  }

  t.truthy(
    clientKitA.debug.sessionManager.getActiveSession(clientKitB.locationId),
  );
  const greeter = E(ocapnA.getRemoteBootstrap()).fetch(
    encodeSwissnum('Greeter'),
  );
  t.is(await E(greeter).greet('heartbeat'), 'Hello heartbeat');
});

netTest('a silent peer is detected within the session timeout', async t => {
  const clockA = makeManualTimer();
  const { establishSession, shutdownBoth, clientKitA, clientKitB } =
    await makeTestClientPair({
      makeDefaultSwissnumTable: makeGreeterTable,
      // B predates the extension: it never pings but must absorb A's
      // heartbeats without aborting.
      clientAOptions: { heartbeat: { timer: clockA.timer } },
    });
  t.teardown(shutdownBoth);
  const {
    sessionA: { ocapn: ocapnA },
  } = await establishSession();
  const greeter = E(ocapnA.getRemoteBootstrap()).fetch(
    encodeSwissnum('Greeter'),
  );
  t.is(await E(greeter).greet('before'), 'Hello before');

  clockA.advance(25_000);
  await settle();
  t.truthy(
    clientKitA.debug.sessionManager.getActiveSession(clientKitB.locationId),
    'B absorbed op:ping / op:pong and A has heard from B recently enough',
  );

  clockA.advance(5000);
  await waitUntilTrue(
    () =>
      !clientKitA.debug.sessionManager.getActiveSession(clientKitB.locationId),
  );
  t.pass('A tore the session down after 30 s without traffic from B');
});
