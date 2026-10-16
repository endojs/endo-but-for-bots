// @ts-check

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeOcapnNoiseNetwork } from '../index.js';
import { makeMockTransportPair } from '../src/transports/mock.js';
import { makeStallableTransport } from './_stall-injector.js';

/**
 * @param {number} milliseconds
 */
const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

// Wide enough that timer jitter on a loaded CI runner cannot fake a loss.
const heartbeat = { intervalMs: 50, sessionTimeoutMs: 500 };

/**
 * Connect A to B over a mock transport whose writes from A can be
 * stalled.
 *
 * @param {ExecutionContext<unknown>} t
 * @param {import('@endo/ocapn/codec-interface').OcapnCodec} codec
 */
const connectStallablePair = async (t, codec) => {
  const netA = makeOcapnNoiseNetwork({ codec, heartbeat });
  const netB = makeOcapnNoiseNetwork({ codec, heartbeat });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  const injector = makeStallableTransport(transportA);
  await netA.addTransport(injector.transport);
  await netB.addTransport(transportB);
  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);
  return { sessionA, sessionB, injector };
};

for (const [codecName, codec] of /** @type {const} */ ([
  ['cbor', cborCodec],
  ['syrup', syrupCodec],
])) {
  test(`${codecName}: writes queue through a transport stall and replay in order`, async t => {
    const { sessionA, sessionB, injector } = await connectStallablePair(
      t,
      codec,
    );
    const sentBefore = /** @type {bigint} */ (
      sessionA.getLiveness().lastSentNonce
    );

    injector.stall();
    // Stall for longer than HEARTBEAT_INTERVAL, writing as we go. The
    // writes resolve although nothing reaches the transport.
    for (const byte of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(await sessionA.writer.next(Uint8Array.of(byte)), {
        done: false,
        value: undefined,
      });
      // eslint-disable-next-line no-await-in-loop
      await delay(heartbeat.intervalMs);
    }
    await delay(heartbeat.intervalMs * 2);

    const stalled = sessionA.getLiveness();
    // The three writes are queued. Heartbeats coalesce rather than
    // piling up: at most one ping/pong pair waits behind the frame the
    // transport is holding.
    t.true(stalled.queuedFrames >= 3, `queued ${stalled.queuedFrames}`);
    t.true(stalled.queuedFrames <= 6, `queued ${stalled.queuedFrames}`);
    t.is(injector.getHeldWrites(), 1);
    // B's heartbeats still reach A, so A does not take the stall for a
    // loss, and A's own send nonce has not moved.
    t.is(stalled.lastSentNonce, sentBefore);

    injector.resume();

    for (const byte of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      const received = await sessionB.reader.next(undefined);
      t.false(received.done);
      if (!received.done) t.deepEqual([...received.value], [byte]);
    }

    await delay(heartbeat.intervalMs * 2);
    const recovered = sessionA.getLiveness();
    t.is(recovered.queuedFrames, 0);
    t.is(recovered.epoch, 0n);
    t.true(/** @type {bigint} */ (recovered.lastSentNonce) > sentBefore);
    t.true(
      /** @type {bigint} */ (sessionB.getLiveness().lastAckedRecvNonce) >=
        /** @type {bigint} */ (recovered.lastSentNonce) - 2n,
    );

    // The session survived: traffic still flows both ways.
    await sessionB.writer.next(Uint8Array.of(9));
    const back = await sessionA.reader.next(undefined);
    t.false(back.done);
    if (!back.done) t.deepEqual([...back.value], [9]);
  });
}

test('a stall that outlasts the session timeout is a loss on both sides', async t => {
  const { sessionA, sessionB, injector } = await connectStallablePair(
    t,
    cborCodec,
  );
  injector.stall();
  await sessionA.writer.next(Uint8Array.of(1));

  // B hears nothing from A for the session timeout.
  await t.throwsAsync(() => sessionB.reader.next(undefined), {
    message: /no traffic from peer for 500ms; session lost/,
  });
  // A either times out its own held write or sees B hang up first.
  try {
    const result = await sessionA.reader.next(undefined);
    t.true(result.done);
  } catch (error) {
    t.regex(/** @type {Error} */ (error).message, /session lost/);
  }
  t.deepEqual(await sessionA.writer.next(Uint8Array.of(2)), {
    done: true,
    value: undefined,
  });
  injector.resume();
});

test('a held write times out as a loss even while the peer is heard', async t => {
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat });
  // B's timeout is far longer, so only A's write-stall timer can fire.
  const netB = makeOcapnNoiseNetwork({
    codec: cborCodec,
    heartbeat: { intervalMs: 50, sessionTimeoutMs: 60_000 },
  });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  const injector = makeStallableTransport(transportA);
  await netA.addTransport(injector.transport);
  await netB.addTransport(transportB);
  const [sessionA] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);

  injector.stall();
  await sessionA.writer.next(Uint8Array.of(1));
  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: /transport write stalled for 500ms; session lost/,
  });
  injector.resume();
});

test('writer.return delivers queued frames before ending the stream', async t => {
  const { sessionA, sessionB, injector } = await connectStallablePair(
    t,
    cborCodec,
  );
  injector.stall();
  await sessionA.writer.next(Uint8Array.of(7));
  const returned = sessionA.writer.return(undefined);
  await delay(heartbeat.intervalMs);
  injector.resume();
  await returned;

  const received = await sessionB.reader.next(undefined);
  t.false(received.done);
  if (!received.done) t.deepEqual([...received.value], [7]);
});

test('sessions without heartbeats write directly and report no queue', async t => {
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat: false });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat: false });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  await netA.addTransport(transportA);
  await netB.addTransport(transportB);
  const [sessionA] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);
  const liveness = sessionA.getLiveness();
  t.is(liveness.lastSentNonce, undefined);
  t.is(liveness.queuedFrames, 0);
});
