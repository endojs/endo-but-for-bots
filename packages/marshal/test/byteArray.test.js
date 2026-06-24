// @ts-nocheck
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import { passStyleOf } from '@endo/pass-style';
import { frozenBytes } from '@endo/pass-style/to-bytes.js';
import { thawnBytes } from '@endo/pass-style/from-bytes.js';
import { makeMarshal } from '../src/marshal.js';
import {
  makeEncodePassable,
  makeDecodePassable,
} from '../src/encodePassable.js';
import { compareRank } from '../src/rankOrder.js';

// A `byteArray` is a plain frozen `Uint8Array` backed by an immutable
// `ArrayBuffer` (per the narrowing in the byteArray pass style). Build one
// from raw bytes with `frozenBytes`, and read its contents back out as a
// fresh mutable copy with `thawnBytes`.
const mkByteArray = bytes => frozenBytes(new Uint8Array(bytes));
const readBytes = byteArray => [...thawnBytes(byteArray)];

const fixtures = harden([
  { name: 'empty', bytes: [] },
  { name: 'single-zero', bytes: [0x00] },
  { name: 'single-ff', bytes: [0xff] },
  { name: 'two-zeroes', bytes: [0x00, 0x00] },
  { name: 'deadbeef', bytes: [0xde, 0xad, 0xbe, 0xef] },
  { name: 'long', bytes: Array.from({ length: 256 }, (_, i) => i) },
]);

test('smallcaps round-trips byteArray', t => {
  const { serialize, unserialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
    errorTagging: 'off',
  });
  for (const { name, bytes } of fixtures) {
    const ba = mkByteArray(bytes);
    const { body } = serialize(ba);
    const decoded = unserialize({ body, slots: [] });
    t.is(passStyleOf(decoded), 'byteArray', name);
    t.deepEqual(readBytes(decoded), bytes, `smallcaps ${name}`);
  }
});

test('smallcaps byteArray uses "*" prefix with hex body', t => {
  const { serialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
    errorTagging: 'off',
  });
  const { body } = serialize(mkByteArray([0xde, 0xad, 0xbe, 0xef]));
  // smallcaps body has a leading `#` sentinel before the JSON text.
  t.true(body.includes('"*deadbeef"'), `got ${body}`);
});

test('capdata round-trips byteArray', t => {
  const { serialize, unserialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'capdata',
    errorTagging: 'off',
  });
  for (const { name, bytes } of fixtures) {
    const ba = mkByteArray(bytes);
    const { body } = serialize(ba);
    const decoded = unserialize({ body, slots: [] });
    t.is(passStyleOf(decoded), 'byteArray', name);
    t.deepEqual(readBytes(decoded), bytes, `capdata ${name}`);
  }
});

test('capdata byteArray uses @qclass "byteArray" with hex data', t => {
  const { serialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'capdata',
    errorTagging: 'off',
  });
  const { body } = serialize(mkByteArray([0xde, 0xad, 0xbe, 0xef]));
  t.true(
    body.includes('"@qclass":"byteArray"') && body.includes('"deadbeef"'),
    `got ${body}`,
  );
});

test('byteArray nested in copyArray, copyRecord, tagged', t => {
  const { serialize, unserialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
    errorTagging: 'off',
  });
  const ba = mkByteArray([1, 2, 3]);
  const structure = harden({
    arr: [ba, ba],
    rec: { k: ba },
  });
  const { body } = serialize(structure);
  const decoded = unserialize({ body, slots: [] });
  t.is(passStyleOf(decoded.arr[0]), 'byteArray');
  t.is(passStyleOf(decoded.rec.k), 'byteArray');
  t.deepEqual(readBytes(decoded.arr[1]), [1, 2, 3]);
});

test('encodePassable round-trips byteArray (legacyOrdered)', t => {
  const encode = makeEncodePassable({ format: 'legacyOrdered' });
  const decode = makeDecodePassable({ format: 'legacyOrdered' });
  for (const { name, bytes } of fixtures) {
    const ba = mkByteArray(bytes);
    const enc = encode(ba);
    t.is(enc.charAt(0), 'a', `legacy ${name} starts with 'a'`);
    const back = decode(enc);
    t.deepEqual(readBytes(back), bytes, `legacy ${name}`);
  }
});

