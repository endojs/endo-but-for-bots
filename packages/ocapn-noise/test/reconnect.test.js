// @ts-check

/**
 * @import { ExecutionContext } from 'ava'
 * @import { OcapnCodec } from '@endo/ocapn/codec-interface'
 * @import { OcapnNoiseSession } from '../src/types.js'
 */

import test from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeOcapnNoiseNetwork } from '../index.js';
import { makeMockTransportPair } from '../src/transports/mock.js';
import { makeLossyTransport } from './_loss-injector.js';

/**
 * @param {number} milliseconds
 */
const delay = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

// Wide enough that timer jitter on a loaded CI runner cannot fake a loss.
const heartbeat = { intervalMs: 50, sessionTimeoutMs: 500 };
const reconnect = {
  backoffInitialMs: 20,
  backoffMaxMs: 200,
  hardTimeoutMs: 10_000,
};

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 */
const eventually = async (predicate, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('condition not reached in time');
    // eslint-disable-next-line no-await-in-loop
    await delay(10);
  }
};

/**
 * Connect A to B over a mock transport whose streams from A can be
 * partitioned.
 *
 * @param {ExecutionContext<unknown>} t
 * @param {OcapnCodec} codec
 * @param {object} [options]
 * @param {object | false} [options.reconnectA]
 * @param {object | false} [options.reconnectB]
 * @param {number} [options.handshakeTimeoutMs]
 */
const connectLossyPair = async (
  t,
  codec,
  { reconnectA = reconnect, reconnectB = reconnect, handshakeTimeoutMs } = {},
) => {
  const netA = makeOcapnNoiseNetwork({
    codec,
    heartbeat,
    reconnect: reconnectA,
    handshakeTimeoutMs,
  });
  const netB = makeOcapnNoiseNetwork({
    codec,
    heartbeat,
    reconnect: reconnectB,
  });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  const injector = makeLossyTransport(transportA);
  await netA.addTransport(injector.transport);
  await netB.addTransport(transportB);
  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);
  return { netA, netB, keyA, keyB, sessionA, sessionB, injector };
};

/**
 * @param {OcapnNoiseSession} session
 * @param {number} count
 */
const readBytes = async (session, count) => {
  const bytes = [];
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const result = await session.reader.next(undefined);
    if (result.done) throw Error('session ended early');
    bytes.push(...result.value);
  }
  return bytes;
};

for (const [codecName, codec] of /** @type {const} */ ([
  ['cbor', cborCodec],
  ['syrup', syrupCodec],
])) {
  test(`${codecName}: a lost transport instance is replaced with a fresh handshake`, async t => {
    const { sessionA, sessionB, injector } = await connectLossyPair(t, codec);
    t.true(sessionA.getLiveness().reconnect);
    t.true(sessionB.getLiveness().reconnect);

    await sessionA.writer.next(Uint8Array.of(1));
    t.deepEqual(await readBytes(sessionB, 1), [1]);

    injector.sever();
    // Written into the partition: A believes the transport took these,
    // so they ride only in the session's replay buffer.
    await sessionA.writer.next(Uint8Array.of(2));
    await sessionB.writer.next(Uint8Array.of(102));
    await delay(heartbeat.sessionTimeoutMs / 2);
    await sessionA.writer.next(Uint8Array.of(3));
    await sessionB.writer.next(Uint8Array.of(103));

    await eventually(
      () =>
        sessionA.getLiveness().epoch === 1n &&
        sessionB.getLiveness().epoch === 1n,
    );
    t.true(injector.getConnects() >= 2);
    await sessionA.writer.next(Uint8Array.of(4));
    await sessionB.writer.next(Uint8Array.of(104));

    // Every frame arrives exactly once, in order, on the same session
    // objects the CapTP layer holds.
    t.deepEqual(await readBytes(sessionB, 3), [2, 3, 4]);
    t.deepEqual(await readBytes(sessionA, 3), [102, 103, 104]);

    // The new instance is live: heartbeats keep it up past a timeout.
    await delay(heartbeat.sessionTimeoutMs * 2);
    t.is(sessionA.getLiveness().epoch, 1n);
    t.false(sessionA.getLiveness().reconnecting);
    sessionA.close();
  });

  test(`${codecName}: the session survives successive reconnects`, async t => {
    const { sessionA, sessionB, injector } = await connectLossyPair(t, codec);
    for (const round of [1, 2, 3]) {
      injector.sever();
      // eslint-disable-next-line no-await-in-loop
      await sessionA.writer.next(Uint8Array.of(round));
      // eslint-disable-next-line no-await-in-loop
      await eventually(
        () =>
          sessionA.getLiveness().epoch === BigInt(round) &&
          sessionB.getLiveness().epoch === BigInt(round),
      );
      // eslint-disable-next-line no-await-in-loop
      t.deepEqual(await readBytes(sessionB, 1), [round]);
    }
    sessionA.close();
  });
}

