// @ts-check

import net from 'net';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { test } from './_util.js';
import { makeClient } from '../src/client/index.js';
import { makeTcpNetLayer } from '../src/netlayers/tcp-test-only.js';
import { encodeSwissnum } from '../src/client/util.js';

// Tag-24 wrapper bytes that prefix every CBOR-framed record on the
// wire: 0xd8 (major type 6 with one follow-byte argument) and 0x18
// (the argument value 24).
const TAG_24_INITIAL = 0xd8;
const TAG_24_ARG = 0x18;

// Initial-byte base for CBOR major type 2 (byte string); the bottom
// five bits are the additional-info nibble (the length-encoding
// width or the inline length for short payloads).
const MAJOR_2_BASE = 0x40;
const MAJOR_3_BASE = 0x60;

/**
 * Establishes a TCP server that accepts a single inbound connection,
 * accumulates every byte the client writes until the client closes
 * (or the server destroys) the socket, then resolves `sessionBytes`
 * with the concatenated capture. Used to peek at the wire format of
 * an outgoing handshake from the test-only TCP netlayer.
 *
 * Capturing the whole session (rather than just the first
 * `socket.on('data')` chunk) removes a non-deterministic dependency
 * on the first TCP packet happening to carry a complete OCapN
 * message; the cbor writer is free to flush its prefix and payload
 * in separate `socket.write` calls.
 *
 * @returns {Promise<{
 *   port: number,
 *   address: string,
 *   sessionBytes: Promise<Uint8Array>,
 *   close: () => void,
 * }>}
 */
const makeSnifferServer = async () => {
  /** @type {(bytes: Uint8Array) => void} */
  let resolveBytes;
  /** @type {(err: Error) => void} */
  let rejectBytes;
  const sessionBytes = new Promise((resolve, reject) => {
    resolveBytes = resolve;
    rejectBytes = reject;
  });
  const server = net.createServer(socket => {
    /** @type {Uint8Array[]} */
    const chunks = [];
    socket.on('data', data => {
      chunks.push(
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      );
    });
    socket.on('error', err => rejectBytes(err));
    socket.on('close', () => {
      let total = 0;
      for (const chunk of chunks) {
        total += chunk.length;
      }
      const concatenated = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        concatenated.set(chunk, offset);
        offset += chunk.length;
      }
      resolveBytes(concatenated);
    });
    // Close the write half once the client's first burst arrives, so
    // the client sees EOF and stops talking; the `close` event above
    // then fires with everything the client managed to send.
    socket.once('data', () => {
      socket.end();
    });
  });
  await /** @type {Promise<void>} */ (
    new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', err =>
        err ? reject(err) : resolve(undefined),
      );
    })
  );
  const addressInfo = server.address();
  if (typeof addressInfo !== 'object' || addressInfo === null) {
    throw Error('Unexpected server address');
  }
  return {
    port: addressInfo.port,
    address: addressInfo.address,
    sessionBytes,
    close: () => server.close(),
  };
};

