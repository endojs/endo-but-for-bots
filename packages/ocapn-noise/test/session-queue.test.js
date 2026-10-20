// @ts-check

/** @import { ExecutionContext } from 'ava' */
/** @import { OcapnCodec } from '@endo/ocapn/codec-interface' */
/** @import { OcapnNoiseTransport } from '../src/types.js' */

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
 * @param {(transport: OcapnNoiseTransport) => OcapnNoiseTransport} [wrap]
 *   Applied to A's transport beneath the stall injector.
 */
const connectStallablePair = async (
  t,
  codec,
  settings = heartbeat,
  wrap = transport => transport,
) => {
  const netA = makeOcapnNoiseNetwork({ codec, heartbeat: settings });
  const netB = makeOcapnNoiseNetwork({ codec, heartbeat: settings });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  const injector = makeStallableTransport(wrap(transportA));
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
    // A session timeout well past the stall, so a loaded runner's timer
    // slip cannot turn the stall into a loss.
    const { sessionA, sessionB, injector } = await connectStallablePair(
      t,
      codec,
      { intervalMs: heartbeat.intervalMs, sessionTimeoutMs: 5000 },
    );
    injector.stall();
    /** @type {bigint | undefined} */
    let sentBefore;
    for (const byte of [1, 2, 3]) {
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(await sessionA.writer.next(Uint8Array.of(byte)), {
        done: false,
        value: undefined,
      });
      if (sentBefore === undefined) {
        // Sample the send nonce only once the stall holds a write, so a
        // write already in flight when the stall began is counted.
        // eslint-disable-next-line no-await-in-loop
        await until(() => injector.getHeldWrites() === 1);
        sentBefore = sessionA.getLiveness().lastSentNonce;
      }
      // eslint-disable-next-line no-await-in-loop
      await delay(heartbeat.intervalMs);
    }
    await delay(heartbeat.intervalMs * 2);

    const stalled = sessionA.getLiveness();
    // Heartbeats coalesce rather than piling up: at most one ping/pong
    // pair waits behind the frame the transport is holding.
    t.true(stalled.queuedFrames >= 3, `queued ${stalled.queuedFrames}`);
    t.true(stalled.queuedFrames <= 6, `queued ${stalled.queuedFrames}`);
    t.is(injector.getHeldWrites(), 1);
    // Frames queued behind the held write are not yet encrypted, so
    // A's send nonce holds.
    t.is(stalled.lastSentNonce, /** @type {bigint} */ (sentBefore));

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
    t.true(recovered.lastSentNonce > /** @type {bigint} */ (sentBefore));
    t.true(
      sessionB.getLiveness().lastAckedRecvNonce >= recovered.lastSentNonce - 2n,
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
  // The writes are concurrent, yet the queue holds no more than the
  // high-water mark plus one coalesced ping/pong pair, which counts
  // against the mark.
  t.true(settled >= 62 && settled <= 64, `settled ${settled}`);
  const { queuedFrames } = sessionA.getLiveness();
  t.true(queuedFrames <= 66, `queued ${queuedFrames}`);

  injector.resume();
  await Promise.all(writes);
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const received = await sessionB.reader.next(undefined);
    t.false(received.done);
    if (!received.done) t.deepEqual([...received.value], [i]);
  }
});

test('writers waiting for room settle as done when the session is lost', async t => {
  const { sessionA, injector } = await connectStallablePair(t, cborCodec);
  injector.stall();
  const count = 80;
  const writes = [];
  for (let i = 0; i < count; i += 1) {
    writes.push(sessionA.writer.next(Uint8Array.of(i)));
  }
  // The stall outlasts the session timeout while writers wait for room.
  const results = await Promise.all(writes);
  const accepted = results.filter(({ done }) => !done).length;
  t.true(accepted >= 62 && accepted <= 64, `accepted ${accepted}`);
  t.deepEqual(
    results.map(({ done }) => done),
    [...Array(count).keys()].map(i => i >= accepted),
  );
  t.deepEqual(await sessionA.writer.next(Uint8Array.of(count)), {
    done: true,
    value: undefined,
  });
  t.is(sessionA.getLiveness().queuedFrames, 0);
  injector.resume();
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
  // The identity greeting took send nonce 0.
  t.is(liveness.lastSentNonce, 0n);
  t.is(liveness.queuedFrames, 0);
});

