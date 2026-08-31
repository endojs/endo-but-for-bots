// @ts-check

// Exercises the shared range-attenuation maker (`makeBlobRangeMethods`,
// src/fs/blob-range.js) through the immutable `BlobRef` producer — the
// design's cross-producer test matrix that is not specific to any one backing:
// nested byte ranges, byte-after-text and text-after-byte ranges, terminal-LF
// and CRLF handling, invalid arguments, `start === end`, EOF clamping, empty
// selections, `getInfo` over the selected content, and content-address
// stability of an immutable selection. See
// designs/readableblob-range-attenuation.md.

import '@endo/init/debug.js';

import test from 'ava';
import { createHash } from 'node:crypto';
import { E } from '@endo/eventual-send';
import { encodeBase64 } from '@endo/base64';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import {
  BYTE_STREAM_CHUNK_SIZE,
  copyByteWindow,
  makeBlobRangeMethods,
} from '../src/fs/blob-range.js';
import { makeBlobRefExo } from '../src/fs/extended/shared/blob-ref.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesOf = str => encoder.encode(str);
const sha256Base64 = bytes =>
  encodeBase64(createHash('sha256').update(bytes).digest());

// Drain a range/blob's `streamBase64` into a single `Uint8Array`.
const collectBytes = async blob => {
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  for await (const chunk of iterateBytesReader(blob)) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
};

test('copyByteWindow never retains the unattenuated backing buffer', async t => {
  const backing = bytesOf('outside-selected-outside');
  const sourceView = backing.subarray(7, 15); // 'selected'
  const source = (async function* makeSource() {
    yield sourceView;
  })();
  const chunks = [];
  for await (const chunk of copyByteWindow(source, 1n, 7n)) {
    chunks.push(chunk);
  }
  t.is(chunks.length, 1);
  const [selected] = chunks;
  t.is(decoder.decode(selected), 'select');
  t.not(selected.buffer, backing.buffer);

  // Mutations on either allocation cannot cross the attenuation boundary.
  selected[0] = 'S'.charCodeAt(0);
  t.is(decoder.decode(backing), 'outside-selected-outside');
  backing[9] = 'X'.charCodeAt(0);
  t.is(decoder.decode(selected), 'Select');
});

test('derived stream reuses one source stream across multiple windows', async t => {
  const backing = new Uint8Array(BYTE_STREAM_CHUNK_SIZE * 3 + 17);
  for (let index = 0; index < backing.length; index += 1) {
    backing[index] = index % 251;
  }
  let streamCount = 0;
  let scalarReadCount = 0;
  const { range } = makeBlobRangeMethods({
    async readWindow() {
      scalarReadCount += 1;
      throw new Error('streamBase64 must use the source stream');
    },
    streamBytes: async function* streamBytes() {
      streamCount += 1;
      // Deliberately use irregular source chunks. The shared maker must
      // rechunk them at its 48 KiB base64 boundary without reopening source.
      for (let offset = 0; offset < backing.length; offset += 17_003) {
        yield backing.subarray(offset, offset + 17_003);
      }
    },
    hashBytes: bytes => bytes,
  });
  const start = 101n;
  const end = BigInt(backing.length - 89);
  const selected = await collectBytes(await range(start, end));
  t.deepEqual(selected, backing.subarray(Number(start), Number(end)));
  t.is(streamCount, 1);
  t.is(scalarReadCount, 0);
});

test('range selects a half-open byte interval, read via the normal surface', async t => {
  const blob = makeBlobRefExo(bytesOf('hello world\n'));
  t.is(await E(await E(blob).range(0n, 12n)).text(), 'hello world\n');
  t.is(await E(await E(blob).range(0n, 5n)).text(), 'hello');
  t.is(await E(await E(blob).range(6n, 11n)).text(), 'world');
  // The returned value is itself a ReadableBlob whose bytes match.
  const suffix = await E(blob).range(6n, 12n);
  t.is(decoder.decode(await collectBytes(suffix)), 'world\n');
});

test('range clamps at end-of-content', async t => {
  const blob = makeBlobRefExo(bytesOf('hello world\n')); // 12 bytes
  // A window past EOF yields the suffix.
  t.is(await E(await E(blob).range(6n, 100n)).text(), 'world\n');
  // A window wholly past EOF is a valid empty attenuation.
  t.is(await E(await E(blob).range(100n, 200n)).text(), '');
});

test('start === end is an empty attenuation with size 0', async t => {
  const blob = makeBlobRefExo(bytesOf('hello'));
  const empty = await E(blob).range(3n, 3n);
  t.is(await E(empty).text(), '');
  const info = await E(empty).getInfo();
  t.is(info.size, 0n);
  t.is(info.hash, sha256Base64(new Uint8Array(0)));
});

