//! NPM registry table backed by SQLite.
//!
//! Maps `(registry, package_name, version)` to CAS tree hashes,
//! serving as a local cache of npm registry metadata for minimal
//! version selection resolution.
//!
//! The **registry origin participates in the key.** A single
//! `registry.db` is shared across every `endor` run under one state
//! path regardless of the configured `--registry` (and per-scope
//! `@scope:registry` routing means one run can even talk to several
//! registries at once). Were the key `(name, version)` alone, a
//! `foo@1.2.3` fetched from registry A would be served from cache
//! for a run configured against registry B — a wrong-origin,
//! cross-registry cache collision. Keying on the (normalized)
//! registry URL as well makes cached entries registry-scoped, so a
//! hit can never cross origins.

use std::io;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

/// SQLite-backed registry table at `{state_path}/registry.sqlite`.
pub struct RegistryTable {
    conn: Connection,
}

/// A resolved package entry from the registry table.
#[derive(Debug, Clone)]
pub struct PackageEntry {
    /// The normalized registry origin this entry was fetched from
    /// (part of the key — see the module docs).
    pub registry: String,
    pub name: String,
    pub version: String,
    pub hash: String,
    pub integrity: Option<String>,
    pub fetched_at: i64,
}

/// A cached package-metadata row (the registry's version-listing
/// document for one package).
#[derive(Debug, Clone)]
pub struct MetaEntry {
    /// The normalized registry origin this metadata was fetched from
    /// (part of the key — see the module docs).
    pub registry: String,
    pub name: String,
    pub fetched_at: i64,
}

impl RegistryTable {
    /// Open (or create) the registry database at the given path.
    pub fn open(db_path: &Path) -> io::Result<Self> {
        let conn = Connection::open(db_path).map_err(|e| {
            io::Error::new(io::ErrorKind::Other, format!("sqlite open: {e}"))
        })?;
        let table = RegistryTable { conn };
        table.create_tables()?;
        Ok(table)
    }

    /// Open an in-memory database (for testing).
    pub fn open_in_memory() -> io::Result<Self> {
        let conn = Connection::open_in_memory().map_err(|e| {
            io::Error::new(io::ErrorKind::Other, format!("sqlite: {e}"))
        })?;
        let table = RegistryTable { conn };
        table.create_tables()?;
        Ok(table)
    }

