// @ts-check

/**
 * Conformance tests for the reconnect protocol rules R1, R3, R4, R5,
 * and R9 of `designs/ocapn-noise-session-reconnect-protocol.md`, build
 * slice B1. Each test drives two real networks over a lossy mock
 * transport and, where a rule concerns what a misbehaving or unlucky
 * peer sends, bends that peer's `op:session-hello` on its way into the
 * Noise channel.
 *
 * @import { ExecutionContext } from 'ava'
 * @import { OcapnCodec } from '@endo/ocapn/codec-interface'
 * @import { ByteStream, OcapnNoiseSession, OcapnNoiseTransport } from '../src/types.js'
 */

import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { cborCodec } from '@endo/ocapn/cbor';
import { syrupCodec } from '@endo/ocapn/syrup';
import {
  readOcapnSessionControlMessage,
  writeOcapnSessionControlMessage,
} from '@endo/ocapn/operations';
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
 * @typedef {{
 *   type: 'op:session-hello',
 *   features: bigint,
 *   epoch: bigint,
 *   session: Uint8Array,
 *   received: bigint,
 * }} SessionHello
 */

/**
 * Wrap a codec so that every `op:session-hello` the network encodes
 * with it passes through `tamper` first. The hello is encrypted after
 * encoding, so this is the one place a test can make a real network
 * send a hello its own state would not.
 *
 * @param {OcapnCodec} codec
 * @param {(hello: SessionHello) => SessionHello} tamper
 * @returns {OcapnCodec}
 */
const makeHelloTamperingCodec = (codec, tamper) =>
  harden({
    ...codec,
    makeWriter: (...writerArguments) => {
      const writer = codec.makeWriter(...writerArguments);
      return new Proxy(writer, {
        get: (target, key) => {
          const value = Reflect.get(target, key);
          if (key !== 'getBytes') {
            return typeof value === 'function' ? value.bind(target) : value;
          }
          return () => {
            const bytes = target.getBytes();
            /** @type {any} */
            let message;
            try {
              message = readOcapnSessionControlMessage(codec.makeReader(bytes));
            } catch {
              return bytes;
            }
            if (message.type !== 'op:session-hello') return bytes;
            return writeOcapnSessionControlMessage(tamper(message), codec);
          };
        },
      });
    },
  });

/**
 * Wrap a transport so that a test can drop the `op:session-hello` this
 * side answers an inbound dial with, and end that stream, as a path
 * dying just after the answer was written would. The SYNACK and the
 * identity greeting are the first two writes, and the hello the third.
 *
 * @param {OcapnNoiseTransport} transport
 */
const makeReplyDropper = transport => {
  let armed = false;
  let dropped = 0;
  /**
   * @param {ByteStream} stream
   * @returns {ByteStream}
   */
  const wrapStream = stream => {
    let writes = 0;
    let dropping = false;
    /** @type {ByteStream['writer']} */
    const writer = harden({
      next: async value => {
        await null;
        writes += 1;
        if (writes === 3 && armed) {
          armed = false;
          dropping = true;
          dropped += 1;
          Promise.resolve(stream.writer.return(undefined)).catch(() => {});
        }
        if (dropping) return harden({ done: false, value: undefined });
        return stream.writer.next(value);
      },
      return: async value => {
        await null;
        if (dropping) return harden({ done: true, value });
        return stream.writer.return(value);
      },
      throw: error => stream.writer.throw(error),
      [Symbol.asyncIterator]() {
        return writer;
      },
    });
    return harden({ reader: stream.reader, writer });
  };
  const { listen } = transport;
  return harden({
    transport: harden({
      ...transport,
      listen:
        listen &&
        (async handler => listen(stream => handler(wrapStream(stream)))),
    }),
    /** Drop the hello answering the next inbound dial. */
    dropNextReply: () => {
      armed = true;
    },
    getDropped: () => dropped,
  });
};

/**
 * Connect A to B over a mock transport whose streams can be
 * partitioned on either side, with each side's outgoing hellos passed
 * through a switchable tamper function.
 *
 * @param {ExecutionContext<unknown>} t
 * @param {OcapnCodec} codec
 */
