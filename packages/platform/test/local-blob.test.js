// @ts-nocheck

/**
 * `makeLocalBlob` tests — the host-file ReadableBlob now also exposes the
 * richer `BlobRef` range-I/O surface (getInfo / range / textRange). See
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

test('LocalBlob.range rejects a negative or out-of-range interval with EINVAL', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  // A negative endpoint must throw EINVAL (via toSafeNumber), not slip through
  // to fs.read with a negative position. Same for a negative end and an
  // over-MAX_SAFE_INTEGER bigint.
  await t.throwsAsync(() => E(blob).range(-1n, 3n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(0n, -4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(2n ** 60n, 2n ** 60n + 4n), {
    message: /EINVAL/,
  });
});

test('LocalBlob.range clamps a huge endpoint to the file size (no over-allocation)', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hi')); // 2 bytes
  // An endpoint far larger than the file (and far larger than is sane to
  // allocate) must clamp to the available bytes rather than allocating a
  // multi-GB buffer. `5_000_000_000` is a valid safe integer, so it passes
  // toSafeNumber; the clamp is what keeps the read bounded.
  t.is(
    fromUtf8(await collectBytes(await E(blob).range(0n, 5_000_000_000n))),
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
    'getInfo',
    'help',
    'json',
    'range',
    'streamBase64',
    'text',
    'textRange',
  ]);
  t.false(methods.includes('readRange'));
  t.false(methods.includes('size'));
  t.false(methods.includes('makeFileReader'));
});

test('LocalBlob.range reads a clamped byte interval', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  // Assert the decoded content of the range's own read surface (production
  // output) rather than that the test helper's accumulator is a `Uint8Array`.
  t.is(
    fromUtf8(await collectBytes(await E(blob).range(0n, 12n))),
    'hello world\n',
  );
  t.is(fromUtf8(await collectBytes(await E(blob).range(0n, 5n))), 'hello');
  t.is(fromUtf8(await collectBytes(await E(blob).range(6n, 106n))), 'world\n'); // clamps at EOF
  t.is(fromUtf8(await collectBytes(await E(blob).range(100n, 104n))), ''); // past EOF
  t.is(fromUtf8(await collectBytes(await E(blob).range(0n, 0n))), ''); // empty window
});

test('LocalBlob.textRange attenuates to a 0-based, end-exclusive line range', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\nc\nd\ne\n'));
  // Lines are ['a', 'b', 'c', 'd', 'e', ''] (trailing '' after the last '\n').
  t.is(await E(await E(blob).textRange(0, 2)).text(), 'a\nb'); // first two lines
  t.is(await E(await E(blob).textRange(1, 3)).text(), 'b\nc');
  t.is(await E(await E(blob).textRange(3, 100)).text(), 'd\ne\n'); // 'd','e','' joined by '\n'
});

test('LocalBlob.textRange clamps past-the-end and handles the trailing newline', async t => {
  // Trailing '\n' means split yields a final '' element (the empty line after
  // the last newline); slicing past the end clamps rather than throwing.
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\nc\n'));
  // Lines are ['a', 'b', 'c', ''].
  t.is(await E(await E(blob).textRange(2, 100)).text(), 'c\n'); // 'c' + '' joined by '\n'
  t.is(await E(await E(blob).textRange(0, 100)).text(), 'a\nb\nc\n');
  t.is(await E(await E(blob).textRange(2, 2)).text(), ''); // empty range
  t.is(await E(await E(blob).textRange(5, 9)).text(), ''); // wholly past the end
});

test('LocalBlob.textRange rejects a negative or non-integer line index', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\n'));
  await t.throwsAsync(() => E(blob).textRange(-1, 2), {
    message: /EINVAL/,
  });
  await t.throwsAsync(() => E(blob).textRange(0, 1.5), {
    message: /EINVAL/,
  });
});

test('LocalBlob.range composes: a range of a range intersects', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  const r = await E(blob).range(6n, 12n);
  t.is(await E(r).text(), 'world\n');
  const r2 = await E(r).range(0n, 3n);
  t.is(await E(r2).text(), 'wor');
});

test('LocalBlob.range getInfo reports the selected size', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'hello world\n'));
  const r = await E(blob).range(0n, 5n);
  const info = await E(r).getInfo();
  t.is(info.size, 5n);
});

test('LocalBlob.textRange returns a ReadableBlob whose text matches', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'a\nb\nc\n'));
  t.is(await E(await E(blob).textRange(0, 2)).text(), 'a\nb');
});

test('LocalBlob.streamBase64 streams the whole file bytes', async t => {
  const payload = 'hello world\n';
  const blob = makeLocalBlob(makeTempFile(t, payload));
  t.is(fromUtf8(await collectBytes(blob)), payload);
});

test('LocalBlob.help describes the surface and rejects unknown methods', async t => {
  const blob = makeLocalBlob(makeTempFile(t, 'x'));
  t.regex(await E(blob).help(), /LocalBlob/);
  t.regex(await E(blob).help('nope'), /No documentation for method/);
});

test('whole-value text() and a full-interval range().text() agree on a BOM file', async t => {
  // The attenuation identity the design rests on: `range(0, size).text()` must
  // equal the whole-value `text()`. A UTF-8 BOM once broke it — Node's string
  // decode retained the BOM while the range path's `TextDecoder` stripped it.
  // Both paths now decode through one shared UTF-8 path.
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const body = 'hello world\n';
  const payload = Buffer.concat([bom, Buffer.from(body, 'utf-8')]);
  const blob = makeLocalBlob(makeTempFile(t, payload));
  const whole = await E(blob).text();
  const full = await E(await E(blob).range(0n, BigInt(payload.length))).text();
  t.is(full, whole);
  // Bytes (and thus the content address) always included the BOM; the decode
  // is what must agree, and it does.
  t.is(fromUtf8(await collectBytes(blob)), whole);
});

test('text decoding is position-independent across a BOM (window beginning on an interior U+FEFF)', async t => {
  // The equivalence must hold not only for a leading BOM but for a U+FEFF at an
  // interior offset that a derived window begins on. A leading BOM (offset 0)
  // is stripped; an interior U+FEFF is literal content, so the whole-value
  // text() preserves it and a window beginning on it must preserve it too — else
  // the window decodes to a different string than those same bytes do within
  // the whole value. See designs/readableblob-range-attenuation.md § Text ranges.
  const preserveDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const bom = Buffer.from([0xef, 0xbb, 0xbf]); // UTF-8 U+FEFF
  const interior = Buffer.concat([
    Buffer.from('abc', 'utf-8'),
    bom,
    Buffer.from('def', 'utf-8'),
  ]); // 'abc' | EF BB BF | 'def' = 9 bytes; the U+FEFF begins at offset 3
  const blob = makeLocalBlob(makeTempFile(t, interior));
  const whole = await E(blob).text();
  t.is(whole, 'abc\uFEFFdef');
  // Full-interval range equals the whole value.
  t.is(await E(await E(blob).range(0n, BigInt(interior.length))).text(), whole);
  // A window beginning on the interior U+FEFF preserves it.
  const window = await E(blob).range(3n, BigInt(interior.length));
  t.is(await E(window).text(), '\uFEFFdef');
  t.is(await E(window).text(), preserveDecoder.decode(interior.subarray(3)));
});

test('LocalBlob reads a multi-chunk file byte-exactly across window boundaries', async t => {
  // READ_CHUNK_BYTES = 64 KiB per `readFileWindow` disk read and
  // BYTE_STREAM_CHUNK_SIZE = 48 KiB per `streamBase64` sub-window, so ~130 KB
  // spans several of each. The rest of the suite fits inside one chunk, so a
  // range / textRange / streamBase64 that crosses a chunk boundary was never
  // exercised (the missing multi-chunk LocalBlob regression the panel found).
  const size = 130_000; // > 2 * 64 KiB; not a multiple of the chunk size or 3
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) {
    bytes[i] = (i * 31 + 7) % 256;
  }
  const blob = makeLocalBlob(makeTempFile(t, Buffer.from(bytes)));

  // getInfo over the whole multi-chunk file.
  const info = await E(blob).getInfo();
  t.is(info.size, BigInt(size));
  t.is(info.hash, createHash('sha256').update(bytes).digest('base64'));

  // A range that begins mid-chunk and runs past a 64 KiB boundary to EOF.
  const from = 60_000; // before the 65_536 boundary
  const to = size; // past it
  const sub = await E(blob).range(BigInt(from), BigInt(to));
  t.deepEqual(await collectBytes(sub), bytes.subarray(from, to));
  t.is((await E(sub).getInfo()).size, BigInt(to - from));

  // Whole-value range streamed via base64 across several 48 KiB sub-windows.
  t.deepEqual(await collectBytes(await E(blob).range(0n, BigInt(size))), bytes);
});

test('LocalBlob.textRange reads across chunk boundaries byte-exactly', async t => {
  // A > 130 KB LF-delimited file so both the LF scan and the minted byte window
  // cross several 64 KiB read windows.
  const lines = [];
  let total = 0;
  for (let i = 0; total < 130_000; i += 1) {
    const line = `line ${i} ${'x'.repeat(40)}`;
    lines.push(line);
    total += line.length + 1; // + LF
  }
  const text = `${lines.join('\n')}\n`;
  const blob = makeLocalBlob(makeTempFile(t, text));
  t.is(await E(blob).text(), text);
  // A line window whose bytes straddle a 64 KiB boundary.
  const a = 900;
  const b = 1500;
  const expected = text.split('\n').slice(a, b).join('\n');
  t.is(await E(await E(blob).textRange(a, b)).text(), expected);
});
