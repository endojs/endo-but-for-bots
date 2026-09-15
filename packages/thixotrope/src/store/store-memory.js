// @ts-check
import { Fail } from '@endo/errors';
import harden from '@endo/harden';

import { assertSessionToken, assertWorkerId } from './store-validators.js';

/** @import { ThixotropeStore, WorkerStore, WorkerMeta, TablesRecord, SessionStore } from './store-fs.js' */

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

  /** @type {Map<string, { meta: Record<string, any>, frames: Array<{ n: number, b64: string, hubSequence?: string }> }>} */
  const sessions = new Map();

  /** @param {string} token */
  const provideSessionStore = token => {
    assertSessionToken(token);
    let entry = sessions.get(token);
    if (!entry) {
      entry = { meta: {}, frames: [] };
      sessions.set(token, entry);
    }
    const state = entry;
    /** @type {SessionStore} */
    const sessionStore = {
      getMeta: () => state.meta,
      setMeta: meta => {
        state.meta = JSON.parse(JSON.stringify(meta));
      },
      appendFrame: frame => state.frames.push({ ...frame }),
      readFrames: () => state.frames.map(frame => ({ ...frame })),
      truncateFramesUpTo: upToN => {
        state.frames = state.frames.filter(frame => frame.n > upToN);
      },
    };
    return harden(sessionStore);
  };

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
    deleteSession: token => {
      sessions.delete(token);
    },
  };
  return harden(store);
};
harden(makeMemoryStore);
