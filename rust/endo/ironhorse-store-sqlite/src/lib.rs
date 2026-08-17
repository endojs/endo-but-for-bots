//! [`SqliteHeapStore`]: the daemon-side SQLite backend of the Ironhorse
//! snapshot store seam (design
//! `designs/ironhorse-snapshot-store-seam.md` § SQLite schema and
//! operational discipline).
//!
//! This is the backend whose **commit I/O is O(dirty rows)**: an
//! incremental checkpoint upserts only the dirty slot pages and chunk
//! extents inside one SQLite transaction under WAL, where the in-crate
//! reference [`ironhorse_snapshot::store_file::FileStore`] rewrites its
//! whole file per commit. The semantics are pinned by the shared
//! contract, not re-invented here: succession discipline via
//! [`ironhorse_snapshot::store::check_succession`] (the seal chain
//! plus the recomputed batch seal — strictly stronger than a bare
//! epoch check), the shared [`ironhorse_snapshot::store::apply_batch`]
//! verification, rows beyond the new geometry dropped on commit, raw
//! row bytes in the crate's canonical encodings, and the same
//! fail-closed gate taxonomy.
//!
//! Operational discipline follows the daemon's SQLite designs
//! (`designs/daemon-endo-rust-sqlite.md`,
//! `designs/daemon-sqlite-shutdown-checkpoint.md`): `journal_mode=WAL`
//! and `foreign_keys=ON` at open, one connection owned by the worker's
//! thread, and an explicit [`SqliteHeapStore::close`] that performs the
//! full last-connection close — after it returns, the `.sqlite` file is
//! self-contained (the WAL is folded in and the `-wal`/`-shm` sidecars
//! removed), so file-level snapshot/handoff of a suspended worker's
//! heap is single-file-safe.
//!
//! The crate lives daemon-side (under `rust/endo/`, in the root
//! workspace) and NOT in the `rust/engine` workspace, which stays
//! `forbid(unsafe_code)` and zero-C (design § Crate and dependency
//! layout); SQLite's C is the same bundled `rusqlite` the daemon
//! already compiles.

use std::path::Path;

use ironhorse_snapshot::store::{
    apply_batch, check_succession, chunk_extent_count, free_seg_count, leaf_hash,
    slot_page_count, CheckpointBatch, HeapStore, StoreError, StoreManifest, LEAF_EXT, LEAF_FREE,
    LEAF_PAGE,
};
use rusqlite::{params, Connection, OptionalExtension};

/// Map a rusqlite failure into the store vocabulary. SQLite errors
/// after a successful open are I/O-class faults (a crashed crank at
/// the machine surface), never silently absorbed.
fn sql_err(e: rusqlite::Error) -> StoreError {
    StoreError::Io(format!("sqlite: {e}"))
}

/// A page/target column read back from the database, range-checked
/// into u32 instead of `as`-truncated: an external writer's negative
/// or oversized value fails closed like a malformed blob would, never
/// wraps into a plausible page number (review nit).
fn page_col(v: i64) -> Result<u32, StoreError> {
    u32::try_from(v).map_err(|_| StoreError::Io(format!("sqlite: page column out of range ({v})")))
}

/// The `meta` key holding the encoded [`StoreManifest`].
const META_MANIFEST: &str = "manifest";
/// The `small_state` row name holding the encoded small state.
const SMALL_NAME: &str = "small";

/// A SQLite-backed [`HeapStore`]. One store per database file; the
/// worker's heap database is daemon-private state in the same trust
/// class as `endo.sqlite`.
#[derive(Debug)]
pub struct SqliteHeapStore {
    conn: Connection,
}

impl SqliteHeapStore {
    /// Open (creating if absent) the heap store at `path`, applying the
    /// daemon's connection discipline (WAL, foreign keys) and the
    /// schema. A file that is not a SQLite database fails closed here.
    pub fn open(path: impl AsRef<Path>) -> Result<SqliteHeapStore, StoreError> {
        let conn = Connection::open(path).map_err(sql_err)?;
        Self::init(conn, false)
    }

    /// An in-memory store for tests and ephemeral use. Same schema and
    /// semantics; nothing durable.
    pub fn open_in_memory() -> Result<SqliteHeapStore, StoreError> {
        let conn = Connection::open_in_memory().map_err(sql_err)?;
        Self::init(conn, true)
    }

    /// The `PRAGMA application_id` stamp: `IRON` as a big-endian u32 —
    /// the SQLite analogue of the file store's magic. A SQLite database
    /// that is not a heap store fails closed at open instead of being
    /// silently adopted as "empty" and grafted with our schema (the
    /// review's foreign-database finding).
    const APPLICATION_ID: i32 = i32::from_be_bytes(*b"IRON");

