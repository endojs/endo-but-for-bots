// @ts-check

/** @import { ExecutionContext } from 'ava' */
/** @import { OcapnCodec } from '@endo/ocapn/codec-interface' */

import harden from '@endo/harden';
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
 * @param {() => boolean} predicate
 */
const until = async predicate => {
  await null;
  while (!predicate()) {
    // eslint-disable-next-line no-await-in-loop
    await delay(1);
  }
};

/**
 * Connect A to B over a mock transport whose writes from A can be
 * stalled.
 *
 * @param {ExecutionContext<unknown>} t
 * @param {OcapnCodec} codec
 * @param {{ intervalMs: number, sessionTimeoutMs: number }} [settings]
 */
const connectStallablePair = async (t, codec, settings = heartbeat) => {
  const netA = makeOcapnNoiseNetwork({ codec, heartbeat: settings });
  const netB = makeOcapnNoiseNetwork({ codec, heartbeat: settings });
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
    injector.stall();
    // Sample the send nonce only once the stall holds a write, so a
    // write already in flight when the stall began is counted.
    await until(() => injector.getHeldWrites() === 1);
    const sentBefore = /** @type {bigint} */ (
      sessionA.getLiveness().lastSentNonce
    );

    // Stall for longer than the heartbeat interval, writing as we go.
    // The writes resolve although nothing reaches the transport.
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
      sessionB.getLiveness().lastAckedRecvNonce >=
        /** @type {bigint} */ (recovered.lastSentNonce) - 2n,
    );

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

test('writer.next waits while the queue is at its high-water mark', async t => {
  const { sessionA, sessionB, injector } = await connectStallablePair(
    t,
    cborCodec,
  );
  injector.stall();
  const count = 80;
  let settled = 0;
  const writes = [];
  for (let i = 0; i < count; i += 1) {
    writes.push(
      sessionA.writer.next(Uint8Array.of(i)).then(result => {
        settled += 1;
        return result;
      }),
    );
  }
  await delay(heartbeat.intervalMs);
  t.true(settled > 0, `settled ${settled}`);
  t.true(settled < count, `settled ${settled}`);

  injector.resume();
  await Promise.all(writes);
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const received = await sessionB.reader.next(undefined);
    t.false(received.done);
    if (!received.done) t.deepEqual([...received.value], [i]);
  }
});

test('a write enqueued as a drain finishes is sent without waiting for a heartbeat', async t => {
  // Heartbeats far apart, so only a fresh drain can deliver the frame.
  const { sessionA, sessionB, injector } = await connectStallablePair(
    t,
    cborCodec,
    { intervalMs: 10_000, sessionTimeoutMs: 60_000 },
  );
  // Release a held write, then enqueue the next frame some turns later,
  // sweeping the turns at which the drain loop exits.
  for (let turns = 0; turns < 16; turns += 1) {
    injector.stall();
    // eslint-disable-next-line no-await-in-loop
    await sessionA.writer.next(Uint8Array.of(0));
    injector.resume();
    for (let i = 0; i < turns; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await null;
    }
    // eslint-disable-next-line no-await-in-loop
    await sessionA.writer.next(Uint8Array.of(turns + 1));
    for (const byte of [0, turns + 1]) {
      // eslint-disable-next-line no-await-in-loop
      const received = await Promise.race([
        sessionB.reader.next(undefined),
        delay(1000).then(
          () =>
            /** @type {IteratorReturnResult<undefined>} */ ({
              done: true,
              value: undefined,
            }),
        ),
      ]);
      t.false(received.done, `frame ${byte} stranded after ${turns} turns`);
      if (!received.done) t.deepEqual([...received.value], [byte]);
    }
  }
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
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec });
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

test('a transport write that rejects ends the session with its error', async t => {
  const netA = makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat });
  const netB = makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  let broken = false;
  await netA.addTransport(
    harden({
      ...transportA,
      connect: async hints => {
        await null;
        const stream = await transportA.connect(hints);
        /** @type {typeof stream.writer} */
        const writer = harden({
          ...stream.writer,
          next: async value => {
            await null;
            if (broken) throw Error('transport write failed');
            return stream.writer.next(value);
          },
          [Symbol.asyncIterator]() {
            return writer;
          },
        });
        return harden({ reader: stream.reader, writer });
      },
    }),
  );
  await netB.addTransport(transportB);
  const [sessionA] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);

  broken = true;
  await sessionA.writer.next(Uint8Array.of(1));
  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: 'transport write failed',
  });
  t.deepEqual(await sessionA.writer.next(Uint8Array.of(2)), {
    done: true,
    value: undefined,
  });
});
