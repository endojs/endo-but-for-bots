// @ts-check

import '@endo/init/debug.js';

import { wrapTest } from '@endo/ses-ava';
import rawTest from 'ava';
import { bytesFromText } from '@endo/bytes/from-string.js';
import Database from 'better-sqlite3';

import {
  hashObject,
  makeGitObjectStore,
  makeMemoryOidIndex,
  makeSqliteOidIndex,
  serializeCommit,
  serializeTree,
} from '../index.js';
import { nodeDigest } from '../src/node-digest.js';
import { makeMemoryContentStore } from './helpers.js';

/** @import { GitHashAlgorithm, GitObjectId, GitObjectType } from '../src/types.js' */

const test = wrapTest(rawTest);

const makeStore = () => {
  const contentStore = makeMemoryContentStore();
  const oidIndex = makeMemoryOidIndex();
  const store = makeGitObjectStore({
    contentStore,
    oidIndex,
    hashAlgorithm: 'sha1',
    digest: nodeDigest,
  });
  return { store, contentStore, oidIndex };
};

const makeBatchCountingIndex = () => {
  const inner = makeMemoryOidIndex();
  /** @type {number[]} */
  const batchLengths = [];
  return {
    batchLengths,
    index: harden({
      /**
       * @param {GitHashAlgorithm} algorithm
       * @param {GitObjectId} oid
       */
      get: (algorithm, oid) => inner.get(algorithm, oid),
      /**
       * @param {GitHashAlgorithm} algorithm
       * @param {GitObjectId[]} oids
       */
      getMany: async (algorithm, oids) => {
        batchLengths.push(oids.length);
        return inner.getMany(algorithm, oids);
      },
      /**
       * @param {GitHashAlgorithm} algorithm
       * @param {GitObjectId} oid
       * @param {GitObjectType} type
       * @param {string} casHash
       */
      put: (algorithm, oid, type, casHash) =>
        inner.put(algorithm, oid, type, casHash),
      /**
       * @param {GitHashAlgorithm} algorithm
       * @param {GitObjectId} oid
       */
      has: (algorithm, oid) => inner.has(algorithm, oid),
    }),
  };
};

test('writeObject stores content without header and indexes oid', async t => {
  const { store, contentStore, oidIndex } = makeStore();
  const content = bytesFromText('payload\n');
  const oid = await store.writeObject('blob', content);

  t.is(oid, hashObject('sha1', nodeDigest, 'blob', content));
  t.true(await store.hasObject(oid));

  const entry = await oidIndex.get('sha1', oid);
  if (entry === undefined) {
    t.fail('expected oid index entry');
    return;
  }
  t.is(entry.type, 'blob');

  // CAS blob equals content bytes (no framing header).
  const blob = contentStore.fetch(entry.casHash);
  const readRange = blob.readRange;
  const sizeFn = blob.size;
  if (readRange === undefined || sizeFn === undefined) {
    t.fail('memory content store must expose readRange/size');
    return;
  }
  const casBytes = await readRange(0, content.byteLength);
  t.deepEqual(casBytes, content);
  // Header would have added type/length prefix; ensure size matches content.
  t.is(await sizeFn(), BigInt(content.byteLength));
});

test('readObject and readObjects round-trip', async t => {
  const { store } = makeStore();
  const a = await store.writeObject('blob', bytesFromText('a\n'));
  const b = await store.writeObject('blob', bytesFromText('b\n'));
  const missing = '0'.repeat(40);

  const one = await store.readObject(a);
  t.is(one.type, 'blob');
  t.is(one.oid, a);
  t.deepEqual(one.content, bytesFromText('a\n'));

  const batch = await store.readObjects([a, missing, b]);
  t.is(batch.length, 3);
  t.is(batch[0] && batch[0].oid, a);
  t.is(batch[1], undefined);
  t.is(batch[2] && batch[2].oid, b);
});

test('readObjects bounds capability batches and preserves order', async t => {
  await null;
  const contentStore = makeMemoryContentStore();
  const { index, batchLengths } = makeBatchCountingIndex();
  const store = makeGitObjectStore({
    contentStore,
    oidIndex: index,
    hashAlgorithm: 'sha1',
    digest: nodeDigest,
    maxBatchSize: 2,
  });
  const oids = [];
  for (const value of ['a', 'b', 'c', 'd', 'e']) {
    // eslint-disable-next-line no-await-in-loop
    oids.push(await store.writeObject('blob', bytesFromText(`${value}\n`)));
  }

  const objects = await store.readObjects(oids);
  t.deepEqual(
    objects.map(object => object && object.oid),
    oids,
  );
  t.deepEqual(batchLengths, [2, 2, 1]);
  t.true(batchLengths.every(length => length <= 2));
});

test('writeObject is idempotent for the same content', async t => {
  const { store, contentStore } = makeStore();
  const content = bytesFromText('same\n');
  const oid1 = await store.writeObject('blob', content);
  const oid2 = await store.writeObject('blob', content);
  t.is(oid1, oid2);
  t.is(contentStore.size(), 1);
});

test('sqlite oid index backs the store', async t => {
  const db = new Database(':memory:');
  t.teardown(() => db.close());
  const contentStore = makeMemoryContentStore();
  const oidIndex = makeSqliteOidIndex(db);
  const store = makeGitObjectStore({
    contentStore,
    oidIndex,
    hashAlgorithm: 'sha1',
    digest: nodeDigest,
  });

  const blobOid = await store.writeObject('blob', bytesFromText('x\n'));
  const treeContent = serializeTree(
    [{ mode: '100644', name: 'x', oid: blobOid }],
    'sha1',
  );
  const treeOid = await store.writeObject('tree', treeContent);
  const commitContent = serializeCommit({
    tree: treeOid,
    parents: [],
    author: {
      name: 'T',
      email: 't@e',
      when: '1',
      tz: '+0000',
    },
    committer: {
      name: 'T',
      email: 't@e',
      when: '1',
      tz: '+0000',
    },
    message: 'c\n',
  });
  const commitOid = await store.writeObject('commit', commitContent);

  const batch = await store.readObjects([commitOid, treeOid, blobOid]);
  t.is(batch[0] && batch[0].type, 'commit');
  t.is(batch[1] && batch[1].type, 'tree');
  t.is(batch[2] && batch[2].type, 'blob');
});
