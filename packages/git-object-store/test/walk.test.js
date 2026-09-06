// @ts-check

import '@endo/init/debug.js';

import harden from '@endo/harden';
import { wrapTest } from '@endo/ses-ava';
import rawTest from 'ava';
import path from 'node:path';
import url from 'node:url';

import {
  diffCommits,
  makeGitObjectStore,
  makeMemoryOidIndex,
  parseCommit,
  walkCommitLog,
  walkTree,
} from '../index.js';
import { nodeDigest } from '../src/node-digest.js';
import { makeMemoryContentStore } from './helpers.js';
import { ingestGitRepository } from './ingest.js';

const test = wrapTest(rawTest);

const packageDir = url.fileURLToPath(new URL('..', import.meta.url));
// This Endo checkout is the fixture repository.
const repoPath = path.resolve(packageDir, '../..');

test('ingest this repository and walk log/tree/diff with batched reads', async t => {
  t.timeout(120_000);

  const contentStore = makeMemoryContentStore();
  const oidIndex = makeMemoryOidIndex();
  /** @type {number} */
  let readObjectsCalls = 0;
  const inner = makeGitObjectStore({
    contentStore,
    oidIndex,
    hashAlgorithm: 'sha1',
    digest: nodeDigest,
  });
  // Wrap to count batch reads; the walk helpers must exercise readObjects.
  const store = harden({
    getHashAlgorithm: inner.getHashAlgorithm,
    hasObject: oid => inner.hasObject(oid),
    readObject: oid => inner.readObject(oid),
    /**
     * @param {string[]} oids
     */
    readObjects: async oids => {
      readObjectsCalls += 1;
      return inner.readObjects(oids);
    },
    writeObject: (type, content) => inner.writeObject(type, content),
  });

  const maxCommits = 20;
  const ingest = await ingestGitRepository({
    repoPath,
    store,
    maxCommits,
  });

  t.true(ingest.ingested > 0, 'ingested at least one object');
  t.true((ingest.byType.commit || 0) > 0, 'ingested at least one commit');
  t.true((ingest.byType.tree || 0) > 0, 'ingested at least one tree');
  t.true((ingest.byType.blob || 0) > 0, 'ingested at least one blob');

  // Library tests stay silent by default; this one line reports fixture
  // proof numbers for the G1 acceptance criteria on stderr.
  console.error(
    JSON.stringify({
      fixture: 'endo-but-for-bots (this checkout)',
      headOid: ingest.headOid,
      maxCommits,
      ingested: ingest.ingested,
      byType: ingest.byType,
    }),
  );

  const beforeBatchCount = readObjectsCalls;
  const log = await walkCommitLog(store, ingest.headOid, {
    maxCount: maxCommits,
  });
  t.true(log.length > 0);
  t.is(log[0].oid, ingest.headOid);
  t.true(
    readObjectsCalls > beforeBatchCount,
    'walkCommitLog must call readObjects',
  );

  const headCommit = await store.readObject(ingest.headOid);
  t.is(headCommit.type, 'commit');
  const parsedHead = parseCommit(headCommit.content);
  const beforeTreeBatch = readObjectsCalls;
  const treeEntries = await walkTree(store, parsedHead.tree);
  t.true(treeEntries.length > 0);
  t.true(
    treeEntries.some(e => !e.isTree),
    'tree walk finds at least one blob path',
  );
  t.true(
    readObjectsCalls > beforeTreeBatch,
    'walkTree must call readObjects for nested trees',
  );

  if (log.length >= 2) {
    const beforeDiffBatch = readObjectsCalls;
    const changes = await diffCommits(store, log[1].oid, log[0].oid);
    t.true(Array.isArray(changes));
    t.true(
      readObjectsCalls > beforeDiffBatch,
      'diffCommits must call readObjects',
    );
  } else {
    t.pass('single-commit history; skipped commit-to-commit diff');
  }
});
