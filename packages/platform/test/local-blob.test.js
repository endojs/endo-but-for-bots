// @ts-nocheck

/**
 * `makeLocalBlob` tests — the host-file ReadableBlob now also exposes the
 * richer `BlobRef` range-I/O surface (getInfo / fetch). See
 * designs/fs-interface-consolidation.md § C4.
 */

import '@endo/init/debug.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';

import { makeLocalBlob } from '../src/fs-node/local-blob.js';

const fromUtf8 = b => new TextDecoder().decode(b);

const collectBytes = async readerRef => {
  const chunks = [];
  let total = 0;
  for await (const chunk of iterateBytesReader(readerRef)) {
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

const makeTempFile = (t, contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-blob-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'blob.txt');
  fs.writeFileSync(filePath, contents);
  return filePath;
};

test('LocalBlob.getInfo returns the content-address triple', async t => {
  const payload = 'hello world\n'; // 12 bytes
  const blob = makeLocalBlob(makeTempFile(t, payload));
  const info = await E(blob).getInfo();
  t.is(info.algorithm, 'sha256');
  t.is(info.size, 12n);
  t.is(info.hash, createHash('sha256').update(payload).digest('base64'));
});

test('LocalBlob.fetch reads a clamped byte range', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  t.is(
    fromUtf8(await collectBytes(await E(blob).fetch(0n, 12n))),
    'hello world\n',
  );
  t.is(fromUtf8(await collectBytes(await E(blob).fetch(0n, 5n))), 'hello');
  t.is(fromUtf8(await collectBytes(await E(blob).fetch(6n, 100n))), 'world\n');
  t.is(fromUtf8(await collectBytes(await E(blob).fetch(100n, 4n))), '');
});

test('LocalBlob.fetch rejects a negative or out-of-range window with EINVAL', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  // A negative offset must throw EINVAL (via toSafeNumber), not slip through
  // to fs.read with a negative position. Same for a negative length and an
  // over-MAX_SAFE_INTEGER bigint.
  await t.throwsAsync(() => E(blob).fetch(-1n, 4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).fetch(0n, -4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).fetch(2n ** 60n, 4n), {
    message: /EINVAL/,
  });
});

test('LocalBlob.fetch clamps a huge length to the file size (no over-allocation)', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hi')); // 2 bytes
  // A length far larger than the file (and far larger than is sane to
  // allocate) must clamp to the available bytes rather than allocating a
  // multi-GB buffer. `5_000_000_000` is a valid safe integer, so it passes
  // toSafeNumber; the clamp is what keeps the read bounded.
  t.is(
    fromUtf8(await collectBytes(await E(blob).fetch(0n, 5_000_000_000n))),
    'hi',
  );
});

test('LocalBlob still exposes the whole-value surface', async t => {
  const blob = makeLocalBlob(makeTempFile(t, '{"k":1}'));
  t.is(await E(blob).text(), '{"k":1}');
  t.deepEqual(await E(blob).json(), { k: 1 });
});

test('LocalBlob exposes only the rich public ReadableBlob Exo surface', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(blob).__getMethodNames__();
  t.deepEqual(methods.filter(name => !name.startsWith('__')).sort(), [
    'fetch',
    'getInfo',
    'help',
    'json',
    'range',
    'rangeRead',
    'rangeReadText',
    'streamBase64',
    'text',
    'textRange',
  ]);
  t.false(methods.includes('readRange'));
  t.false(methods.includes('size'));
  t.false(methods.includes('makeFileReader'));
});

test('LocalBlob.range attenuates to a new blob over the byte interval', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n')); // 12 bytes
  const suffix = await E(blob).range(6n, 100n); // clamps at EOF → 'world\n'
  t.is(await E(suffix).text(), 'world\n');
  // The derived cap has the same interface, so ranges compose.
  const inner = await E(suffix).range(0n, 5n); // 'world'
  t.is(await E(inner).text(), 'world');
  // getInfo reports the SELECTED content, not the parent's.
  const info = await E(inner).getInfo();
  t.is(info.size, 5n);
  t.is(info.hash, createHash('sha256').update('world').digest('base64'));
  // Whole-value and windowed reads apply to the attenuated bytes.
  t.is(fromUtf8(await E(inner).rangeRead(0n, 100n)), 'world');
  t.is(fromUtf8(await collectBytes(await E(inner).fetch(1n, 3n))), 'orl');
});

test('LocalBlob.range: empty, EOF-clamped, and out-of-range selections', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n')); // 12 bytes
  // start === end selects an empty blob.
  const empty = await E(blob).range(3n, 3n);
  t.is(await E(empty).text(), '');
  const emptyInfo = await E(empty).getInfo();
  t.is(emptyInfo.size, 0n);
  t.is(emptyInfo.hash, createHash('sha256').update('').digest('base64'));
  // Wholly past EOF is a valid empty attenuation.
  t.is(await E(await E(blob).range(100n, 200n)).text(), '');
  // A range of a range can never regain authority outside the parent.
  const mid = await E(blob).range(0n, 5n); // 'hello'
  t.is(await E(await E(mid).range(0n, 100n)).text(), 'hello');
  t.is(await E(await E(mid).range(3n, 100n)).text(), 'lo');
});

