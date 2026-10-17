// @ts-check

/** @import { ExecutionContext } from 'ava' */

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
const heartbeat = { intervalMs: 50, sessionTimeoutMs: 1000 };
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
 * @param {import('@endo/ocapn/codec-interface').OcapnCodec} codec
 * @param {object} [options]
 * @param {object | false} [options.reconnectA]
 * @param {object | false} [options.reconnectB]
 */
const connectLossyPair = async (
  t,
  codec,
  { reconnectA = reconnect, reconnectB = reconnect } = {},
) => {
  const netA = makeOcapnNoiseNetwork({
    codec,
    heartbeat,
    reconnect: reconnectA,
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
  const injectorB = makeLossyTransport(transportB);
  await netA.addTransport(injector.transport);
  await netB.addTransport(injectorB.transport);
  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);
  return { netA, netB, keyA, keyB, sessionA, sessionB, injector, injectorB };
};

/**
 * @param {import('../src/types.js').OcapnNoiseSession} session
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

for (const [codecName, codec] of /** @type {const} */ ([
  ['cbor', cborCodec],
  ['syrup', syrupCodec],
])) {
  test(`${codecName}: crossed hellos on reconnect converge on one transport instance`, async t => {
    const { sessionA, sessionB, injector, injectorB } = await connectLossyPair(
      t,
      codec,
    );
    // Holding every dial short of the peer until both sides are dialing
    // makes the two cross however far apart timer jitter puts the two
    // timeouts.
    injector.holdConnects(true);
    injectorB.holdConnects(true);
    injector.sever();
    injectorB.sever();
    await sessionA.writer.next(Uint8Array.of(1));
    await sessionB.writer.next(Uint8Array.of(101));

    // Both sides redial (A's first connection opened the session; B had
    // only ever accepted).
    await eventually(
      () => injector.getConnects() >= 2 && injectorB.getConnects() >= 1,
    );
    injector.holdConnects(false);
    injectorB.holdConnects(false);

    await eventually(
      () =>
        !sessionA.getLiveness().reconnecting &&
        !sessionB.getLiveness().reconnecting &&
        sessionA.getLiveness().epoch > 0n,
    );
    await delay(heartbeat.intervalMs * 4);
    t.is(injector.getOpenStreams() + injectorB.getOpenStreams(), 2);
    t.is(injector.getOpenStreams(), 1);
    t.is(sessionA.getLiveness().epoch, sessionB.getLiveness().epoch);

    t.deepEqual(await readBytes(sessionB, 1), [1]);
    t.deepEqual(await readBytes(sessionA, 1), [101]);
    await sessionA.writer.next(Uint8Array.of(2));
    t.deepEqual(await readBytes(sessionB, 1), [2]);
    sessionA.close();
  });
}

test('either side redials: the side that accepted the session reconnects it', async t => {
  const { sessionA, sessionB, injector, injectorB } = await connectLossyPair(
    t,
    cborCodec,
  );
  injector.refuseOutbound(true);
  injector.sever();
  await sessionB.writer.next(Uint8Array.of(7));
  await eventually(
    () =>
      sessionA.getLiveness().epoch === 1n &&
      sessionB.getLiveness().epoch === 1n,
  );
  t.true(injectorB.getConnects() >= 1);
  t.deepEqual(await readBytes(sessionA, 1), [7]);
});

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
  // The last stretch opens 200ms into reconnecting and the session aborts
  // at 5s, so a loaded runner that stalls the write by seconds still lands
  // it inside the window rather than after the abort.
  const { sessionA, injector } = await connectLossyPair(t, cborCodec, {
    reconnectA: {
      backoffInitialMs: 20,
      backoffMaxMs: 4800,
      hardTimeoutMs: 5000,
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
});