    fn create_tables(&self) -> io::Result<()> {
        // The `registry` column joined the primary key in schema v1
        // (see the module docs). A pre-v1 `registry.db` keyed rows on
        // `(name, version)` / `name` alone; those rows carry no known
        // origin, and backfilling them to an assumed default registry
        // would risk re-introducing the very cross-registry collision
        // v1 fixes. The registry table is a regenerable cache (CAS
        // blobs are immutable and survive), so a pre-v1 database is
        // discarded and rebuilt on demand rather than migrated in
        // place.
        let user_version: i64 = self
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("user_version: {e}")))?;
        if user_version < SCHEMA_VERSION {
            self.conn
                .execute_batch(
                    "DROP TABLE IF EXISTS packages;
                     DROP TABLE IF EXISTS package_meta;",
                )
                .map_err(|e| {
                    io::Error::new(io::ErrorKind::Other, format!("drop stale tables: {e}"))
                })?;
        }
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS packages (
                    registry TEXT NOT NULL,
                    name TEXT NOT NULL,
                    version TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    integrity TEXT,
                    fetched_at INTEGER NOT NULL,
                    PRIMARY KEY (registry, name, version)
                );
                CREATE TABLE IF NOT EXISTS package_meta (
                    registry TEXT NOT NULL,
                    name TEXT NOT NULL,
                    versions_json TEXT NOT NULL,
                    fetched_at INTEGER NOT NULL,
                    PRIMARY KEY (registry, name)
                );",
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("create tables: {e}")))?;
        self.conn
            .execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("set user_version: {e}")))?;
        Ok(())
    }

    /// Look up a specific package version fetched from `registry`.
    /// The registry origin is part of the key, so an entry cached
    /// against one registry is invisible to a lookup against another.
    pub fn lookup(
        &self,
        registry: &str,
        name: &str,
        version: &str,
    ) -> io::Result<Option<PackageEntry>> {
        let registry = normalize_registry_key(registry);
        self.conn
            .query_row(
                "SELECT registry, name, version, hash, integrity, fetched_at
                 FROM packages WHERE registry = ?1 AND name = ?2 AND version = ?3",
                params![registry, name, version],
                |row| {
                    Ok(PackageEntry {
                        registry: row.get(0)?,
                        name: row.get(1)?,
                        version: row.get(2)?,
                        hash: row.get(3)?,
                        integrity: row.get(4)?,
                        fetched_at: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("lookup: {e}")))
    }

    /// Insert or replace a package entry keyed on its `registry`
    /// origin.
    pub fn insert(
        &self,
        registry: &str,
        name: &str,
        version: &str,
        hash: &str,
        integrity: Option<&str>,
    ) -> io::Result<()> {
        let registry = normalize_registry_key(registry);
        let now = unix_timestamp();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO packages (registry, name, version, hash, integrity, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![registry, name, version, hash, integrity, now],
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("insert: {e}")))?;
        Ok(())
    }

    /// List all versions of a package in the table, across every
    /// registry it has been fetched from.
    pub fn list_versions(&self, name: &str) -> io::Result<Vec<PackageEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT registry, name, version, hash, integrity, fetched_at
                 FROM packages WHERE name = ?1 ORDER BY registry, version",
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("prepare: {e}")))?;

        let rows = stmt
            .query_map(params![name], |row| {
                Ok(PackageEntry {
                    registry: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    hash: row.get(3)?,
                    integrity: row.get(4)?,
                    fetched_at: row.get(5)?,
                })
            })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("query: {e}")))?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(
                row.map_err(|e| io::Error::new(io::ErrorKind::Other, format!("row: {e}")))?,
            );
        }
        Ok(entries)
    }

    /// Get cached package metadata (version listing JSON) for a
    /// package as served by `registry`. Metadata cached against one
    /// registry is invisible to a lookup against another.
    pub fn get_meta(&self, registry: &str, name: &str) -> io::Result<Option<String>> {
        let registry = normalize_registry_key(registry);
        self.conn
            .query_row(
                "SELECT versions_json FROM package_meta WHERE registry = ?1 AND name = ?2",
                params![registry, name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("get_meta: {e}")))
    }

    /// Every cached metadata document for `name`, one per registry it
    /// has been fetched from, as `(registry, versions_json)` ordered
    /// by registry. For the inspection CLI, which is not scoped to a
    /// single configured registry.
    pub fn get_meta_all(&self, name: &str) -> io::Result<Vec<(String, String)>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT registry, versions_json FROM package_meta
                 WHERE name = ?1 ORDER BY registry",
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("prepare: {e}")))?;
        let rows = stmt
            .query_map(params![name], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("query: {e}")))?;
        let mut docs = Vec::new();
        for row in rows {
            docs.push(row.map_err(|e| io::Error::new(io::ErrorKind::Other, format!("row: {e}")))?);
        }
        Ok(docs)
    }

    /// Cache package metadata (version listing JSON) keyed on the
    /// `registry` origin it was fetched from.
    pub fn set_meta(&self, registry: &str, name: &str, versions_json: &str) -> io::Result<()> {
        let registry = normalize_registry_key(registry);
        let now = unix_timestamp();
        self.conn
            .execute(
                "INSERT OR REPLACE INTO package_meta (registry, name, versions_json, fetched_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![registry, name, versions_json, now],
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("set_meta: {e}")))?;
        Ok(())
    }

    /// Count total packages in the table.
    pub fn count(&self) -> io::Result<u64> {
        self.conn
            .query_row("SELECT COUNT(*) FROM packages", [], |row| row.get(0))
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("count: {e}")))
    }

    /// List every package entry in the table, ordered by name then
    /// version (lexicographic display order, not semver order).
    pub fn list_packages(&self) -> io::Result<Vec<PackageEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT registry, name, version, hash, integrity, fetched_at
                 FROM packages ORDER BY name, version, registry",
            )
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("prepare: {e}")))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(PackageEntry {
                    registry: row.get(0)?,
                    name: row.get(1)?,
                    version: row.get(2)?,
                    hash: row.get(3)?,
                    integrity: row.get(4)?,
                    fetched_at: row.get(5)?,
                })
            })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("query: {e}")))?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(
                row.map_err(|e| io::Error::new(io::ErrorKind::Other, format!("row: {e}")))?,
            );
        }
        Ok(entries)
    }

    /// List the names and fetch times of every cached metadata row,
    /// ordered by name.
    pub fn list_meta(&self) -> io::Result<Vec<MetaEntry>> {
        let mut stmt = self
            .conn
            .prepare("SELECT registry, name, fetched_at FROM package_meta ORDER BY name, registry")
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("prepare: {e}")))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(MetaEntry {
                    registry: row.get(0)?,
                    name: row.get(1)?,
                    fetched_at: row.get(2)?,
                })
            })
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("query: {e}")))?;

        let mut entries = Vec::new();
        for row in rows {
            entries.push(
                row.map_err(|e| io::Error::new(io::ErrorKind::Other, format!("row: {e}")))?,
            );
        }
        Ok(entries)
    }

    /// Delete every cached metadata row for `name`, across all
    /// registries, so the next resolution re-fetches the version
    /// listing wherever `name` is served from. Returns whether any
    /// row existed. Package rows and their CAS trees are untouched:
    /// fetched package contents are immutable and stay valid.
    pub fn delete_meta(&self, name: &str) -> io::Result<bool> {
        let changed = self
            .conn
            .execute("DELETE FROM package_meta WHERE name = ?1", params![name])
            .map_err(|e| io::Error::new(io::ErrorKind::Other, format!("delete_meta: {e}")))?;
        Ok(changed > 0)
    }
}

