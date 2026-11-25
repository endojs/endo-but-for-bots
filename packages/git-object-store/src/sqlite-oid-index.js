// @ts-check

import { Fail } from '@endo/errors';
import harden from '@endo/harden';

import { assertHashAlgorithm, assertOid } from './hash.js';
import { assertObjectType } from './frame.js';

/** @import { GitHashAlgorithm, GitObjectId, GitObjectType, OidIndex, OidIndexEntry } from './types.js' */

/**
 * SQL schema for the host oid index. Fully reconstructible from CAS
 * content plus known roots; treated as a derived cache.
 */
export const GIT_OID_INDEX_SCHEMA = harden(`
CREATE TABLE IF NOT EXISTS git_oid_index (
  algorithm TEXT NOT NULL,
  oid TEXT NOT NULL,
  object_type TEXT NOT NULL,
  cas_hash TEXT NOT NULL,
  PRIMARY KEY (algorithm, oid)
);
CREATE INDEX IF NOT EXISTS git_oid_index_by_cas
  ON git_oid_index (cas_hash);
`);

/**
 * Minimal better-sqlite3-compatible surface this adapter needs.
 *
 * @typedef {object} SqliteStatement
 * @property {(...params: unknown[]) => unknown} get
 * @property {(...params: unknown[]) => unknown[]} all
 * @property {(...params: unknown[]) => { changes: number }} run
 *
 * @typedef {object} SqliteDatabase
 * @property {(sql: string) => void} exec
 * @property {(sql: string) => SqliteStatement} prepare
 */

/**
 * SQLite-backed oid index for the host plane.
 *
 * @param {SqliteDatabase} db
 * @returns {OidIndex}
 */
export const makeSqliteOidIndex = db => {
  db || Fail`makeSqliteOidIndex requires a database`;
  db.exec(GIT_OID_INDEX_SCHEMA);

  const stmtGet = db.prepare(
    `SELECT object_type AS type, cas_hash AS casHash
     FROM git_oid_index
     WHERE algorithm = ? AND oid = ?`,
  );
  const stmtHas = db.prepare(
    `SELECT 1 AS present FROM git_oid_index WHERE algorithm = ? AND oid = ?`,
  );
  const stmtPut = db.prepare(
    `INSERT OR REPLACE INTO git_oid_index (algorithm, oid, object_type, cas_hash)
     VALUES (?, ?, ?, ?)`,
  );
  // Batch lookup via a temporary values list built per call. For typical
  // commit-parent batches (small N) this is fine; larger batches can be
  // chunked by the caller.
  const makeGetMany = oids => {
    if (oids.length === 0) {
      return null;
    }
    const placeholders = oids.map(() => '?').join(', ');
    return db.prepare(
      `SELECT oid, object_type AS type, cas_hash AS casHash
       FROM git_oid_index
       WHERE algorithm = ? AND oid IN (${placeholders})`,
    );
  };

  return harden({
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId} oid
     */
    async get(algorithm, oid) {
      assertHashAlgorithm(algorithm);
      const normalized = assertOid(algorithm, oid);
      const row = /** @type {OidIndexEntry | undefined} */ (
        stmtGet.get(algorithm, normalized)
      );
      return row === undefined
        ? undefined
        : harden({ type: row.type, casHash: row.casHash });
    },
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId[]} oids
     */
    async getMany(algorithm, oids) {
      assertHashAlgorithm(algorithm);
      if (oids.length === 0) {
        return [];
      }
      const normalized = oids.map(oid => assertOid(algorithm, oid));
      const stmt = makeGetMany(normalized);
      if (stmt === null) {
        return [];
      }
      const rows =
        /** @type {Array<{ oid: string, type: GitObjectType, casHash: string }>} */ (
          stmt.all(algorithm, ...normalized)
        );
      /** @type {Map<string, OidIndexEntry>} */
      const byOid = new Map();
      for (const row of rows) {
        byOid.set(row.oid, harden({ type: row.type, casHash: row.casHash }));
      }
      return normalized.map(oid => byOid.get(oid));
    },
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId} oid
     * @param {GitObjectType} type
     * @param {string} casHash
     */
    async put(algorithm, oid, type, casHash) {
      assertHashAlgorithm(algorithm);
      assertObjectType(type);
      const normalized = assertOid(algorithm, oid);
      stmtPut.run(algorithm, normalized, type, casHash);
    },
    /**
     * @param {GitHashAlgorithm} algorithm
     * @param {GitObjectId} oid
     */
    async has(algorithm, oid) {
      assertHashAlgorithm(algorithm);
      const normalized = assertOid(algorithm, oid);
      return stmtHas.get(algorithm, normalized) !== undefined;
    },
  });
};
harden(makeSqliteOidIndex);