test('range rejects negative, inverted, and non-safe arguments with EINVAL', async t => {
  const blob = makeBlobRefExo(bytesOf('hello world\n'));
  await t.throwsAsync(() => E(blob).range(-1n, 3n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(0n, -4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(5n, 2n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(2n ** 60n, 2n ** 60n + 4n), {
    message: /EINVAL/,
  });
});

test('a range of a range intersects and never escapes the parent', async t => {
  const blob = makeBlobRefExo(bytesOf('hello world\n'));
  const world = await E(blob).range(6n, 12n); // 'world\n'
  t.is(await E(world).text(), 'world\n');
  // Sub-selection is relative to the receiver.
  t.is(await E(await E(world).range(0n, 3n)).text(), 'wor');
  // An over-wide sub-range clamps to the parent's end, never regaining bytes
  // outside [6, 12): 'world\n' has 6 bytes, so range(0, 100) is still 'world\n'.
  t.is(await E(await E(world).range(0n, 100n)).text(), 'world\n');
  // And a sub-range starting past the parent's end is empty.
  t.is(await E(await E(world).range(50n, 60n)).text(), '');
});

test('getInfo reports the selected content-address triple', async t => {
  const whole = bytesOf('hello world\n');
  const blob = makeBlobRefExo(whole);
  const selected = whole.subarray(0, 5); // 'hello'
  const info = await E(await E(blob).range(0n, 5n)).getInfo();
  t.is(info.algorithm, 'sha256');
  t.is(info.size, 5n);
  t.is(info.hash, sha256Base64(selected));
  // An immutable source gives a stable content address across calls.
  const again = await E(await E(blob).range(0n, 5n)).getInfo();
  t.is(again.hash, info.hash);
});

test('textRange selects zero-based, end-exclusive lines as a ReadableBlob', async t => {
  const blob = makeBlobRefExo(bytesOf('a\nb\nc\nd\ne\n'));
  t.is(await E(await E(blob).textRange(0, 2)).text(), 'a\nb');
  t.is(await E(await E(blob).textRange(1, 3)).text(), 'b\nc');
  // 'd','e','' joined by '\n' — the final LF's terminal empty line is preserved.
  t.is(await E(await E(blob).textRange(3, 100)).text(), 'd\ne\n');
});

test('textRange preserves a trailing newline and clamps past the end', async t => {
  const blob = makeBlobRefExo(bytesOf('a\nb\nc\n'));
  t.is(await E(await E(blob).textRange(2, 100)).text(), 'c\n'); // 'c' + ''
  t.is(await E(await E(blob).textRange(0, 100)).text(), 'a\nb\nc\n');
  t.is(await E(await E(blob).textRange(2, 2)).text(), ''); // empty range
  t.is(await E(await E(blob).textRange(5, 9)).text(), ''); // wholly past end
});

test('textRange preserves CRLF (a CR before LF stays content)', async t => {
  const blob = makeBlobRefExo(bytesOf('a\r\nb\r\nc'));
  // Line 0 is 'a\r' (the CR is content, only LF is the boundary).
  t.is(await E(await E(blob).textRange(0, 1)).text(), 'a\r');
  t.is(await E(await E(blob).textRange(0, 2)).text(), 'a\r\nb\r');
});

test('textRange rejects negative, fractional, and inverted line indices', async t => {
  const blob = makeBlobRefExo(bytesOf('a\nb\n'));
  await t.throwsAsync(() => E(blob).textRange(-1, 2), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).textRange(0, 1.5), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).textRange(3, 1), { message: /EINVAL/ });
});

test('textRange(a,b).text() === text.split(LF).slice(a,b).join(LF) across a corpus', async t => {
  // The module documents (and the PR body repeats) that `textRange(a,b).text()`
  // equals `text.split('\n').slice(a,b).join('\n')` and "never disagrees" with
  // the retired `rangeReadText`. That method is deleted, so pin the equivalence
  // directly: an exhaustive `(a,b)` sweep over a corpus that includes the empty
  // string, a bare LF, blank interior lines, CRLF, and an unterminated final
  // line (skills/regression-evidence § Equivalence claims need a backing test).
  const corpus = [
    '',
    '\n',
    'a',
    'a\n',
    'a\nb',
    'a\nb\n',
    'a\nb\nc\n',
    '\n\n\n',
    'x\n\ny\n', // blank interior line
    'a\r\nb\r\nc', // CRLF, unterminated final line
    'a\r\nb\r\nc\r\n',
    'one\ntwo\nthree\nfour\nfive', // no trailing LF
    'trailing\nnewline\n',
    'line without terminator',
  ];
  const MAX = 8; // beyond any corpus entry's line count, to exercise clamping
  for (const text of corpus) {
    const blob = makeBlobRefExo(bytesOf(text));
    const lines = text.split('\n');
    for (let a = 0; a <= MAX; a += 1) {
      for (let b = a; b <= MAX; b += 1) {
        // eslint-disable-next-line no-await-in-loop
        const actual = await E(await E(blob).textRange(a, b)).text();
        t.is(
          actual,
          lines.slice(a, b).join('\n'),
          `textRange(${a}, ${b}) of ${JSON.stringify(text)}`,
        );
      }
    }
  }
});

test('byte range of a text range indexes the selected lines bytes', async t => {
  const blob = makeBlobRefExo(bytesOf('aa\nbb\ncc\n'));
  const line1 = await E(blob).textRange(1, 2); // 'bb'
  t.is(await E(line1).text(), 'bb');
  t.is(await E(await E(line1).range(0n, 1n)).text(), 'b');
});

test('text range of a byte range indexes the lines visible in that byte range', async t => {
  const blob = makeBlobRefExo(bytesOf('aa\nbb\ncc\n'));
  const mid = await E(blob).range(3n, 8n); // 'bb\ncc'
  t.is(await E(mid).text(), 'bb\ncc');
  t.is(await E(await E(mid).textRange(0, 1)).text(), 'bb');
  t.is(await E(await E(mid).textRange(1, 2)).text(), 'cc');
});

test('streamBase64 of a range yields exactly the selected bytes', async t => {
  const blob = makeBlobRefExo(bytesOf('hello world\n'));
  const world = await E(blob).range(6n, 12n);
  t.deepEqual(await collectBytes(world), bytesOf('world\n'));
});

test('streamBase64 of a range spans multiple base64 chunks byte-exactly', async t => {
  // Pin the derived range's windowed `streamBase64` (`streamByteWindow`,
  // BYTE_STREAM_CHUNK_SIZE = 48 KiB per sub-window): the whole existing corpus
  // fits in one chunk, so a >1-chunk round-trip was never exercised. Drive
  // ~130 KB — a non-multiple of the chunk size and of 3 — through a range's
  // `streamBase64` and assert byte-exact decode.
  const size = 130_000;
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    payload[i] = (i * 31 + 7) % 256;
  }
  const blob = makeBlobRefExo(payload);
  const whole = await E(blob).range(0n, BigInt(size));
  t.deepEqual(await collectBytes(whole), payload);
  // A sub-window that itself crosses several chunk boundaries.
  const from = 1000;
  const to = 125_321;
  const sub = await E(blob).range(BigInt(from), BigInt(to));
  t.deepEqual(await collectBytes(sub), payload.subarray(from, to));
});