test('LocalBlob.range rejects invalid arguments with EINVAL', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  await t.throwsAsync(() => E(blob).range(-1n, 4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(5n, 2n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(2n ** 60n, 4n), {
    message: /EINVAL/,
  });
});

test('LocalBlob.textRange selects a line interval as a new blob', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\nc\nd\ne\n'));
  const first = await E(blob).textRange(0, 2); // lines 'a','b'
  t.is(await E(first).text(), 'a\nb');
  // Agrees byte-for-byte with rangeReadText.
  t.is(await E(blob).rangeReadText(0, 2), await E(first).text());
  const tail = await E(blob).textRange(3, 100); // 'd','e','' clamped
  t.is(await E(tail).text(), 'd\ne\n');
  t.is(await E(blob).rangeReadText(3, 100), await E(tail).text());
});

test('LocalBlob.textRange preserves CRLF and the terminal LF', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\r\nb\r\n')); // CRLF, trailing LF
  const line0 = await E(blob).textRange(0, 1);
  t.is(await E(line0).text(), 'a\r'); // CR stays content, not normalized
  const both = await E(blob).textRange(0, 3); // both lines + terminal empty
  t.is(await E(both).text(), 'a\r\nb\r\n'); // final LF preserved
});

test('LocalBlob.textRange: empty, inverted, and past-end selections', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\nc\n'));
  t.is(await E(await E(blob).textRange(1, 1)).text(), ''); // equal → empty
  t.is(await E(await E(blob).textRange(5, 9)).text(), ''); // wholly past end
  await t.throwsAsync(() => E(blob).textRange(2, 1), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).textRange(-1, 2), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).textRange(0, 1.5), { message: /EINVAL/ });
});

test('LocalBlob: byte-after-text and text-after-byte ranges compose', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nbb\nccc\n'));
  // text-after-byte: a byte range then a line range of the visible bytes.
  const bytePart = await E(blob).range(2n, 9n); // 'bb\nccc\n'
  t.is(await E(bytePart).text(), 'bb\nccc\n');
  const lineOfBytes = await E(bytePart).textRange(0, 1); // first visible line
  t.is(await E(lineOfBytes).text(), 'bb');
  // byte-after-text: a line range then a byte range of its bytes.
  const linePart = await E(blob).textRange(1, 3); // 'bb\nccc'
  t.is(await E(linePart).text(), 'bb\nccc');
  const byteOfLines = await E(linePart).range(0n, 2n);
  t.is(await E(byteOfLines).text(), 'bb');
});

test('LocalBlob.range reflects live file changes; a snapshot does not', async t => {
  const filePath = makeTempFile(t, 'hello world\n');
  const blob = makeLocalBlob(filePath);
  const suffix = await E(blob).range(6n, 11n); // 'world'
  t.is(await E(suffix).text(), 'world');
  // The live face observes the source at each operation (subject to the fixed
  // interval); overwrite the bytes under the same window.
  fs.writeFileSync(filePath, 'HELLO globe\n');
  t.is(await E(suffix).text(), 'globe');
});

test('LocalBlob.rangeRead returns a clamped byte range as a Uint8Array', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  const whole = await E(blob).rangeRead(0n, 12n);
  t.true(whole instanceof Uint8Array);
  t.is(fromUtf8(whole), 'hello world\n');
  t.is(fromUtf8(await E(blob).rangeRead(0n, 5n)), 'hello');
  t.is(fromUtf8(await E(blob).rangeRead(6n, 100n)), 'world\n'); // clamps at EOF
  t.is(fromUtf8(await E(blob).rangeRead(100n, 4n)), ''); // past EOF
  t.is(fromUtf8(await E(blob).rangeRead(0n, 0n)), ''); // empty window
});

test('LocalBlob.rangeRead rejects a negative or out-of-range window with EINVAL', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  await t.throwsAsync(() => E(blob).rangeRead(-1n, 4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).rangeRead(0n, -4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).rangeRead(2n ** 60n, 4n), {
    message: /EINVAL/,
  });
});

test('LocalBlob.rangeReadText returns a 0-based, end-exclusive line range', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\nc\nd\ne\n'));
  // Lines are ['a', 'b', 'c', 'd', 'e', ''] (trailing '' after the last '\n').
  t.is(await E(blob).rangeReadText(0, 2), 'a\nb'); // first two lines
  t.is(await E(blob).rangeReadText(1, 3), 'b\nc');
  t.is(await E(blob).rangeReadText(3, 100), 'd\ne\n'); // 'd','e','' joined by '\n'
});

test('LocalBlob.rangeReadText clamps past-the-end and handles the trailing newline', async t => {
  // Trailing '\n' means split yields a final '' element (the empty line after
  // the last newline); slicing past the end clamps rather than throwing.
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\nc\n'));
  // Lines are ['a', 'b', 'c', ''].
  t.is(await E(blob).rangeReadText(2, 100), 'c\n'); // 'c' + '' joined by '\n'
  t.is(await E(blob).rangeReadText(0, 100), 'a\nb\nc\n');
  t.is(await E(blob).rangeReadText(2, 2), ''); // empty range
  t.is(await E(blob).rangeReadText(5, 9), ''); // wholly past the end
});

test('LocalBlob.rangeReadText rejects a negative or non-integer line index', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\n'));
  await t.throwsAsync(() => E(blob).rangeReadText(-1, 2), {
    message: /EINVAL/,
  });
  await t.throwsAsync(() => E(blob).rangeReadText(0, 1.5), {
    message: /EINVAL/,
  });
});
