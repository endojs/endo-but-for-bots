// @ts-check

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
import {
  readOcapnHeartbeatMessage,
  writeOcapnHeartbeatMessage,
} from '@endo/ocapn/operations';
import { makeOcapnNoiseNetwork } from '../index.js';
import { makeMockTransportPair } from '../src/transports/mock.js';

/**
 * @param {number} milliseconds
 */
const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

/**
 * @param {ExecutionContext<unknown>} t
 * @param {Parameters<typeof makeOcapnNoiseNetwork>[0]} optionsA
 * @param {Parameters<typeof makeOcapnNoiseNetwork>[0]} optionsB
 */
const connectPair = async (t, optionsA, optionsB) => {
  const netA = makeOcapnNoiseNetwork(optionsA);
  const netB = makeOcapnNoiseNetwork(optionsB);
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  await netA.addTransport(transportA);
  await netB.addTransport(transportB);
  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);
  return { sessionA, sessionB };
};

// Wide enough that timer jitter on a loaded CI runner cannot fake a loss.
const heartbeat = { intervalMs: 50, sessionTimeoutMs: 500 };

for (const [codecName, codec] of /** @type {const} */ ([
  ['cbor', cborCodec],
  ['syrup', syrupCodec],
])) {
  test(`${codecName}: heartbeats keep an idle session alive and stay below the session`, async t => {
    const { sessionA, sessionB } = await connectPair(
      t,
      { codec, heartbeat },
      { codec, heartbeat },
    );

    // Both sides wait on their readers, so the liveness timeout runs,
    // while the session idles for several session timeouts.
    const receivedP = sessionB.reader.next(undefined);
    const replyP = sessionA.reader.next(undefined);
    await delay(heartbeat.sessionTimeoutMs * 3);

    // Each pending read skips the peer's heartbeats and gets its data.
    await sessionA.writer.next(Uint8Array.of(1, 2, 3));
    const received = await receivedP;
    t.false(received.done);
    if (!received.done) {
      t.deepEqual([...received.value], [1, 2, 3]);
    }
    await sessionB.writer.next(Uint8Array.of(4));
    const reply = await replyP;
    t.false(reply.done);

    const livenessA = sessionA.getLiveness();
    const livenessB = sessionB.getLiveness();
    t.true(livenessA.heartbeat);
    t.is(livenessA.epoch, 0n);
    // Each side has decrypted the peer's identity greeting plus many
    // heartbeats, and has heard the peer acknowledge some of its own.
    t.true(/** @type {bigint} */ (livenessA.lastAckedRecvNonce) > 4n);
    t.true(/** @type {bigint} */ (livenessB.lastAckedRecvNonce) > 4n);
    t.not(livenessA.peerLastAckedRecvNonce, undefined);
    t.not(livenessB.peerLastAckedRecvNonce, undefined);
    t.true(
      /** @type {bigint} */ (livenessA.peerLastAckedRecvNonce) <=
        /** @type {bigint} */ (livenessB.lastAckedRecvNonce),
    );
  });
}

test('a silent peer is detected as lost after the session timeout', async t => {
  // B does not heartbeat and never writes, as if it had crashed.
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  t.false(sessionB.getLiveness().heartbeat);

  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: /no traffic from peer for 500ms; session lost/,
  });

  // The terminal state is sticky and the writer is closed.
  t.deepEqual(await sessionA.reader.next(undefined), {
    done: true,
    value: undefined,
  });
  t.deepEqual(await sessionA.writer.next(new Uint8Array([1])), {
    done: true,
    value: undefined,
  });
});

test('a peer without heartbeats receives op:ping and op:pong frames', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  const first = await sessionB.reader.next(undefined);
  const second = await sessionB.reader.next(undefined);
  t.false(first.done);
  t.false(second.done);
  if (!first.done && !second.done) {
    t.deepEqual(readOcapnHeartbeatMessage(cborCodec.makeReader(first.value)), {
      type: 'op:ping',
      epoch: 0n,
      sequence: 0n,
    });
    t.deepEqual(readOcapnHeartbeatMessage(cborCodec.makeReader(second.value)), {
      type: 'op:pong',
      epoch: 0n,
      sequence: 0n,
      // A has decrypted only B's identity greeting, nonce 0.
      lastAckedRecvNonce: 0n,
    });
  }
  sessionA.close();
});