test('the session aborts once SESSION_HARD_TIMEOUT passes unreconnected', async t => {
  const hardTimeoutMs = 1500;
  const { sessionA, sessionB, injector } = await connectLossyPair(
    t,
    cborCodec,
    {
      reconnectA: { ...reconnect, hardTimeoutMs, backoffMaxMs: 200 },
      reconnectB: { ...reconnect, hardTimeoutMs, backoffMaxMs: 200 },
    },
  );
  injector.refuse(true);
  injector.sever();
  await sessionA.writer.next(Uint8Array.of(1));

  await eventually(() => sessionA.getLiveness().reconnecting);
  // Redials back off and are refused until the budget runs out.
  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: /not reconnected within 1500ms/,
  });
  t.true(injector.getConnects() >= 2);
  // The side waiting for the redial gives up on the same budget, which
  // surfaces upward as the session's terminal error.
  await t.throwsAsync(() => sessionB.reader.next(undefined), {
    message: /not reconnected within 1500ms/,
  });
  t.deepEqual(await sessionA.writer.next(Uint8Array.of(2)), {
    done: true,
    value: undefined,
  });
});

test('writes fail fast in the last stretch of the reconnect budget', async t => {
  const { sessionA, injector } = await connectLossyPair(t, cborCodec, {
    reconnectA: {
      backoffInitialMs: 20,
      backoffMaxMs: 1000,
      hardTimeoutMs: 1200,
    },
  });
  injector.refuse(true);
  injector.sever();
  await eventually(() => sessionA.getLiveness().reconnecting);
  await delay(300);
  await t.throwsAsync(() => sessionA.writer.next(Uint8Array.of(1)), {
    message: /about to abort/,
  });
});

test('a lost resume reply is retried at the same epoch', async t => {
  const { sessionA, sessionB, injector } = await connectLossyPair(
    t,
    cborCodec,
    { handshakeTimeoutMs: 1000 },
  );
  // The dialer reads the SYNACK and the identity greeting, then loses
  // the resume reply: the responder attaches epoch 1, the dialer times
  // out and must ask for epoch 1 again.
  injector.limitNextReads(2);
  injector.sever();
  await sessionA.writer.next(Uint8Array.of(1));
  await eventually(
    () =>
      sessionA.getLiveness().epoch === 1n &&
      sessionB.getLiveness().epoch === 1n,
  );
  t.true(injector.getConnects() >= 2);
  t.deepEqual(await readBytes(sessionB, 1), [1]);
  await sessionB.writer.next(Uint8Array.of(101));
  t.deepEqual(await readBytes(sessionA, 1), [101]);
  sessionA.close();
});

test('a peer that no longer holds the session refuses the reconnect', async t => {
  const { sessionA, sessionB, injector } = await connectLossyPair(t, cborCodec);
  injector.sever();
  // B gives the session up; its op:session-end is lost in the partition.
  sessionB.close();
  const started = Date.now();
  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: /refused to resume/,
  });
  t.true(Date.now() - started < reconnect.hardTimeoutMs);
});

