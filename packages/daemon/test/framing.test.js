// @ts-check
// The framing seam (designs/daemon-cbor-frame-migration.md, Phase 1):
// first-byte classification, byte-level frame fixtures for both
// framings, the sniffing accept-side reader, the classification-gated
// writer, and the framing-times-peer matrix for CapTP sessions.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/marshal';
import { makePromiseKit } from '@endo/promise-kit';
import { makePipe } from '@endo/stream';
import { concatBytes } from '@endo/bytes/concat.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import {
  classifyFirstByte,
  makeFrameReader,
  makeFrameWriter,
  makeGatedFrameWriter,
  makeSniffingFrameReader,
} from '../src/framing.js';
import { makeFramedCapTP, makeSniffingCapTP } from '../src/connection.js';

/** @import { FramingName } from '../src/framing.js' */

/** @type {FramingName[]} */
const framings = ['netstring', 'cbor-frame'];

const hello = encodeUtf8('hello');

// Specimen wire bytes for the payload "hello" in each framing.
/** @type {Record<FramingName, Uint8Array>} */
const specimens = {
  netstring: encodeUtf8('5:hello,'),
  'cbor-frame': new Uint8Array([0xd8, 0x18, 0x45, ...hello]),
};

const makeCollectingWriter = () => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let closed = false;
  const writer = harden({
    /** @param {Uint8Array} chunk */
    async next(chunk) {
      chunks.push(chunk.slice());
      return harden({ done: false, value: undefined });
    },
    async return() {
      closed = true;
      return harden({ done: true, value: undefined });
    },
    async throw() {
      closed = true;
      return harden({ done: true, value: undefined });
    },
    [Symbol.asyncIterator]() {
      return writer;
    },
  });
  return {
    writer,
    bytes: () => concatBytes(chunks),
    isClosed: () => closed,
  };
};

/** @param {Uint8Array[]} chunks */
const makeChunkReader = chunks =>
  /** @type {import('@endo/stream').Reader<Uint8Array>} */ (
    harden(
      (async function* chunkReader() {
        yield* chunks;
      })(),
    )
  );

/** @param {AsyncIterable<Uint8Array>} reader */
const collect = async reader => {
  const frames = [];
  for await (const frame of reader) {
    frames.push(new TextDecoder().decode(frame));
  }
  return frames;
};

test('classifier: digits are netstring, 0xd8 is cbor-frame, all else fails by name', t => {
  for (let byte = 0; byte < 256; byte += 1) {
    if (byte >= 0x30 && byte <= 0x39) {
      t.is(classifyFirstByte(byte), 'netstring');
    } else if (byte === 0xd8) {
      t.is(classifyFirstByte(byte), 'cbor-frame');
    } else {
      const hex = byte.toString(16).padStart(2, '0');
      t.throws(() => classifyFirstByte(byte, 'specimen'), {
        message: `Unrecognized framing: first byte 0x${hex} is neither a netstring length digit nor the cbor-frame tag-24 prefix at offset 0 of specimen`,
      });
    }
  }
});

for (const framing of framings) {
  test(`${framing}: writer emits the specimen bytes`, async t => {
    const { writer, bytes } = makeCollectingWriter();
    const frameWriter = makeFrameWriter(writer, { framing });
    await frameWriter.next(hello);
    t.deepEqual([...bytes()], [...specimens[framing]]);
  });

  test(`${framing}: reader decodes the specimen bytes`, async t => {
    await null;
    const reader = makeFrameReader(makeChunkReader([specimens[framing]]), {
      framing,
    });
    t.deepEqual(await collect(reader), ['hello']);
  });

  test(`${framing}: sniffing reader classifies and decodes across chunk boundaries`, async t => {
    await null;
    const wire = concatBytes([specimens[framing], specimens[framing]]);
    // An empty leading chunk, then one byte, then the rest split mid-frame.
    const chunks = [
      new Uint8Array(0),
      wire.subarray(0, 1),
      wire.subarray(1, 7),
      wire.subarray(7),
    ];
    const { framingChosen, reader } = makeSniffingFrameReader(
      makeChunkReader(chunks),
      { name: 'specimen' },
    );
    t.deepEqual(await collect(reader), ['hello', 'hello']);
    t.is(await framingChosen, framing);
  });
}