/**
 * Record the heartbeat and liveness timers that sessions arm, by their
 * period, and which of them are later cleared. Only run from serial
 * tests, which AVA runs before the concurrent ones, so no other test's
 * timers are observed.
 *
 * @param {ExecutionContext<unknown>} t
 */
const watchSessionTimers = t => {
  const {
    setInterval: realSetInterval,
    clearInterval: realClearInterval,
    setTimeout: realSetTimeout,
    clearTimeout: realClearTimeout,
  } = globalThis;
  /** @type {Set<unknown>} */
  const armed = new Set();
  /** @type {Set<unknown>} */
  const cleared = new Set();
  /** @type {any} */
  const g = globalThis;
  g.setInterval = (/** @type {any} */ fn, /** @type {number} */ ms) => {
    const handle = realSetInterval(fn, ms);
    if (ms === heartbeat.intervalMs) armed.add(handle);
    return handle;
  };
  g.setTimeout = (/** @type {any} */ fn, /** @type {number} */ ms) => {
    const handle = realSetTimeout(fn, ms);
    if (ms === heartbeat.sessionTimeoutMs) armed.add(handle);
    return handle;
  };
  g.clearInterval = (/** @type {any} */ handle) => {
    cleared.add(handle);
    realClearInterval(handle);
  };
  g.clearTimeout = (/** @type {any} */ handle) => {
    cleared.add(handle);
    realClearTimeout(handle);
  };
  t.teardown(() => {
    g.setInterval = realSetInterval;
    g.clearInterval = realClearInterval;
    g.setTimeout = realSetTimeout;
    g.clearTimeout = realClearTimeout;
  });
  return {
    /** Heartbeat or liveness timers armed and not yet cleared. */
    live: () => [...armed].filter(handle => !cleared.has(handle)),
  };
};

for (const [how, end] of /** @type {const} */ ([
  [
    'close()',
    async (/** @type {any} */ sessionA, /** @type {any} */ sessionB) => {
      sessionA.close();
      sessionB.close();
    },
  ],
  [
    'reader.return',
    async (/** @type {any} */ sessionA, /** @type {any} */ sessionB) => {
      await sessionA.reader.return(undefined);
      await sessionB.reader.return(undefined);
    },
  ],
  [
    'a peer-initiated end of stream',
    async (/** @type {any} */ sessionA, /** @type {any} */ sessionB) => {
      await null;
      // Only A ends; B must notice the end of stream and stop its own.
      sessionA.close();
      let result;
      do {
        // eslint-disable-next-line no-await-in-loop
        result = await sessionB.reader.next(undefined);
      } while (!result.done);
    },
  ],
])) {
  test.serial(
    `ending a heartbeat session by ${how} clears its timers`,
    async t => {
      const timers = watchSessionTimers(t);
      const { sessionA, sessionB } = await connectPair(
        t,
        { codec: cborCodec, heartbeat },
        { codec: cborCodec, heartbeat },
      );
      // A pending read on each side arms its liveness timeout.
      const readA = sessionA.reader.next(undefined).catch(() => {});
      const readB = sessionB.reader.next(undefined).catch(() => {});
      await delay(0);
      // One heartbeat interval and one liveness timeout per session.
      t.true(timers.live().length >= 4);
      await end(sessionA, sessionB);
      t.deepEqual(timers.live(), []);
      await Promise.all([readA, readB]);
    },
  );
}

test('getLiveness reports the received nonce once the peer has spoken', async t => {
  const { sessionA } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  // A has decrypted B's identity greeting, nonce 0.
  t.is(sessionA.getLiveness().lastAckedRecvNonce, 0n);
  sessionA.close();
});

test('a malformed heartbeat operation aborts the session', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  const ping = writeOcapnHeartbeatMessage(
    { type: 'op:ping', epoch: 0n, sequence: 0n },
    cborCodec,
  );
  await sessionB.writer.next(Uint8Array.of(...ping, 0));
  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: /malformed heartbeat operation from peer/,
  });
});

