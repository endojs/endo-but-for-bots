// @ts-nocheck
/* eslint-disable import/order, no-await-in-loop */

/**
 * Streaming clone tests (designs/endo-app-sharing.md, Pillar 3c).
 *
 * `cloneTree(source, dest)` ships a whole tree as one ordered frame
 * stream and recreates it under a destination Directory. These tests
 * build an in-memory source, clone it into a fresh in-memory
 * destination, and assert the structure and bytes round-trip — including
 * empty files, empty directories, deep nesting, and multi-chunk content.
 */

import '@endo/init/debug.js';

import test from 'ava';
import { E } from '@endo/far';
import { iterateBytesReader } from '@endo/exo-stream/iterate-bytes-reader.js';
import { iterateBytesWriter } from '@endo/exo-stream/iterate-bytes-writer.js';

import { makeInMemoryFilesystem } from '../src/in-memory.js';
import { cloneTree, streamTree, writeTreeStream } from '../src/clone.js';

const utf8 = s => new TextEncoder().encode(s);
const fromUtf8 = b => new TextDecoder().decode(b);

const collectBytes = async readerRef => {
  const chunks = [];
  let total = 0;
  for await (const chunk of iterateBytesReader(readerRef)) {
    chunks.push(chunk);
    total += chunk.length;
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return buf;
};

const writeBytes = async (writerRef, bytes) => {
  const writer = iterateBytesWriter(writerRef);
  await writer.next(bytes);
  await writer.return();
};

/** Create a file with `bytes` at `name` under directory `dir`. */
const putFile = async (dir, name, bytes) => {
  const open = await E(dir).create(name, {});
  if (bytes.length) {
    await writeBytes(await E(open).write(0n), bytes);
  }
  await E(open).close();
};

/** Read the bytes of the file at `path` (string[]) under `root`. */
const readFileAt = async (root, path) => {
  let node = root;
  for (const seg of path) {
    node = await E(node).lookup(seg);
  }
  const open = await E(node).open({ read: true });
  return collectBytes(await E(open).read(0n));
};

/** True if a child `name` exists under directory `dir`. */
const childKinds = async dir => {
  const cursor = await E(dir).list();
  const entries = await E(cursor).toArray();
  const map = new Map();
  for (const { name, qid } of entries) {
    map.set(name, qid.type);
  }
  return map;
};

/**
 * Build a source tree:
 *   /readme.txt          "top level\n"
 *   /empty.txt           (zero bytes)
 *   /emptydir/           (no children)
 *   /src/index.js        "export const x = 1;\n"
 *   /src/deep/nested.txt  larger, multi-write content
 */
const buildSource = async () => {
  const fs = makeInMemoryFilesystem();
  const root = await E(fs).root();
  await putFile(root, 'readme.txt', utf8('top level\n'));
  await putFile(root, 'empty.txt', utf8(''));
  await E(root).makeDirectory('emptydir', {});
  const src = await E(root).makeDirectory('src', {});
  await putFile(src, 'index.js', utf8('export const x = 1;\n'));
  const deep = await E(src).makeDirectory('deep', {});
  // A larger payload written as several chunks, to exercise multi-chunk
  // streaming through the single frame stream.
  const big = 'abcdefghij'.repeat(5000); // 50 KiB
  const open = await E(deep).create('nested.txt', {});
  const writer = iterateBytesWriter(await E(open).write(0n));
  await writer.next(utf8(big.slice(0, 20000)));
  await writer.next(utf8(big.slice(20000)));
  await writer.return();
  await E(open).close();
  return { fs, root, big };
};

test('cloneTree reproduces the full tree and its bytes', async t => {
  const { root: source, big } = await buildSource();

  const destFs = makeInMemoryFilesystem();
  const dest = await E(destFs).root();

  const stats = await cloneTree(source, dest);

  // Directories: emptydir, src, src/deep → 3. Files: readme.txt,
  // empty.txt, src/index.js, src/deep/nested.txt → 4.
  t.is(stats.directories, 3);
  t.is(stats.files, 4);
  t.is(stats.bytes, 10 + 0 + 20 + big.length);

  t.is(fromUtf8(await readFileAt(dest, ['readme.txt'])), 'top level\n');
  t.is(fromUtf8(await readFileAt(dest, ['empty.txt'])), '');
  t.is(
    fromUtf8(await readFileAt(dest, ['src', 'index.js'])),
    'export const x = 1;\n',
  );
  t.is(fromUtf8(await readFileAt(dest, ['src', 'deep', 'nested.txt'])), big);

  // Empty directory is materialised even though it has no children.
  const top = await childKinds(dest);
  t.is(top.get('emptydir'), 'directory');
  t.is(top.get('src'), 'directory');
  t.is(top.get('readme.txt'), 'file');
  t.is(top.get('empty.txt'), 'file');
});

test('cloneTree of a sub-directory clones only that subtree', async t => {
  const { root: source } = await buildSource();
  const src = await E(source).lookup('src');

  const destFs = makeInMemoryFilesystem();
  const dest = await E(destFs).root();

  const stats = await cloneTree(src, dest);
  t.is(stats.files, 2); // index.js + deep/nested.txt
  t.is(stats.directories, 1); // deep

  t.is(
    fromUtf8(await readFileAt(dest, ['index.js'])),
    'export const x = 1;\n',
  );
  const top = await childKinds(dest);
  t.false(top.has('readme.txt')); // outside the cloned subtree
});

test('streamTree + writeTreeStream compose explicitly', async t => {
  const { root: source } = await buildSource();
  const destFs = makeInMemoryFilesystem();
  const dest = await E(destFs).root();

  // Equivalent to cloneTree, but with the producer/consumer split visible.
  const reader = streamTree(source, { buffer: 4 });
  const stats = await writeTreeStream(dest, reader);

  t.is(stats.files, 4);
  t.is(fromUtf8(await readFileAt(dest, ['readme.txt'])), 'top level\n');
});

test('cloning an empty tree yields zero counts', async t => {
  const srcFs = makeInMemoryFilesystem();
  const source = await E(srcFs).root();
  const destFs = makeInMemoryFilesystem();
  const dest = await E(destFs).root();

  const stats = await cloneTree(source, dest);
  t.deepEqual({ ...stats }, { directories: 0, files: 0, bytes: 0 });
});
