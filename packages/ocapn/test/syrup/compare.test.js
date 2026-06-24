// @ts-check

import test from '@endo/ses-ava/test.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';

import { compareBytes } from '@endo/bytes/compare.js';

test('equal', t => {
  const left = new Uint8Array([1, 2, 3]);
  const right = new Uint8Array([1, 2, 3]);
  t.is(compareBytes(left, right), 0);
});

test('left longer', t => {
  const left = new Uint8Array([1, 2, 3, 4]);
  const right = new Uint8Array([1, 2, 3]);
  t.is(compareBytes(left, right), 1);
});

test('right longer', t => {
  const left = new Uint8Array([1, 2, 3]);
  const right = new Uint8Array([1, 2, 3, 4]);
  t.is(compareBytes(left, right), -1);
});

test('compareBytes - equal buffers', t => {
  const buffer1 = encodeUtf8('hello');
  const buffer2 = encodeUtf8('hello');

  t.is(compareBytes(buffer1, buffer2), 0);
});

test('compareBytes - left less than right', t => {
  const buffer1 = encodeUtf8('abc');
  const buffer2 = encodeUtf8('xyz');

  t.is(compareBytes(buffer1, buffer2), -1);
});

test('compareBytes - left greater than right', t => {
  const buffer1 = encodeUtf8('xyz');
  const buffer2 = encodeUtf8('abc');

  t.is(compareBytes(buffer1, buffer2), 1);
});

test('compareBytes - left is prefix of right', t => {
  const buffer1 = encodeUtf8('hello');
  const buffer2 = encodeUtf8('helloworld');

  const result = compareBytes(buffer1, buffer2);
  t.true(result < 0, 'left should be less than right');
});

test('compareBytes - right is prefix of left', t => {
  const buffer1 = encodeUtf8('helloworld');
  const buffer2 = encodeUtf8('hello');

  const result = compareBytes(buffer1, buffer2);
  t.true(result > 0, 'left should be greater than right');
});

test('compareBytes - empty buffers', t => {
  const buffer1 = new Uint8Array(0);
  const buffer2 = new Uint8Array(0);

  t.is(compareBytes(buffer1, buffer2), 0);
});

test('compareBytes - empty vs non-empty', t => {
  const buffer1 = new Uint8Array(0);
  const buffer2 = encodeUtf8('a');

  t.is(compareBytes(buffer1, buffer2), -1);
  t.is(compareBytes(buffer2, buffer1), 1);
});

test('compareBytes - binary data', t => {
  const buffer1 = new Uint8Array([0x00, 0x01, 0x02]);
  const buffer2 = new Uint8Array([0x00, 0x01, 0x03]);

  t.is(compareBytes(buffer1, buffer2), -1);
  t.is(compareBytes(buffer2, buffer1), 1);
});

test('compareBytes - bytewise comparison', t => {
  // Test that comparison is bytewise, not lexicographic
  const buffer1 = new Uint8Array([0xff]);
  const buffer2 = new Uint8Array([0x00, 0x00]);

  // 0xff > 0x00, so buffer1 > buffer2 despite being shorter
  t.is(compareBytes(buffer1, buffer2), 1);
  t.is(compareBytes(buffer2, buffer1), -1);
});

test('compareBytes - subrange comparison', t => {
  const buffer = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  // Compare bytes[1..3] vs bytes[0..2]: [1,2] vs [0,1,2]
  const result = compareBytes(buffer, buffer, 1, 3, 0, 2);
  // [1,2] vs [0,1]: first byte 1 > 0, so result > 0
  t.true(result > 0);
});
