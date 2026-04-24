import test from '@endo/ses-ava/prepare-endo.js';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { checkinTree } from '../src/fs/checkin.js';
import { makeLocalTree } from '../src/fs-node/local-tree.js';
import { makeSnapshotStore } from '../src/fs/snapshot-store.js';

/**
 * A simple in-memory content store for testing.
 */
const makeMemoryContentStore = () => {
  /** @type {Map<string, Uint8Array>} */
  const blobs = new Map();
  let counter = 0;

  const computeSha256 = bytes => {
    // Simple hash for testing (not cryptographic).
    let hash = 0;
    for (const b of bytes) {
      // Use arithmetic instead of bitwise to satisfy no-bitwise.
      hash = Math.trunc((hash * 31 + b) % 2147483647);
    }
    counter += 1;
    return `memhash-${Math.abs(hash).toString(16)}-${counter}`;
  };

  return harden({
    store: async readable => {
      const chunks = [];
      for await (const chunk of readable) {
        chunks.push(chunk);
      }
      const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        total.set(chunk, offset);
        offset += chunk.length;
      }
      const sha256 = computeSha256(total);
      blobs.set(sha256, total);
      return sha256;
    },
    fetch: sha256 => {
      const data = blobs.get(sha256);
      if (!data) throw new Error(`Not found: ${sha256}`);
      return harden({
        streamBase64: () => {
          throw new Error('Not implemented in test');
        },
        text: async () => new TextDecoder().decode(data),
        json: async () => JSON.parse(new TextDecoder().decode(data)),
      });
    },
    has: async sha256 => blobs.has(sha256),
  });
};

/**
 * @param {import('ava').ExecutionContext} _t
 * @returns {Promise<string>}
 */
const makeTmpDir = async _t => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'endo-ci-'));
  return dir;
};

const scaffold = async root => {
  await fs.promises.mkdir(path.join(root, 'sub'), { recursive: true });
  await fs.promises.writeFile(path.join(root, 'a.txt'), 'alpha', 'utf-8');
  await fs.promises.writeFile(path.join(root, 'b.txt'), 'beta', 'utf-8');
  await fs.promises.writeFile(
    path.join(root, 'sub', 'c.txt'),
    'charlie',
    'utf-8',
  );
};

test('checkinTree ingests a local tree into a store', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const contentStore = makeMemoryContentStore();
  const store = makeSnapshotStore(contentStore);
  const tree = makeLocalTree(dir);

  const result = await checkinTree(tree, store);
  t.is(result.type, 'tree');
  t.is(typeof result.sha256, 'string');
  t.true(result.sha256.length > 0);

  await fs.promises.rm(dir, { recursive: true });
});

test('checkinTree produces a loadable snapshot tree', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const contentStore = makeMemoryContentStore();
  const store = makeSnapshotStore(contentStore);
  const tree = makeLocalTree(dir);

  const { sha256 } = await checkinTree(tree, store);
  const snapshotTree = store.loadTree(sha256);

  // The snapshot tree should be navigable.
  const entries = await snapshotTree.list();
  const names = entries.map(e => (typeof e === 'string' ? e : e));
  t.true(names.length >= 3, 'tree has at least 3 entries');

  // Lookup a file and read its text.
  const aBlob = await snapshotTree.lookup('a.txt');
  t.is(await aBlob.text(), 'alpha');

  await fs.promises.rm(dir, { recursive: true });
});

test('snapshot tree has() method', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const contentStore = makeMemoryContentStore();
  const store = makeSnapshotStore(contentStore);
  const { sha256 } = await checkinTree(makeLocalTree(dir), store);
  const snapshotTree = store.loadTree(sha256);

  t.true(await snapshotTree.has());
  t.true(await snapshotTree.has('a.txt'));
  t.true(await snapshotTree.has('sub'));
  t.false(await snapshotTree.has('nonexistent'));
  // Deep path
  t.true(await snapshotTree.has('sub', 'c.txt'));
  t.false(await snapshotTree.has('sub', 'nope'));

  await fs.promises.rm(dir, { recursive: true });
});

test('snapshot tree list() with subpath', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const contentStore = makeMemoryContentStore();
  const store = makeSnapshotStore(contentStore);
  const { sha256 } = await checkinTree(makeLocalTree(dir), store);
  const snapshotTree = store.loadTree(sha256);

  const subEntries = await snapshotTree.list('sub');
  t.deepEqual(subEntries, ['c.txt']);

  await fs.promises.rm(dir, { recursive: true });
});

test('snapshot tree lookup() with multi-segment path', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const contentStore = makeMemoryContentStore();
  const store = makeSnapshotStore(contentStore);
  const { sha256 } = await checkinTree(makeLocalTree(dir), store);
  const snapshotTree = store.loadTree(sha256);

  // Multi-segment lookup via array
  const cBlob = await snapshotTree.lookup(['sub', 'c.txt']);
  t.is(await cBlob.text(), 'charlie');

  await fs.promises.rm(dir, { recursive: true });
});

test('snapshot tree lookup() throws for unknown name', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const contentStore = makeMemoryContentStore();
  const store = makeSnapshotStore(contentStore);
  const { sha256 } = await checkinTree(makeLocalTree(dir), store);
  const snapshotTree = store.loadTree(sha256);

  await t.throwsAsync(() => snapshotTree.lookup('nonexistent'), {
    message: /Unknown name/,
  });

  await fs.promises.rm(dir, { recursive: true });
});

test('checkinTree with nested directory', async t => {
  const dir = await makeTmpDir(t);
  await scaffold(dir);

  const contentStore = makeMemoryContentStore();
  const store = makeSnapshotStore(contentStore);
  const tree = makeLocalTree(dir);

  const result = await checkinTree(tree, store);
  t.is(result.type, 'tree');

  // The stored content should be accessible via the store.
  t.true(await contentStore.has(result.sha256));

  await fs.promises.rm(dir, { recursive: true });
});
