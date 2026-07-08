// @ts-check
/* eslint-disable no-underscore-dangle, max-classes-per-file,
   class-methods-use-this -- shim classes follow the same conventions
   as better-sqlite3-xs.js, the sibling backend for
   daemon-database.js. */

// Cloudflare Durable Object adapter that presents a
// `better-sqlite3`-compatible surface backed by the Durable Object's
// SQLite storage (`ctx.storage.sql`), the third backend for
// `daemon-database.js` after Node's native `better-sqlite3` and the
// XS-on-Rust shim (`better-sqlite3-xs.js`). Design:
// CLOUDFLARE-STORAGE.md.
//
// The surface this module emulates is the same strict subset of
// better-sqlite3 that `better-sqlite3-xs.js` emulates — exactly the
// methods daemon-database.js uses:
//
//   const db = new Database(path);
//   db.pragma(stmt);
//   db.exec(sql);
//   const stmt = db.prepare(sql);
//   stmt.run(...args);   // -> { changes, lastInsertRowid }
//   stmt.get(...args);   // -> object | undefined
//   stmt.all(...args);   // -> object[]
//   db.close();
//
// Unlike the XS shim, whose host functions are ambient globals, a
// Durable Object's storage handle is an injected capability, so this
// module exports a factory that closes a Database constructor over
// the handle; `new Database(path)` then ignores the path (the Durable
// Object *is* the database's identity and location).
//
// The Durable Object SQL API is synchronous, which is what makes this
// adaptation honest: daemon-database.js's prepared-statement calls
// run without buffering, queueing, or async seams. D1, Cloudflare's
// other SQLite service, is async-only and therefore cannot back this
// surface; see the design document for that analysis.

/**
 * The subset of the Durable Object SQL storage API this shim uses.
 * Structural types, so the package does not take a dependency on
 * `@cloudflare/workers-types`.
 *
 * @typedef {object} SqlStorageCursor
 * @property {() => Array<Record<string, unknown>>} toArray
 * @property {number} [rowsWritten]
 *
 * @typedef {object} SqlStorage
 * @property {(query: string, ...bindings: Array<unknown>) => SqlStorageCursor} exec
 *
 * @typedef {object} DurableObjectSqlStorage
 * @property {SqlStorage} sql
 */

/**
 * @param {DurableObjectSqlStorage} storage - A Durable Object storage
 * handle (the `ctx.storage` of a SQLite-backed Durable Object).
 * @returns {new (path: string) => any} A better-sqlite3-compatible
 * Database constructor for `makeDaemonDatabase(config, { Database })`.
 */
export const makeDatabaseConstructor = storage => {
  const { sql } = storage;

  class DoStatement {
    /** @param {string} query */
    constructor(query) {
      this._query = query;
    }

    /** @param {Array<unknown>} args */
    run(...args) {
      const cursor = sql.exec(this._query, ...args);
      // Drain the cursor so the statement completes before we read
      // its write count.
      cursor.toArray();
      const changes = cursor.rowsWritten ?? 0;
      const rowidRows = sql
        .exec('SELECT last_insert_rowid() AS lastInsertRowid')
        .toArray();
      const lastInsertRowid =
        rowidRows.length > 0 ? rowidRows[0].lastInsertRowid : 0;
      return { changes, lastInsertRowid };
    }

    /** @param {Array<unknown>} args */
    get(...args) {
      const rows = sql.exec(this._query, ...args).toArray();
      return rows.length > 0 ? rows[0] : undefined;
    }

    /** @param {Array<unknown>} args */
    all(...args) {
      return sql.exec(this._query, ...args).toArray();
    }
  }

  class DoDatabase {
    /**
     * @param {string} _path - Ignored: the Durable Object is the
     * database's identity; there is no filesystem path.
     */
    constructor(_path) {
      this._closed = false;
    }

    /** @param {string} query */
    prepare(query) {
      if (this._closed) throw new Error('Database is closed');
      // The Durable Object API prepares per-exec; statement identity
      // here is just the query text. SQLite statement caching happens
      // inside the platform.
      return new DoStatement(query);
    }

    /** @param {string} query */
    exec(query) {
      if (this._closed) throw new Error('Database is closed');
      // The Durable Object exec supports multi-statement strings when
      // no bindings are passed, which covers daemon-database.js's
      // schema DDL.
      sql.exec(query).toArray();
    }

    /**
     * daemon-database.js issues `journal_mode = WAL` and
     * `foreign_keys = ON` as fire-and-forget tuning hints. The
     * Durable Object platform manages journaling itself and rejects
     * most PRAGMAs, so unsupported ones are deliberately swallowed.
     *
     * @param {string} stmt
     */
    pragma(stmt) {
      if (this._closed) throw new Error('Database is closed');
      try {
        sql.exec(`PRAGMA ${stmt};`).toArray();
      } catch (_error) {
        // Not supported on this platform; a hint, not a requirement.
      }
    }

    close() {
      // The platform owns the connection lifecycle; eviction closes it.
      this._closed = true;
    }
  }

  return DoDatabase;
};