test('range with omitted end selects from start to end-of-content', async t => {
  const blob = makeBlobRefExo(bytesOf('hello world\n')); // 12 bytes
  // "offset to EOF" is expressible without synthesizing a sentinel upper bound.
  t.is(await E(await E(blob).range(6n)).text(), 'world\n');
  t.is(await E(await E(blob).range(0n)).text(), 'hello world\n');
  // Composes: a to-EOF sub-range of a to-EOF range never escapes the parent.
  const suffix = await E(blob).range(6n); // 'world\n'
  t.is(await E(await E(suffix).range(2n)).text(), 'rld\n');
  const info = await E(await E(blob).range(6n)).getInfo();
  t.is(info.size, 6n);
});

test('composing nested open-ended ranges clamps an overflowing composed bound', async t => {
  // Each offset is individually valid (`assertOffset` bounds it at
  // MAX_SAFE_INTEGER), but nesting open-ended ranges sums them past that bound.
  // Before the clamp the composed start/end was stored unclamped and failed far
  // later at read time with a bare EINVAL (`readWindow`'s bigint→Number
  // boundary); it must instead resolve here to the intended empty, past-end
  // selection. See designs/readableblob-range-attenuation.md.
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const blob = makeBlobRefExo(bytesOf('hello world\n')); // 12 bytes
  // A single open-ended range far past EOF is a valid empty attenuation.
  const farOpen = await E(blob).range(max); // [MAX_SAFE, EOF)
  t.is(await E(farOpen).text(), '');
  // Nesting another open-ended range at the same huge offset overflows the
  // composed *start* (MAX + MAX). It clamps into the safe-integer domain and
  // resolves empty rather than throwing EINVAL at read time.
  const nestedOpen = await E(farOpen).range(max);
  t.is(await E(nestedOpen).text(), '');
  t.is((await E(nestedOpen).getInfo()).size, 0n);
  // A closed nested range whose composed *end* (absoluteStart + end = MAX + MAX)
  // overflows clamps the same way — `end` is itself a valid offset, so it is the
  // composition, not `assertOffset`, that must contain the overflow.
  const nestedClosed = await E(farOpen).range(0n, max);
  t.is(await E(nestedClosed).text(), '');
});

