// @ts-check
/** @import { NodePowers } from '../platform/node-powers.js' */
import harden from '@endo/harden';

import { Fail, q } from '@endo/errors';

import { assertSessionToken, assertWorkerId } from './store-validators.js';

export { assertWorkerId, isSessionToken } from './store-validators.js';

/**
 * The daemon-side record of one endpoint session: export descriptions,
 * resolver obligations, and the answer epoch
 * (worker-session-records.js).
 *
 * @typedef {Record<string, any>} TablesRecord
 */

/**
 * @typedef {object} WorkerMeta
 * @property {string} [debugLabel] optional human-readable label; used
 *   only in diagnostics, never as an identifier
 * @property {string} [failure] deterministic halt; retained for inspection
 * @property {string} [hubDelivery] highest hub outbox sequence covered by the snapshot
 * @property {{ ref: unknown, cut?: number } | null} [snapshot]
 *   the engine snapshot and the absolute journal index (`cut`) it
 *   subsumes
 * @property {number} [outboundBase] count of worker→host OCapN
 *   frames subsumed by the recorded snapshot; frames number from here
 *   (session-lifetime sequence), so the hub's inbound watermark can
 *   drop replay-regenerated duplicates
 */

/**
 * Durable storage for one worker: its CapTP tables record, its inbound
 * message journal, and its metadata (bootstrap slot, engine snapshot ref,
 * resource export descriptions).
 *
 * The journal is indexed by absolute entry number: indices remain stable
 * across truncation, so a snapshot's recorded `journalLength` always
 * names the same suffix.
 *
 * @typedef {object} WorkerStore
 * @property {() => TablesRecord | undefined} getTablesRecord
 * @property {(record: TablesRecord) => void} setTablesRecord
 * @property {() => WorkerMeta} getMeta
 * @property {(meta: WorkerMeta) => void} setMeta
 * @property {(entry: unknown) => void} appendJournal
 * @property {(from?: number) => Array<any>} readJournal entries with
 *   absolute index >= from (entries before the truncation point are gone)
 * @property {() => number} journalLength total absolute entry count
 * @property {(upTo: number) => void} truncateJournal drops entries with
 *   absolute index < upTo; call only after a snapshot covering them is
 *   durably recorded
 */

/**
 * Durable storage for one resumable OCapN session: its identity and
 * export descriptions (meta) and its unacknowledged outbound frames.
 *
 * @typedef {object} SessionStore
 * @property {() => Record<string, any>} getMeta
 * @property {(meta: Record<string, any>) => void} setMeta
 * @property {(entry: { n: number, b64: string, hubSequence?: string }) => void} appendFrame
 * @property {() => Array<{ n: number, b64: string, hubSequence?: string }>} readFrames
 * @property {(upToN: number) => void} truncateFramesUpTo drops frames
 *   with sequence number <= upToN (the peer acknowledged them)
 */

/**
 * @typedef {object} ThixotropeStore
 * @property {string} [statePath] filesystem ownership boundary
 * @property {() => any} getHubState the OCapN hub's persisted tables
 * @property {(state: any) => void} setHubState
 * @property {() => Array<string>} listWorkerIds
 * @property {(workerId: string) => WorkerStore} provideWorkerStore
 * @property {(workerId: string) => void} deleteWorker removes the
 *   worker's durable state (tables, journal, meta) entirely
 * @property {() => Array<string>} listSessionTokens
 * @property {(token: string) => SessionStore} provideSessionStore
 * @property {(token: string) => void} deleteSession
 */

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
 * - `sessions/<token>/frames.jsonl`
 *
 * @param {NodePowers} powers
 * @param {string} statePath
 * @returns {ThixotropeStore}
 */