test('sniffing reader rejects an unrecognized first byte with the stream name', async t => {
  await null;
  const { framingChosen, reader } = makeSniffingFrameReader(
    makeChunkReader([encodeUtf8('{"type":"CTP_BOOTSTRAP"}')]),
    { name: 'specimen' },
  );
  const message =
    'Unrecognized framing: first byte 0x7b is neither a netstring length digit nor the cbor-frame tag-24 prefix at offset 0 of specimen';
  await t.throwsAsync(collect(reader), { message });
  await t.throwsAsync(framingChosen, { message });
});

test('sniffing reader ends cleanly on an empty stream and rejects the choice', async t => {
  await null;
  const { framingChosen, reader } = makeSniffingFrameReader(
    makeChunkReader([]),
    { name: 'specimen' },
  );
  t.deepEqual(await collect(reader), []);
  await t.throwsAsync(framingChosen, {
    message: 'Stream specimen ended before its first frame',
  });
});

test('gated writer holds writes until the framing is chosen', async t => {
  const { writer, bytes } = makeCollectingWriter();
  const { promise: chosen, resolve } = makePromiseKit();
  const gated = makeGatedFrameWriter(
    writer,
    /** @type {Promise<FramingName>} */ (chosen),
  );
  const written = gated.next(hello);
  await null;
  t.is(bytes().length, 0, 'nothing reaches the wire before the choice');
  resolve('cbor-frame');
  await written;
  t.deepEqual([...bytes()], [...specimens['cbor-frame']]);
});

test('gated writer closes without waiting for a choice that never comes', async t => {
  const { writer, isClosed } = makeCollectingWriter();
  const gated = makeGatedFrameWriter(writer, new Promise(() => {}));
  await gated.return(undefined);
  t.true(isClosed());
});

test('gated writer rejects writes when the choice rejects', async t => {
  const { writer } = makeCollectingWriter();
  const gated = makeGatedFrameWriter(
    writer,
    Promise.reject(Error('no first frame')),
  );
  await t.throwsAsync(gated.next(hello), { message: 'no first frame' });
});

// Matrix: each initiator framing against the bilingual accepter, and
// against a same-framing accepter as the control. The initiator's reader
// expects its own framing, so a session completes only if the accepter
// mirrors the initiator's framing on its outbound frames.
for (const framing of framings) {
  for (const accepter of ['sniffing', 'same-framing']) {
    test(`CapTP: ${framing} initiator against ${accepter} accepter`, async t => {
      await null;
      /** @type {any[]} */
      const [clientToServer, serverFromClient] = makePipe();
      /** @type {any[]} */
      const [serverToClient, clientFromServer] = makePipe();
      /** @type {Promise<void>} */
      const cancelled = new Promise(() => {});
      const bootstrap = Far('bootstrap', { hello: () => 'hi' });

      /** @type {Promise<FramingName> | undefined} */
      let framingChosen;
      if (accepter === 'sniffing') {
        ({ framingChosen } = makeSniffingCapTP(
          'server',
          serverToClient,
          serverFromClient,
          cancelled,
          bootstrap,
        ));
      } else {
        makeFramedCapTP(
          framing,
          'server',
          serverToClient,
          serverFromClient,
          cancelled,
          bootstrap,
        );
      }
      const client = makeFramedCapTP(
        framing,
        'client',
        clientToServer,
        clientFromServer,
        cancelled,
        undefined,
      );

      t.is(await E(client.getBootstrap()).hello(), 'hi');
      if (framingChosen !== undefined) {
        t.is(await framingChosen, framing);
      }
    });
  }
}