test('an invalid frame rejects its own write and leaves the session open', async t => {
  const { sessionA, sessionB } = await connectStallablePair(t, cborCodec);
  await t.throwsAsync(
    () =>
      sessionA.writer.next(
        /** @type {Uint8Array} */ (/** @type {unknown} */ ('not bytes')),
      ),
    { message: /session frame must be a Uint8Array/ },
  );
  await t.throwsAsync(() => sessionA.writer.next(new Uint8Array(65_536)), {
    message: /session frame of 65536 bytes exceeds 65519/,
  });
  t.deepEqual(await sessionA.writer.next(Uint8Array.of(5)), {
    done: false,
    value: undefined,
  });
  const received = await sessionB.reader.next(undefined);
  t.false(received.done);
  if (!received.done) t.deepEqual([...received.value], [5]);
});

test('closing the session while a write is held releases the writer', async t => {
  const { sessionA, injector } = await connectStallablePair(t, cborCodec, {
    intervalMs: heartbeat.intervalMs,
    sessionTimeoutMs: 60_000,
  });
  injector.stall();
  await sessionA.writer.next(Uint8Array.of(1));
  await sessionA.writer.next(Uint8Array.of(2));
  await until(() => injector.getHeldWrites() === 1);
  sessionA.close();
  t.deepEqual(
    await Promise.race([
      sessionA.writer.return(undefined),
      delay(1000).then(() => 'stuck'),
    ]),
    { done: true, value: undefined },
  );
  t.deepEqual(await sessionA.writer.next(Uint8Array.of(3)), {
    done: true,
    value: undefined,
  });
  t.is(sessionA.getLiveness().queuedFrames, 0);
  injector.resume();
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

test('a queued Buffer frame is copied, not aliased', async t => {
  const { sessionA, sessionB, injector } = await connectStallablePair(
    t,
    cborCodec,
  );
  injector.stall();
  await sessionA.writer.next(Uint8Array.of(0));
  await until(() => injector.getHeldWrites() === 1);
  const buffer = Buffer.from([1, 2, 3]);
  await sessionA.writer.next(buffer);
  buffer.fill(9);
  injector.resume();

  for (const expected of [[0], [1, 2, 3]]) {
    // eslint-disable-next-line no-await-in-loop
    const received = await sessionB.reader.next(undefined);
    t.false(received.done);
    if (!received.done) t.deepEqual([...received.value], expected);
  }
});

test('writer.throw tears the session down even when the transport throw rejects', async t => {
  const { sessionA, injector } = await connectStallablePair(
    t,
    cborCodec,
    { intervalMs: heartbeat.intervalMs, sessionTimeoutMs: 60_000 },
    transport =>
      harden({
        ...transport,
        connect: async hints => {
          await null;
          const stream = await transport.connect(hints);
          /** @type {typeof stream.writer} */
          const writer = harden({
            ...stream.writer,
            throw: async () => {
              await null;
              throw Error('transport throw failed');
            },
            [Symbol.asyncIterator]() {
              return writer;
            },
          });
          return harden({ reader: stream.reader, writer });
        },
      }),
  );
  injector.stall();
  const count = 80;
  const writes = [];
  for (let i = 0; i < count; i += 1) {
    writes.push(sessionA.writer.next(Uint8Array.of(i)));
  }
  await delay(heartbeat.intervalMs);

  await t.throwsAsync(() => sessionA.writer.throw(Error('local abort')), {
    message: 'transport throw failed',
  });
  const results = await Promise.all(writes);
  t.true(results.some(({ done }) => done));
  t.is(sessionA.getLiveness().queuedFrames, 0);
  injector.resume();
});
