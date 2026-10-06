// @ts-check
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

import {
  assertBundleDigest,
  assertSessionToken,
  assertWorkerId,
  bundleDigestOf,
} from './store-validators.js';

/** @import { ThixotropeStore, WorkerStore, WorkerMeta, TablesRecord, SessionStore } from './store.js' */

/**
 * In-memory {@link ThixotropeStore} for tests. Simulates restart survival as
 * long as the same store object is handed to each host incarnation.
 *
 * @returns {ThixotropeStore}
 */
export const makeMemoryStore = () => {
  /** @type {Map<string, { tables?: TablesRecord, meta: WorkerMeta, base: number, journal: Array<any> }>} */
  const workers = new Map();
  /** @type {any} */
  let hubState;

  /** @param {string} workerId */
  const provideWorkerStore = workerId => {
    assertWorkerId(workerId);
    let entry = workers.get(workerId);
    if (!entry) {
      entry = { tables: undefined, meta: {}, base: 0, journal: [] };
      workers.set(workerId, entry);
    }
    const state = entry;
    /** @type {WorkerStore} */
    const workerStore = {
      getTablesRecord: () => state.tables,
      setTablesRecord: record => {
        state.tables = record;
      },
      getMeta: () => state.meta,
      setMeta: meta => {
        state.meta = meta;
      },
      appendJournal: message =>
        state.journal.push(JSON.parse(JSON.stringify(message))),
      readJournal: (from = 0) =>
        state.journal.slice(Math.max(0, from - state.base)),
      journalLength: () => state.base + state.journal.length,
      truncateJournal: upTo => {
        if (upTo <= state.base) {
          return;
        }
        upTo <= state.base + state.journal.length ||
          Fail`Cannot truncate journal beyond its length`;
        state.journal = state.journal.slice(upTo - state.base);
        state.base = upTo;
      },
    };
    return harden(workerStore);
  };

  /** @type {Map<string, { meta: Record<string, any> }>} */
  const sessions = new Map();

  /** @param {string} token */
  const provideSessionStore = token => {
    assertSessionToken(token);
    let entry = sessions.get(token);
    if (!entry) {
      entry = { meta: {} };
      sessions.set(token, entry);
    }
    const state = entry;
    /** @type {SessionStore} */
    const sessionStore = {
      getMeta: () => state.meta,
      setMeta: meta => {
        state.meta = JSON.parse(JSON.stringify(meta));
      },
    };
    return harden(sessionStore);
  };

  // Bundles by digest. They live in memory, so nothing can load one as a
  // file: a daemon over this store cannot launch a native process.
  /** @type {Map<string, string>} */
  const bundles = new Map();

  /** @type {ThixotropeStore} */
  const store = {
    listWorkerIds: () => [...workers.keys()].sort(),
    provideWorkerStore,
    deleteWorker: workerId => {
      workers.delete(workerId);
    },
    getHubState: () => hubState,
    setHubState: state => {
      hubState = JSON.parse(JSON.stringify(state));
    },
    listSessionTokens: () => [...sessions.keys()].sort(),
    provideSessionStore,
    putBundle: text => {
      const digest = bundleDigestOf(text);
      if (!bundles.has(digest)) bundles.set(digest, text);
      return digest;
    },
    bundlePath: digest => {
      assertBundleDigest(digest);
      throw Fail`The memory store keeps bundles in memory, not at a path`;
    },
    readBundle: digest => {
      assertBundleDigest(digest);
      return bundles.get(digest);
    },
    listBundles: () => [...bundles.keys()].sort(),
    deleteBundle: digest => {
      assertBundleDigest(digest);
      bundles.delete(digest);
    },
  };
  return harden(store);
};
harden(makeMemoryStore);
