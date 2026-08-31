// @ts-nocheck

/**
 * `makeLocalBlob` tests — the host-file ReadableBlob now also exposes the
 * richer `BlobRef` named-read surface. See
 * designs/fs-interface-consolidation.md § C4.
 */

import '@endo/init/debug.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { decodeUtf8 } from '@endo/utf8/decode.js';
import { encodeUtf8 } from '@endo/utf8/encode.js';
import { sha256 } from '@endo/sha256';
import { encodeBase64 } from '@endo/base64';

import { makeLocalBlob } from '../src/fs-node/local-blob.js';

const fromUtf8 = decodeUtf8;

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

const makeTemporaryFile = (t, contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-blob-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'blob.txt');
  fs.writeFileSync(filePath, contents);
  return filePath;
};

test('LocalBlob exposes sha256 and size accessors', async t => {
  const payload = 'hello world\n'; // 12 bytes
  const blob = makeLocalBlob(makeTemporaryFile(t, payload));
  t.is(await E(blob).size(), 12n);
  t.is(await E(blob).sha256(), encodeBase64(sha256(encodeUtf8(payload))));
});

test('LocalBlob bytes and byteRange read the selected bytes', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'hello world\n'));
  t.is(fromUtf8(await collectBytes(await E(blob).bytes())), 'hello world\n');
  t.is(await E(await E(blob).byteRange(0n, 5n)).text(), 'hello');
  t.is(await E(await E(blob).byteRange(6n, 100n)).text(), 'world\n');
  t.is(await E(await E(blob).byteRange(100n, 104n)).text(), '');
});

test('LocalBlob still exposes the whole-value surface', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, '{"k":1}'));
  t.is(await E(blob).text(), '{"k":1}');
  t.deepEqual(await E(blob).json(), { k: 1 });
});

test('LocalBlob exposes only the rich public ReadableBlob Exo surface', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'hello world\n'));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await E(blob).__getMethodNames__();
  t.deepEqual(methods.filter(name => !name.startsWith('__')).sort(), [
    'byteRange',
    'bytes',
    'help',
    'json',
    'sha256',
    'size',
    'stream',
    'text',
    'textRange',
  ]);
  t.false(methods.includes('readRange'));
  t.false(methods.includes('makeFileReader'));
});

test('LocalBlob.byteRange attenuates to a new blob over the byte interval', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'hello world\n')); // 12 bytes
  const suffix = await E(blob).byteRange(6n, 100n); // clamps at EOF → 'world\n'
  t.is(await E(suffix).text(), 'world\n');
  // The derived cap has the same interface, so ranges compose.
  const inner = await E(suffix).byteRange(0n, 5n); // 'world'
  t.is(await E(inner).text(), 'world');
  // Metadata accessors report the selected content, not the parent's.
  t.is(await E(inner).size(), 5n);
  t.is(await E(inner).sha256(), encodeBase64(sha256(encodeUtf8('world'))));
  // Whole-value reads apply to the attenuated bytes.
  t.is(fromUtf8(await collectBytes(inner)), 'world');
  t.is(await E(await E(inner).byteRange(1n, 4n)).text(), 'orl');
});

test('LocalBlob.byteRange: empty, EOF-clamped, and out-of-range selections', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'hello world\n')); // 12 bytes
  // start === end selects an empty blob.
  const empty = await E(blob).byteRange(3n, 3n);
  t.is(await E(empty).text(), '');
  t.is(await E(empty).size(), 0n);
  t.is(await E(empty).sha256(), encodeBase64(sha256(encodeUtf8(''))));
  // Wholly past EOF is a valid empty attenuation.
  t.is(await E(await E(blob).byteRange(100n, 200n)).text(), '');
  // A range of a range can never regain authority outside the parent.
  const mid = await E(blob).byteRange(0n, 5n); // 'hello'
  t.is(await E(await E(mid).byteRange(0n, 100n)).text(), 'hello');
  t.is(await E(await E(mid).byteRange(3n, 100n)).text(), 'lo');
});

test('LocalBlob.byteRange rejects invalid arguments with EINVAL', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'hello world\n'));
  await t.throwsAsync(() => E(blob).byteRange(-1n, 4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).byteRange(5n, 2n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).byteRange(2n ** 60n, 4n), {
    message: /EINVAL/,
  });
});

test('LocalBlob.textRange selects a line interval as a new blob', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'a\nb\nc\nd\ne\n'));
  const first = await E(blob).textRange(0, 2); // lines 'a','b'
  t.is(await E(first).text(), 'a\nb');
  const tail = await E(blob).textRange(3, 100); // 'd','e','' clamped
  t.is(await E(tail).text(), 'd\ne\n');
});