/// Schema version stamped into the SQLite `user_version` pragma. Bump
/// this whenever the table shape changes so [`create_tables`] can
/// discard an incompatible pre-existing (regenerable) cache rather
/// than fail on the mismatched columns. v1 added `registry` to both
/// primary keys.
const SCHEMA_VERSION: i64 = 1;

/// Canonicalize a registry URL into the string used as the key
/// column, so origins that differ only in a trailing slash
/// (`https://r/` vs `https://r`) collide on the same cache entry
/// rather than splitting into two. Trailing slashes are stripped;
/// everything else is preserved verbatim.
fn normalize_registry_key(registry: &str) -> String {
    registry.trim_end_matches('/').to_string()
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const REG: &str = "https://registry.npmjs.org/";
    const REG_B: &str = "https://registry.other.example/";

    #[test]
    fn insert_and_lookup() {
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.insert(REG, "is-odd", "1.0.0", "sha256:abc123", Some("sha512-xyz"))
            .unwrap();

        let entry = reg.lookup(REG, "is-odd", "1.0.0").unwrap().unwrap();
        assert_eq!(entry.name, "is-odd");
        assert_eq!(entry.version, "1.0.0");
        assert_eq!(entry.hash, "sha256:abc123");
        assert_eq!(entry.integrity.as_deref(), Some("sha512-xyz"));
        // The origin is recorded (trailing slash normalized away).
        assert_eq!(entry.registry, "https://registry.npmjs.org");
    }

    #[test]
    fn lookup_missing_returns_none() {
        let reg = RegistryTable::open_in_memory().unwrap();
        assert!(reg.lookup(REG, "nonexistent", "1.0.0").unwrap().is_none());
    }

    #[test]
    fn insert_replace_updates() {
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.insert(REG, "foo", "1.0.0", "sha256:old", None).unwrap();
        reg.insert(REG, "foo", "1.0.0", "sha256:new", None).unwrap();

        let entry = reg.lookup(REG, "foo", "1.0.0").unwrap().unwrap();
        assert_eq!(entry.hash, "sha256:new");
    }

    #[test]
    fn lookup_is_scoped_to_registry() {
        // The heart of the fix: a package fetched from registry A must
        // NOT be served from cache for a lookup against registry B, or
        // a wrong-origin cross-registry cache collision results.
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.insert(REG, "foo", "1.2.3", "sha256:from-a", Some("sha512-a"))
            .unwrap();

        // Same (name, version) but a different registry: cache miss.
        assert!(
            reg.lookup(REG_B, "foo", "1.2.3").unwrap().is_none(),
            "registry B must not hit registry A's cached entry"
        );

        // Registry B may hold its own, independent entry for the same
        // (name, version) — the two coexist and never overwrite.
        reg.insert(REG_B, "foo", "1.2.3", "sha256:from-b", Some("sha512-b"))
            .unwrap();
        assert_eq!(
            reg.lookup(REG, "foo", "1.2.3").unwrap().unwrap().hash,
            "sha256:from-a"
        );
        assert_eq!(
            reg.lookup(REG_B, "foo", "1.2.3").unwrap().unwrap().hash,
            "sha256:from-b"
        );
        assert_eq!(reg.count().unwrap(), 2);
    }

    #[test]
    fn lookup_registry_key_normalizes_trailing_slash() {
        // A URL that differs only in a trailing slash keys the same
        // entry, so the cache does not needlessly split.
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.insert("https://registry.npmjs.org", "foo", "1.0.0", "h", None)
            .unwrap();
        assert!(reg
            .lookup("https://registry.npmjs.org/", "foo", "1.0.0")
            .unwrap()
            .is_some());
    }

    #[test]
    fn list_versions_ordered() {
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.insert(REG, "bar", "2.0.0", "sha256:v2", None).unwrap();
        reg.insert(REG, "bar", "1.0.0", "sha256:v1", None).unwrap();
        reg.insert(REG, "bar", "1.1.0", "sha256:v11", None).unwrap();

        let versions = reg.list_versions("bar").unwrap();
        assert_eq!(versions.len(), 3);
        assert_eq!(versions[0].version, "1.0.0");
        assert_eq!(versions[1].version, "1.1.0");
        assert_eq!(versions[2].version, "2.0.0");
    }

    #[test]
    fn meta_cache_round_trip() {
        let reg = RegistryTable::open_in_memory().unwrap();
        assert!(reg.get_meta(REG, "express").unwrap().is_none());

        let versions_json = r#"{"4.18.0":{},"4.17.1":{}}"#;
        reg.set_meta(REG, "express", versions_json).unwrap();

        let cached = reg.get_meta(REG, "express").unwrap().unwrap();
        assert_eq!(cached, versions_json);
    }

    #[test]
    fn meta_cache_is_scoped_to_registry() {
        // Metadata (the version listing) is just as origin-sensitive as
        // package contents: registry A and B can advertise different
        // version sets, so a B lookup must not see A's document.
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.set_meta(REG, "pkg", r#"{"1.0.0":{}}"#).unwrap();

        assert!(reg.get_meta(REG_B, "pkg").unwrap().is_none());

        reg.set_meta(REG_B, "pkg", r#"{"2.0.0":{}}"#).unwrap();
        assert_eq!(reg.get_meta(REG, "pkg").unwrap().unwrap(), r#"{"1.0.0":{}}"#);
        assert_eq!(reg.get_meta(REG_B, "pkg").unwrap().unwrap(), r#"{"2.0.0":{}}"#);

        let docs = reg.get_meta_all("pkg").unwrap();
        assert_eq!(docs.len(), 2);
    }

    #[test]
    fn meta_cache_updates() {
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.set_meta(REG, "pkg", "v1").unwrap();
        reg.set_meta(REG, "pkg", "v2").unwrap();

        let cached = reg.get_meta(REG, "pkg").unwrap().unwrap();
        assert_eq!(cached, "v2");
    }

    #[test]
    fn count_packages() {
        let reg = RegistryTable::open_in_memory().unwrap();
        assert_eq!(reg.count().unwrap(), 0);

        reg.insert(REG, "a", "1.0.0", "h1", None).unwrap();
        reg.insert(REG, "b", "2.0.0", "h2", None).unwrap();
        assert_eq!(reg.count().unwrap(), 2);
    }

    #[test]
    fn list_packages_all_ordered() {
        let reg = RegistryTable::open_in_memory().unwrap();
        assert!(reg.list_packages().unwrap().is_empty());

        reg.insert(REG, "zeta", "1.0.0", "hz", None).unwrap();
        reg.insert(REG, "alpha", "2.0.0", "ha2", None).unwrap();
        reg.insert(REG, "alpha", "1.0.0", "ha1", None).unwrap();

        let all = reg.list_packages().unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!((all[0].name.as_str(), all[0].version.as_str()), ("alpha", "1.0.0"));
        assert_eq!((all[1].name.as_str(), all[1].version.as_str()), ("alpha", "2.0.0"));
        assert_eq!((all[2].name.as_str(), all[2].version.as_str()), ("zeta", "1.0.0"));
    }

    #[test]
    fn list_meta_names_ordered() {
        let reg = RegistryTable::open_in_memory().unwrap();
        assert!(reg.list_meta().unwrap().is_empty());

        reg.set_meta(REG, "zeta", "{}").unwrap();
        reg.set_meta(REG, "alpha", "{}").unwrap();

        let metas = reg.list_meta().unwrap();
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0].name, "alpha");
        assert_eq!(metas[1].name, "zeta");
        assert!(metas[0].fetched_at > 0);
    }

    #[test]
    fn delete_meta_invalidates_only_meta() {
        let reg = RegistryTable::open_in_memory().unwrap();
        reg.set_meta(REG, "pkg", r#"{"1.0.0":{}}"#).unwrap();
        reg.insert(REG, "pkg", "1.0.0", "sha256:aaa", None).unwrap();

        assert!(reg.delete_meta("pkg").unwrap());
        assert!(reg.get_meta(REG, "pkg").unwrap().is_none());
        // A second delete finds nothing.
        assert!(!reg.delete_meta("pkg").unwrap());
        // The package row (and thus its CAS tree) survives.
        assert!(reg.lookup(REG, "pkg", "1.0.0").unwrap().is_some());
    }

    #[test]
    fn file_backed_persistence() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("registry.sqlite");

        // Create and populate.
        {
            let reg = RegistryTable::open(&db_path).unwrap();
            reg.insert(REG, "pkg", "1.0.0", "sha256:aaa", None).unwrap();
        }

        // Reopen and verify.
        {
            let reg = RegistryTable::open(&db_path).unwrap();
            let entry = reg.lookup(REG, "pkg", "1.0.0").unwrap().unwrap();
            assert_eq!(entry.hash, "sha256:aaa");
        }
    }

    #[test]
    fn pre_v1_schema_is_discarded_on_open() {
        // A pre-v1 database keyed packages on (name, version) with no
        // registry column and left user_version at 0. Opening it under
        // the current code must migrate by discarding the stale tables
        // (a regenerable cache) rather than fail on the mismatched
        // columns — and must never let an origin-less row satisfy a
        // registry-scoped lookup.
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("registry.sqlite");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE packages (
                    name TEXT NOT NULL,
                    version TEXT NOT NULL,
                    hash TEXT NOT NULL,
                    integrity TEXT,
                    fetched_at INTEGER NOT NULL,
                    PRIMARY KEY (name, version)
                );
                CREATE TABLE package_meta (
                    name TEXT PRIMARY KEY,
                    versions_json TEXT NOT NULL,
                    fetched_at INTEGER NOT NULL
                );
                INSERT INTO packages VALUES ('foo', '1.0.0', 'sha256:old', NULL, 1);",
            )
            .unwrap();
            // user_version defaults to 0 — the pre-v1 marker.
        }

        // Open succeeds (no column-mismatch error) and the stale,
        // origin-less row is gone.
        let reg = RegistryTable::open(&db_path).unwrap();
        assert_eq!(reg.count().unwrap(), 0);
        assert!(reg.lookup(REG, "foo", "1.0.0").unwrap().is_none());

        // The new schema is usable and stamped at the current version.
        reg.insert(REG, "foo", "1.0.0", "sha256:new", None).unwrap();
        assert_eq!(
            reg.lookup(REG, "foo", "1.0.0").unwrap().unwrap().hash,
            "sha256:new"
        );
        let uv: i64 = reg
            .conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(uv, SCHEMA_VERSION);
    }
}
