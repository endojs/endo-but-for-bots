// Coverage for the platform's read-only node-fs primitives that the
// existing checkin / directory tests exercise only indirectly:
//   - makeLocalBlob: a read-only file blob (has its own text/json/stream
//     surface; previously only streamBase64 was exercised through the
//     local-tree → checkin path).
//   - makeLocalTree: the read-only directory tree (has() and the
//     deep-lookup path are not covered by the checkin tests).
//   - makeTreeWriter: the writeBlob / makeDirectory exo (only walked
//     transitively through checkout; direct-write coverage and the
//     parent-directory creation branch were absent).
//
// See also the cleaner pass on `packages/platform/` for PR #122.

import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { Far } from '@endo/far';

import { makeLocalBlob } from '../src/fs-node/local-blob.js';
import { makeLocalTree } from '../src/fs-node/local-tree.js';
import { makeTreeWriter } from '../src/fs-node/tree-writer.js';

/**
 * Wrap a list of chunks as a remotable AsyncIterable that satisfies both
 * the `M.remotable()` guard and `for await ... of` consumption.
 *
 * @param {Uint8Array[]} chunks
 */
const makeAsyncIterableChunks = chunks => {
  let i = 0;
  /** @type {any} */
  const exo = Far('TestAsyncIterable', {
    next: async () => {
      if (i >= chunks.length) return harden({ done: true, value: undefined });
      const value = chunks[i];
      i += 1;
      return harden({ done: false, value });
    },
    [Symbol.asyncIterator]: () => exo,
  });
  return exo;
};

/**
 * @param {import('ava').ExecutionContext} t
 * @returns {Promise<string>}
 */
const makeTemporaryDirectory = async t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'endo-test-'));
  t.teardown(() => fs.promises.rm(dir, { recursive: true, force: true }));
  return dir;
};

test('makeLocalBlob exposes text and json on a local file', async t => {
  const dir = await makeTemporaryDirectory(t);
  const filePath = path.join(dir, 'data.json');
  await fs.promises.writeFile(filePath, '{"k":"v"}', 'utf-8');

  const blob = makeLocalBlob(filePath);

  t.is(await blob.text(), '{"k":"v"}');
  t.deepEqual(await blob.json(), { k: 'v' });
});

test('makeLocalTree has() reports presence (and absence) of a single name', async t => {
  const dir = await makeTemporaryDirectory(t);
  await fs.promises.writeFile(path.join(dir, 'present.txt'), 'x', 'utf-8');

  const tree = makeLocalTree(dir);

  // The bare-receiver call returns true (the tree itself exists).
  t.true(await tree.has());
  t.true(await tree.has('present.txt'));
  t.false(await tree.has('absent.txt'));
});

test('makeLocalTree lookup descends through a multi-segment path', async t => {
  const dir = await makeTemporaryDirectory(t);
  await fs.promises.mkdir(path.join(dir, 'a', 'b'), { recursive: true });
  await fs.promises.writeFile(
    path.join(dir, 'a', 'b', 'leaf.txt'),
    'leaf-content',
    'utf-8',
  );

  const tree = makeLocalTree(dir);

  // The multi-segment array form exercises the in-tree descent
  // (local-tree.js lines 111-118).
  const blob = await tree.lookup(['a', 'b', 'leaf.txt']);
  t.is(await blob.text(), 'leaf-content');
});

test('makeLocalTree enforces the maxDepth guard', async t => {
  const dir = await makeTemporaryDirectory(t);
  await fs.promises.mkdir(path.join(dir, 'one', 'two'), { recursive: true });

  // maxDepth: 1 so the second descent (to 'two') trips the guard.
  // The error is raised lazily on traversal, not on construction;
  // descending from the root (depth 0) into 'one' (depth 1) is still
  // allowed, but the next step into 'two' (depth 2) throws.
  const tree = makeLocalTree(dir, { maxDepth: 1 });
  const oneTree = await tree.lookup('one');
  t.truthy(oneTree);
  await t.throwsAsync(() => oneTree.lookup('two'), {
    message: /Maximum directory depth/,
  });
});

test('makeTreeWriter writes a blob and creates parent directories', async t => {
  const dir = await makeTemporaryDirectory(t);

  const writer = makeTreeWriter(dir);

  // writeBlob to a deep path: parent directories are created on demand.
  const readable = makeAsyncIterableChunks([
    new TextEncoder().encode('hello '),
    new TextEncoder().encode('world'),
  ]);
  await writer.writeBlob(['nested', 'deep', 'leaf.txt'], readable);

  const text = await fs.promises.readFile(
    path.join(dir, 'nested', 'deep', 'leaf.txt'),
    'utf-8',
  );
  t.is(text, 'hello world');
});

test('makeTreeWriter makeDirectory creates a directory at the given path', async t => {
  const dir = await makeTemporaryDirectory(t);

  const writer = makeTreeWriter(dir);
  await writer.makeDirectory(['a', 'b', 'c']);

  const stat = await fs.promises.stat(path.join(dir, 'a', 'b', 'c'));
  t.true(stat.isDirectory());
});
