// @ts-nocheck
/* global setTimeout */

import '@endo/init/debug.js';

import test from 'ava';
import { makePipe, mapReader } from '@endo/stream';
import { concatBytes } from '@endo/bytes/concat.js';
import { makeCborFrameReader } from '../src/decode.js';
import { makeCborFrameWriter } from '../src/encode.js';
import {
  encodeByteStringHead,
  decodeByteStringHead,
  headLengthFor,
  TAG_24_PREFIX,
} from '../src/head.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const drain = async source => {
  const array = [];
  for await (const chunk of source) {
    array.push(chunk.slice());
  }
  return array;
};

test('headLengthFor matches CBOR boundaries', t => {
  t.is(headLengthFor(0), 1);
  t.is(headLengthFor(23), 1);
  t.is(headLengthFor(24), 2);
  t.is(headLengthFor(255), 2);
  t.is(headLengthFor(256), 3);
  t.is(headLengthFor(0xffff), 3);
  t.is(headLengthFor(0x1_0000), 5);
  t.is(headLengthFor(0xffff_ffff), 5);
  t.is(headLengthFor(0x1_0000_0000), 9);
});

test('encodeByteStringHead produces canonical shortest forms', t => {
  // 1-byte head: argument inline.
  t.deepEqual(encodeByteStringHead(0), new Uint8Array([0x40]));
  t.deepEqual(encodeByteStringHead(5), new Uint8Array([0x45]));
  t.deepEqual(encodeByteStringHead(23), new Uint8Array([0x57]));
  // 2-byte head: 0x58 + uint8.
  t.deepEqual(encodeByteStringHead(24), new Uint8Array([0x58, 24]));
  t.deepEqual(encodeByteStringHead(255), new Uint8Array([0x58, 0xff]));
  // 3-byte head: 0x59 + uint16 BE.
  t.deepEqual(encodeByteStringHead(256), new Uint8Array([0x59, 0x01, 0x00]));
  t.deepEqual(encodeByteStringHead(0xffff), new Uint8Array([0x59, 0xff, 0xff]));
  // 5-byte head: 0x5a + uint32 BE.
  t.deepEqual(
    encodeByteStringHead(0x1_0000),
    new Uint8Array([0x5a, 0x00, 0x01, 0x00, 0x00]),
  );
  t.deepEqual(
    encodeByteStringHead(0xffff_ffff),
    new Uint8Array([0x5a, 0xff, 0xff, 0xff, 0xff]),
  );
  // 9-byte head: 0x5b + uint64 BE.
  t.deepEqual(
    encodeByteStringHead(0x1_0000_0000),
    new Uint8Array([0x5b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
  );
});

test('encodeByteStringHead rejects non-integer and negative lengths', t => {
  t.throws(() => encodeByteStringHead(-1));
  t.throws(() => encodeByteStringHead(1.5));
  t.throws(() => encodeByteStringHead(NaN));
});

test('decodeByteStringHead round-trips canonical heads (tag-24-wrapped)', t => {
  for (const len of [0, 1, 23, 24, 255, 256, 0xffff, 0x1_0000, 0xffff_ffff]) {
    const head = concatBytes([TAG_24_PREFIX, encodeByteStringHead(len)]);
    const decoded = decodeByteStringHead(head);
    t.deepEqual(decoded, {
      length: len,
      headLength: head.length,
    });
  }
});

test('decodeByteStringHead returns undefined when buffer too short', t => {
  t.is(decodeByteStringHead(new Uint8Array(0)), undefined);
  // tag-24 initial byte but nothing else:
  t.is(decodeByteStringHead(new Uint8Array([0xd8])), undefined);
  // tag-24 wrapper but no byte-string head byte:
  t.is(decodeByteStringHead(new Uint8Array([0xd8, 0x18])), undefined);
  // tag-24 wrapper plus 2-byte-head initial but missing follow byte:
  t.is(decodeByteStringHead(new Uint8Array([0xd8, 0x18, 0x58])), undefined);
  // tag-24 wrapper plus 9-byte-head initial but missing 8-byte follow:
  t.is(
    decodeByteStringHead(new Uint8Array([0xd8, 0x18, 0x5b, 0, 0])),
    undefined,
  );
});

test('decodeByteStringHead rejects missing tag-24 prefix', t => {
  // Any initial byte other than 0xd8 fails the mandatory tag-24 check.
  t.throws(() => decodeByteStringHead(new Uint8Array([0x40])), {
    message: /mandatory tag-24/,
  });
});

test('decodeByteStringHead rejects wrong major type inside tag 24', t => {
  // Tag 24 prefix then the rejected major-type initial byte.
  // Major type 0 (unsigned int): 0x00.
  t.throws(() => decodeByteStringHead(new Uint8Array([0xd8, 0x18, 0x00])), {
    message: /major type 2/,
  });
  // Major type 3 (text string): 0x60.
  t.throws(() => decodeByteStringHead(new Uint8Array([0xd8, 0x18, 0x60])));
  // Major type 4 (array): 0x80.
  t.throws(() => decodeByteStringHead(new Uint8Array([0xd8, 0x18, 0x80])));
});

test('decodeByteStringHead rejects indefinite-length byte string', t => {
  // Tag 24 prefix then the indefinite-length byte-string initial.
  t.throws(() => decodeByteStringHead(new Uint8Array([0xd8, 0x18, 0x5f])), {
    message: /indefinite/,
  });
});

test('decodeByteStringHead rejects reserved additional-info 28-30', t => {
  // RFC 8949 § 3: additional-info values 28, 29 and 30 are reserved and
  // carry no defined argument. Inside tag 24 the byte-string initial
  // bytes are 0x40 + arg: 0x5c, 0x5d, 0x5e.
  for (const initial of [0x5c, 0x5d, 0x5e]) {
    t.throws(
      () => decodeByteStringHead(new Uint8Array([0xd8, 0x18, initial])),
      {
        message: /reserved additional-info/,
      },
    );
  }
});

test('decodeByteStringHead rejects tag other than 24', t => {
  // 0xd8 names "tag with one follow byte"; 0x19 is not 24.
  t.throws(() => decodeByteStringHead(new Uint8Array([0xd8, 0x19, 0x40])), {
    message: /tag 24/,
  });
});

// Bridge the writer's output to a snapshotting reader: `makePipe()` gives a
// writer/reader pair sharing one async queue; `mapReader` runs its transform
// synchronously between pulling each chunk and yielding it, so the slice
// happens before the writer can return to the event loop and overwrite the
// buffer it just passed. The `array` view collects snapshots eagerly via a
// background drain so tests can assert on chunk shape after `writer.return()`
// resolves.
const makeArrayWriter = opts => {
  const array = [];
  const [pipeWriter, pipeReader] = makePipe();
  const snapshotReader = mapReader(pipeReader, chunk => {
    const snapshot = chunk.slice();
    array.push(snapshot);
    return snapshot;
  });
  const drained = (async () => {
    for await (const _ of snapshotReader) {
      // Snapshot is committed in the transform; nothing to do here.
    }
  })();
  // Surface drain-task rejections rather than swallowing them.
  drained.catch(() => {});
  const writer = makeCborFrameWriter(pipeWriter, opts);
  return { array, writer, drained };
};

const delay = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

const roundTripLengths = async (t, opts) => {
  await null;
  // Cover each head-length boundary, including just-over each break.
  const lengths = [0, 1, 23, 24, 25, 255, 256, 257, 0xffff, 0x1_0000];
  const messages = lengths.map(len => {
    const buf = new Uint8Array(len);
    // Fill with a pattern that exercises every byte position.
    for (let i = 0; i < len; i += 1) {
      buf[i] = (i * 31 + 7) % 256;
    }
    return buf;
  });

  const { array, writer } = makeArrayWriter(opts);
  for (const m of messages) {
    // eslint-disable-next-line no-await-in-loop
    await writer.next(m);
  }
  await writer.return();

  const got = await drain(makeCborFrameReader(array));
  t.deepEqual(
    got.map(b => Array.from(b)),
    messages.map(b => Array.from(b)),
  );
};

test('round-trip across each head boundary (plain)', roundTripLengths);

test('round-trip across each head boundary (chunked)', roundTripLengths, {
  chunked: true,
});

test('round-trip short text messages (canonical inline head)', async t => {
  const { array, writer } = makeArrayWriter();
  await writer.next(encoder.encode(''));
  await writer.next(encoder.encode('A'));
  await writer.next(encoder.encode('hello'));
  await writer.return();

  // Verify the on-the-wire byte pattern explicitly: each frame is the
  // mandatory tag-24 prefix (0xd8 0x18) plus the byte-string head
  // (0x40 + length, for these short payloads) plus the payload bytes,
  // with no separator.
  const all = concatBytes(array);
  t.deepEqual(Array.from(all), [
    0xd8,
    0x18,
    0x40, // ""
    0xd8,
    0x18,
    0x41,
    0x41, // "A"
    0xd8,
    0x18,
    0x45,
    0x68,
    0x65,
    0x6c,
    0x6c,
    0x6f, // "hello"
  ]);

  const got = await drain(makeCborFrameReader(array));
  t.deepEqual(
    got.map(b => decoder.decode(b)),
    ['', 'A', 'hello'],
  );
});

test('tag-24 wire bytes match the design specimen', async t => {
  const { array, writer } = makeArrayWriter();
  await writer.next(encoder.encode('hello'));
  await writer.next(encoder.encode('A'));
  await writer.return();

  const all = concatBytes(array);
  t.deepEqual(
    Array.from(all),
    [0xd8, 0x18, 0x45, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xd8, 0x18, 0x41, 0x41],
  );
});

const readChunkedFrames = async (t, chunks, expected) => {
  const reader = makeCborFrameReader(chunks.map(c => new Uint8Array(c)));
  const got = await drain(reader);
  t.deepEqual(
    got.map(b => Array.from(b)),
    expected.map(b => Array.from(b)),
  );
};

test('read frames split across chunk boundaries (tag-24 prefix split)', t =>
  readChunkedFrames(
    t,
    [
      // tag-24 prefix split across the boundary, then 2-byte head + 24 payload
      [0xd8],
      [0x18, 0x58, 24],
      Array.from({ length: 24 }, (_v, i) => i),
    ],
    [new Uint8Array(24).map((_v, i) => i)],
  ));

test('read frames split across chunk boundaries (head split)', t =>
  readChunkedFrames(
    t,
    [
      // tag-24 prefix + 2-byte head initial in one chunk, follow byte alone,
      // payload separately
      [0xd8, 0x18, 0x58],
      [24],
      Array.from({ length: 24 }, (_v, i) => i),
    ],
    [new Uint8Array(24).map((_v, i) => i)],
  ));

test('read frames split across chunk boundaries (payload split)', t =>
  readChunkedFrames(
    t,
    [
      // tag-24 prefix + head + first 3 payload bytes
      [0xd8, 0x18, 0x45, 0x68, 0x65],
      [0x6c, 0x6c, 0x6f],
    ],
    [encoder.encode('hello')],
  ));

test('read multiple frames divided over chunk boundaries', t =>
  readChunkedFrames(
    t,
    [
      // tag24 + head + "hello", then tag24 + head + "w"
      [0xd8, 0x18, 0x45, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xd8, 0x18, 0x45, 0x77],
      // "orld" + tag24 + head + "A"
      [0x6f, 0x72, 0x6c, 0x64, 0xd8, 0x18, 0x41, 0x41],
    ],
    [encoder.encode('hello'), encoder.encode('world'), encoder.encode('A')],
  ));

test('head cache resets between frames across a straddled residual head', t => {
  // Frame 1 is a 30-byte payload (a 2-byte extended head) delivered one byte
  // at a time; its final byte shares a chunk with the first two bytes of the
  // next frame's head. Frame 2's head therefore straddles the residual suffix
  // left by frame 1, exercising the multi-chunk head probe, and its fresh
  // decode locks the head-cache reset between frames.
  const payload1 = Array.from({ length: 30 }, (_v, i) => (i * 7 + 3) % 256);
  const chunks = [
    [0xd8],
    [0x18],
    [0x58],
    [30],
    ...payload1.slice(0, 29).map(b => [b]),
    // The last payload byte arrives with the start of frame 2's tag-24 head.
    [payload1[29], 0xd8, 0x18],
    // The rest of frame 2's head (byte-string head 0x42, "hi") arrives next,
    // so the probe must concatenate the residual suffix with this chunk.
    [0x42, 0x68, 0x69],
  ];
  return readChunkedFrames(t, chunks, [
    new Uint8Array(payload1),
    encoder.encode('hi'),
  ]);
});

test('error wording includes name and offset', async t => {
  // Tag-24 prefix plus a head declaring 5 payload bytes, but only one
  // payload byte arrives.
  const reader = makeCborFrameReader(
    [new Uint8Array([0xd8, 0x18, 0x45, 0x68])],
    { name: 'my-stream' },
  );
  await t.throwsAsync(() => drain(reader), {
    message: /Unexpected dangling message at offset 0 of my-stream/,
  });
});

test('truncated head throws with name and offset', async t => {
  // Tag-24 prefix plus 2-byte-head initial, but follow byte is absent.
  const reader = makeCborFrameReader([new Uint8Array([0xd8, 0x18, 0x58])], {
    name: 'truncated-head',
  });
  await t.throwsAsync(() => drain(reader), {
    message: /Unexpected dangling message at offset 0 of truncated-head/,
  });
});

test('reader rejects head declaring length above maxMessageLength', async t => {
  // Tag-24 prefix plus a head naming a 50-byte payload; cap is 20.
  const reader = makeCborFrameReader(
    [
      new Uint8Array([0xd8, 0x18, 0x58, 50]),
      // Note: we do NOT supply the 50 payload bytes; the reader must
      // throw before waiting for them.
    ],
    { name: 'capped', maxMessageLength: 20 },
  );
  await t.throwsAsync(() => drain(reader), {
    message: /CBOR message too big.*max 20.*offset 0 of capped/,
  });
});

test('reader rejects bad initial byte with name and offset', async t => {
  // First frame OK (tag-24 + 2-byte head + 2-byte payload = 5 bytes),
  // then a major-type-0 byte at offset 5 fails the mandatory tag-24
  // check.
  const reader = makeCborFrameReader(
    [new Uint8Array([0xd8, 0x18, 0x42, 0x41, 0x42, 0x00])],
    { name: 'bad-initial' },
  );
  await t.throwsAsync(() => drain(reader), {
    message: /mandatory tag-24.*offset 5 of bad-initial/,
  });
});

test('writer rejects messages larger than maxMessageLength', async t => {
  const { writer } = makeArrayWriter({ maxMessageLength: 5, name: 'sender' });
  await t.throwsAsync(() => writer.next(new Uint8Array(6)), {
    message: /CBOR message too big.*max 5.*sender/,
  });
});

test('round-trip exactly at maxMessageLength succeeds', async t => {
  const { array, writer } = makeArrayWriter({ maxMessageLength: 10 });
  const payload = new Uint8Array(10).map((_v, i) => i + 1);
  await writer.next(payload);
  await writer.return();
  const got = await drain(makeCborFrameReader(array, { maxMessageLength: 10 }));
  t.deepEqual(
    got.map(b => Array.from(b)),
    [Array.from(payload)],
  );
});

test('zero-length payload round-trips', async t => {
  const { array, writer } = makeArrayWriter();
  await writer.next(new Uint8Array(0));
  await writer.return();
  const got = await drain(makeCborFrameReader(array));
  t.is(got.length, 1);
  t.is(got[0].length, 0);
});

test('chunked write composes head and payload as separate parts', async t => {
  // With chunked: true, the tag-24 prefix, head, and each payload chunk
  // each go via their own output.next call. The wire form must still
  // concatenate to a valid frame.
  const { array, writer } = makeArrayWriter({ chunked: true });
  await writer.next(['hello', ' ', 'world'].map(s => encoder.encode(s)));
  await writer.return();

  // We expect exactly: TAG_24_PREFIX, head, 3 payload chunks = 5 writes.
  t.true(array.length >= 5);
  const got = await drain(makeCborFrameReader(array));
  t.deepEqual(
    got.map(b => decoder.decode(b)),
    ['hello world'],
  );
});

test('concurrent writes', async t => {
  const { array, writer } = makeArrayWriter();
  await Promise.all([
    writer.next(encoder.encode('')),
    writer.next(encoder.encode('A')),
    writer.next(encoder.encode('hello')),
    writer.return(),
  ]);

  const got = await drain(makeCborFrameReader(array));
  t.deepEqual(
    got.map(b => decoder.decode(b)),
    ['', 'A', 'hello'],
  );
});

test('writer propagates downstream close (chunked)', async t => {
  // The CBOR chunked writer issues one output.next per part: the
  // mandatory tag-24 prefix, the head, and each payload chunk (no
  // trailer; CBOR byte-string framing has none). With a two-chunk
  // message that is four writes per frame. Closing the pipe before any
  // of those writes lands should surface as a `done` result on
  // writer.next; closing only after every write has been absorbed
  // (count >= 4) leaves the writer with no close to observe.
  await null;
  for (let count = 0; count < 4; count += 1) {
    const pipe = makePipe();
    const writer = makeCborFrameWriter(pipe[1], { chunked: true });
    for (let i = 0; i < count; i += 1) {
      pipe[0].next();
    }
    pipe[0].return();
    // eslint-disable-next-line no-await-in-loop
    const { done } = await writer.next(
      ['Hello, ', 'World!\n'].map(s => encoder.encode(s)),
    );
    t.assert(done, `count=${count} should observe close`);
  }
});

test('round-trip varying messages over a live pipe', async t => {
  const payloads = [];
  payloads.push(new Uint8Array(0));
  payloads.push(new Uint8Array([42]));
  for (let i = 20; i < 30; i += 1) {
    const buf = new Uint8Array(i);
    for (let j = 0; j < i; j += 1) {
      buf[j] = j % 256;
    }
    payloads.push(buf);
  }
  // Cross a head-width boundary inside one stream.
  payloads.push(new Uint8Array(300));
  payloads.push(new Uint8Array(65_540));

  t.plan(payloads.length);

  const [input, output] = makePipe();
  const producer = (async () => {
    await null;
    const w = makeCborFrameWriter(output);
    for (const p of payloads) {
      // eslint-disable-next-line no-await-in-loop
      await w.next(p);
      // eslint-disable-next-line no-await-in-loop
      await delay(1);
    }
    await w.return();
  })();
  const consumer = (async () => {
    const r = makeCborFrameReader(input);
    let i = 0;
    for await (const got of r) {
      t.is(got.length, payloads[i].length);
      i += 1;
    }
  })();
  await Promise.all([producer, consumer]);
});

test('decodeByteStringHead rejects all non-byte-string major types inside tag 24', t => {
  // RFC 8949 § 3.1: eight major types in the top three bits of the
  // initial byte. Inside the mandatory tag-24 wrapper, only major 2
  // (byte string, 0x40-0x5f) is accepted by this framing reader.
  // Sample each rejected major type at its base initial byte, fed in
  // after the tag-24 prefix:
  //   major 0 (unsigned int):       0x00
  //   major 1 (negative int):       0x20
  //   major 3 (text string):        0x60
  //   major 4 (array):              0x80
  //   major 5 (map):                0xa0
  //   major 6 (tag, non-tag-24):    0xc0 (tag 0 inline)
  //   major 7 (simple/float):       0xe0
  const cases = [
    { byte: 0x00, major: 0 },
    { byte: 0x20, major: 1 },
    { byte: 0x60, major: 3 },
    { byte: 0x80, major: 4 },
    { byte: 0xa0, major: 5 },
    { byte: 0xc0, major: 6 },
    { byte: 0xe0, major: 7 },
  ];
  for (const { byte, major } of cases) {
    t.throws(() => decodeByteStringHead(new Uint8Array([0xd8, 0x18, byte])), {
      message: new RegExp(`major type ${major}`),
    });
  }
});

test('decodeByteStringHead accepts non-canonical (overlong) head encodings inside tag 24', t => {
  // RFC 8949 § 4.2 says encoders SHOULD emit shortest form, but the
  // generic decoder MAY accept non-canonical encodings. Our framing
  // reader accepts overlong forms so that a strictly-conforming peer
  // emitting a non-shortest head still interoperates. Document this
  // choice with explicit assertions for each over-wide form encoding
  // payload length 5 (which canonically fits in a 1-byte head), each
  // wrapped in the mandatory tag-24 prefix:
  //   2-byte:  0x58 0x05
  //   3-byte:  0x59 0x00 0x05
  //   5-byte:  0x5a 0x00 0x00 0x00 0x05
  //   9-byte:  0x5b 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x05
  const overlongBodies = [
    [0x58, 0x05],
    [0x59, 0x00, 0x05],
    [0x5a, 0x00, 0x00, 0x00, 0x05],
    [0x5b, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x05],
  ];
  for (const body of overlongBodies) {
    const head = new Uint8Array([0xd8, 0x18, ...body]);
    const decoded = decodeByteStringHead(head);
    t.deepEqual(decoded, {
      length: 5,
      headLength: head.length,
    });
  }
});

test('decodeByteStringHead rejects 9-byte head declaring length above 2^53-1', t => {
  // Builder explicitly bounded head-decoded lengths at
  // Number.MAX_SAFE_INTEGER (2^53 - 1). The 9-byte head carries an
  // unsigned 64-bit length argument; the reader splits it into hi
  // and lo 32-bit halves. Any hi32 above 0x1fffff guarantees the
  // total exceeds 2^53 - 1 (since 0x1fffff * 2^32 + 0xffffffff
  // equals exactly 2^53 - 1), so the fast-path check `hi > 0x1fffff`
  // is what bounds the decoder.
  //
  // Two cases:
  //   (a) hi32 just over the bound (0x00200000 = 0x1fffff + 1, lo 0):
  //       length would be 2^53 exactly. Caught by the fast path.
  //   (b) hi32 saturated to all-ones (0xffffffff, lo all-ones):
  //       length would be 2^64 - 1, the maximum a uint64 can express.
  //       Also caught by the fast path.
  const justOver = new Uint8Array([
    0xd8, 0x18, 0x5b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  t.throws(() => decodeByteStringHead(justOver), {
    message: /above 2\^53-1/,
  });
  const saturated = new Uint8Array([
    0xd8, 0x18, 0x5b, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  t.throws(() => decodeByteStringHead(saturated), {
    message: /above 2\^53-1/,
  });
  // Boundary sanity: hi32 = 0x1fffff, lo32 = 0xffffffff names
  // exactly Number.MAX_SAFE_INTEGER (2^53 - 1). This decode succeeds.
  // No useful Uint8Array of this size could be allocated, but the
  // head-level boundary holds strictly: the next integer up is only
  // reachable by incrementing hi32 into the rejected range, which
  // the fast path catches above.
  const atBound = new Uint8Array([
    0xd8, 0x18, 0x5b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  const decoded = decodeByteStringHead(atBound);
  t.is(decoded.length, Number.MAX_SAFE_INTEGER);
});

test('reader cancellation mid-payload closes the underlying input', async t => {
  // When a caller breaks from `for await (const frame of reader)` mid
  // way, the async iteration protocol calls `reader.return()`, which
  // exits the generator and calls `return()` on the upstream iterator.
  // Build an input iterator whose `return` is observable, drive it
  // through the reader, break out after the first frame, and confirm
  // the upstream `return` was called.
  let returnedCalled = false;
  let nextCount = 0;
  const chunks = [
    // frame 1: tag-24 + 1-byte head + payload "A"
    new Uint8Array([0xd8, 0x18, 0x41, 0x41]),
    // frame 2: tag-24 + 1-byte head + payload "B" (read if we did not break)
    new Uint8Array([0xd8, 0x18, 0x41, 0x42]),
  ];
  const trackedInput = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (nextCount >= chunks.length) {
        return { value: undefined, done: true };
      }
      const value = chunks[nextCount];
      nextCount += 1;
      return { value, done: false };
    },
    async return(value) {
      returnedCalled = true;
      return { value, done: true };
    },
  };
  const reader = makeCborFrameReader(trackedInput);
  // The intentional single-iteration break is the regression's whole
  // point: it exercises the for-await desugaring that routes into the
  // generator's `return` path.
  // eslint-disable-next-line no-unreachable-loop
  for await (const frame of reader) {
    t.is(frame.length, 1);
    t.is(frame[0], 0x41);
    break;
  }
  // The `for await ... break` desugars to a try/finally that invokes
  // reader.return(), which routes into the generator's finally and
  // (because it is using `for await` on `trackedInput`) drives a
  // matching `return` on the upstream iterator.
  t.true(
    returnedCalled,
    'breaking from for await on the reader must close the upstream iterator',
  );
});
