// @ts-check
// Optional disposable benchmark backend. Never open normal daemon state with it.
import { Fail } from '@endo/errors';
import harden from '@endo/harden';
import { chmodSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

/** @import { SyncFilePowers } from '../src/platform/sync-files.js' */

/**
 * Keep the existing hub JSON as a single SQLite row, using WAL + FULL sync.
 * This isolates the storage mechanism without introducing a SQL table redesign.
 * Requires an optional Node runtime providing node:sqlite (not Node 20).
 * @param {SyncFilePowers} files
 * @param {object} [options]
 * @param {(operation: string, start: number, end: number) => void} [options.onStorage]
 */
export const makeMailHubSqlite = (files, { onStorage = () => {} } = {}) => {
  /** @type {Map<string, DatabaseSync>} */
  const databases = new Map();
  let closed = false;
  /** @param {string} path */
  const provide = path => {
    !closed || Fail`Experimental SQLite hub store is closed`;
    let database = databases.get(path);
    if (database !== undefined) return database;
    const target = `${path}.experiment.sqlite`;
    database = new DatabaseSync(target);
    try {
      // Set the database's private mode before creating WAL/SHM sidecars.
      chmodSync(target, 0o600);
      // Node/libuv fsync requests F_FULLFSYNC on Darwin. SQLite's FULL
      // transaction setting alone does not request that stronger operation.
      database.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON;',
      );
      const mode = database.prepare('PRAGMA journal_mode').get();
      const sync = database.prepare('PRAGMA synchronous').get();
      const full = database.prepare('PRAGMA fullfsync').get();
      (mode?.journal_mode === 'wal' &&
        sync?.synchronous === 2 &&
        full?.fullfsync === 1) ||
        Fail`Experimental SQLite hub requires WAL, FULL synchronization and fullfsync`;
      database.exec(
        'CREATE TABLE IF NOT EXISTS hub_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)',
      );
      databases.set(path, database);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  };
  /**
   * @template T
   * @param {string} operation
   * @param {() => T} fn
   * @returns {T}
   */
  const time = (operation, fn) => {
    const start = performance.timeOrigin + performance.now();
    try {
      return fn();
    } finally {
      onStorage(operation, start, performance.timeOrigin + performance.now());
    }
  };
  /** @type {SyncFilePowers} */
  const syncFiles = harden({
    ...files,
    exists: path =>
      files.exists(path) ||
      (path.endsWith('/hub.json') && files.exists(`${path}.experiment.sqlite`)),
    readText: path => {
      if (
        !path.endsWith('/hub.json') ||
        !files.exists(`${path}.experiment.sqlite`)
      )
        return files.readText(path);
      return time('sqlite-read', () => {
        const row = provide(path)
          .prepare('SELECT value FROM hub_state WHERE id=1')
          .get();
        if (typeof row?.value !== 'string')
          throw Error('Missing experimental SQLite hub state');
        JSON.parse(row.value);
        return row.value;
      });
    },
    writeTextAtomic: (path, text, options) => {
      if (!path.endsWith('/hub.json'))
        return files.writeTextAtomic(path, text, options);
      JSON.parse(text);
      return time('sqlite-commit', () => {
        provide(path)
          .prepare(
            'INSERT INTO hub_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
          )
          .run(text);
      });
    },
  });
  return harden({
    syncFiles,
    close: () => {
      if (closed) return;
      closed = true;
      for (const database of databases.values()) database.close();
      databases.clear();
    },
  });
};
harden(makeMailHubSqlite);