const connectPair = async (t, codec) => {
  /** @type {{ A?: (hello: SessionHello) => SessionHello, B?: (hello: SessionHello) => SessionHello }} */
  const tamper = {};
  const netA = makeOcapnNoiseNetwork({
    codec: makeHelloTamperingCodec(codec, hello =>
      tamper.A ? tamper.A(hello) : hello,
    ),
    heartbeat,
    reconnect,
  });
  const netB = makeOcapnNoiseNetwork({
    codec: makeHelloTamperingCodec(codec, hello =>
      tamper.B ? tamper.B(hello) : hello,
    ),
    heartbeat,
    reconnect,
  });
  t.teardown(() => {
    netA.shutdown();
    netB.shutdown();
  });
  const keyA = netA.addSigningKeys(netA.generateSigningKeys());
  const keyB = netB.addSigningKeys(netB.generateSigningKeys());
  const { transportA, transportB } = makeMockTransportPair();
  const injectorA = makeLossyTransport(transportA);
  const injectorB = makeLossyTransport(transportB);
  const dropperA = makeReplyDropper(injectorA.transport);
  const dropperB = makeReplyDropper(injectorB.transport);
  await netA.addTransport(dropperA.transport);
  await netB.addTransport(dropperB.transport);
  const [sessionA, sessionB] = await Promise.all([
    netA.provideSession(netB.locationFor(keyB)),
    netB.waitForInboundSession(keyA),
  ]);
  return {
    sessionA,
    sessionB,
    injectorA,
    injectorB,
    dropperA,
    dropperB,
    tamper,
  };
};

/**
 * Inbound dials that this side closed without an `op:session-hello`
 * answer: it ended its writer having written only the SYNACK and its
 * identity greeting.
 *
 * @param {ReturnType<typeof makeLossyTransport>} injector
 */
const droppedDials = injector =>
  injector
    .getStreams()
    .filter(stream => !stream.outbound && stream.writesAtReturn === 2).length;

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

/**
 * The x25519 ephemeral each stream's first write carries in the clear:
 * bytes 32 to 64 of an initiator's SYN, the first 32 bytes of a
 * responder's SYNACK.
 *
 * @param {ReturnType<typeof makeLossyTransport>} injector
 */
const ephemerals = injector =>
  injector
    .getStreams()
    .filter(({ firstWrite }) => firstWrite !== undefined)
    .map(({ outbound, firstWrite }) => {
      const bytes = /** @type {Uint8Array} */ (firstWrite);
      return Buffer.from(
        outbound ? bytes.slice(32, 64) : bytes.slice(0, 32),
      ).toString('hex');
    });

