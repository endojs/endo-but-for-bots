// @ts-check
/// <reference types="ses"/>

// Paged directory listing over `makeGitFsBackend` (Phase 6 of
// designs/endo-fs-from-git.md), against a fake `GitBackend` that counts
// how many tree entries the listing has pulled.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { wrapBackend } from '@endo/platform/fs/extended/wrap-backend.js';

import { makeGitFsBackend } from '../src/git-filesystem.js';

const ROOT_OID = 'a'.repeat(40);
const SUB_OID = 'b'.repeat(40);
const BLOB_OID = 'c'.repeat(40);
const SHA256_BLOB_OID = 'd'.repeat(64);
const ENTRY_COUNT = 5000;

const nameAt = i => `file-${String(i).padStart(6, '0')}.txt`;

/**
 * @param {object} [options]
 * @param {boolean} [options.streaming]
 */
const makeCountingBackend = ({ streaming = true } = {}) => {
  const counts = { lsTree: 0, streamLsTree: 0, pulled: 0, released: 0 };
  const rootEntries = harden([
    { mode: '040000', type: 'tree', oid: SUB_OID, name: 'sub' },
    {
      mode: '100644',
      type: 'blob',
      oid: SHA256_BLOB_OID,
      size: 3,
      name: 'wide-oid.txt',
    },
  ]);
  const subEntryAt = i =>
    harden({
      mode: '100644',
      type: 'blob',
      oid: BLOB_OID,
      size: 3,
      name: nameAt(i),
    });
  const backend = {
    async lsTree(treeOid) {
      counts.lsTree += 1;
      if (treeOid === ROOT_OID) return rootEntries;
      if (treeOid === SUB_OID) {
        return harden(
          Array.from({ length: ENTRY_COUNT }, (_, i) => subEntryAt(i)),
        );
      }
      return harden([]);
    },
    ...(streaming
      ? {
          async *streamLsTree(treeOid) {
            counts.streamLsTree += 1;
            if (treeOid !== SUB_OID) {
              yield* treeOid === ROOT_OID ? rootEntries : [];
              return;
            }
            try {
              for (let i = 0; i < ENTRY_COUNT; i += 1) {
                counts.pulled += 1;
                yield subEntryAt(i);
              }
            } finally {
              counts.released += 1;
            }
          },
        }
      : {}),
    async *streamBlobBytes() {
      yield new Uint8Array([104, 105, 10]);
    },
  };
  const fsBackend = makeGitFsBackend({
    backend: /** @type {any} */ (backend),
    treeOid: ROOT_OID,
  });
  const filesystem = wrapBackend(fsBackend, { description: 'git-tree test' });
  return { counts, filesystem };
};

test('Cursor.read(limit) pulls one page of a wide tree from streamLsTree', async t => {
  const { counts, filesystem } = makeCountingBackend();
  const root = await E(filesystem).root();
  const sub = /** @type {any} */ (await E(root).lookup('sub'));
  // Resolving `sub` lists the root, not `sub` itself.
  t.is(counts.pulled, 0);

  const cursor = await E(sub).list();
  const first = await E(cursor).read(10n);
  t.false(first.atEnd);
  t.deepEqual(
    first.entries.map(entry => entry.name),
    Array.from({ length: 10 }, (_, i) => nameAt(i)),
  );
  // One page, not the 5,000-entry listing: the generator is pulled
  // exactly as far as the page asked for.
  t.is(counts.pulled, 10);
  t.is(counts.lsTree, 1);

  const second = await E(cursor).read(5n);
  t.deepEqual(
    second.entries.map(entry => entry.name),
    Array.from({ length: 5 }, (_, i) => nameAt(10 + i)),
  );
  t.is(counts.pulled, 15);

  // Listing entries carry the content-addressed QID.
  t.is(first.entries[0].qid.pathId, BigInt(`0x${BLOB_OID}`));

  await E(cursor).close();
  t.is(counts.released, 1);
});

test('Cursor.read() without a limit drains the streamed listing', async t => {
  const { counts, filesystem } = makeCountingBackend();
  const root = await E(filesystem).root();
  const sub = /** @type {any} */ (await E(root).lookup('sub'));
  const { entries, atEnd } = await E(await E(sub).list()).read();
  t.true(atEnd);
  t.is(entries.length, ENTRY_COUNT);
  t.is(entries.at(-1).name, nameAt(ENTRY_COUNT - 1));
  t.is(counts.pulled, ENTRY_COUNT);
});

test('a listing already cached for path resolution is replayed, not re-streamed', async t => {
  const { counts, filesystem } = makeCountingBackend();
  const root = await E(filesystem).root();
  // `lookup('sub')` cached the root listing through `lsTree`.
  await E(root).lookup('sub');
  t.is(counts.lsTree, 1);

  const { entries } = await E(await E(root).list()).read();
  t.deepEqual(
    entries.map(entry => entry.name),
    ['sub', 'wide-oid.txt'],
  );
  t.is(counts.streamLsTree, 0);
  t.is(counts.lsTree, 1);
});

test('a backend without streamLsTree falls back to the lsTree array', async t => {
  const { counts, filesystem } = makeCountingBackend({ streaming: false });
  const root = await E(filesystem).root();
  const sub = /** @type {any} */ (await E(root).lookup('sub'));
  const page = await E(await E(sub).list()).read(3n);
  t.deepEqual(
    page.entries.map(entry => entry.name),
    [nameAt(0), nameAt(1), nameAt(2)],
  );
  t.is(counts.lsTree, 2);
});

test('a 64-hex (sha256-repository) OID becomes a 256-bit QID pathId', async t => {
  const { filesystem } = makeCountingBackend();
  const root = await E(filesystem).root();
  const file = await E(root).lookup('wide-oid.txt');
  const qid = await E(file).getQid();
  t.is(qid.type, 'file');
  t.is(qid.pathId, BigInt(`0x${SHA256_BLOB_OID}`));
  t.true(qid.pathId > 2n ** 160n);
});