test('streamBase64 of a near-MAX_SAFE open-ended range drains to empty', async t => {
  // Regression for the fuzzer-caught divergence: a producer WITHOUT a
  // `streamBytes` primitive (BlobRef here) derives `streamBase64` through
  // `streamByteWindow`'s scalar-read loop. On an open-ended range whose start
  // sits within one `BYTE_STREAM_CHUNK_SIZE` (48 KiB) of MAX_SAFE_INTEGER — a
  // documented valid empty attenuation, e.g. `range(MAX_SAFE)` — the per-window
  // `end` (position + chunk) overflowed MAX_SAFE_INTEGER and `readWindow`
  // rejected it with a bare EINVAL, so `streamBase64` threw while `text()`,
  // `getInfo().size`, and every `streamBytes`-backed producer answered empty.
  // The sub-window end is now clamped into the safe-integer domain, so all four
  // read methods agree on empty. The nested-open-ended test above exercised
  // only `text()`/`getInfo()`, never `streamBase64`, and so missed this.
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const blob = makeBlobRefExo(bytesOf('hello world\n')); // 12 bytes
  const farOpen = await E(blob).range(max); // [MAX_SAFE, EOF) — empty
  // The three methods that already agreed on empty.
  t.is(await E(farOpen).text(), '');
  t.is((await E(farOpen).getInfo()).size, 0n);
  // The method the fuzzer found throwing: it must drain to empty, not EINVAL.
  t.deepEqual(await collectBytes(farOpen), new Uint8Array(0));
  // Just inside the throwing threshold (start > MAX_SAFE − 48 KiB) drains empty.
  const nearMax = await E(blob).range(max - 1n);
  t.deepEqual(await collectBytes(nearMax), new Uint8Array(0));
});

test('text decoding is position-independent across a BOM (whole-value and window agree)', async t => {
  const preserveDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
  // An interior U+FEFF (its UTF-8 bytes begin at offset 3, not 0) is literal
  // content, so the whole-value text() preserves it. A derived window that
  // BEGINS on that interior U+FEFF must preserve it too — decoding the same
  // bytes to the same string they decode to within the whole value — rather
  // than stripping it as a byte-order mark.
  const interior = bytesOf('abc\uFEFFdef'); // 'abc' | EF BB BF | 'def' = 9 bytes
  const bomOffset = 3;
  const blob = makeBlobRefExo(interior);
  const whole = await E(blob).text();
  t.is(whole, 'abc\uFEFFdef');
  // Full-interval range equals the whole value (the documented identity).
  t.is(await E(await E(blob).range(0n, BigInt(interior.length))).text(), whole);
  // The window beginning on the interior U+FEFF preserves it.
  const window = await E(blob).range(
    BigInt(bomOffset),
    BigInt(interior.length),
  );
  t.is(await E(window).text(), '\uFEFFdef');
  t.is(await E(window).text(), preserveDecoder.decode(interior.subarray(3)));

  // A genuine leading BOM (offset 0) is stripped, and range(0, size) agrees
  // (both strip), so range(0n, size).text() === text() still holds.
  const leading = bytesOf('\uFEFFhello'); // EF BB BF | 'hello'
  const leadingBlob = makeBlobRefExo(leading);
  const leadingWhole = await E(leadingBlob).text();
  t.is(leadingWhole, 'hello');
  t.is(
    await E(await E(leadingBlob).range(0n, BigInt(leading.length))).text(),
    leadingWhole,
  );
});

test('json parses the selected bytes of a range', async t => {
  const blob = makeBlobRefExo(bytesOf('[0,{"k":"v"},2]'));
  // A byte range selecting the embedded object decodes as JSON on its own.
  t.deepEqual(await E(await E(blob).range(3n, 12n)).json(), { k: 'v' });
  // A textRange over a JSON-per-line document decodes the selected line.
  const lines = makeBlobRefExo(bytesOf('{"a":1}\n{"b":2}\n'));
  t.deepEqual(await E(await E(lines).textRange(1, 2)).json(), { b: 2 });
});

test('help describes the range surface and rejects unknown methods', async t => {
  const range = await E(makeBlobRefExo(bytesOf('hello'))).range(0n, 5n);
  t.regex(await E(range).help(), /attenuated read/);
  t.regex(await E(range).help('nope'), /No documentation for method/);
});