for (const [codecName, codec] of /** @type {const} */ ([
  ['cbor', cborCodec],
  ['syrup', syrupCodec],
])) {
  test(`${codecName}: R1 every transport instance runs a fresh handshake`, async t => {
    const { sessionA, sessionB, injectorA, injectorB } = await connectPair(
      t,
      codec,
    );
    for (const round of [1, 2, 3]) {
      injectorA.sever();
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
    // The IK transcript hash mixes in both ephemerals, so a fresh pair
    // of ephemerals per instance is a fresh handshake hash per epoch and
    // fresh CipherStates: no key crosses an instance boundary.
    const seen = [...ephemerals(injectorA), ...ephemerals(injectorB)];
    t.true(seen.length >= 8);
    t.is(new Set(seen).size, seen.length);
    sessionA.close();
  });

  test(`${codecName}: R3 a hello for an epoch the session has reached is closed unanswered`, async t => {
    const { sessionA, sessionB, injectorA, injectorB, tamper } =
      await connectPair(t, codec);
    injectorA.sever();
    await eventually(
      () =>
        sessionA.getLiveness().epoch === 1n &&
        sessionB.getLiveness().epoch === 1n,
    );

    // Only A dials, and every hello it sends names epoch 1, where B
    // already is.
    injectorB.refuseOutbound(true);
    tamper.A = hello => (hello.epoch > 0n ? { ...hello, epoch: 1n } : hello);
    const dropsBefore = droppedDials(injectorB);
    injectorA.sever();
    injectorB.sever();
    await sessionA.writer.next(Uint8Array.of(1));
    await eventually(() => droppedDials(injectorB) >= dropsBefore + 2);
    t.is(sessionA.getLiveness().epoch, 1n);
    t.is(sessionB.getLiveness().epoch, 1n);
    t.true(sessionA.getLiveness().reconnecting);
    t.true(sessionB.getLiveness().reconnecting);

    // The stragglers did not abort the session: an honest hello
    // continues it.
    tamper.A = undefined;
    await eventually(
      () =>
        sessionA.getLiveness().epoch === 2n &&
        sessionB.getLiveness().epoch === 2n,
    );
    t.deepEqual(await readBytes(sessionB, 1), [1]);
    sessionA.close();
  });

  test(`${codecName}: R3 a hello that skips epochs is accepted`, async t => {
    const { sessionA, sessionB, injectorA, injectorB, dropperB } =
      await connectPair(t, codec);
    /** @type {Set<bigint>} */
    const epochsA = new Set();
    const watch = setInterval(() => {
      epochsA.add(sessionA.getLiveness().epoch);
    }, 2);
    t.teardown(() => clearInterval(watch));

    // B takes A's dial for epoch 1 and attaches, but its answer is lost,
    // so A stays at epoch 0 while B has reached 1. B's dial for epoch 2
    // must then be taken by A at epoch 0.
    dropperB.dropNextReply();
    injectorB.refuseOutbound(true);
    injectorA.sever();
    injectorB.sever();
    await sessionA.writer.next(Uint8Array.of(1));
    await eventually(() => dropperB.getDropped() === 1);
    injectorB.refuseOutbound(false);
    await eventually(
      () =>
        sessionA.getLiveness().epoch >= 2n &&
        sessionB.getLiveness().epoch >= 2n &&
        !sessionA.getLiveness().reconnecting &&
        !sessionB.getLiveness().reconnecting,
    );
    clearInterval(watch);
    t.is(sessionA.getLiveness().epoch, sessionB.getLiveness().epoch);
    t.false(epochsA.has(1n));
    t.deepEqual(await readBytes(sessionB, 1), [1]);
    await sessionB.writer.next(Uint8Array.of(101));
    t.deepEqual(await readBytes(sessionA, 1), [101]);
    sessionA.close();
  });

  test(`${codecName}: R4 a refusal aborts the session with no further dials`, async t => {
    const { sessionA, sessionB, injectorA, injectorB } = await connectPair(
      t,
      codec,
    );
    injectorA.sever();
    // B gives the session up; its op:session-end is lost in the
    // partition, so only the refusal can tell A.
    sessionB.close();
    const started = Date.now();
    await t.throwsAsync(() => sessionA.reader.next(undefined), {
      message: /refused to resume/,
    });
    t.true(Date.now() - started < reconnect.hardTimeoutMs);
    t.false(sessionA.getLiveness().reconnecting);
    const connectsA = injectorA.getConnects();
    const connectsB = injectorB.getConnects();
    await delay(reconnect.backoffMaxMs * 4);
    t.is(injectorA.getConnects(), connectsA);
    t.is(injectorB.getConnects(), connectsB);
  });

  for (const liar of /** @type {const} */ (['A', 'B'])) {
    const role = liar === 'A' ? 'dialer' : 'responder';
    test(`${codecName}: R5 a ${role} claiming more frames than were sent aborts the session`, async t => {
      const { sessionA, sessionB, injectorA, injectorB, tamper } =
        await connectPair(t, codec);
      await sessionA.writer.next(Uint8Array.of(1));
      await sessionB.writer.next(Uint8Array.of(101));
      t.deepEqual(await readBytes(sessionB, 1), [1]);
      t.deepEqual(await readBytes(sessionA, 1), [101]);

      // A dials and B answers; the liar claims to have delivered more
      // frames than its peer ever sent.
      injectorB.refuseOutbound(true);
      tamper[liar] = hello =>
        hello.epoch > 0n ? { ...hello, received: hello.received + 5n } : hello;
      injectorA.sever();
      injectorB.sever();
      const victim = liar === 'A' ? sessionB : sessionA;
      await t.throwsAsync(() => victim.reader.next(undefined), {
        message: /peer claims "\[6n\]" frames of "\[1n\]" sent/,
      });
    });
  }

  test(`${codecName}: R9 op:session-end ends the session without a redial`, async t => {
    const { sessionA, sessionB, injectorA, injectorB } = await connectPair(
      t,
      codec,
    );
    await sessionA.writer.next(Uint8Array.of(1));
    sessionA.close();
    t.deepEqual(await readBytes(sessionB, 1), [1]);
    t.deepEqual(await sessionB.reader.next(undefined), {
      done: true,
      value: undefined,
    });
    t.false(sessionA.getLiveness().reconnecting);
    t.false(sessionB.getLiveness().reconnecting);
    await delay(heartbeat.sessionTimeoutMs * 2);
    t.is(injectorA.getConnects(), 1);
    t.is(injectorB.getConnects(), 0);
  });
}