export const makeFsStore = (powers, statePath) => {
  const {
    appendFileSync,
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    writeFileSync,
  } = powers.fs;
  const { dirname, join } = powers.path;
  /**
   * @param {string} path
   * @returns {any}
   */
  const readJsonMaybe = path => {
    if (!existsSync(path)) {
      return undefined;
    }
    return JSON.parse(readFileSync(path, 'utf8'));
  };

  /**
   * @param {string} path
   */
  const syncPath = path => {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };

  /** @param {string} path */
  const makeDirectory = path => {
    if (existsSync(path)) return;
    makeDirectory(dirname(path));
    mkdirSync(path, { recursive: true });
    syncPath(dirname(path));
  };

  /**
   * @param {string} path
   * @param {string} text
   */
  const writeFileAtomic = (path, text) => {
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, text);
    syncPath(tempPath);
    renameSync(tempPath, path);
    syncPath(dirname(path));
  };

  const workersPath = join(statePath, 'workers');
  const sessionsPath = join(statePath, 'sessions');
  makeDirectory(workersPath);
  makeDirectory(sessionsPath);

  /** @param {string} token */
  const makeSessionStore = token => {
    assertSessionToken(token);
    const sessionPath = join(sessionsPath, token);
    makeDirectory(sessionPath);
    const metaPath = join(sessionPath, 'meta.json');
    const framesPath = join(sessionPath, 'frames.jsonl');

    let framesRepaired = false;

    /** @param {Array<{ n: number, b64: string, hubSequence?: string }>} entries */
    const writeFramesFile = entries => {
      const text = [...entries.map(entry => JSON.stringify(entry)), ''].join(
        '\n',
      );
      writeFileAtomic(framesPath, text);
      framesRepaired = true;
    };

    /** @returns {Array<{ n: number, b64: string, hubSequence?: string }>} */
    const readFramesFile = () => {
      if (!existsSync(framesPath)) {
        return [];
      }
      const lines = readFileSync(framesPath, 'utf8')
        .split('\n')
        .filter(line => line !== '');
      /** @type {Array<{ n: number, b64: string, hubSequence?: string }>} */
      const entries = [];
      let torn = false;
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch (_error) {
          // Torn tail from a crash mid-append: the frame was never
          // acknowledged, so the peer will retransmit-tolerate its loss.
          torn = true;
          break;
        }
      }
      if (torn) {
        // Repair the file so a later append cannot concatenate onto the
        // partial line and swallow the next frame.
        writeFramesFile(entries);
      }
      return entries;
    };

    /** @type {SessionStore} */
    const sessionStore = {
      getMeta: () => readJsonMaybe(metaPath) ?? {},
      setMeta: meta => writeFileAtomic(metaPath, `${JSON.stringify(meta)}\n`),
      appendFrame: entry => {
        if (!existsSync(framesPath)) {
          writeFramesFile([]);
        } else if (!framesRepaired) {
          readFramesFile();
          framesRepaired = true;
        }
        appendFileSync(framesPath, `${JSON.stringify(entry)}\n`);
        syncPath(framesPath);
      },
      readFrames: readFramesFile,
      truncateFramesUpTo: upToN => {
        writeFramesFile(readFramesFile().filter(entry => entry.n > upToN));
      },
    };
    return harden(sessionStore);
  };

  /** @param {string} workerId */
  const makeWorkerStore = workerId => {
    assertWorkerId(workerId);
    const workerPath = join(workersPath, workerId);
    makeDirectory(workerPath);
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

    /** @returns {{ base: number, lines: Array<string> }} */
    const readJournalFile = () => {
      if (!existsSync(journalPath)) {
        return { base: 0, lines: [] };
      }
      const text = readFileSync(journalPath, 'utf8');
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
      return { base: header.base, lines: entries };
    };

    /**
     * @param {number} base
     * @param {Array<string>} lines
     */
    const writeJournalFile = (base, lines) => {
      const text = [JSON.stringify({ base }), ...lines, ''].join('\n');
      writeFileAtomic(journalPath, text);
      journalRepaired = true;
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
        writeFileAtomic(tablesPath, `${JSON.stringify(record)}\n`),
      getMeta: () => readJsonMaybe(metaPath) ?? {},
      setMeta: meta => writeFileAtomic(metaPath, `${JSON.stringify(meta)}\n`),
      appendJournal: entry => {
        if (!existsSync(journalPath)) {
          writeJournalFile(0, []);
        }
        ensureJournalRepaired();
        appendFileSync(journalPath, `${JSON.stringify(entry)}\n`);
        syncPath(journalPath);
      },
      readJournal: (from = 0) => {
        const { base, lines } = readJournalFile();
        return lines
          .slice(Math.max(0, from - base))
          .map(line => JSON.parse(line));
      },
      journalLength: () => {
        const { base, lines } = readJournalFile();
        return base + lines.length;
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

  /** @type {ThixotropeStore} */
  const store = {
    statePath,
    listWorkerIds: () =>
      existsSync(workersPath) ? readdirSync(workersPath).sort() : [],
    provideWorkerStore: makeWorkerStore,
    deleteWorker: workerId => {
      assertWorkerId(workerId);
      rmSync(join(workersPath, workerId), { recursive: true, force: true });
      syncPath(workersPath);
    },
    getHubState: () => readJsonMaybe(join(statePath, 'hub.json')),
    setHubState: state =>
      writeFileAtomic(
        join(statePath, 'hub.json'),
        `${JSON.stringify(state)}\n`,
      ),
    listSessionTokens: () =>
      existsSync(sessionsPath) ? readdirSync(sessionsPath).sort() : [],
    provideSessionStore: makeSessionStore,
    deleteSession: token => {
      assertSessionToken(token);
      rmSync(join(sessionsPath, token), { recursive: true, force: true });
      syncPath(sessionsPath);
    },
  };
  return harden(store);
};
harden(makeFsStore);

export { makeMemoryStore } from './store-memory.js';
