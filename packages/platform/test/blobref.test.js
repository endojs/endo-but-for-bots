// @ts-nocheck
/* eslint-disable import/order */

/**
 * BlobRef tests (F6: File.snapshot).
 *
 * `File.snapshot()` returns an immutable content-addressed handle.
 * The handle's identity (algorithm + hash + size) is captured at
 * snapshot time; later mutations to the source file are not visible
 * through the BlobRef.
 */

import '@endo/init/debug.js';
import { createHash } from 'node:crypto';

import test from 'ava';
import { E } from '@endo/eventual-send';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { makeInMemoryFilesystem } from '../src/fs/extended/in-memory.js';

const utf8 = s => new TextEncoder().encode(s);
const fromUtf8 = b => new TextDecoder().decode(b);

const writeBytes = async (writerRef, bytes) => {
  const w = iterateBytesWriter(writerRef);
  await w.next(bytes);
  await w.return();
};

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

test('snapshot returns a BlobRef with sha256 hash + size', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('x', {});
  const payload = utf8('the quick brown fox');
  await writeBytes(await E(opened).write(0n), payload);
  await E(opened).close();

  const file = await E(root).lookup('x');
  const blob = await E(file).snapshot();
  t.truthy(blob);

  const info = await E(blob).getInfo();
  t.is(info.algorithm, 'sha256');
  t.is(info.size, BigInt(payload.length));

  const expected = createHash('sha256').update(payload).digest('base64');
  t.is(info.hash, expected);
});

test('BlobRef.fetch reads the captured bytes', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('x', {});
  await writeBytes(await E(opened).write(0n), utf8('hello world'));
  await E(opened).close();

  const file = await E(root).lookup('x');
  const blob = await E(file).snapshot();
  const bytes = await collectBytes(await E(blob).fetch(0n, 64n));
  t.is(fromUtf8(bytes), 'hello world');
});

test('BlobRef.text and BlobRef.json decode the captured bytes', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('x', {});
  await writeBytes(await E(opened).write(0n), utf8('{"hello":"world"}'));
  await E(opened).close();

  const file = await E(root).lookup('x');
  const blob = await E(file).snapshot();
  t.is(await E(blob).text(), '{"hello":"world"}');
  t.deepEqual(await E(blob).json(), { hello: 'world' });
});

test('BlobRef survives a later mutation to the source file', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('x', {});
  await writeBytes(await E(opened).write(0n), utf8('original'));
  await E(opened).close();

  const file = await E(root).lookup('x');
  const blob = await E(file).snapshot();

  // Mutate the source after the snapshot.
  const opened2 = await E(file).open({ write: true, truncate: true });
  await writeBytes(await E(opened2).write(0n), utf8('different content'));
  await E(opened2).close();

  // BlobRef still yields the original bytes.
  const bytes = await collectBytes(await E(blob).fetch(0n, 64n));
  t.is(fromUtf8(bytes), 'original');

  // The file itself has the new content.
  const fresh = await E(file).open({ read: true });
  const after = await collectBytes(await E(fresh).read(0n, 64n));
  t.is(fromUtf8(after), 'different content');
});

test('BlobRef.fetch with offset returns the suffix', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('x', {});
  await writeBytes(await E(opened).write(0n), utf8('abcdefghij'));
  await E(opened).close();
  const file = await E(root).lookup('x');
  const blob = await E(file).snapshot();
  const bytes = await collectBytes(await E(blob).fetch(3n, 4n));
  t.is(fromUtf8(bytes), 'defg');
});

// Snapshot a byte payload as an immutable BlobRef for the attenuation tests.
const snapshotOf = async payload => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('x', {});
  await writeBytes(await E(opened).write(0n), payload);
  await E(opened).close();
  const file = await E(root).lookup('x');
  return E(file).snapshot();
};

test('BlobRef.range attenuates to a new BlobRef over the byte interval', async t => {
  const blob = await snapshotOf(utf8('hello world\n')); // 12 bytes
  const suffix = await E(blob).range(6n, 100n); // clamps at EOF → 'world\n'
  t.is(await E(suffix).text(), 'world\n');
  // A range of a range intersects and can never regain authority.
  const inner = await E(suffix).range(0n, 5n); // 'world'
  t.is(await E(inner).text(), 'world');
  t.is(await E(await E(inner).range(0n, 100n)).text(), 'world');
  // getInfo reports the selected content's own SHA-256.
  const info = await E(inner).getInfo();
  t.is(info.size, 5n);
  t.is(info.hash, createHash('sha256').update('world').digest('base64'));
  // Windowed reads apply to the attenuated bytes.
  t.is(fromUtf8(await collectBytes(await E(inner).fetch(1n, 3n))), 'orl');
});

test('BlobRef.range: empty selection has the sha256 of empty bytes', async t => {
  const blob = await snapshotOf(utf8('hello world\n'));
  const empty = await E(blob).range(4n, 4n);
  t.is(await E(empty).text(), '');
  const info = await E(empty).getInfo();
  t.is(info.size, 0n);
  t.is(info.hash, '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
  // A wholly-past-EOF range is a valid empty attenuation.
  t.is(await E(await E(blob).range(100n, 200n)).text(), '');
});

test('BlobRef.range rejects invalid arguments with EINVAL', async t => {
  const blob = await snapshotOf(utf8('hello world\n'));
  await t.throwsAsync(() => E(blob).range(-1n, 4n), { message: /EINVAL/ });
  await t.throwsAsync(() => E(blob).range(5n, 2n), { message: /EINVAL/ });
});

test('BlobRef.textRange selects a line interval; CRLF and terminal LF preserved', async t => {
  const blob = await snapshotOf(utf8('a\nb\nc\nd\ne\n'));
  t.is(await E(await E(blob).textRange(0, 2)).text(), 'a\nb');
  t.is(await E(await E(blob).textRange(3, 100)).text(), 'd\ne\n'); // clamps
  t.is(await E(await E(blob).textRange(1, 1)).text(), ''); // equal → empty

  const crlf = await snapshotOf(utf8('a\r\nb\r\n'));
  t.is(await E(await E(crlf).textRange(0, 1)).text(), 'a\r'); // CR stays content
  t.is(await E(await E(crlf).textRange(0, 3)).text(), 'a\r\nb\r\n'); // final LF kept
});

test('BlobRef: a range of an immutable snapshot is stable', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('x', {});
  await writeBytes(await E(opened).write(0n), utf8('original bytes'));
  await E(opened).close();
  const file = await E(root).lookup('x');
  const blob = await E(file).snapshot();
  const part = await E(blob).range(0n, 8n); // 'original'
  t.is(await E(part).text(), 'original');

  // Mutate the source after taking the range.
  const opened2 = await E(file).open({ write: true, truncate: true });
  await writeBytes(await E(opened2).write(0n), utf8('different content'));
  await E(opened2).close();

  // The attenuated snapshot is unchanged.
  t.is(await E(part).text(), 'original');
});

test('snapshot of empty file has zero size and the known sha256(empty)', async t => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  const opened = await E(root).create('e', {});
  await E(opened).close();
  const file = await E(root).lookup('e');
  const blob = await E(file).snapshot();
  const info = await E(blob).getInfo();
  t.is(info.size, 0n);
  // sha256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  // base64-encoded:
  t.is(info.hash, '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
});
