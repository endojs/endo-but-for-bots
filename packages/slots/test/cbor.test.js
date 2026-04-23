// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  makeWriter,
  writerToBytes,
  writeUint,
  writeByteString,
  writeArrayHeader,
  writeNull,
  makeReader,
  readUint,
  readByteString,
  readArrayHeader,
  readNullOrPeek,
  assertConsumed,
} from '../src/cbor.js';

/**
 * Build bytes by running writer fns in sequence and returning the
 * finalised Uint8Array.
 *
 * @param {((w: import('../src/cbor.js').Writer) => void)[]} fns
 */
const build = fns => {
  const w = makeWriter();
  for (const fn of fns) fn(w);
  return [...writerToBytes(w)];
};

test('uint — canonical minimal-head encoding', t => {
  t.deepEqual(build([w => writeUint(w, 0)]), [0x00]);
  t.deepEqual(build([w => writeUint(w, 23)]), [0x17]);
  t.deepEqual(build([w => writeUint(w, 24)]), [0x18, 0x18]);
  t.deepEqual(build([w => writeUint(w, 255)]), [0x18, 0xff]);
  t.deepEqual(build([w => writeUint(w, 256)]), [0x19, 0x01, 0x00]);
  t.deepEqual(build([w => writeUint(w, 0xffff)]), [0x19, 0xff, 0xff]);
  t.deepEqual(
    build([w => writeUint(w, 0x10000)]),
    [0x1a, 0x00, 0x01, 0x00, 0x00],
  );
  t.deepEqual(
    build([w => writeUint(w, 0xffffffff)]),
    [0x1a, 0xff, 0xff, 0xff, 0xff],
  );
});

test('uint large — 53-bit safe integer', t => {
  // 2^32 encodes as [0x1b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]
  t.deepEqual(
    build([w => writeUint(w, 2 ** 32)]),
    [0x1b, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00],
  );
  // MAX_SAFE_INTEGER = 2^53 - 1 = 0x001f_ffff_ffff_ffff
  t.deepEqual(
    build([w => writeUint(w, Number.MAX_SAFE_INTEGER)]),
    [0x1b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
  );
});

test('uint — rejects negative and unsafe values', t => {
  t.throws(() => build([w => writeUint(w, -1)]), {
    message: /non-negative/,
  });
  t.throws(() => build([w => writeUint(w, Number.MAX_SAFE_INTEGER + 1)]), {
    message: /safe-integer/,
  });
});

test('byte string — header + body', t => {
  t.deepEqual(
    build([w => writeByteString(w, new Uint8Array([1, 2, 3]))]),
    [0x43, 0x01, 0x02, 0x03],
  );
  t.deepEqual(build([w => writeByteString(w, new Uint8Array(0))]), [0x40]);
});

test('array header — minimal-head', t => {
  t.deepEqual(build([w => writeArrayHeader(w, 0)]), [0x80]);
  t.deepEqual(build([w => writeArrayHeader(w, 2)]), [0x82]);
  t.deepEqual(build([w => writeArrayHeader(w, 23)]), [0x97]);
  t.deepEqual(build([w => writeArrayHeader(w, 24)]), [0x98, 0x18]);
});

test('null — single-byte 0xf6', t => {
  t.deepEqual(build([w => writeNull(w)]), [0xf6]);
});

test('reader — roundtrip uint', t => {
  const w = makeWriter();
  writeUint(w, 0);
  writeUint(w, 23);
  writeUint(w, 24);
  writeUint(w, 0xffff);
  writeUint(w, 2 ** 40);
  const r = makeReader(writerToBytes(w));
  t.is(readUint(r), 0);
  t.is(readUint(r), 23);
  t.is(readUint(r), 24);
  t.is(readUint(r), 0xffff);
  t.is(readUint(r), 2 ** 40);
  assertConsumed(r);
});

test('reader — roundtrip byte string', t => {
  const body = new Uint8Array([9, 8, 7, 6, 5]);
  const w = makeWriter();
  writeByteString(w, body);
  const r = makeReader(writerToBytes(w));
  t.deepEqual([...readByteString(r)], [...body]);
  assertConsumed(r);
});

test('reader — array header', t => {
  const w = makeWriter();
  writeArrayHeader(w, 3);
  const r = makeReader(writerToBytes(w));
  t.is(readArrayHeader(r), 3);
});

test('reader — null peek', t => {
  const w = makeWriter();
  writeNull(w);
  const r = makeReader(writerToBytes(w));
  t.true(readNullOrPeek(r));
  assertConsumed(r);
});

test('reader — non-null peek does not advance', t => {
  const w = makeWriter();
  writeUint(w, 5);
  const r = makeReader(writerToBytes(w));
  t.false(readNullOrPeek(r));
  t.is(readUint(r), 5);
});

test('reader — rejects trailing bytes in assertConsumed', t => {
  const r = makeReader(new Uint8Array([0x00, 0x00]));
  readUint(r);
  t.throws(() => assertConsumed(r), { message: /trailing byte/ });
});

test('reader — rejects EOF', t => {
  const r = makeReader(new Uint8Array(0));
  t.throws(() => readUint(r), { message: /EOF/ });
});

test('reader — rejects wrong major', t => {
  const r = makeReader(new Uint8Array([0x40]));
  t.throws(() => readUint(r), { message: /expected uint/ });
});
