// @ts-check

/**
 * @typedef {object} SqlStatement
 * @property {(...params: any[]) => any} run
 * @property {(...params: any[]) => any} get
 * @property {(...params: any[]) => any[]} all
 */

/**
 * The subset of the `better-sqlite3` database surface the store uses. Node's
 * `node:sqlite` `DatabaseSync` satisfies it too, so the database is injected
 * rather than imported.
 *
 * @typedef {object} SqlDatabase
 * @property {(sql: string) => void} exec
 * @property {(sql: string) => SqlStatement} prepare
 */

export const SCHEMA_VERSION = 1;

/**
 * The registry tables of the proposed design
 * `designs/npm-dev-registry-serving.md` (not yet landed; see
 * https://github.com/endojs/endo-but-for-bots/pull/1361) § Durable schema, plus the grant and audit tables the publish path records into.
 * `packages` keeps its existing meaning: a row exists only when the exact
 * tarball blob and extracted tree are in the CAS.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS packages (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  tarball_hash TEXT NOT NULL,
  integrity TEXT NOT NULL,
  shasum TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS package_versions (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  integrity TEXT NOT NULL,
  shasum TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('published', 'upstream')),
  indexed_at INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS dist_tags (
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('published', 'upstream')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (name, tag),
  FOREIGN KEY (name, version) REFERENCES package_versions(name, version)
);
CREATE TABLE IF NOT EXISTS package_metadata (
  name TEXT PRIMARY KEY,
  upstream_json TEXT,
  upstream_etag TEXT,
  expires_at INTEGER,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  packages_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  issued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  subject TEXT,
  action TEXT NOT NULL,
  name TEXT,
  version TEXT,
  tag TEXT,
  outcome TEXT NOT NULL,
  integrity TEXT,
  detail TEXT
);
`;

/**
 * Open (and migrate) the registry tables on an injected SQLite database.
 *
 * @param {SqlDatabase} database
 */
export const makeRegistryStore = database => {
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('PRAGMA foreign_keys = ON');
  const { user_version: userVersion } = database
    .prepare('PRAGMA user_version')
    .get();
  if (Number(userVersion) > SCHEMA_VERSION) {
    throw Error(
      `Registry schema version ${userVersion} is newer than this server (${SCHEMA_VERSION})`,
    );
  }
  database.exec(SCHEMA);
  database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);

  const statements = {
    getVersion: database.prepare(
      'SELECT * FROM package_versions WHERE name = ? AND version = ?',
    ),
    listVersions: database.prepare(
      'SELECT * FROM package_versions WHERE name = ? ORDER BY indexed_at, version',
    ),
    insertVersion: database.prepare(
      `INSERT INTO package_versions
         (name, version, manifest_json, integrity, shasum, source, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name, version) DO NOTHING`,
    ),
    getPackage: database.prepare(
      'SELECT * FROM packages WHERE name = ? AND version = ?',
    ),
    listPackages: database.prepare('SELECT * FROM packages'),
    insertPackage: database.prepare(
      `INSERT INTO packages
         (name, version, tree_hash, tarball_hash, integrity, shasum, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (name, version) DO NOTHING`,
    ),
    listTags: database.prepare('SELECT * FROM dist_tags WHERE name = ?'),
    getTag: database.prepare(
      'SELECT * FROM dist_tags WHERE name = ? AND tag = ?',
    ),
    setPublishedTag: database.prepare(
      `INSERT INTO dist_tags (name, tag, version, source, updated_at)
       VALUES (?, ?, ?, 'published', ?)
       ON CONFLICT (name, tag) DO UPDATE SET
         version = excluded.version, source = 'published',
         updated_at = excluded.updated_at`,
    ),
    // Upstream metadata may add or refresh upstream-sourced tags but can
    // never replace a locally published one.
    setUpstreamTag: database.prepare(
      `INSERT INTO dist_tags (name, tag, version, source, updated_at)
       VALUES (?, ?, ?, 'upstream', ?)
       ON CONFLICT (name, tag) DO UPDATE SET
         version = excluded.version, updated_at = excluded.updated_at
       WHERE dist_tags.source = 'upstream'`,
    ),
    getMetadata: database.prepare(
      'SELECT * FROM package_metadata WHERE name = ?',
    ),
    upsertMetadata: database.prepare(
      `INSERT INTO package_metadata
         (name, upstream_json, upstream_etag, expires_at, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET
         upstream_json = excluded.upstream_json,
         upstream_etag = excluded.upstream_etag,
         expires_at = excluded.expires_at,
         fetched_at = excluded.fetched_at`,
    ),
    getGrantByToken: database.prepare(
      'SELECT * FROM grants WHERE token_sha256 = ?',
    ),
    listGrants: database.prepare(
      'SELECT id, subject, packages_json, expires_at, revoked_at, issued_at FROM grants ORDER BY issued_at',
    ),
    upsertGrant: database.prepare(
      `INSERT INTO grants
         (id, subject, token_sha256, packages_json, expires_at, issued_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         subject = excluded.subject, token_sha256 = excluded.token_sha256,
         packages_json = excluded.packages_json,
         expires_at = excluded.expires_at
       WHERE grants.revoked_at IS NULL`,
    ),
    revokeGrant: database.prepare(
      'UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    ),
    audit: database.prepare(
      `INSERT INTO audit_events
         (at, subject, action, name, version, tag, outcome, integrity, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
  };

  /**
   * Run `thunk` in one IMMEDIATE transaction: the write lock is taken up
   * front, so per-package checks (tag monotonicity, idempotent retry)
   * serialize with the writes that depend on them.
   *
   * @template T
   * @param {() => T} thunk
   * @returns {T}
   */
  const transaction = thunk => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = thunk();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };

  const checkpoint = () => {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  };

  // Frozen, not hardened: hardening would walk into and freeze the
  // native statement objects' prototypes. The statement table is frozen
  // too, so no holder can swap the statement that authenticates grants.
  return Object.freeze({
    statements: Object.freeze(statements),
    transaction,
    checkpoint,
  });
};
harden(makeRegistryStore);

/** @typedef {ReturnType<typeof makeRegistryStore>} RegistryStore */
