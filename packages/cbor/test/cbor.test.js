/* eslint-disable unicorn/numeric-separators-style */
import 'ses';
import test from 'ava';
import {
  assertConsumed,
  cborWriterBytes,
  makeCborReader,
  makeCborWriter,
  readArrayHeader,
  readBignum,
  readBoolean,
  readByteString,
  readFloat64,
  readHead,
  readInt,
  readMapHeader,
  readOptionalNull,
  readTag,
  readTextString,
  readUint,
  writeArrayHeader,
  writeBignum,
  writeBoolean,
  writeByteString,
  writeFloat64,
  writeInt,
  writeMapHeader,
  writeNull,
  writeTag,
  writeTextString,
  writeUint,
  writeUndefined,
} from '../index.js';

const hex = bytes =>
  [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
const unhex = value =>
  new Uint8Array(value.match(/../g).map(pair => Number.parseInt(pair, 16)));

test('canonical argument-width boundaries', t => {
  /** @type {Array<[number, string]>} */
  const cases = [
    [0, '00'],
    [23, '17'],
    [24, '1818'],
    [255, '18ff'],
    [256, '190100'],
    [65535, '19ffff'],
    [65536, '1a00010000'],
    [0xffffffff, '1affffffff'],
    [0x100000000, '1b0000000100000000'],
    [Number.MAX_SAFE_INTEGER, '1b001fffffffffffff'],
  ];
  for (const [value, expected] of cases) {
    const writer = makeCborWriter();
    writeUint(writer, value);
    t.is(hex(cborWriterBytes(writer)), expected);
    const reader = makeCborReader(unhex(expected), { name: 'boundary' });
    t.is(readUint(reader), value);
    assertConsumed(reader);
  }
});

test('all in-scope primitive major types', t => {
  const writer = makeCborWriter();
  writeInt(writer, -2);
  writeByteString(writer, new Uint8Array([1, 2]));
  writeTextString(writer, 'hi');
  writeArrayHeader(writer, 0);
  writeMapHeader(writer, 0);
  writeTag(writer, 280);
  writeBoolean(writer, false);
  writeBoolean(writer, true);
  writeNull(writer);
  writeUndefined(writer);
  const reader = makeCborReader(cborWriterBytes(writer), { name: 'all' });
  t.is(readInt(reader), -2);
  t.deepEqual(readByteString(reader), new Uint8Array([1, 2]));
  t.is(readTextString(reader), 'hi');
  t.is(readArrayHeader(reader), 0);
  t.is(readMapHeader(reader), 0);
  t.is(readTag(reader), 280);
  t.false(readBoolean(reader));
  t.true(readBoolean(reader));
  t.true(readOptionalNull(reader));
  t.false(readOptionalNull(reader));
  t.deepEqual(readHead(reader), { major: 7, value: 23 });
  assertConsumed(reader);
});

test('float64 canonical NaN and bignum edges', t => {
  const writer = makeCborWriter();
  writeFloat64(writer, NaN);
  writeBignum(writer, 0n);
  writeBignum(writer, -1n);
  writeBignum(writer, 256n);
  t.is(hex(cborWriterBytes(writer)), 'fb7ff8000000000000c240c340c2420100');
  const reader = makeCborReader(cborWriterBytes(writer), { name: 'numbers' });
  t.true(Number.isNaN(readFloat64(reader)));
  t.is(readBignum(reader), 0n);
  t.is(readBignum(reader), -1n);
  t.is(readBignum(reader), 256n);
  assertConsumed(reader);
  t.throws(
    () =>
      readFloat64(makeCborReader(unhex('fb7ff0000000000001'), { name: 'nan' })),
    { message: /Non-canonical NaN.*index 1 of nan/ },
  );
});

test('reader is tolerant by default and strict when requested', t => {
  t.is(readUint(makeCborReader(unhex('1817'))), 23);
  t.throws(
    () =>
      readUint(makeCborReader(unhex('1817'), { strict: true, name: 'strict' })),
    { message: /Non-minimal CBOR head.*index 0 of strict/ },
  );
  t.is(readBignum(makeCborReader(unhex('c24100'))), 0n);
  t.throws(
    () =>
      readBignum(
        makeCborReader(unhex('c24100'), { strict: true, name: 'strict' }),
      ),
    { message: /Non-minimal bignum payload/ },
  );
});

test('rejections identify reader offsets', t => {
  for (const value of ['1f', '1c', '1a0000', '4301'])
    t.throws(() => readUint(makeCborReader(unhex(value), { name: 'bad' })), {
      message: /index .* of bad/,
    });
  t.throws(
    () => readByteString(makeCborReader(unhex('4301'), { name: 'payload' })),
    { message: /index 1 of payload/ },
  );
  t.throws(
    () => assertConsumed(makeCborReader(unhex('0001'), { name: 'trailing' })),
    { message: /index 0 of trailing/ },
  );
  t.throws(() => writeTextString(makeCborWriter(), '\ud800'), {
    message: /well-formed/,
  });
});