test('LocalBlob.textRange preserves CRLF and the terminal LF', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'a\r\nb\r\n')); // CRLF, trailing LF
  const line0 = await E(blob).textRange(0, 1);
  t.is(await E(line0).text(), 'a\r'); // CR stays content, not normalized
  const both = await E(blob).textRange(0, 3); // both lines + terminal empty
  t.is(await E(both).text(), 'a\r\nb\r\n'); // final LF preserved
});

test('LocalBlob.textRange: empty, inverted, and past-end selections', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'a\nb\nc\n'));
  t.is(await E(await E(blob).textRange(1, 1)).text(), ''); // equal → empty
  t.is(await E(await E(blob).textRange(5, 9)).text(), ''); // wholly past end
  await t.throwsAsync(() => E(blob).textRange(2, 1), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).textRange(-1, 2), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).textRange(0, 1.5), { message: /EINVAL/ });
});

test('LocalBlob: byte-after-text and text-after-byte ranges compose', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'a\nbb\nccc\n'));
  // text-after-byte: a byte range then a line range of the visible bytes.
  const bytePart = await E(blob).byteRange(2n, 9n); // 'bb\nccc\n'
  t.is(await E(bytePart).text(), 'bb\nccc\n');
  const lineOfBytes = await E(bytePart).textRange(0, 1); // first visible line
  t.is(await E(lineOfBytes).text(), 'bb');
  // byte-after-text: a line range then a byte range of its bytes.
  const linePart = await E(blob).textRange(1, 3); // 'bb\nccc'
  t.is(await E(linePart).text(), 'bb\nccc');
  const byteOfLines = await E(linePart).byteRange(0n, 2n);
  t.is(await E(byteOfLines).text(), 'bb');
});

test('LocalBlob.byteRange reflects live file changes; a snapshot does not', async t => {
  const filePath = makeTemporaryFile(t, 'hello world\n');
  const blob = makeLocalBlob(filePath);
  const suffix = await E(blob).byteRange(6n, 11n); // 'world'
  t.is(await E(suffix).text(), 'world');
  // The live face observes the source at each operation (subject to the fixed
  // interval); overwrite the bytes under the same window.
  fs.writeFileSync(filePath, 'HELLO globe\n');
  t.is(await E(suffix).text(), 'globe');
});

test('LocalBlob.streamBase64 confines an attenuated view to its selected bytes', async t => {
  const payload = 'hello world\n'; // 12 bytes
  const blob = makeLocalBlob(makeTemporaryFile(t, payload));
  // The unattenuated blob streams the whole file straight off disk.
  t.is(fromUtf8(await collectBytes(blob)), payload);
  // An attenuated view streams ONLY the selected bytes: streaming is the one
  // read path that could bypass the interval by re-opening the file, so a
  // derived cap that streamed the whole file would hand back authority its
  // holder never received.
  const suffix = await E(blob).byteRange(6n, 100n);
  t.is(fromUtf8(await collectBytes(suffix)), 'world\n');
  const inner = await E(suffix).byteRange(0n, 5n);
  t.is(fromUtf8(await collectBytes(inner)), 'world');
  // An empty selection streams nothing rather than a zero-length chunk.
  const empty = await E(blob).byteRange(4n, 4n);
  t.is(fromUtf8(await collectBytes(empty)), '');
});

test('LocalBlob.help documents the surface and declines unknown methods', async t => {
  const blob = makeLocalBlob(makeTemporaryFile(t, 'hi'));
  t.regex(await E(blob).help(), /LocalBlob:.*\bbyteRange\b.*\btextRange\b/);
  t.is(await E(blob).help('nonesuch'), 'No documentation for method nonesuch.');
});

test('LocalBlob: json and textRange read an attenuated view, not the whole file', async t => {
  // The file holds two JSON documents; the selection covers only the second,
  // so a derived cap that fell back to the whole file would either parse the
  // wrong document or fail outright.
  const payload = '{"secret":1}\n{"ok":2}\n';
  const blob = makeLocalBlob(makeTemporaryFile(t, payload));
  const second = await E(blob).byteRange(13n, 21n); // '{"ok":2}'
  t.deepEqual(await E(second).json(), { ok: 2 });
  await t.throwsAsync(() => E(blob).json()); // the whole file is not one document

  const lines = makeLocalBlob(makeTemporaryFile(t, 'a\nb\nc\nd\n'));
  const tail = await E(lines).byteRange(4n, 8n); // 'c\nd\n'
  t.is(await E(await E(tail).textRange(0, 1)).text(), 'c');
  t.is(await E(await E(tail).textRange(0, 100)).text(), 'c\nd\n');
  t.is(await E(await E(tail).textRange(1, 1)).text(), '');
});
