// @ts-check

/** @import { ExecutionContext } from 'ava' */

import test from '@endo/ses-ava/test.js';

import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
import { readOcapnHeartbeatMessage } from '@endo/ocapn/operations';
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

const heartbeat = { intervalMs: 20, sessionTimeoutMs: 100 };

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
    t.true(livenessA.heartbeat);
    t.is(livenessA.epoch, 0n);
    // Each side has decrypted the peer's identity greeting plus many
    // heartbeats, and has heard the peer acknowledge some of its own.
    t.true(livenessA.lastAckedRecvNonce > 4n);
    t.true(livenessB.lastAckedRecvNonce > 4n);
    t.not(livenessA.peerAckedRecvNonce, undefined);
    t.not(livenessB.peerAckedRecvNonce, undefined);
    t.true(
      /** @type {bigint} */ (livenessA.peerAckedRecvNonce) <=
        livenessB.lastAckedRecvNonce,
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

  const start = Date.now();
  await t.throwsAsync(() => sessionA.reader.next(undefined), {
    message: /no traffic from peer for 100ms; session lost/,
  });
  t.true(Date.now() - start >= heartbeat.sessionTimeoutMs - 10);

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