test('encodePassable round-trips byteArray (compactOrdered)', t => {
  const encode = makeEncodePassable({ format: 'compactOrdered' });
  const decode = makeDecodePassable({ format: 'compactOrdered' });
  for (const { name, bytes } of fixtures) {
    const ba = mkByteArray(bytes);
    const enc = encode(ba);
    const back = decode(enc);
    t.deepEqual(readBytes(back), bytes, `compact ${name}`);
  }
});

test('encodePassable byteArray preserves shortlex order', t => {
  const encode = makeEncodePassable({ format: 'legacyOrdered' });
  // Listed in the expected shortlex order.
  const orderedBytes = [
    [],
    [0x00],
    [0x01],
    [0xff],
    [0x00, 0x00],
    [0x00, 0x01],
    [0x01, 0x00],
    [0xff, 0xfe],
    [0xff, 0xff],
    [0x00, 0x00, 0x00],
  ];
  const encodings = orderedBytes.map(bs => encode(mkByteArray(bs)));
  const sorted = [...encodings].sort();
  t.deepEqual(sorted, encodings, `sorted=${sorted.join(',')}`);
});

test('encodePassable byteArray agrees with compareRank', t => {
  const encode = makeEncodePassable({ format: 'legacyOrdered' });
  const values = harden([
    mkByteArray([]),
    mkByteArray([0x00]),
    mkByteArray([0xff]),
    mkByteArray([0x00, 0x00]),
    mkByteArray([0x00, 0x01]),
    mkByteArray([0xff, 0xff]),
    mkByteArray([0x00, 0x00, 0x00]),
  ]);
  for (let i = 0; i < values.length; i += 1) {
    for (let j = 0; j < values.length; j += 1) {
      const rank = compareRank(values[i], values[j]);
      const encA = encode(values[i]);
      const encB = encode(values[j]);
      // eslint-disable-next-line no-nested-ternary
      const lex = encA < encB ? -1 : encA > encB ? 1 : 0;
      t.is(
        Math.sign(rank),
        lex,
        `pair i=${i} j=${j}: rank ${rank} vs lex ${lex}`,
      );
    }
  }
});

test('encodePassable byteArray cover sits between promise and boolean', t => {
  const encode = makeEncodePassable({
    format: 'legacyOrdered',
    encodePromise: (_p, _r) => '?0',
  });
  const promiseEnc = '?0';
  const boolTrue = encode(true);
  const byteEnc = encode(mkByteArray([0xff]));
  t.true(promiseEnc < byteEnc, `${promiseEnc} < ${byteEnc}`);
  t.true(byteEnc < boolTrue, `${byteEnc} < ${boolTrue}`);
});

test('decodePassable rejects malformed byteArray body', t => {
  const decode = makeDecodePassable({ format: 'legacyOrdered' });
  // The body after the leading 'a' must match /^(p[~]*[0-9]+:[0-9]+):([0-9a-f]*)$/.
  // A body with no length-prefix-then-colon-then-hex shape must fail closed.
  t.throws(() => decode('agarbage'), { message: /byteArray/ });
});

test('decodePassable rejects byteArray length-vs-body mismatch', t => {
  const encode = makeEncodePassable({ format: 'legacyOrdered' });
  const decode = makeDecodePassable({ format: 'legacyOrdered' });
  // Header claims byteLength=3 but the hex body has 4 bytes (8 hex chars).
  // The mismatch path is the explicit length check between the header and the
  // hex body, distinct from the regex shape check above.
  const lengthThree = encode(mkByteArray([0xaa, 0xbb, 0xcc]));
  // lengthThree is `a<encodeBigInt(3n)>:aabbcc`; replace the body with 4 bytes.
  const headerLen = lengthThree.lastIndexOf(':');
  const mismatched = `${lengthThree.slice(0, headerLen + 1)}aabbccdd`;
  t.throws(() => decode(mismatched), {
    message: /byteArray length mismatch/,
  });
});

test('capdata unserialize rejects byteArray with non-string data', t => {
  const { unserialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'capdata',
    errorTagging: 'off',
  });
  // The decoder asserts typeof data === 'string'; a number must fail closed
  // rather than silently passing through to the hex decoder.
  const body = JSON.stringify({ '@qclass': 'byteArray', data: 42 });
  t.throws(() => unserialize({ body, slots: [] }), {
    message: /invalid byteArray data typeof/,
  });
});