test('a frame that is not a heartbeat reaches the session', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  // A record that is not a heartbeat, then raw bytes that are not a
  // record at all.
  const writer = cborCodec.makeWriter();
  writer.enterRecord(1);
  writer.writeSelectorFromString('op:abort');
  writer.exitRecord();
  const record = writer.getBytes();
  await sessionB.writer.next(record);
  await sessionB.writer.next(Uint8Array.of(0xff, 0xfe));
  const first = await sessionA.reader.next(undefined);
  const second = await sessionA.reader.next(undefined);
  t.false(first.done);
  t.false(second.done);
  if (!first.done && !second.done) {
    t.deepEqual([...first.value], [...record]);
    t.deepEqual([...second.value], [0xff, 0xfe]);
  }
  sessionA.close();
});

test('an op:pong acknowledging an unsent nonce is ignored', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  const forged = writeOcapnHeartbeatMessage(
    {
      type: 'op:pong',
      epoch: 0n,
      sequence: 0n,
      lastAckedRecvNonce: 2n ** 64n,
    },
    cborCodec,
  );
  await sessionB.writer.next(forged);
  const honest = writeOcapnHeartbeatMessage(
    { type: 'op:pong', epoch: 0n, sequence: 1n, lastAckedRecvNonce: 0n },
    cborCodec,
  );
  await sessionB.writer.next(honest);
  await sessionB.writer.next(Uint8Array.of(1));
  // Reading the data frame absorbs both pongs ahead of it.
  const data = await sessionA.reader.next(undefined);
  t.false(data.done);
  // A sent its greeting at nonce 0, so only the honest pong counts.
  t.is(sessionA.getLiveness().peerLastAckedRecvNonce, 0n);
  sessionA.close();
});

test('a consumer that stops reading is not mistaken for a lost peer', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  const frameCount = 200;
  // B writes while A reads nothing for longer than the session timeout.
  const writes = [];
  for (let index = 0; index < frameCount; index += 1) {
    writes.push(sessionB.writer.next(Uint8Array.of(index)));
  }
  await delay(heartbeat.sessionTimeoutMs * 2);
  for (let index = 0; index < frameCount; index += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sessionA.reader.next(undefined);
    t.false(result.done);
    if (!result.done) t.is(result.value[0], index);
  }
  await Promise.all(writes);
  // The stall was local, so the session survived it.
  await sessionB.writer.next(Uint8Array.of(42));
  const last = await sessionA.reader.next(undefined);
  t.false(last.done);
  sessionA.close();
});

test('heartbeat options are validated', t => {
  t.throws(
    () =>
      makeOcapnNoiseNetwork({
        codec: cborCodec,
        heartbeat: { intervalMs: 10, sessionTimeoutMs: 29 },
      }),
    { message: /at least 3 times heartbeat.intervalMs/ },
  );
  t.throws(
    () =>
      makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat: { intervalMs: 0 } }),
    { message: /positive number/ },
  );
  for (const intervalMs of [NaN, -0, Infinity, 2 ** 31]) {
    t.throws(
      () =>
        makeOcapnNoiseNetwork({ codec: cborCodec, heartbeat: { intervalMs } }),
      { message: /positive number of at most 2147483647/ },
      `intervalMs ${intervalMs}`,
    );
  }
  for (const sessionTimeoutMs of [NaN, 2 ** 31]) {
    t.throws(
      () =>
        makeOcapnNoiseNetwork({
          codec: cborCodec,
          heartbeat: { intervalMs: 10, sessionTimeoutMs },
        }),
      { message: /at least 3 times heartbeat.intervalMs and at most/ },
      `sessionTimeoutMs ${sessionTimeoutMs}`,
    );
  }
  // The bounds themselves are accepted.
  for (const options of [
    { intervalMs: 10 },
    { intervalMs: 10, sessionTimeoutMs: 30 },
    { intervalMs: 10, sessionTimeoutMs: 2 ** 31 - 1 },
  ]) {
    const network = makeOcapnNoiseNetwork({
      codec: cborCodec,
      heartbeat: options,
    });
    network.shutdown();
  }
  t.pass();
});

test('closing the writer ends a pending heartbeat read', async t => {
  const { sessionA } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec },
  );
  const pending = sessionA.reader.next(undefined);
  await sessionA.writer.return(undefined);
  t.deepEqual(await pending, { done: true, value: undefined });
});