test('cbor framing wraps outgoing bytes with a tag-24 byte-string head', async t => {
  const sniffer = await makeSnifferServer();
  t.teardown(() => sniffer.close());

  const client = makeClient({ debugLabel: 'cbor-sniff', debugMode: true });
  t.teardown(() => client.shutdown());

  const netlayer = await client.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'sniff-A',
      framing: 'cbor',
    }),
  );

  // Trigger an outbound handshake to the sniffer. The sniffer
  // half-closes its write side as soon as the first chunk arrives,
  // so the pending session rejects; swallow it so it does not
  // surface as an unhandled rejection.
  client
    .provideSession({
      type: 'ocapn-peer',
      transport: netlayer.location.transport,
      designator: 'sniff-B',
      hints: { host: sniffer.address, port: String(sniffer.port) },
    })
    .catch(() => {});

  const bytes = await sniffer.sessionBytes;

  // The first three bytes must be the tag-24 wrapper followed by a
  // major-type-2 initial byte: 0xd8 0x18 <major-2 initial>.
  t.true(bytes.length >= 3, 'sniffer captured at least 3 bytes');
  t.is(bytes[0], TAG_24_INITIAL, 'first byte is the tag-24 major-6 initial');
  t.is(bytes[1], TAG_24_ARG, 'second byte is the tag-24 argument (24)');
  t.true(
    bytes[2] >= MAJOR_2_BASE && bytes[2] < MAJOR_3_BASE,
    `third byte initiates a major-type-2 (byte string) head (got 0x${bytes[2].toString(16)})`,
  );

  // Decode the head's additional-info nibble and read the payload
  // length. Heads beyond the inline-23 case use 1, 2, 4, or 8
  // follow bytes per RFC 8949 § 3.
  const additional = bytes[2] - MAJOR_2_BASE;
  let headLength;
  let declaredPayloadLength;
  if (additional <= 23) {
    headLength = 3;
    declaredPayloadLength = additional;
  } else if (additional === 24) {
    headLength = 4;
    declaredPayloadLength = bytes[3];
  } else if (additional === 25) {
    headLength = 5;
    declaredPayloadLength = bytes[3] * 0x100 + bytes[4];
  } else if (additional === 26) {
    headLength = 7;
    declaredPayloadLength =
      bytes[3] * 0x1000000 + bytes[4] * 0x10000 + bytes[5] * 0x100 + bytes[6];
  } else {
    t.fail(
      `unexpected additional-info ${additional} in major-type-2 head; test does not cover the 8-byte-follow case`,
    );
    return;
  }

  // The captured chunk must cover at least the framed payload.
  t.true(
    bytes.length >= headLength + declaredPayloadLength,
    `captured ${bytes.length} bytes covers the framed payload (head ${headLength} + payload ${declaredPayloadLength})`,
  );
});

test('cbor framing round-trip through the test-only TCP netlayer', async t => {
  const swissnumTable = new Map();
  swissnumTable.set(
    'Echo',
    Far('echo', {
      echo: value => value,
    }),
  );

  const clientA = makeClient({
    debugLabel: 'cbor-A',
    debugMode: true,
  });
  const clientB = makeClient({
    debugLabel: 'cbor-B',
    debugMode: true,
    swissnumTable,
  });
  t.teardown(() => {
    clientA.shutdown();
    clientB.shutdown();
  });

  await clientA.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'cbor-A',
      framing: 'cbor',
    }),
  );
  const netlayerB = await clientB.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'cbor-B',
      framing: 'cbor',
    }),
  );

  const session = await clientA.provideSession(netlayerB.location);
  const bootstrap = session.getBootstrap();
  const echoRef = await E(bootstrap).fetch(encodeSwissnum('Echo'));
  const result = await E(echoRef).echo('hello cbor');
  t.is(result, 'hello cbor');
});

test('cbor framing is the default when no framing option is passed', async t => {
  // Mirror the round-trip but omit the `framing` option; the default
  // should be `'cbor'` so the two peers interoperate without an
  // explicit value.
  const swissnumTable = new Map();
  swissnumTable.set(
    'Echo',
    Far('echo', {
      echo: value => value,
    }),
  );

  const clientA = makeClient({
    debugLabel: 'cbor-default-A',
    debugMode: true,
  });
  const clientB = makeClient({
    debugLabel: 'cbor-default-B',
    debugMode: true,
    swissnumTable,
  });
  t.teardown(() => {
    clientA.shutdown();
    clientB.shutdown();
  });

  await clientA.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'cbor-default-A',
    }),
  );
  const netlayerB = await clientB.registerNetlayer((handlers, logger) =>
    makeTcpNetLayer({
      handlers,
      logger,
      specifiedDesignator: 'cbor-default-B',
    }),
  );

  const session = await clientA.provideSession(netlayerB.location);
  const bootstrap = session.getBootstrap();
  const echoRef = await E(bootstrap).fetch(encodeSwissnum('Echo'));
  const result = await E(echoRef).echo('default is cbor');
  t.is(result, 'default is cbor');
});