    fn init(conn: Connection, in_memory: bool) -> Result<SqliteHeapStore, StoreError> {
        // Foreign-database gate before anything else touches the file.
        let app_id: i32 = conn
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(sql_err)?;
        if app_id == 0 {
            // Unstamped: acceptable only for a genuinely fresh database
            // (no tables at all) — an unstamped populated database is
            // some other subsystem's data, not ours to adopt.
            let tables: i64 = conn
                .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'", [], |r| {
                    r.get(0)
                })
                .map_err(sql_err)?;
            if tables != 0 {
                return Err(StoreError::Io(
                    "sqlite: refusing foreign database (populated, unstamped)".to_string(),
                ));
            }
            conn.execute_batch(&format!("PRAGMA application_id = {}", Self::APPLICATION_ID))
                .map_err(sql_err)?;
        } else if app_id != Self::APPLICATION_ID {
            return Err(StoreError::Io(format!(
                "sqlite: refusing foreign database (application_id {app_id})"
            )));
        }

        // WAL + foreign keys per the daemon defaults
        // (daemon-endo-rust-sqlite), plus the busy wait and the pinned
        // autocheckpoint threshold those designs specify. The
        // journal-mode pragma reports the resulting mode; anything but
        // `wal` (or `memory`, for the in-memory tests) means the
        // documented WAL discipline is not actually in force, and the
        // silent fallback the review flagged must fail closed instead.
        conn.busy_timeout(std::time::Duration::from_millis(5000))
            .map_err(sql_err)?;
        // Enforce the documented single-writer-per-path model instead
        // of assuming it (the collaborator review's finding): under
        // EXCLUSIVE locking the first connection to touch the file
        // holds it, so a stray second opener fails closed with
        // SQLITE_BUSY at its first query (our application_id gate)
        // rather than silently racing. In-memory databases report
        // "exclusive" trivially (nothing shares them).
        let lock_mode: String = conn
            .query_row("PRAGMA locking_mode=EXCLUSIVE", [], |r| r.get(0))
            .map_err(sql_err)?;
        if lock_mode.to_ascii_lowercase() != "exclusive" {
            return Err(StoreError::Io(format!(
                "sqlite: locking_mode=EXCLUSIVE refused (got {lock_mode})"
            )));
        }
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
            .map_err(sql_err)?;
        // "memory" is acceptable ONLY for a genuinely in-memory
        // connection — keyed on how WE opened it, not on the reported
        // string, so an on-disk database claiming a memory journal
        // (no crash durability at all) fails closed (review nit).
        if mode != "wal" && !(in_memory && mode == "memory") {
            return Err(StoreError::Io(format!(
                "sqlite: journal_mode=WAL refused (got {mode})"
            )));
        }
        conn.execute_batch("PRAGMA wal_autocheckpoint = 1000")
            .map_err(sql_err)?;
        // Pin durability explicitly rather than riding the build-time
        // default: FULL syncs the WAL on every commit, which is the
        // acked-checkpoint-survives-power-loss contract the machine
        // layer's fsync discipline assumes. Verified by read-back like
        // the two pragmas above — `synchronous` is exactly the one
        // whose silent absence breaks the stated contract (the review
        // found it fired blind while its siblings were checked).
        conn.execute_batch("PRAGMA synchronous = FULL")
            .map_err(sql_err)?;
        let sync: i64 = conn
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .map_err(sql_err)?;
        if sync != 2 {
            return Err(StoreError::Io(format!(
                "sqlite: synchronous=FULL refused (got {sync})"
            )));
        }
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             CREATE TABLE IF NOT EXISTS meta (
               key   TEXT PRIMARY KEY,
               value BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS slot_pages (
               page  INTEGER PRIMARY KEY,
               bytes BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS chunk_exts (
               ext   INTEGER PRIMARY KEY,
               bytes BLOB NOT NULL
             );
             CREATE TABLE IF NOT EXISTS small_state (
               name  TEXT PRIMARY KEY,
               bytes BLOB NOT NULL
             );
             -- Row-leaf hashes (store seam phase 5): kind 0 = slot
             -- page, 1 = chunk extent; 32-byte SHA-256 per row,
             -- maintained transactionally with the rows themselves.
             CREATE TABLE IF NOT EXISTS leaf_hashes (
               kind  INTEGER NOT NULL,
               idx   INTEGER NOT NULL,
               hash  BLOB NOT NULL,
               PRIMARY KEY (kind, idx)
             );
             -- Page-edge summaries (store seam phase 6): the sorted
             -- outgoing page targets per slot page, as big-endian u32s.
             CREATE TABLE IF NOT EXISTS page_edges (
               page    INTEGER PRIMARY KEY,
               targets BLOB NOT NULL
             );
             -- Free-list segments (store seam phase 9): big-endian u32
             -- entries; kind-2 rows in leaf_hashes checksum them.
             CREATE TABLE IF NOT EXISTS free_segs (
               seg   INTEGER PRIMARY KEY,
               bytes BLOB NOT NULL
             );
             -- One row set per side-table ledger row, populated as the
             -- Pending atoms land paired with their store rows (design
             -- § Side tables: the ledger governs the schema).
             CREATE TABLE IF NOT EXISTS side_tables (
               name  TEXT NOT NULL,
               key   BLOB NOT NULL,
               bytes BLOB NOT NULL,
               PRIMARY KEY (name, key)
             );
             -- Normalized page-edge pairs (the query-driven GC layer,
             -- store seam phase 10): one row per (target, page) edge,
             -- DERIVED from page_edges — never sealed, rebuildable —
             -- maintained in the same commit transaction. The primary
             -- key answers \"which pages reference target?\" (the
             -- reverse index no blob encoding can); the page index
             -- answers forward adjacency, which is what lets
             -- reachability run as a recursive CTE inside SQLite
             -- instead of reifying the whole edge set into Rust.
             CREATE TABLE IF NOT EXISTS edge_pairs (
               target INTEGER NOT NULL,
               page   INTEGER NOT NULL,
               PRIMARY KEY (target, page)
             ) WITHOUT ROWID;
             CREATE INDEX IF NOT EXISTS edge_pairs_by_page
               ON edge_pairs (page);",
        )
        .map_err(sql_err)?;
        Self::rebuild_edge_pairs(&conn)?;
        Ok(SqliteHeapStore { conn })
    }

    /// Rebuild `edge_pairs` from the sealed `page_edges` rows,
    /// UNCONDITIONALLY, at every open. The derived index is
    /// decision-critical (the CTE collector reads only it) yet sits
    /// outside the integrity root by design, so open never TRUSTS it:
    /// any at-rest divergence — a store from before the table existed,
    /// a wiped index, or a count-preserving content edit no cheap gate
    /// can see (the review's finding: an earlier version rebuilt only
    /// when cardinalities disagreed, which a moved pair defeats) — is
    /// erased here, and between opens the EXCLUSIVE locking mode keeps
    /// other writers out while our own commits maintain the index
    /// transactionally. Cost is one pass over metadata-scale rows,
    /// the same order as the dense summary read `validate_store`
    /// already performs at resume.
    fn rebuild_edge_pairs(conn: &Connection) -> Result<(), StoreError> {
        let tx = conn.unchecked_transaction().map_err(sql_err)?;
        tx.execute("DELETE FROM edge_pairs", []).map_err(sql_err)?;
        {
            let mut read = tx
                .prepare("SELECT page, targets FROM page_edges")
                .map_err(sql_err)?;
            let mut insert = tx
                .prepare("INSERT OR REPLACE INTO edge_pairs (target, page) VALUES (?1, ?2)")
                .map_err(sql_err)?;
            let rows = read
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
                .map_err(sql_err)?;
            for row in rows {
                let (page, blob) = row.map_err(sql_err)?;
                if blob.len() % 4 != 0 {
                    return Err(StoreError::Io("sqlite: malformed page edges".to_string()));
                }
                for c in blob.chunks_exact(4) {
                    let target = u32::from_be_bytes(c.try_into().unwrap());
                    insert
                        .execute(params![target as i64, page])
                        .map_err(sql_err)?;
                }
            }
        }
        tx.commit().map_err(sql_err)
    }

    /// The full last-connection close of the shutdown-checkpoint
    /// contract: checkpoints the WAL into the main file and removes the
    /// sidecars, leaving a self-contained single file safe to copy or
    /// hand off. Consume-on-close mirrors the daemon's "no database
    /// request after close" invariant.
    ///
    /// The single-file invariant holds only once this returns `Ok`: a
    /// dropped (not closed) store runs `Connection`'s `Drop`, which
    /// swallows any checkpoint error, and may leave live `-wal`/`-shm`
    /// sidecars beside the file. Committed epochs are still durable
    /// either way (WAL + `synchronous=FULL`); only the
    /// one-self-contained-file property needs the explicit close.
    pub fn close(self) -> Result<(), StoreError> {
        self.conn
            .close()
            .map_err(|(_conn, e)| sql_err(e))
    }

    fn stored_manifest(conn: &Connection) -> Result<Option<StoreManifest>, StoreError> {
        let bytes: Option<Vec<u8>> = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![META_MANIFEST],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)?;
        match bytes {
            None => Ok(None),
            Some(b) => Ok(Some(StoreManifest::decode(&b)?)),
        }
    }

    // --- query-driven GC capabilities (store seam phase 10) ---
    //
    // `pages_referencing` is backend-specific (the trait grows a
    // reverse-edge surface when the generational collector needs it
    // from every backend); reachability and the summary count are
    // ALSO served through the `HeapStore` trait overrides below, so
    // the summary-driven partial collector's decision query runs as
    // the CTE on this backend with no caller change.

    /// The pages whose summaries reference `target` — the reverse
    /// query the normalized pairs exist for: O(in-degree) by primary
    /// key, no blob decode, no whole-edge-set reification. The
    /// generational mark asks exactly this for each page a crank
    /// dirtied.
    pub fn pages_referencing(&self, target: u32) -> Result<Vec<u32>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT page FROM edge_pairs WHERE target = ?1 ORDER BY page")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![target as i64], |r| r.get::<_, i64>(0))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(page_col(r.map_err(sql_err)?)?);
        }
        Ok(out)
    }

    /// Page reachability computed INSIDE SQLite as a recursive CTE
    /// over the normalized pairs — the query-driven twin of
    /// [`ironhorse_snapshot::store::reachable_pages`], which reads
    /// the WHOLE edge set into Rust first (O(pages) transfer per
    /// call, regardless of how much is reachable). Same answer by
    /// construction — locked by a parity test — with transfer
    /// proportional to the ANSWER; the store bench compares their
    /// scaling. Roots ride a temp table, so root-set size never hits
    /// SQL length limits.
    pub fn reachable_pages_sql(
        &self,
        roots: &[u32],
    ) -> Result<std::collections::BTreeSet<u32>, StoreError> {
        self.conn
            .execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS reach_roots (p INTEGER PRIMARY KEY);
                 DELETE FROM reach_roots;",
            )
            .map_err(sql_err)?;
        {
            let mut ins = self
                .conn
                .prepare("INSERT OR IGNORE INTO reach_roots (p) VALUES (?1)")
                .map_err(sql_err)?;
            for &r in roots {
                ins.execute(params![r as i64]).map_err(sql_err)?;
            }
        }
        let mut stmt = self
            .conn
            .prepare(
                "WITH RECURSIVE reach(p) AS (
                   SELECT p FROM reach_roots
                   UNION
                   SELECT e.target FROM edge_pairs e JOIN reach ON e.page = reach.p
                 )
                 SELECT p FROM reach",
            )
            .map_err(sql_err)?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).map_err(sql_err)?;
        let mut out = std::collections::BTreeSet::new();
        for r in rows {
            out.insert(page_col(r.map_err(sql_err)?)?);
        }
        self.conn
            .execute("DELETE FROM reach_roots", [])
            .map_err(sql_err)?;
        Ok(out)
    }
}

