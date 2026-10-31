// @ts-check
/** @import { SyncFilePowers } from '../platform/sync-files.js' */
/** @import { PathPowers } from '../platform/paths.js' */
/** @import { SessionStore, TablesRecord, ThixotropeStore, WorkerMeta, WorkerStore } from './store.js' */
import { Fail, q } from '@endo/errors';
import harden from '@endo/harden';

import {
  assertBundleDigest,
  assertSessionToken,
  assertWorkerId,
  bundleDigestOf,
} from './store-validators.js';

export { assertWorkerId, isSessionToken } from './store-validators.js';

/**
 * Filesystem-backed {@link ThixotropeStore}. All writes are synchronous
 * write-through so durable state always precedes any message reaching a
 * worker ("disk before graph").
 *
 * Layout under `statePath`:
 * - `workers/<workerId>/meta.json`
 * - `workers/<workerId>/tables.json`
 * - `workers/<workerId>/journal.jsonl`
 * - `sessions/<token>/meta.json`
 * - `bundles/<digest>.cjs`
 *
 * @param {{ syncFiles: SyncFilePowers, paths: PathPowers }} powers
 * @param {string} statePath
 * @returns {ThixotropeStore}
 */
export const makeFsStore = ({ syncFiles, paths }, statePath) => {
  const { join } = paths;
  /**
   * @param {string} path
   * @returns {any}
   */
  const readJsonMaybe = path => {
    if (!syncFiles.exists(path)) {
      return undefined;
    }
    return JSON.parse(syncFiles.readText(path));
  };

  const workersPath = join(statePath, 'workers');
  const sessionsPath = join(statePath, 'sessions');
  const bundlesPath = join(statePath, 'bundles');
  syncFiles.makeDirectory(workersPath);
  syncFiles.makeDirectory(sessionsPath);
  syncFiles.makeDirectory(bundlesPath);

  /** @param {string} digest */
  const bundlePath = digest => {
    assertBundleDigest(digest);
    return join(bundlesPath, `${digest}.cjs`);
  };

  /** @param {string} token */
  const makeSessionStore = token => {
    assertSessionToken(token);
    const sessionPath = join(sessionsPath, token);
    syncFiles.makeDirectory(sessionPath);
    const metaPath = join(sessionPath, 'meta.json');
    /** @type {SessionStore} */
    const sessionStore = {
      getMeta: () => readJsonMaybe(metaPath) ?? {},
      setMeta: meta =>
        syncFiles.writeTextAtomic(metaPath, `${JSON.stringify(meta)}\n`),
    };
    return harden(sessionStore);
  };

  /** @param {string} workerId */
  const makeWorkerStore = workerId => {
    assertWorkerId(workerId);
    const workerPath = join(workersPath, workerId);
    syncFiles.makeDirectory(workerPath);
    const tablesPath = join(workerPath, 'tables.json');
    const metaPath = join(workerPath, 'meta.json');
    const journalPath = join(workerPath, 'journal.jsonl');

    // The journal's first line is a header recording the absolute index
    // of the first entry line, so truncation can drop a prefix while
    // keeping absolute indices stable. Truncation rewrites the file via
    // rename so the base and the entries change atomically. Appends are
    // plain appends, so a crash mid-append can leave a torn final line;
    // it is dropped on the first read (safe, because the host journals
    // before delivering: a torn entry was never delivered) and the file
    // is repaired before any further append so the tear cannot swallow
    // the next entry.

    /** @param {string} line */
    const isWholeJsonLine = line => {
      try {
        JSON.parse(line);
        return true;
      } catch (_error) {
        return false;
      }
    };

    let journalRepaired = false;
    // The journal's length, from the file the first time and from memory
    // after: this store is the directory's only writer under the lease, and
    // the length is asked for every frame written, so it must not cost a
    // read of the whole journal each time.
    let journalBase = 0;
    let journalCount = 0;
    let journalCounted = false;

    /** @returns {{ base: number, lines: Array<string> }} */
    const readJournalFile = () => {
      if (!syncFiles.exists(journalPath)) {
        journalBase = 0;
        journalCount = 0;
        journalCounted = true;
        return { base: 0, lines: [] };
      }
      const text = syncFiles.readText(journalPath);
      const lines = text.split('\n').filter(line => line !== '');
      const header = JSON.parse(lines[0] ?? '{}');
      typeof header.base === 'number' ||
        Fail`Journal at ${q(journalPath)} is missing its base header`;
      let entries = lines.slice(1);
      if (entries.length > 0 && !isWholeJsonLine(entries[entries.length - 1])) {
        // Torn final line from a crash mid-append: the entry was never
        // delivered, so forgetting it is correct.
        entries = entries.slice(0, -1);
        writeJournalFile(header.base, entries);
      }
      journalBase = header.base;
      journalCount = entries.length;
      journalCounted = true;
      return { base: header.base, lines: entries };
    };

    /**
     * @param {number} base
     * @param {Array<string>} lines
     */
    const writeJournalFile = (base, lines) => {
      const text = [JSON.stringify({ base }), ...lines, ''].join('\n');
      syncFiles.writeTextAtomic(journalPath, text);
      journalRepaired = true;
      journalBase = base;
      journalCount = lines.length;
      journalCounted = true;
    };

    const ensureJournalRepaired = () => {
      if (!journalRepaired) {
        // Reading repairs a torn tail (rewriting the file) so a
        // subsequent append cannot concatenate onto a partial line.
        readJournalFile();
        journalRepaired = true;
      }
    };

    /** @type {WorkerStore} */
    const workerStore = {
      getTablesRecord: () => readJsonMaybe(tablesPath),
      setTablesRecord: record =>
        syncFiles.writeTextAtomic(tablesPath, `${JSON.stringify(record)}\n`),
      getMeta: () => readJsonMaybe(metaPath) ?? {},
      setMeta: meta =>
        syncFiles.writeTextAtomic(metaPath, `${JSON.stringify(meta)}\n`),
      appendJournal: entry => {
        if (!syncFiles.exists(journalPath)) {
          writeJournalFile(0, []);
        }
        ensureJournalRepaired();
        if (!journalCounted) readJournalFile();
        syncFiles.appendTextDurable(journalPath, `${JSON.stringify(entry)}\n`);
        // Counted once durable: a failed append leaves the length as it was.
        journalCount += 1;
      },
      readJournal: (from = 0) => {
        const { base, lines } = readJournalFile();
        return lines
          .slice(Math.max(0, from - base))
          .map(line => JSON.parse(line));
      },
      journalLength: () => {
        if (!journalCounted) readJournalFile();
        return journalBase + journalCount;
      },
      truncateJournal: upTo => {
        const { base, lines } = readJournalFile();
        if (upTo <= base) {
          return;
        }
        upTo <= base + lines.length ||
          Fail`Cannot truncate journal beyond its length`;
        writeJournalFile(upTo, lines.slice(upTo - base));
      },
    };
    return harden(workerStore);
  };

  // One store per worker, so every holder of a worker's store shares its
  // journal count.
  /** @type {Map<string, WorkerStore>} */
  const workerStores = new Map();

  /** @type {ThixotropeStore} */
  const store = {
    statePath,
    listWorkerIds: () =>
      syncFiles.exists(workersPath)
        ? syncFiles.listDirectory(workersPath).sort()
        : [],
    provideWorkerStore: workerId => {
      let workerStore = workerStores.get(workerId);
      if (workerStore === undefined) {
        workerStore = makeWorkerStore(workerId);
        workerStores.set(workerId, workerStore);
      }
      return workerStore;
    },
    deleteWorker: workerId => {
      assertWorkerId(workerId);
      workerStores.delete(workerId);
      syncFiles.remove(join(workersPath, workerId), {
        recursive: true,
        force: true,
      });
    },
    getHubState: () => readJsonMaybe(join(statePath, 'hub.json')),
    setHubState: state =>
      syncFiles.writeTextAtomic(
        join(statePath, 'hub.json'),
        `${JSON.stringify(state)}\n`,
      ),
    listSessionTokens: () =>
      syncFiles.exists(sessionsPath)
        ? syncFiles.listDirectory(sessionsPath).sort()
        : [],
    provideSessionStore: makeSessionStore,
    putBundle: text => {
      const digest = bundleDigestOf(text);
      const path = bundlePath(digest);
      // The digest names the bytes: a file already there holds them.
      if (!syncFiles.exists(path)) syncFiles.writeTextAtomic(path, text);
      return digest;
    },
    bundlePath,
    readBundle: digest => {
      const path = bundlePath(digest);
      return syncFiles.exists(path) ? syncFiles.readText(path) : undefined;
    },
    listBundles: () =>
      syncFiles
        .listDirectory(bundlesPath)
        .flatMap(name => {
          // A scratch file left by a crash before its rename is not a bundle.
          const match = /^([0-9a-f]{64})\.cjs$/.exec(name);
          return match ? [match[1]] : [];
        })
        .sort(),
    deleteBundle: digest => {
      syncFiles.remove(bundlePath(digest), { force: true });
    },
  };
  return harden(store);
};
harden(makeFsStore);
