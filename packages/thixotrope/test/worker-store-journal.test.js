// @ts-check

/**
 * The worker store's journal count.
 *
 * `journalLength()` is asked for every frame written to a worker, for every
 * worker at start, and for every worker on every `status`. It must not read
 * and split the whole journal each time: a busy worker's journal is long
 * exactly when it is asked most often.
 */
import test from '@endo/ses-ava/test.js';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeNodePowers } from '../src/platform/node/powers.js';
import { makeFsStore } from '../src/store/store-fs.js';

/** @import { SyncFilePowers } from '../src/platform/sync-files.js' */

const nodePowers = makeNodePowers();
const workerId = 'a'.repeat(32);

/** Count the file reads the store makes. */
const makeCountingSyncFiles = () => {
  const { syncFiles } = nodePowers;
  const counts = { readText: 0 };
  /** @type {SyncFilePowers} */
  const counting = {
    readText: path => {
      counts.readText += 1;
      return syncFiles.readText(path);
    },
    exists: path => syncFiles.exists(path),
    writeTextAtomic: (path, text, options) =>
      syncFiles.writeTextAtomic(path, text, options),
    appendTextDurable: (path, text) => syncFiles.appendTextDurable(path, text),
    makeDirectory: path => syncFiles.makeDirectory(path),
    listDirectory: path => syncFiles.listDirectory(path),
    remove: (path, options) => syncFiles.remove(path, options),
    stat: path => syncFiles.stat(path),
    isPrivateToUser: path => syncFiles.isPrivateToUser(path),
  };
  return { counting, counts };
};

/** @param {import('ava').ExecutionContext} t */
const makeStatePath = async t => {
  const path = await mkdtemp(join(tmpdir(), 'thixotrope-journal-'));
  t.teardown(() => rm(path, { recursive: true, force: true }));
  return path;
};

test('journalLength counts in memory rather than rereading the journal', async t => {
  const path = await makeStatePath(t);
  const { counting, counts } = makeCountingSyncFiles();
  const store = makeFsStore(
    { syncFiles: counting, paths: nodePowers.paths },
    path,
  );
  const worker = store.provideWorkerStore(workerId);
  t.is(worker.journalLength(), 0);
  const reads = counts.readText;

  for (let i = 0; i < 50; i += 1) {
    worker.appendJournal({ i });
    t.is(worker.journalLength(), i + 1);
  }
  t.is(counts.readText, reads, 'appends and lengths read nothing');

  t.deepEqual(worker.readJournal(48), [{ i: 48 }, { i: 49 }]);
  worker.truncateJournal(40);
  t.is(worker.journalLength(), 50, 'indices stay absolute across truncation');
  worker.appendJournal({ i: 50 });
  t.is(worker.journalLength(), 51);
  t.deepEqual(worker.readJournal(49), [{ i: 49 }, { i: 50 }]);

  // One store per worker, so every holder sees the same count.
  t.is(store.provideWorkerStore(workerId), worker);
  // A successor process reads the file once and agrees.
  const successor = makeFsStore(nodePowers, path).provideWorkerStore(workerId);
  t.is(successor.journalLength(), 51);
});

test('a torn final line is left out of the count and repaired before the next append', async t => {
  const path = await makeStatePath(t);
  const first = makeFsStore(nodePowers, path).provideWorkerStore(workerId);
  for (let i = 0; i < 3; i += 1) first.appendJournal({ i });
  // A crash mid-append leaves a partial line; the entry was never delivered.
  await appendFile(join(path, 'workers', workerId, 'journal.jsonl'), '{"i":');

  const worker = makeFsStore(nodePowers, path).provideWorkerStore(workerId);
  t.is(worker.journalLength(), 3);
  worker.appendJournal({ i: 3 });
  t.is(worker.journalLength(), 4);
  t.deepEqual(worker.readJournal(), [{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]);
});

test('deleting a worker forgets its store', async t => {
  const path = await makeStatePath(t);
  const store = makeFsStore(nodePowers, path);
  const worker = store.provideWorkerStore(workerId);
  worker.appendJournal({ i: 0 });
  t.is(worker.journalLength(), 1);
  store.deleteWorker(workerId);
  const replacement = store.provideWorkerStore(workerId);
  t.not(replacement, worker);
  t.is(replacement.journalLength(), 0);
});