impl HeapStore for SqliteHeapStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        Self::stored_manifest(&self.conn)?.ok_or(StoreError::Empty)
    }

    // Trait-level query overrides (store seam phase 10): the partial
    // collector's decision queries run indexed on this backend — the
    // summary-count gate as a COUNT(*), reachability as the recursive
    // CTE — with the dense defaults' exact semantics (dense/CTE parity
    // and MemoryStore equivalence locked in tests/query_gc.rs).

    fn summary_page_count(&self) -> Result<u32, StoreError> {
        // Empty-store parity with the dense default (which fails with
        // `Empty` through `page_edges`), and contiguity, not just
        // cardinality: `{0,1,3,4,X}` has the right COUNT while page 2
        // is missing — the dense default fails closed on that gap, so
        // this override must too (review finding).
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        let (count, extent): (i64, i64) = self
            .conn
            .query_row(
                "SELECT COUNT(*), COALESCE(MAX(page) + 1, 0) FROM page_edges",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(sql_err)?;
        if count != extent {
            return Err(StoreError::Io(format!(
                "sqlite: page_edges not contiguous ({count} rows, extent {extent})"
            )));
        }
        Ok(count as u32)
    }

    fn reachable_page_set(
        &self,
        roots: &[u32],
    ) -> Result<std::collections::BTreeSet<u32>, StoreError> {
        // Same empty-store parity as above; the dense default errors
        // before BFS on any backend without a committed epoch.
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        self.reachable_pages_sql(roots)
    }

    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        self.conn
            .query_row(
                "SELECT bytes FROM small_state WHERE name = ?1",
                params![SMALL_NAME],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)?
            .ok_or(StoreError::Io(
                "sqlite: committed store has no small-state row".to_string(),
            ))
    }

    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        // Empty-store gate for point-read parity: all three backends
        // report `Empty` for a store with no committed epoch, and
        // `MissingRow` only for a committed store lacking the row
        // (the review's parity table).
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        self.conn
            .query_row(
                "SELECT bytes FROM slot_pages WHERE page = ?1",
                params![page as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)?
            .ok_or(StoreError::MissingRow("slot page", page))
    }

    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        self.conn
            .query_row(
                "SELECT bytes FROM chunk_exts WHERE ext = ?1",
                params![ext as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)?
            .ok_or(StoreError::MissingRow("chunk extent", ext))
    }

    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        // Metadata-only: `length(bytes)` never materializes the BLOBs,
        // so open-time validation (and lazy resume) reads no row
        // contents.
        let _ = self.manifest()?;
        // Built from the rows actually present (ORDER BY page), never
        // pre-sized from the manifest's untrusted geometry — a forged
        // slot_count must fail validation, not force an allocation
        // (the malformed-count discipline). Contiguity is enforced
        // here; the count-vs-geometry comparison is validate_store's.
        let mut pages: Vec<usize> = Vec::new();
        let mut stmt = self
            .conn
            .prepare("SELECT page, length(bytes) FROM slot_pages ORDER BY page")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map_err(sql_err)?;
        for row in rows {
            let (page, len) = row.map_err(sql_err)?;
            if page as usize != pages.len() {
                return Err(StoreError::MissingRow("slot page", pages.len() as u32));
            }
            pages.push(len as usize);
        }

        let mut exts: Vec<usize> = Vec::new();
        let mut stmt = self
            .conn
            .prepare("SELECT ext, length(bytes) FROM chunk_exts ORDER BY ext")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))
            .map_err(sql_err)?;
        for row in rows {
            let (ext, len) = row.map_err(sql_err)?;
            if ext as usize != exts.len() {
                return Err(StoreError::MissingRow("chunk extent", exts.len() as u32));
            }
            exts.push(len as usize);
        }
        Ok((pages, exts))
    }

    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        let read = |kind: i64, what: &'static str| -> Result<Vec<[u8; 32]>, StoreError> {
            let mut stmt = self
                .conn
                .prepare("SELECT idx, hash FROM leaf_hashes WHERE kind = ?1 ORDER BY idx")
                .map_err(sql_err)?;
            let rows = stmt
                .query_map(params![kind], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                })
                .map_err(sql_err)?;
            let mut out: Vec<[u8; 32]> = Vec::new();
            for row in rows {
                let (idx, hash) = row.map_err(sql_err)?;
                if idx as usize != out.len() {
                    return Err(StoreError::MissingRow(what, out.len() as u32));
                }
                let arr: [u8; 32] = hash
                    .try_into()
                    .map_err(|_| StoreError::Io("sqlite: malformed leaf hash".to_string()))?;
                out.push(arr);
            }
            Ok(out)
        };
        Ok((read(0, "slot page leaf")?, read(1, "chunk extent leaf")?))
    }

    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        let Some(m) = Self::stored_manifest(&self.conn)? else {
            return Err(StoreError::Empty);
        };
        let mut stmt = self
            .conn
            .prepare("SELECT page, targets FROM page_edges ORDER BY page")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
            .map_err(sql_err)?;
        let mut out: Vec<Vec<u32>> = Vec::new();
        for row in rows {
            let (page, blob) = row.map_err(sql_err)?;
            if page as usize != out.len() {
                return Err(StoreError::MissingRow("page edges", out.len() as u32));
            }
            if blob.len() % 4 != 0 {
                return Err(StoreError::Io("sqlite: malformed page edges".to_string()));
            }
            out.push(
                blob.chunks_exact(4)
                    .map(|c| u32::from_be_bytes(c.try_into().unwrap()))
                    .collect(),
            );
        }
        // Contiguity above rules out interior gaps; this rules out a
        // truncated TAIL — the case the review showed reads as "no
        // outgoing edges" and turns the partial collector maximal.
        let expected = slot_page_count(m.slot_count);
        if out.len() != expected as usize {
            return Err(StoreError::SummaryCount {
                expected,
                found: out.len() as u32,
            });
        }
        Ok(out)
    }

    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        self.conn
            .query_row(
                "SELECT bytes FROM free_segs WHERE seg = ?1",
                params![seg as i64],
                |row| row.get(0),
            )
            .optional()
            .map_err(sql_err)?
            .ok_or(StoreError::MissingRow("free segment", seg))
    }

    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT idx, hash FROM leaf_hashes WHERE kind = 2 ORDER BY idx")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
            .map_err(sql_err)?;
        let mut out: Vec<[u8; 32]> = Vec::new();
        for row in rows {
            let (idx, hash) = row.map_err(sql_err)?;
            if idx as usize != out.len() {
                return Err(StoreError::MissingRow("free segment leaf", out.len() as u32));
            }
            let arr: [u8; 32] = hash
                .try_into()
                .map_err(|_| StoreError::Io("sqlite: malformed leaf hash".to_string()))?;
            out.push(arr);
        }
        Ok(out)
    }

    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
        // IMMEDIATE: take the writer lock up front so a concurrent
        // commit serializes under busy_timeout instead of surfacing
        // SQLITE_BUSY_SNAPSHOT on the mid-transaction read-to-write
        // upgrade (the collaborator review's finding).
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        {
            let stored = Self::stored_manifest(&tx)?;
            check_succession(stored.as_ref(), batch)?;
            let pages = slot_page_count(batch.manifest.slot_count);
            let exts = chunk_extent_count(batch.manifest.chunk_len);

            let mut upsert_page = tx
                .prepare(
                    "INSERT INTO slot_pages (page, bytes) VALUES (?1, ?2)
                     ON CONFLICT(page) DO UPDATE SET bytes = excluded.bytes",
                )
                .map_err(sql_err)?;
            for (page, bytes) in &batch.slot_pages {
                upsert_page
                    .execute(params![*page as i64, bytes])
                    .map_err(sql_err)?;
            }
            let mut upsert_ext = tx
                .prepare(
                    "INSERT INTO chunk_exts (ext, bytes) VALUES (?1, ?2)
                     ON CONFLICT(ext) DO UPDATE SET bytes = excluded.bytes",
                )
                .map_err(sql_err)?;
            for (ext, bytes) in &batch.chunk_extents {
                upsert_ext
                    .execute(params![*ext as i64, bytes])
                    .map_err(sql_err)?;
            }

            // Drop rows beyond the new geometry (the commit contract:
            // a shrink across a GC compaction must not leave stale
            // extents for a later, larger geometry to resurrect).
            tx.execute("DELETE FROM slot_pages WHERE page >= ?1", params![pages as i64])
                .map_err(sql_err)?;
            tx.execute("DELETE FROM chunk_exts WHERE ext >= ?1", params![exts as i64])
                .map_err(sql_err)?;

            // The shared per-commit verification (grown-region
            // presence for all three row dimensions, row lengths,
            // summary coupling, root recombination) against the prior
            // leaves and summaries — all read inside this transaction,
            // the same snapshot the succession check read. The prior
            // leaves are read PER KIND with contiguity enforced, like
            // the trait readers: the review found an unfiltered
            // `ORDER BY kind, idx` here silently folding kind-2 free
            // leaves into the extent vector (masked only by resize
            // bounds), and no gap detection.
            {
                let read_kind = |kind: i64, what: &'static str| -> Result<Vec<[u8; 32]>, StoreError> {
                    let mut stmt = tx
                        .prepare("SELECT idx, hash FROM leaf_hashes WHERE kind = ?1 ORDER BY idx")
                        .map_err(sql_err)?;
                    let rows = stmt
                        .query_map(params![kind], |r| {
                            Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))
                        })
                        .map_err(sql_err)?;
                    let mut out: Vec<[u8; 32]> = Vec::new();
                    for row in rows {
                        let (idx, hash) = row.map_err(sql_err)?;
                        if idx as usize != out.len() {
                            return Err(StoreError::MissingRow(what, out.len() as u32));
                        }
                        let arr: [u8; 32] = hash.try_into().map_err(|_| {
                            StoreError::Io("sqlite: malformed leaf hash".to_string())
                        })?;
                        out.push(arr);
                    }
                    Ok(out)
                };
                let mut prior_pages = read_kind(0, "slot page leaf")?;
                let mut prior_exts = read_kind(1, "chunk extent leaf")?;
                let mut prior_frees = read_kind(2, "free segment leaf")?;
                let mut prior_edges: Vec<Vec<u32>> = Vec::new();
                {
                    let mut stmt = tx
                        .prepare("SELECT page, targets FROM page_edges ORDER BY page")
                        .map_err(sql_err)?;
                    let rows = stmt
                        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))
                        .map_err(sql_err)?;
                    for row in rows {
                        let (page, blob) = row.map_err(sql_err)?;
                        if page as usize != prior_edges.len() {
                            return Err(StoreError::MissingRow(
                                "page edges",
                                prior_edges.len() as u32,
                            ));
                        }
                        if blob.len() % 4 != 0 {
                            return Err(StoreError::Io(
                                "sqlite: malformed page edges".to_string(),
                            ));
                        }
                        prior_edges.push(
                            blob.chunks_exact(4)
                                .map(|c| u32::from_be_bytes(c.try_into().unwrap()))
                                .collect(),
                        );
                    }
                }
                apply_batch(
                    &mut prior_pages,
                    &mut prior_exts,
                    &mut prior_frees,
                    &mut prior_edges,
                    batch,
                )?;
                let mut upsert_leaf = tx
                    .prepare(
                        "INSERT INTO leaf_hashes (kind, idx, hash) VALUES (?1, ?2, ?3)
                         ON CONFLICT(kind, idx) DO UPDATE SET hash = excluded.hash",
                    )
                    .map_err(sql_err)?;
                for (page, bytes) in &batch.slot_pages {
                    upsert_leaf
                        .execute(params![0i64, *page as i64, leaf_hash(LEAF_PAGE, *page, bytes).as_slice()])
                        .map_err(sql_err)?;
                }
                for (ext, bytes) in &batch.chunk_extents {
                    upsert_leaf
                        .execute(params![1i64, *ext as i64, leaf_hash(LEAF_EXT, *ext, bytes).as_slice()])
                        .map_err(sql_err)?;
                }
                for (seg, bytes) in &batch.free_segs {
                    upsert_leaf
                        .execute(params![2i64, *seg as i64, leaf_hash(LEAF_FREE, *seg, bytes).as_slice()])
                        .map_err(sql_err)?;
                }
                drop(upsert_leaf);
                tx.execute(
                    "DELETE FROM leaf_hashes WHERE kind = 0 AND idx >= ?1",
                    params![pages as i64],
                )
                .map_err(sql_err)?;
                tx.execute(
                    "DELETE FROM leaf_hashes WHERE kind = 1 AND idx >= ?1",
                    params![exts as i64],
                )
                .map_err(sql_err)?;
                let n_frees = free_seg_count(batch.manifest.free_len);
                tx.execute(
                    "DELETE FROM leaf_hashes WHERE kind = 2 AND idx >= ?1",
                    params![n_frees as i64],
                )
                .map_err(sql_err)?;
                let mut upsert_seg = tx
                    .prepare(
                        "INSERT INTO free_segs (seg, bytes) VALUES (?1, ?2)
                         ON CONFLICT(seg) DO UPDATE SET bytes = excluded.bytes",
                    )
                    .map_err(sql_err)?;
                for (seg, bytes) in &batch.free_segs {
                    upsert_seg
                        .execute(params![*seg as i64, bytes])
                        .map_err(sql_err)?;
                }
                drop(upsert_seg);
                tx.execute("DELETE FROM free_segs WHERE seg >= ?1", params![n_frees as i64])
                    .map_err(sql_err)?;
            }

            // Page-edge summaries (phase 6): upsert the dirty pages'
            // summaries, drop those beyond the new geometry. Grown
            // pages are necessarily dirty, so every page in range has
            // a row by induction. The normalized `edge_pairs` twin
            // (phase 10) is maintained in the SAME transaction from
            // the same batch rows, so the derived index can never
            // drift from the sealed source across a commit.
            {
                let mut upsert = tx
                    .prepare(
                        "INSERT INTO page_edges (page, targets) VALUES (?1, ?2)
                         ON CONFLICT(page) DO UPDATE SET targets = excluded.targets",
                    )
                    .map_err(sql_err)?;
                let mut clear_pairs = tx
                    .prepare("DELETE FROM edge_pairs WHERE page = ?1")
                    .map_err(sql_err)?;
                let mut insert_pair = tx
                    .prepare("INSERT OR REPLACE INTO edge_pairs (target, page) VALUES (?1, ?2)")
                    .map_err(sql_err)?;
                for (page, targets) in &batch.page_edges {
                    let mut blob = Vec::with_capacity(targets.len() * 4);
                    for t in targets {
                        blob.extend_from_slice(&t.to_be_bytes());
                    }
                    upsert
                        .execute(params![*page as i64, blob])
                        .map_err(sql_err)?;
                    clear_pairs.execute(params![*page as i64]).map_err(sql_err)?;
                    for t in targets {
                        insert_pair
                            .execute(params![*t as i64, *page as i64])
                            .map_err(sql_err)?;
                    }
                }
                drop(upsert);
                drop(clear_pairs);
                drop(insert_pair);
                tx.execute("DELETE FROM page_edges WHERE page >= ?1", params![pages as i64])
                    .map_err(sql_err)?;
                // Mirror the page_edges normalization VERBATIM: pairs
                // are dropped exactly when their page's row is dropped.
                // (An earlier `OR target >= ?1` disjunct implemented a
                // different normalization than the open-time rebuild —
                // dead code on honest histories, and on a crafted
                // shrink it manufactured a commit/rebuild oscillation;
                // the review killed it.)
                tx.execute(
                    "DELETE FROM edge_pairs WHERE page >= ?1",
                    params![pages as i64],
                )
                .map_err(sql_err)?;
            }

            tx.execute(
                "INSERT INTO small_state (name, bytes) VALUES (?1, ?2)
                 ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes",
                params![SMALL_NAME, batch.small],
            )
            .map_err(sql_err)?;
            tx.execute(
                "INSERT INTO meta (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![META_MANIFEST, batch.manifest.encode()],
            )
            .map_err(sql_err)?;
        }
        tx.commit().map_err(sql_err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_snapshot::machine::{
        begin_store_session, checkpoint_to_store, resume_from_store, MachineSnapshot,
    };
    use ironhorse_snapshot::store::{
        export_to_container, image_to_batch, import_from_container, store_to_image,
        validate_store,
    };
    use ironhorse_snapshot::Signature;
    use ironhorse_vm::Interp;
    use std::path::PathBuf;

    fn sig() -> Signature {
        Signature::new("ironhorse-worker-v1")
    }

    // The captured oracle bytecodes the engine-side store tests use:
    // PROG_A completes "6", PROG_B completes "1".
    const PROG_A: [u8; 44] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
        0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
        0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
    ];
    const PROG_B: [u8; 51] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x1c, 0x0b, 0x00, 0xe0, 0x38, 0x00, 0x00,
        0x2e, 0x06, 0x0b, 0x00, 0x72, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00,
        0x72, 0x04, 0x28, 0xab, 0x00, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72,
        0x04, 0x28, 0xab, 0x00, 0xbb, 0xa9,
    ];

    fn tmp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ironhorse-sqlite-store-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn empty_store_reports_empty() {
        let store = SqliteHeapStore::open_in_memory().unwrap();
        assert_eq!(store.manifest().unwrap_err(), StoreError::Empty);
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::Empty
        );
    }

    /// The identity lock through SQLite: container → store → container
    /// is byte-identical.
    #[test]
    fn container_import_export_is_byte_identical() {
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let bytes = m.write_snapshot(&sig());

        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        import_from_container(&bytes, &sig(), &mut store).expect("imports");
        validate_store(&store, &sig()).expect("validates");
        assert_eq!(export_to_container(&store).unwrap(), bytes);
    }

    /// The central invariant, through SQLite: after full and
    /// incremental checkpoints alike, the store equals the live
    /// machine and exports byte-identically to the machine's own blob.
    #[test]
    fn store_tracks_live_machine() {
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let mut session = begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .unwrap();
        assert_eq!(
            store_to_image(&store).unwrap(),
            session.machine().snapshot_image(&sig())
        );

        assert!(session.machine_mut().run(&PROG_B).completed);
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
        assert_eq!(
            store_to_image(&store).unwrap(),
            session.machine().snapshot_image(&sig())
        );
        assert_eq!(
            export_to_container(&store).unwrap(),
            session.machine().write_snapshot(&sig())
        );
    }

    /// The row-6 bar through SQLite on disk: suspend after crank A,
    /// close the database fully, reopen, resume, run crank B — result
    /// and computron count equal the uninterrupted machine's.
    #[test]
    fn resume_across_full_close_equals_uninterrupted() {
        let dir = tmp_dir("resume");
        let path = dir.join("worker-heap.sqlite");

        let mut uninterrupted = Interp::new();
        assert!(uninterrupted.run(&PROG_A).completed);
        let ub = uninterrupted.run(&PROG_B);
        assert!(ub.completed);

        let mut store = SqliteHeapStore::open(&path).unwrap();
        let mut m1 = Interp::new();
        assert!(m1.run(&PROG_A).completed);
        drop(
            begin_store_session(m1, &sig(), &mut store)
                .map_err(|(_, e)| e)
                .unwrap(),
        );
        store.close().expect("full close");

        // The full-close contract (daemon-sqlite-shutdown-checkpoint):
        // after the last connection closes, the WAL is folded in and
        // the sidecars are gone — the file is single-file-safe.
        let wal = dir.join("worker-heap.sqlite-wal");
        let shm = dir.join("worker-heap.sqlite-shm");
        assert!(!wal.exists(), "WAL sidecar must be gone after close");
        assert!(!shm.exists(), "SHM sidecar must be gone after close");

        let store = SqliteHeapStore::open(&path).unwrap();
        let mut session = resume_from_store(&store, &sig()).expect("resumes");
        assert_eq!(session.epoch(), 1);
        let b2 = session.machine_mut().run(&PROG_B);
        assert_eq!(b2.result, ub.result);
        assert_eq!(
            b2.computrons, ub.computrons,
            "meter continued through the SQLite round-trip"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Incremental commits persist: checkpoint, close, reopen, and the
    /// merged state (dirty rows over preserved rows) reads back
    /// exactly; the epoch discipline holds across the reopen.
    #[test]
    fn incremental_checkpoints_persist_and_epoch_holds_across_reopen() {
        let dir = tmp_dir("incremental");
        let path = dir.join("worker-heap.sqlite");

        let mut store = SqliteHeapStore::open(&path).unwrap();
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let mut session = begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .unwrap();
        assert!(session.machine_mut().run(&PROG_B).completed);
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
        let expected = session.machine().snapshot_image(&sig());
        store.close().unwrap();

        let mut store = SqliteHeapStore::open(&path).unwrap();
        assert_eq!(store.manifest().unwrap().epoch, 2);
        assert_eq!(store_to_image(&store).unwrap(), expected);

        // A replayed batch is refused after reopen.
        let stale = image_to_batch(&expected, 2, "");
        assert_eq!(
            store.commit(&stale).unwrap_err(),
            StoreError::EpochMismatch {
                expected: 3,
                found: 2
            }
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The geometry-drop contract: a shrink deletes stale rows in the
    /// same transaction (SELECT count agrees with the new geometry).
    #[test]
    fn commit_drops_rows_beyond_the_new_geometry() {
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image = m.snapshot_image(&sig());
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        assert!(
            !image.chunks.is_empty(),
            "fixture must carry chunk bytes for the shrink to mean anything"
        );

        let mut shrunk = image.clone();
        shrunk.chunks = Vec::new();
        let prev = store.manifest().unwrap().seal;
        let mut batch = image_to_batch(&shrunk, 2, &prev);
        batch.chunk_extents.clear();
        store.commit(&batch).unwrap();

        let exts: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM chunk_exts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(exts, 0, "stale extents deleted transactionally");
        assert_eq!(store_to_image(&store).unwrap().chunks, Vec::<u8>::new());
    }

    /// A file that is not a SQLite database fails closed at open.
    #[test]
    fn foreign_file_fails_closed() {
        let dir = tmp_dir("foreign");
        let path = dir.join("not-a-db.sqlite");
        std::fs::write(&path, b"IHSTORE1 this is the wrong kind of store").unwrap();
        match SqliteHeapStore::open(&path) {
            Err(StoreError::Io(msg)) => assert!(msg.contains("sqlite"), "named failure: {msg}"),
            other => panic!("expected fail-closed open, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cross-backend parity: the SQLite store and the in-crate memory
    /// reference agree byte-for-byte on the same checkpoint history.
    #[test]
    fn agrees_with_the_memory_reference_backend() {
        use ironhorse_snapshot::store::MemoryStore;
        let mut sqlite = SqliteHeapStore::open_in_memory().unwrap();
        let mut memory = MemoryStore::new();

        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image(&sig());
        sqlite.commit(&image_to_batch(&image1, 1, "")).unwrap();
        memory.commit(&image_to_batch(&image1, 1, "")).unwrap();

        assert!(m.run(&PROG_B).completed);
        let image2 = m.snapshot_image(&sig());
        let prev = memory.manifest().unwrap().seal;
        sqlite.commit(&image_to_batch(&image2, 2, &prev)).unwrap();
        memory.commit(&image_to_batch(&image2, 2, &prev)).unwrap();

        assert_eq!(
            export_to_container(&sqlite).unwrap(),
            export_to_container(&memory).unwrap(),
            "backends are interchangeable byte-for-byte"
        );
    }
}
