// @ts-check

import test from '@endo/ses-ava/test.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { compareUint8Arrays } from '../../src/syrup/compare.js';

test('equal', t => {
  const left = new Uint8Array([1, 2, 3]);
  const right = new Uint8Array([1, 2, 3]);
  t.is(compareUint8Arrays(left, right), 0);
});

test('left longer', t => {
  const left = new Uint8Array([1, 2, 3, 4]);
  const right = new Uint8Array([1, 2, 3]);
  t.is(compareUint8Arrays(left, right), 1);
});

test('right longer', t => {
  const left = new Uint8Array([1, 2, 3]);
  const right = new Uint8Array([1, 2, 3, 4]);
  t.is(compareUint8Arrays(left, right), -1);
});

test('compareUint8Arrays - equal buffers', t => {
  const buffer1 = encodeUtf8('hello');
  const buffer2 = encodeUtf8('hello');

  t.is(compareUint8Arrays(buffer1, buffer2), 0);
});

test('compareUint8Arrays - left less than right', t => {
  const buffer1 = encodeUtf8('abc');
  const buffer2 = encodeUtf8('xyz');

  t.is(compareUint8Arrays(buffer1, buffer2), -1);
});

test('compareUint8Arrays - left greater than right', t => {
  const buffer1 = encodeUtf8('xyz');
  const buffer2 = encodeUtf8('abc');

  t.is(compareUint8Arrays(buffer1, buffer2), 1);
});

test('compareUint8Arrays - left is prefix of right', t => {
  const buffer1 = encodeUtf8('hello');
  const buffer2 = encodeUtf8('helloworld');

  const result = compareUint8Arrays(buffer1, buffer2);
  t.true(result < 0, 'left should be less than right');
  t.is(result, 5 - 10, 'should return length difference when one is prefix');
});

test('compareUint8Arrays - right is prefix of left', t => {
  const buffer1 = encodeUtf8('helloworld');
  const buffer2 = encodeUtf8('hello');

  const result = compareUint8Arrays(buffer1, buffer2);
  t.true(result > 0, 'left should be greater than right');
});

test('compareUint8Arrays - empty buffers', t => {
  const buffer1 = new Uint8Array(0);
  const buffer2 = new Uint8Array(0);

  t.is(compareUint8Arrays(buffer1, buffer2), 0);
});

test('compareUint8Arrays - empty vs non-empty', t => {
  const buffer1 = new Uint8Array(0);
  const buffer2 = encodeUtf8('a');

  t.is(compareUint8Arrays(buffer1, buffer2), -1);
  t.is(compareUint8Arrays(buffer2, buffer1), 1);
});

test('compareUint8Arrays - binary data', t => {
  const buffer1 = new Uint8Array([0x00, 0x01, 0x02]);
  const buffer2 = new Uint8Array([0x00, 0x01, 0x03]);

  t.is(compareUint8Arrays(buffer1, buffer2), -1);
  t.is(compareUint8Arrays(buffer2, buffer1), 1);
});

test('compareUint8Arrays - bytewise comparison', t => {
  // Test that comparison is bytewise, not lexicographic
  const buffer1 = new Uint8Array([0xff]);
  const buffer2 = new Uint8Array([0x00, 0x00]);

  // 0xff > 0x00, so buffer1 > buffer2 despite being shorter
  t.is(compareUint8Arrays(buffer1, buffer2), 1);
  t.is(compareUint8Arrays(buffer2, buffer1), -1);
});
