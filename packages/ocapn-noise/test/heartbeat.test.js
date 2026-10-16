// @ts-check

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
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

    // Idle for several session timeouts.
    await delay(heartbeat.sessionTimeoutMs * 3);

    await sessionA.writer.next(Uint8Array.of(1, 2, 3));
    const received = await sessionB.reader.next(undefined);
    t.false(received.done);
    if (!received.done) {
      t.deepEqual([...received.value], [1, 2, 3]);
    }

    const livenessA = sessionA.getLiveness();
    const livenessB = sessionB.getLiveness();
    const receivedA = /** @type {bigint} */ (livenessA.lastAckedRecvNonce);
    const receivedB = /** @type {bigint} */ (livenessB.lastAckedRecvNonce);
    t.true(livenessA.heartbeat);
    t.is(livenessA.epoch, 0n);
    // Each side has decrypted the peer's identity greeting plus many
    // heartbeats, and has heard the peer acknowledge some of its own.
    t.true(receivedA > 4n);
    t.true(receivedB > 4n);
    t.not(livenessA.peerAckedRecvNonce, undefined);
    t.not(livenessB.peerAckedRecvNonce, undefined);
    t.true(/** @type {bigint} */ (livenessA.peerAckedRecvNonce) <= receivedB);
  });
}

test('a silent peer is detected as lost after the session timeout', async t => {
  // B's heartbeat is far slower than A's session timeout and B never
  // writes, so A hears nothing, as if B had crashed.
  const { sessionA } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec, heartbeat: { intervalMs: 60_000 } },
  );

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

test('a peer without heartbeats receives no heartbeat frames', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec, heartbeat: false },
  );
  // The capability bit of op:session-hello: heartbeats run only when
  // both sides advertise them.
  t.false(sessionA.getLiveness().heartbeat);
  t.false(sessionB.getLiveness().heartbeat);
  // Idle well past A's session timeout: A neither sends B heartbeats nor
  // takes B's silence for loss.
  await delay(heartbeat.sessionTimeoutMs * 2);
  await sessionA.writer.next(Uint8Array.of(9));
  const first = await sessionB.reader.next(undefined);
  t.deepEqual(first, { done: false, value: Uint8Array.of(9) });
  sessionA.close();
});

test('heartbeats are on by default', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec },
    { codec: cborCodec },
  );
  t.true(sessionA.getLiveness().heartbeat);
  t.true(sessionB.getLiveness().heartbeat);
  sessionA.close();
});

test('closing a heartbeat session stops its timers', async t => {
  const { sessionA, sessionB } = await connectPair(
    t,
    { codec: cborCodec, heartbeat },
    { codec: cborCodec, heartbeat },
  );
  sessionA.close();
  sessionB.close();
  // Were the timers still armed, a timeout would surface here as a
  // rejection rather than the clean end of stream.
  await delay(heartbeat.sessionTimeoutMs * 2);
  t.deepEqual(await sessionA.writer.next(new Uint8Array([1])), {
    done: true,
    value: undefined,
  });
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
  const network = makeOcapnNoiseNetwork({
    codec: cborCodec,
    heartbeat: { intervalMs: 10 },
  });
  network.shutdown();
  t.pass();
});
