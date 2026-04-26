// @ts-nocheck
import test from '@endo/ses-ava/test.js';

import harden from '@endo/harden';
import {
  byteArrayToUint8Array,
  makeTagged,
  passStyleOf,
  uint8ArrayToByteArray,
} from '@endo/pass-style';
import { makeMarshal } from '../src/marshal.js';
import {
  makeEncodePassable,
  makeDecodePassable,
} from '../src/encodePassable.js';
import { compareRank, getPassStyleCover } from '../src/rankOrder.js';

const mkByteArray = bytes => uint8ArrayToByteArray(new Uint8Array(bytes));

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
    t.deepEqual(
      [...byteArrayToUint8Array(decoded)],
      bytes,
      `smallcaps ${name}`,
    );
  }
});

test('smallcaps byteArray uses "*" prefix with hex body', t => {
  const { serialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
    errorTagging: 'off',
  });
  const { body } = serialize(mkByteArray([0xde, 0xad, 0xbe, 0xef]));
  // smallcaps body is a leading `#` sentinel followed by JSON-encoded text.
  t.is(body, '#"*deadbeef"');
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
    t.deepEqual([...byteArrayToUint8Array(decoded)], bytes, `capdata ${name}`);
  }
});

test('capdata byteArray uses @qclass "byteArray" with hex data', t => {
  const { serialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'capdata',
    errorTagging: 'off',
  });
  const { body } = serialize(mkByteArray([0xde, 0xad, 0xbe, 0xef]));
  t.is(body, '{"@qclass":"byteArray","data":"deadbeef"}');
});

const checkNested = (t, format) => {
  const { serialize, unserialize } = makeMarshal(undefined, undefined, {
    serializeBodyFormat: format,
    errorTagging: 'off',
  });
  const ba = mkByteArray([1, 2, 3]);
  const structure = harden({
    arr: [ba, ba],
    rec: { k: ba },
    tagged: makeTagged('myTag', ba),
  });
  const { body } = serialize(structure);
  const decoded = unserialize({ body, slots: [] });
  t.is(passStyleOf(decoded.arr[0]), 'byteArray', `${format} arr`);
  t.is(passStyleOf(decoded.rec.k), 'byteArray', `${format} rec`);
  t.is(passStyleOf(decoded.tagged), 'tagged', `${format} tagged`);
  t.deepEqual([...byteArrayToUint8Array(decoded.arr[1])], [1, 2, 3]);
  t.deepEqual([...byteArrayToUint8Array(decoded.rec.k)], [1, 2, 3]);
  t.deepEqual([...byteArrayToUint8Array(decoded.tagged.payload)], [1, 2, 3]);
};

test('byteArray nested in copyArray, copyRecord, tagged (smallcaps)', t => {
  checkNested(t, 'smallcaps');
});

test('byteArray nested in copyArray, copyRecord, tagged (capdata)', t => {
  checkNested(t, 'capdata');
});

test('cross-codec interop: smallcaps and capdata agree on round-trip bytes', t => {
  const original = mkByteArray([
    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
  ]);
  const sc = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'smallcaps',
    errorTagging: 'off',
  });
  const cd = makeMarshal(undefined, undefined, {
    serializeBodyFormat: 'capdata',
    errorTagging: 'off',
  });
  // smallcaps -> bytes -> capdata -> bytes
  const fromSmallcaps = sc.unserialize(sc.serialize(original));
  const reEncoded = cd.serialize(fromSmallcaps);
  const round = cd.unserialize(reEncoded);
  t.deepEqual(
    [...byteArrayToUint8Array(round)],
    [...byteArrayToUint8Array(original)],
  );
});

test('encodePassable round-trips byteArray (legacyOrdered)', t => {
  const encode = makeEncodePassable({ format: 'legacyOrdered' });
  const decode = makeDecodePassable({ format: 'legacyOrdered' });
  for (const { name, bytes } of fixtures) {
    const ba = mkByteArray(bytes);
    const enc = encode(ba);
    t.is(enc.charAt(0), 'a', `legacy ${name} starts with 'a'`);
    const back = decode(enc);
    t.deepEqual([...byteArrayToUint8Array(back)], bytes, `legacy ${name}`);
  }
});

test('encodePassable round-trips byteArray (compactOrdered)', t => {
  const encode = makeEncodePassable({ format: 'compactOrdered' });
  const decode = makeDecodePassable({ format: 'compactOrdered' });
  for (const { name, bytes } of fixtures) {
    const ba = mkByteArray(bytes);
    const enc = encode(ba);
    const back = decode(enc);
    t.deepEqual([...byteArrayToUint8Array(back)], bytes, `compact ${name}`);
  }
});

test('encodePassable byteArray preserves shortlex order', t => {
  const encode = makeEncodePassable({ format: 'legacyOrdered' });
  // Listed in the expected shortlex order, including pairs that straddle
  // Elias-delta length-encoding boundaries (1↔2 digit length count and
  // 2↔3 digit length count) to nail down the cross-class invariant.
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
    Array.from({ length: 9 }, () => 0),
    Array.from({ length: 9 }, () => 0xff),
    Array.from({ length: 10 }, () => 0),
    Array.from({ length: 99 }, () => 0xff),
    Array.from({ length: 100 }, () => 0),
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

test('getPassStyleCover("byteArray") yields the ["a", "b") interval', t => {
  const [low, high] = getPassStyleCover('byteArray');
  t.is(low, 'a');
  t.is(high, 'b');
});