test('a peer that restarts and opens a fresh session aborts the one waiting to resume', async t => {
  const netA = makeOcapnNoiseNetwork({
    codec: cborCodec,
    heartbeat,
    reconnect,
  });
  const netB = makeOcapnNoiseNetwork({
    codec: cborCodec,
    heartbeat,
    reconnect,
  });
  const restartedA = makeOcapnNoiseNetwork({
    codec: cborCodec,
    heartbeat,
    reconnect,
  });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
    restartedA.shutdown();
  });
  const signingKeysA = netA.generateSigningKeys();
  const keyA = netA.addSigningKeys(signingKeysA);
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  const injector = makeLossyTransport(transportA);
  await netA.addTransport(injector.transport);
  await netB.addTransport(transportB);
  const [_sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);

  // A dies in a partition, so B never hears it go.
  injector.refuse(true);
  injector.sever();
  netA.shutdown();
  await eventually(() => sessionB.getLiveness().reconnecting);

  // A comes back with the same identity but none of the session state.
  restartedA.addSigningKeys(signingKeysA);
  await restartedA.addTransport(transportA);
  const fresh = await restartedA.provideSession(netB.locationFor(keyB));
  t.is(fresh.getLiveness().epoch, 0n);
  await t.throwsAsync(() => sessionB.reader.next(undefined), {
    message: /peer opened a new session instead of resuming/,
  });
});

test('a deliberate close ends the session without a reconnect', async t => {
  const { sessionA, sessionB, injector } = await connectLossyPair(t, cborCodec);
  sessionA.close();
  t.deepEqual(await sessionB.reader.next(undefined), {
    done: true,
    value: undefined,
  });
  t.false(sessionB.getLiveness().reconnecting);
  await delay(heartbeat.sessionTimeoutMs * 2);
  t.is(injector.getConnects(), 1);
});

test('a peer without reconnect keeps the Phase 2 loss semantics', async t => {
  const { sessionA, sessionB, injector } = await connectLossyPair(
    t,
    cborCodec,
    { reconnectB: false },
  );
  t.false(sessionA.getLiveness().reconnect);
  t.false(sessionB.getLiveness().reconnect);
  injector.sever();
  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: /session lost/,
  });
  t.is(injector.getConnects(), 1);
});

test('reconnect options are validated', t => {
  t.throws(() => makeOcapnNoiseNetwork({ codec: cborCodec, reconnect: true }), {
    message: /reconnect requires heartbeat/,
  });
  t.throws(
    () =>
      makeOcapnNoiseNetwork({
        codec: cborCodec,
        heartbeat,
        reconnect: { backoffMaxMs: 10, backoffInitialMs: 100 },
      }),
    { message: /backoffMaxMs/ },
  );
  t.throws(
    () =>
      makeOcapnNoiseNetwork({
        codec: cborCodec,
        heartbeat,
        reconnect: { backoffInitialMs: -1 },
      }),
    { message: /backoffInitialMs.* must be a positive number/ },
  );
  for (const [name, value] of /** @type {Array<[string, unknown]>} */ ([
    ['backoffInitialMs', 0],
    ['backoffInitialMs', NaN],
    ['backoffInitialMs', '10'],
    ['backoffMaxMs', 0],
    ['backoffMaxMs', NaN],
    ['hardTimeoutMs', 0],
    ['hardTimeoutMs', NaN],
    ['hardTimeoutMs', '600000'],
    // `setTimeout` would clamp these to 1 ms and abort at once.
    ['hardTimeoutMs', Infinity],
    ['hardTimeoutMs', 2 ** 31],
  ])) {
    t.throws(
      () =>
        makeOcapnNoiseNetwork({
          codec: cborCodec,
          heartbeat,
          reconnect: /** @type {any} */ ({ [name]: value }),
        }),
      { message: /must be a positive number/ },
      `${name}: ${String(value)}`,
    );
  }
  t.throws(
    () =>
      makeOcapnNoiseNetwork({
        codec: cborCodec,
        heartbeat,
        reconnect: { backoffMaxMs: 2000, hardTimeoutMs: 1000 },
      }),
    { message: /backoffMaxMs must lie between/ },
  );
  for (const options of [
    { backoffInitialMs: 100, backoffMaxMs: 100 },
    { backoffMaxMs: 1000, hardTimeoutMs: 1000 },
    { hardTimeoutMs: 2 ** 31 - 1 },
  ]) {
    t.notThrows(
      () =>
        makeOcapnNoiseNetwork({
          codec: cborCodec,
          heartbeat,
          reconnect: options,
        }),
      JSON.stringify(options),
    );
  }
});
