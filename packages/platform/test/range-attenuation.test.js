// @ts-nocheck

/**
 * Unit tests for the shared `ReadableBlob` range-attenuation helpers
 * (designs/readableblob-range-attenuation.md): argument validation, interval
 * composition (a range of a range intersects), and the LF line-boundary math
 * that defines `textRange` line addressing.
 */

import '@endo/init/debug.js';
import test from 'ava';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';

import {
  assertByteRange,
  assertLineRange,
  composeByteInterval,
  lineRangeToByteSlice,
} from '../src/fs/range-attenuation.js';

const utf8 = encodeUtf8;

test('assertByteRange accepts non-negative safe bigints with start <= end', t => {
  t.deepEqual({ ...assertByteRange(0n, 0n) }, { start: 0, end: 0 });
  t.deepEqual({ ...assertByteRange(3n, 9n) }, { start: 3, end: 9 });
});

test('assertByteRange rejects negative, inverted, and non-safe requests', t => {
  t.throws(() => assertByteRange(-1n, 4n), { message: /EINVAL/ });
  t.throws(() => assertByteRange(5n, 2n), { message: /EINVAL/ });
  t.throws(() => assertByteRange(2n ** 60n, 4n), { message: /EINVAL/ });
});

test('assertLineRange accepts equal intervals and rejects invalid indices', t => {
  t.deepEqual({ ...assertLineRange(2, 2) }, { startLine: 2, endLine: 2 });
  t.throws(() => assertLineRange(3, 1), { message: /EINVAL/ });
  t.throws(() => assertLineRange(-1, 2), { message: /EINVAL/ });
  t.throws(() => assertLineRange(0, 1.5), { message: /EINVAL/ });
});

test('composeByteInterval intersects a child with its parent', t => {
  // Unattenuated parent (end undefined) inherits the concrete child bounds.
  t.deepEqual(
    { ...composeByteInterval(0, undefined, 6, 100) },
    {
      start: 6,
      end: 100,
    },
  );
  // A range of a range clamps at the parent's end — never regains authority.
  t.deepEqual({ ...composeByteInterval(6, 12, 0, 100) }, { start: 6, end: 12 });
  t.deepEqual({ ...composeByteInterval(6, 12, 3, 100) }, { start: 9, end: 12 });
  // A child starting at/past the parent's end is empty.
  t.deepEqual(
    { ...composeByteInterval(6, 12, 100, 200) },
    {
      start: 12,
      end: 12,
    },
  );
});

test('lineRangeToByteSlice implements textRange line addressing', t => {
  const bytes = utf8('a\nb\nc\nd\ne\n'); // lines: a,b,c,d,e,''
  const decode = ({ start, end }) => decodeUtf8(bytes.subarray(start, end));
  t.is(decode(lineRangeToByteSlice(bytes, 0, 2)), 'a\nb');
  t.is(decode(lineRangeToByteSlice(bytes, 1, 3)), 'b\nc');
  t.is(decode(lineRangeToByteSlice(bytes, 3, 100)), 'd\ne\n'); // clamps at end
});

test('lineRangeToByteSlice preserves CRLF and selects nothing past the end', t => {
  const crlf = utf8('a\r\nb\r\n'); // lines: 'a\r','b\r',''
  const decode = (b, { start, end }) => decodeUtf8(b.subarray(start, end));
  t.is(decode(crlf, lineRangeToByteSlice(crlf, 0, 1)), 'a\r');
  t.is(decode(crlf, lineRangeToByteSlice(crlf, 0, 3)), 'a\r\nb\r\n');
  // A start at/beyond the last line is an empty slice at EOF.
  const three = utf8('a\nb\nc\n');
  t.deepEqual(
    { ...lineRangeToByteSlice(three, 5, 9) },
    {
      start: three.length,
      end: three.length,
    },
  );
});

test('lineRangeToByteSlice handles a single line with no trailing LF', t => {
  const bytes = utf8('solo'); // one line, no LF
  t.deepEqual({ ...lineRangeToByteSlice(bytes, 0, 1) }, { start: 0, end: 4 });
  t.deepEqual({ ...lineRangeToByteSlice(bytes, 0, 100) }, { start: 0, end: 4 });
});

test('lineRangeToByteSlice clamps to an empty slice when its caller skips assertLineRange', t => {
  // `lineRangeToByteSlice` is exported from the package index, so a caller can
  // reach it without the `assertLineRange` validation and the `endLine <=
  // startLine` short-circuit its docstring requires. Both guards it keeps for
  // that case collapse the selection to an empty slice rather than returning an
  // inverted interval a caller would turn into a negative-length read.
  const inverted = utf8('a\nb\nc'); // no trailing LF; 5 bytes
  t.deepEqual(
    { ...lineRangeToByteSlice(inverted, 2, 1) },
    { start: 4, end: 4 },
    'an inverted request selects nothing at the start line, not a negative span',
  );
  // A fractional start matches no line index, so the scan never records a
  // start; the slice falls back to EOF instead of the -1 sentinel.
  const fractional = utf8('a\nb\nc\n'); // 6 bytes
  t.deepEqual(
    { ...lineRangeToByteSlice(fractional, 1.5, 3) },
    { start: 6, end: 6 },
    'a non-integer start line selects nothing at EOF',
  );
});
