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
//! [`ironhorse_snapshot::store::check_succession`] (the epoch plus the
//! commit token, which pairs each batch with the stored state it was
//! built on), the shared batch admission checks, rows beyond the new
//! geometry dropped on commit, raw row bytes in the crate's canonical
//! encodings, and the same fail-closed gate taxonomy.
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
    check_migration_baseline, chunk_extent_count, free_seg_count, slot_page_count, HeapStore,
    StoreError, StoreManifest,
};
use ironhorse_snapshot::store_sections::{
    frame_small_state, split_small_state, SectionLeaves, SectionUpdate, SMALL_SECTION_COUNT,
};
use ironhorse_snapshot::SnapshotError;
use rusqlite::{params, Connection, OptionalExtension};

/// Map a rusqlite failure into the store vocabulary. SQLite errors are
/// I/O-class faults (a crashed crank at the machine surface), never
/// silently absorbed, except the two that describe the file itself: one
/// that is not a SQLite database, or whose pages SQLite finds malformed,
/// reads the same on every retry, so it is a corrupt store, like the
/// foreign-database refusal at open.
fn sql_err(e: rusqlite::Error) -> StoreError {
    match e.sqlite_error_code() {
        Some(rusqlite::ErrorCode::NotADatabase) => {
            StoreError::Snapshot(SnapshotError::Corrupt("sqlite: not a database"))
        }
        Some(rusqlite::ErrorCode::DatabaseCorrupt) => StoreError::Snapshot(SnapshotError::Corrupt(
            "sqlite: database disk image is malformed",
        )),
        _ => StoreError::Io(format!("sqlite: {e}")),
    }
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
/// The `meta` key recording that `edge_pairs` mirrors the `page_edges`
/// rows: its value is the big-endian epoch of the manifest
/// whose commit last maintained the index. Only commits write it, in
/// the transaction that maintains the index rows, so a marker naming
/// the committed epoch means a commit that keeps the marker last
/// maintained the current rows; open only reads it, and trusts it
/// without re-deriving the rows. No migration ladder step changes the
/// epoch or writes `page_edges`, so the marker stays valid across
/// migration; a step that ever rewrites the summaries must rebuild the
/// index too. A change to the index's layout must move it to a new
/// table under a new marker key: each build then rebuilds and trusts
/// only its own table, so neither build's open rewrites rows the
/// other's marker covers, and a commit by either moves the epoch past
/// the other's marker. A build that retires the old table must delete
/// its marker in the same transaction, or an older build would recreate
/// the table empty and trust it.
const META_EDGE_PAIRS_EPOCH: &str = "edge_pairs_epoch";
/// The `small_state` row name holding the encoded small state.
const SMALL_NAME: &str = "small";

/// Record that `edge_pairs` is current for `epoch`. The caller owns the
/// commit transaction that brought the index rows to that epoch, so the
/// marker commits (or rolls back) with the rows it describes.
fn write_edge_pairs_epoch(conn: &Connection, epoch: u64) -> Result<(), StoreError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![META_EDGE_PAIRS_EPOCH, &epoch.to_be_bytes()[..]],
    )
    .map_err(sql_err)?;
    Ok(())
}

/// Whether the stored marker records `edge_pairs` as current for
/// `epoch`. An absent marker, one naming another epoch, or one that is
/// not the 8-byte big-endian blob [`write_edge_pairs_epoch`] writes all
/// read as stale.
fn edge_pairs_current(conn: &Connection, epoch: u64) -> Result<bool, StoreError> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM meta WHERE key = ?1 AND value = ?2)",
        params![META_EDGE_PAIRS_EPOCH, &epoch.to_be_bytes()[..]],
        |r| r.get(0),
    )
    .map_err(sql_err)
}

/// The caller owns a transaction so section rows and their manifest are atomic.
fn write_small_state(conn: &Connection, schema: u32, bytes: &[u8]) -> Result<(), StoreError> {
    if schema < 28 {
        conn.execute(
            "INSERT INTO small_state (name, bytes) VALUES (?1, ?2)
             ON CONFLICT(name) DO UPDATE SET bytes = excluded.bytes",
            params![SMALL_NAME, bytes],
        )
        .map_err(sql_err)?;
        return Ok(());
    }
    let sections = split_small_state(bytes)?;
    // Schema DDL belongs to the authorized write transaction. Merely opening
    // a legacy store (which may have an incompatible signature) must not edit it.
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS small_sections (
           id INTEGER PRIMARY KEY CHECK (id >= 0 AND id < 32),
           bytes BLOB NOT NULL,
           hash BLOB NOT NULL CHECK (length(hash) = 32)
         );",
    )
    .map_err(sql_err)?;
    let leaves = SectionLeaves::from_payloads(&sections);
    let mut upsert = conn
        .prepare(
            "INSERT INTO small_sections (id, bytes, hash) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes, hash = excluded.hash",
        )
        .map_err(sql_err)?;
    for (id, payload) in sections.iter().enumerate() {
        upsert
            .execute(params![id as i64, payload, &leaves.hashes()[id][..]])
            .map_err(sql_err)?;
    }
    conn.execute(
        "DELETE FROM small_state WHERE name = ?1",
        params![SMALL_NAME],
    )
    .map_err(sql_err)?;
    Ok(())
}

fn read_section_hashes(conn: &Connection) -> Result<[[u8; 32]; SMALL_SECTION_COUNT], StoreError> {
    let mut stmt = conn
        .prepare("SELECT id, hash FROM small_sections ORDER BY id")
        .map_err(sql_err)?;
    let mut rows = stmt.query([]).map_err(sql_err)?;
    let mut hashes = [[0; 32]; SMALL_SECTION_COUNT];
    for (id, hash) in hashes.iter_mut().enumerate() {
        let row = rows
            .next()
            .map_err(sql_err)?
            .ok_or(StoreError::MissingRow("small section hash", id as u32))?;
        let found: i64 = row.get(0).map_err(sql_err)?;
        if found != id as i64 {
            return Err(StoreError::MissingRow("small section hash", id as u32));
        }
        let bytes: Vec<u8> = row.get(1).map_err(sql_err)?;
        *hash = bytes
            .try_into()
            .map_err(|_| StoreError::Io("sqlite: small section hash length".into()))?;
    }
    if rows.next().map_err(sql_err)?.is_some() {
        return Err(StoreError::Io("sqlite: extra small section hashes".into()));
    }
    Ok(hashes)
}

fn write_section_updates(conn: &Connection, updates: &[SectionUpdate]) -> Result<(), StoreError> {
    let mut upsert = conn
        .prepare(
            "INSERT INTO small_sections (id, bytes, hash) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET bytes = excluded.bytes, hash = excluded.hash",
        )
        .map_err(sql_err)?;
    for update in updates {
        let hash = ironhorse_snapshot::store_sections::section_hash(update.section, &update.bytes);
        upsert
            .execute(params![
                update.section.id() as i64,
                &update.bytes,
                &hash[..]
            ])
            .map_err(sql_err)?;
    }
    Ok(())
}

/// Read the small state back from its section rows. The stored section
/// digests are not re-derived here: under the store-seam design's trust
/// model the rows are the state, and the digests are change detection
/// only (`validate_store_content` re-derives them).
fn read_sectioned_state(conn: &Connection) -> Result<Vec<u8>, StoreError> {
    let mut stmt = conn
        .prepare("SELECT id, bytes FROM small_sections ORDER BY id")
        .map_err(sql_err)?;
    let mut rows = stmt.query([]).map_err(sql_err)?;
    let mut payloads: [Vec<u8>; SMALL_SECTION_COUNT] = std::array::from_fn(|_| Vec::new());
    for (id, payload) in payloads.iter_mut().enumerate() {
        let row = rows
            .next()
            .map_err(sql_err)?
            .ok_or(StoreError::MissingRow("small section", id as u32))?;
        let found: i64 = row.get(0).map_err(sql_err)?;
        if found != id as i64 {
            return Err(StoreError::MissingRow("small section", id as u32));
        }
        *payload = row.get(1).map_err(sql_err)?;
    }
    if rows.next().map_err(sql_err)?.is_some() {
        return Err(StoreError::Io("sqlite: extra small sections".into()));
    }
    frame_small_state(&std::array::from_fn(|id| payloads[id].as_slice()))
}

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
        // A read-only database (a write-protected file, or a `mode=ro`
        // URI) cannot take the exclusive lock below: SQLite runs BEGIN
        // IMMEDIATE there as a plain read transaction, with no lock and no
        // error. Such a store could never commit either, so refuse it here,
        // before the fresh-store stamp below tries to write, rather than at
        // its first checkpoint. The refusal is a capability the medium
        // lacks, not a transient I/O fault, so a supervisor does not retry
        // it.
        if conn
            .is_readonly(rusqlite::DatabaseName::Main)
            .map_err(sql_err)?
        {
            return Err(StoreError::Unsupported(
                "open a read-only sqlite database (open locks it for writing)",
            ));
        }
        // Foreign-database gate before anything else touches the file.
        let app_id: i32 = conn
            .query_row("PRAGMA application_id", [], |r| r.get(0))
            .map_err(sql_err)?;
        if app_id == 0 {
            // Unstamped: acceptable only for a genuinely fresh database
            // (no tables at all) — an unstamped populated database is
            // some other subsystem's data, not ours to adopt.
            let tables: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                    [],
                    |r| r.get(0),
                )
                .map_err(sql_err)?;
            if tables != 0 {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "sqlite: foreign database (populated, unstamped)",
                )));
            }
            conn.execute_batch(&format!("PRAGMA application_id = {}", Self::APPLICATION_ID))
                .map_err(sql_err)?;
        } else if app_id != Self::APPLICATION_ID {
            // Not a heap store, which a retry cannot change: the file
            // store's foreign-magic refusal, in the same vocabulary.
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "sqlite: foreign database (application_id)",
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
        // EXCLUSIVE locking a connection never releases a lock it has
        // taken, and open takes the database's exclusive lock below, so
        // a stray second opener fails closed with SQLITE_BUSY at its
        // first query (our application_id gate) rather than silently
        // racing. In-memory databases report "exclusive" trivially
        // (nothing shares them).
        let lock_mode: String = conn
            .query_row("PRAGMA locking_mode=EXCLUSIVE", [], |r| r.get(0))
            .map_err(sql_err)?;
        if !lock_mode.eq_ignore_ascii_case("exclusive") {
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
        // Take that lock now, explicitly. SQLite acquires it at the
        // connection's first write transaction (the application_id read
        // above ran before EXCLUSIVE was set), and opening a current
        // store writes nothing: its edge index is trusted below, not
        // rebuilt. An empty IMMEDIATE transaction takes the lock without
        // writing a page, and EXCLUSIVE keeps it until close. The
        // per-open edge rebuild used to take it as a side effect; with
        // neither, a second connection could open, read, and write a
        // store this one had just opened. (A read-only database, where
        // this takes no lock, was refused at the top.)
        conn.execute_batch("BEGIN IMMEDIATE; COMMIT;")
            .map_err(sql_err)?;
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
             -- Page-edge summaries (store seam phase 6): the sorted
             -- outgoing page targets per slot page, as big-endian u32s.
             CREATE TABLE IF NOT EXISTS page_edges (
               page    INTEGER PRIMARY KEY,
               targets BLOB NOT NULL
             );
             -- Free-list segments (store seam phase 9): big-endian u32
             -- entries.
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
             -- DERIVED from page_edges — rebuildable —
             -- maintained in the same commit transaction. Open trusts
             -- it while meta.edge_pairs_epoch names the committed
             -- epoch, so an edit here that leaves that marker in place
             -- is trusted by the collectors that read it. The primary
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
        // Fail closed on an unsupported schema BEFORE the derived-table
        // rebuild below can write anything: a store this build cannot
        // use — too new to decode, or too old to migrate — must be
        // refused with its bytes untouched, not clobbered by
        // `rebuild_edge_pairs` (a committed DELETE+INSERT) and only THEN
        // refused (review wave 4, F1). A supported-old store (migratable)
        // and the current schema both pass; the DDL above is
        // content-neutral (CREATE ... IF NOT EXISTS never drops a row) so
        // it may precede this read, but the rebuild may not. A fresh
        // (unstamped) store has no manifest and reads as `None`.
        //
        // The DECODE is the gate: `StoreManifest::decode` already refuses
        // any schema outside [MIN_SUPPORTED, VERSION]. What this call
        // site contributes is its POSITION, so the explicit range check
        // that used to stand here was unreachable and is gone (review
        // wave 5).
        let manifest = Self::stored_manifest(&conn)?;
        // Trust the edge index the file records as current for its epoch
        // (issue #1330): opening such a store reads one marker and
        // rewrites nothing. Only a store whose current rows no
        // marker-keeping commit wrote is rebuilt. A fresh store has
        // nothing to rebuild; its first commit writes every page's pairs
        // and the marker.
        if let Some(m) = &manifest {
            if !edge_pairs_current(&conn, m.epoch)? {
                Self::rebuild_edge_pairs(&conn)?;
            }
        }
        // Open does NOT migrate. A supported-old store opens as-is and
        // the caller upgrades it with `migrate_store`, which gates the
        // restamp on the callback-table signature this connection has no
        // way to know (review wave 4, F2). The EXCLUSIVE locking taken
        // above still makes that later in-place restamp safe.
        Ok(SqliteHeapStore { conn })
    }

    /// Rebuild `edge_pairs` from the `page_edges` rows. Open runs this
    /// only when the store does not record its index as current for the
    /// committed epoch (see [`META_EDGE_PAIRS_EPOCH`]): a store from
    /// before the table or the marker existed, or one last committed by
    /// a build that does not keep the marker. A crash mid-rebuild, or
    /// between creating the table and filling it, leaves the marker as
    /// stale as it found it, so the next open rebuilds again.
    ///
    /// The rebuild leaves the marker alone. Only a commit, the store's
    /// authorized write, records the marker, so open leaves a store it may
    /// yet refuse (an incompatible boot layout or signature is found only
    /// later, by the caller's `migrate_store` or resume) exactly
    /// as every open used to: rebuilding an index that already mirrors
    /// its summaries rewrites the same rows. A stale store therefore
    /// rebuilds at each open until its first commit under this build
    /// records the marker.
    ///
    /// A store whose marker is current is trusted instead (issue #1330),
    /// as the store seam's trust model (its phase 13) trusts every row:
    /// open does not re-derive the index, and so no longer pays an
    /// O(edges) write transaction for it. While the store is open, the
    /// EXCLUSIVE locking mode keeps other SQLite writers out as our own
    /// commits maintain the index and its marker transactionally. The
    /// marker records which epoch the index was maintained for, not
    /// whether its rows are right: a bug in commit-time maintenance
    /// persists across reopens, and an offline edit of `page_edges` must
    /// delete the marker so that the next open rebuilds the index.
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
        self.conn.close().map_err(|(_conn, e)| sql_err(e))
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
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(sql_err)?;
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

    /// One IMMEDIATE transaction: the durable manifest must still be
    /// `from`, and then `to` and the small state (in `to`'s layout) replace
    /// it, and the row-leaf hashes the schemas before 36 kept are dropped
    /// with their table. The edge marker stays valid: no ladder step
    /// changes the epoch or writes `page_edges`. A step that rewrote the
    /// summaries would have to rebuild `edge_pairs` in this transaction,
    /// or the next commit would mark a stale index current.
    fn replace_for_migration(
        &mut self,
        from: &StoreManifest,
        to: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        let durable = Self::stored_manifest(&tx)?.ok_or(StoreError::Empty)?;
        check_migration_baseline(&durable, from)?;
        write_small_state(&tx, to.store_schema, small)?;
        tx.execute("DROP TABLE IF EXISTS leaf_hashes", [])
            .map_err(sql_err)?;
        tx.execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![META_MANIFEST, to.encode()],
        )
        .map_err(sql_err)?;
        tx.commit().map_err(sql_err)
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

    /// Generational seed query, answered from the reverse index:
    /// candidates with an inbound edge from a page OUTSIDE the
    /// candidate set — transfer proportional to the ANSWER, like the
    /// CTE (the dense default reads the whole edge table).
    fn externally_referenced(&self, targets: &[u32]) -> Result<Vec<u32>, StoreError> {
        // Empty-store parity with the dense default, which fails with
        // `Empty` through `page_edges` while this override would answer
        // `[]` off an empty `edge_pairs` (review wave 4, GC-P3b). Not
        // reachable through `generational_collect` — it reads the
        // manifest first — but the backends must be interchangeable at
        // the trait surface, not merely along the one path that happens
        // to check first.
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        self.conn
            .execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS gen_targets (p INTEGER PRIMARY KEY);
                 DELETE FROM gen_targets;",
            )
            .map_err(sql_err)?;
        {
            let mut ins = self
                .conn
                .prepare("INSERT OR IGNORE INTO gen_targets (p) VALUES (?1)")
                .map_err(sql_err)?;
            for &t in targets {
                ins.execute(params![t as i64]).map_err(sql_err)?;
            }
        }
        let mut stmt = self
            .conn
            .prepare(
                "SELECT DISTINCT e.target FROM edge_pairs e
                 WHERE e.target IN (SELECT p FROM gen_targets)
                   AND e.page NOT IN (SELECT p FROM gen_targets)",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(page_col(r.map_err(sql_err)?)?);
        }
        self.conn
            .execute("DELETE FROM gen_targets", [])
            .map_err(sql_err)?;
        out.sort_unstable();
        Ok(out)
    }

    /// Region-bounded reachability for the generational pass: the
    /// recursive walk never leaves the candidate set, so its transfer
    /// is bounded by the mutated region, not the heap.
    fn reachable_within(
        &self,
        roots: &[u32],
        within: &[u32],
    ) -> Result<std::collections::BTreeSet<u32>, StoreError> {
        // Empty-store parity with the dense default (review wave 4,
        // GC-P3b) — see `externally_referenced` above.
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        self.conn
            .execute_batch(
                "CREATE TEMP TABLE IF NOT EXISTS gen_within (p INTEGER PRIMARY KEY);
                 CREATE TEMP TABLE IF NOT EXISTS gen_roots (p INTEGER PRIMARY KEY);
                 DELETE FROM gen_within; DELETE FROM gen_roots;",
            )
            .map_err(sql_err)?;
        {
            let mut ins = self
                .conn
                .prepare("INSERT OR IGNORE INTO gen_within (p) VALUES (?1)")
                .map_err(sql_err)?;
            for &w in within {
                ins.execute(params![w as i64]).map_err(sql_err)?;
            }
            let mut ins = self
                .conn
                .prepare(
                    "INSERT OR IGNORE INTO gen_roots (p)
                     SELECT ?1 WHERE ?1 IN (SELECT p FROM gen_within)",
                )
                .map_err(sql_err)?;
            for &r in roots {
                ins.execute(params![r as i64]).map_err(sql_err)?;
            }
        }
        let mut stmt = self
            .conn
            .prepare(
                "WITH RECURSIVE reach(p) AS (
                   SELECT p FROM gen_roots
                   UNION
                   SELECT e.target FROM edge_pairs e JOIN reach ON e.page = reach.p
                   WHERE e.target IN (SELECT p FROM gen_within)
                 )
                 SELECT p FROM reach",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, i64>(0))
            .map_err(sql_err)?;
        let mut out = std::collections::BTreeSet::new();
        for r in rows {
            out.insert(page_col(r.map_err(sql_err)?)?);
        }
        self.conn
            .execute_batch("DELETE FROM gen_within; DELETE FROM gen_roots;")
            .map_err(sql_err)?;
        Ok(out)
    }

    /// `edge_pairs` is derived from `page_edges`: one row per distinct
    /// (target, page) edge, no more. Open trusts it while its marker names
    /// the committed epoch, so the full validator is where an index that
    /// commit-time maintenance got wrong, or an offline edit left stale,
    /// shows up.
    fn check_derived_indexes(&self) -> Result<(), StoreError> {
        const DISAGREES: StoreError = StoreError::Snapshot(SnapshotError::Corrupt(
            "sqlite: edge_pairs disagrees with page_edges",
        ));
        let mut expected: Vec<(i64, i64)> = self
            .page_edges()?
            .iter()
            .enumerate()
            .flat_map(|(page, targets)| targets.iter().map(move |&t| (i64::from(t), page as i64)))
            .collect();
        expected.sort_unstable();
        expected.dedup();
        // Both sides are sorted, so compare as the rows stream in and stop
        // at the first difference; a value no summary could hold (out of
        // range, or not an integer at all) is a difference like any other.
        let mut stmt = self
            .conn
            .prepare("SELECT target, page FROM edge_pairs ORDER BY target, page")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, rusqlite::types::Value>(0)?,
                    r.get::<_, rusqlite::types::Value>(1)?,
                ))
            })
            .map_err(sql_err)?;
        let mut expected = expected.into_iter();
        for row in rows {
            let pair = match row.map_err(sql_err)? {
                (rusqlite::types::Value::Integer(t), rusqlite::types::Value::Integer(p)) => {
                    Some((t, p))
                }
                _ => None,
            };
            if pair.is_none() || pair != expected.next() {
                return Err(DISAGREES);
            }
        }
        if expected.next().is_some() {
            return Err(DISAGREES);
        }
        Ok(())
    }

    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        let manifest = Self::stored_manifest(&self.conn)?.ok_or(StoreError::Empty)?;
        if manifest.store_schema >= 28 {
            return read_sectioned_state(&self.conn);
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

    fn small_section_hashes(&self) -> Result<[[u8; 32]; SMALL_SECTION_COUNT], StoreError> {
        if Self::stored_manifest(&self.conn)?.is_none() {
            return Err(StoreError::Empty);
        }
        read_section_hashes(&self.conn)
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
        // so the metadata-scale validator reads no row contents.
        let _ = self.manifest()?;
        // Built from the rows actually present (ORDER BY page), never
        // pre-sized from the manifest's geometry — a garbled slot_count
        // must fail validation, not force an allocation (the
        // malformed-count discipline). Contiguity is enforced here; the
        // count-vs-geometry comparison is validate_store's.
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

    fn commit_verified(
        &mut self,
        verify: &mut ironhorse_snapshot::store::CommitVerifier<'_>,
    ) -> Result<(), StoreError> {
        // IMMEDIATE: take the writer lock up front so a concurrent
        // commit serializes under busy_timeout instead of surfacing
        // SQLITE_BUSY_SNAPSHOT on the mid-transaction read-to-write
        // upgrade (the collaborator review's finding). rusqlite rolls
        // the transaction back on any early return.
        let tx = self
            .conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        {
            // The common verifier runs inside this writer transaction.
            let stored = Self::stored_manifest(&tx)?;
            let batch = verify(stored.as_ref())?.batch();
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
            tx.execute(
                "DELETE FROM slot_pages WHERE page >= ?1",
                params![pages as i64],
            )
            .map_err(sql_err)?;
            tx.execute(
                "DELETE FROM chunk_exts WHERE ext >= ?1",
                params![exts as i64],
            )
            .map_err(sql_err)?;

            {
                let n_frees = free_seg_count(batch.manifest.free_len);
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
                tx.execute(
                    "DELETE FROM free_segs WHERE seg >= ?1",
                    params![n_frees as i64],
                )
                .map_err(sql_err)?;
            }

            // Page-edge summaries (phase 6): upsert the dirty pages'
            // summaries, drop those beyond the new geometry. Grown
            // pages are necessarily dirty, so every page in range has
            // a row by induction. The normalized `edge_pairs` twin
            // (phase 10) is maintained in the SAME transaction from
            // the same batch rows, so the derived index can never
            // drift from its source across a commit.
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
                    clear_pairs
                        .execute(params![*page as i64])
                        .map_err(sql_err)?;
                    for t in targets {
                        insert_pair
                            .execute(params![*t as i64, *page as i64])
                            .map_err(sql_err)?;
                    }
                }
                drop(upsert);
                drop(clear_pairs);
                drop(insert_pair);
                tx.execute(
                    "DELETE FROM page_edges WHERE page >= ?1",
                    params![pages as i64],
                )
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
                // The pairs now mirror this batch's summaries: record
                // that for the epoch this transaction commits, so the
                // next open trusts the index instead of rebuilding it.
                write_edge_pairs_epoch(&tx, batch.manifest.epoch)?;
            }

            if stored.is_none() {
                // Initial sparse writes require all sections, so framing here is
                // bounded by the initial full snapshot, never a warmed checkpoint.
                let small = ironhorse_snapshot::store_sections::merge_framed(None, batch)?;
                write_small_state(&tx, batch.manifest.store_schema, &small)?;
            } else {
                let updates = ironhorse_snapshot::store_sections::batch_updates(batch)?;
                write_section_updates(&tx, &updates)?;
            }
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
    use ironhorse_snapshot::store::HeapStoreCommit;
    use ironhorse_snapshot::store::{
        export_to_container, image_to_batch, image_to_batch_unchecked, import_from_container,
        store_to_image, validate_store, CommitToken, STORE_SCHEMA_VERSION,
    };
    use ironhorse_snapshot::{Signature, SnapshotError};
    use ironhorse_vm::Interp;
    use std::path::PathBuf;

    fn sig() -> Signature {
        Signature::new("ironhorse-worker-v1")
    }

    #[test]
    fn sparse_checkpoints_write_only_changes_and_retry_from_persisted_sections() {
        use ironhorse_snapshot::store_sections::SmallSection;
        let mut machine = Interp::new();
        let (code, names) =
            ironhorse_compile::compile_atoms("var a = []; for(var i=0;i<10000;i++) a[i]=i; 0")
                .unwrap();
        machine.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
        assert!(machine.run(&code).completed);
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        let mut session = begin_store_session(machine, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .unwrap();
        store
            .conn
            .execute_batch(
                "CREATE TEMP TABLE section_writes (id INTEGER, size INTEGER);
             CREATE TEMP TRIGGER count_sections AFTER UPDATE ON main.small_sections
             BEGIN INSERT INTO section_writes VALUES (NEW.id, length(NEW.bytes)); END;",
            )
            .unwrap();
        let (hot, _) = ironhorse_compile::compile_atoms("1 + 1").unwrap();
        for cold in [false, true] {
            store
                .conn
                .execute("DELETE FROM section_writes", [])
                .unwrap();
            if cold {
                // A resumed session reads the stored section digests.
                session = resume_from_store(&store, &sig()).unwrap();
            }
            assert!(session.machine_mut().run(&hot).completed);
            checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
            let writes: Vec<i64> = store
                .conn
                .prepare("SELECT id FROM section_writes ORDER BY id")
                .unwrap()
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            assert_eq!(writes, vec![SmallSection::Meter.id() as i64]);
            assert_eq!(
                store_to_image(&store).unwrap(),
                session
                    .machine()
                    .snapshot_image(&sig())
                    .unwrap()
                    .into_image()
            );
        }
        let before = store.manifest().unwrap();
        let before_small = store.read_small_state().unwrap();
        let (change, names) = ironhorse_compile::compile_atoms("var a; a[0] = 42").unwrap();
        let change = session
            .machine_mut()
            .relink_crank(&change, &ironhorse_vm::parse_symbols(&names))
            .unwrap();
        assert!(session.machine_mut().run(&change).completed);
        store
            .conn
            .execute_batch(
                "CREATE TEMP TRIGGER abort_array_section BEFORE UPDATE ON small_sections
             WHEN NEW.id = 6 BEGIN SELECT RAISE(ABORT, 'array write failure'); END;",
            )
            .unwrap();
        assert!(
            matches!(checkpoint_to_store(&mut session, &sig(), &mut store), Err(StoreError::Io(msg))
            if msg.contains("array write failure"))
        );
        assert_eq!(store.manifest().unwrap(), before);
        assert_eq!(store.read_small_state().unwrap(), before_small);
        store
            .conn
            .execute_batch("DROP TRIGGER abort_array_section")
            .unwrap();
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
        assert_eq!(
            store_to_image(&store).unwrap(),
            session
                .machine()
                .snapshot_image(&sig())
                .unwrap()
                .into_image()
        );
    }

    #[test]
    fn section_migration_preserves_bytes_and_rolls_back_partial_inserts() {
        use ironhorse_snapshot::store::{migrate_store, StoreManifest};
        let mut machine = Interp::new();
        let (code, names) = ironhorse_compile::compile_atoms(
            "var a = [1, 'kept', 3]; var m = new Map([[1, 'value']]); 0",
        )
        .unwrap();
        machine.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
        assert!(machine.run(&code).completed);
        let image = machine.snapshot_image(&sig()).unwrap();
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        store
            .commit(&image_to_batch(&image, 1, CommitToken::ZERO))
            .unwrap();
        let small = store.read_small_state().unwrap();
        let current = store.manifest().unwrap();
        // A schema-27 store keeps its small state whole.
        let old = StoreManifest {
            store_schema: 27,
            ..current.clone()
        };
        store.replace_for_migration(&current, &old, &small).unwrap();
        store
            .conn
            .execute("DELETE FROM small_sections", [])
            .unwrap();
        // And the row-leaf hashes every schema before 36 kept, which only a
        // completed migration drops.
        store
            .conn
            .execute_batch(
                "CREATE TABLE leaf_hashes (
                   kind INTEGER NOT NULL, idx INTEGER NOT NULL, hash BLOB NOT NULL,
                   PRIMARY KEY (kind, idx)
                 );
                 INSERT INTO leaf_hashes VALUES (0, 0, zeroblob(32));",
            )
            .unwrap();
        let leaf_rows = |store: &SqliteHeapStore| -> Option<i64> {
            store
                .conn
                .query_row("SELECT count(*) FROM leaf_hashes", [], |r| r.get(0))
                .ok()
        };
        assert_eq!(leaf_rows(&store), Some(1));
        let next = image_to_batch(&image, old.epoch + 1, old.token);
        assert!(matches!(
            store.commit(&next),
            Err(StoreError::NeedsMigration { found: 27 })
        ));
        assert_eq!(store.manifest().unwrap(), old);
        store
            .conn
            .execute_batch(
                "CREATE TEMP TRIGGER abort_section_migration BEFORE INSERT ON small_sections
             WHEN NEW.id = 16 BEGIN SELECT RAISE(ABORT, 'migration insert failure'); END;",
            )
            .unwrap();
        assert!(
            matches!(migrate_store(&mut store, &sig()), Err(StoreError::Io(message))
            if message.contains("migration insert failure"))
        );
        assert_eq!(store.manifest().unwrap(), old);
        assert_eq!(store.read_small_state().unwrap(), small);
        assert_eq!(leaf_rows(&store), Some(1));
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM small_sections", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        store
            .conn
            .execute_batch("DROP TRIGGER abort_section_migration")
            .unwrap();
        // A real v27 database has no section table at all. DDL must roll back
        // with the payload rows if the final manifest write fails.
        store
            .conn
            .execute_batch(
                "DROP TABLE small_sections;
             CREATE TEMP TRIGGER abort_migration_manifest BEFORE UPDATE ON meta
             WHEN NEW.key = 'manifest'
             BEGIN SELECT RAISE(ABORT, 'migration manifest failure'); END;",
            )
            .unwrap();
        assert!(
            matches!(migrate_store(&mut store, &sig()), Err(StoreError::Io(message))
            if message.contains("migration manifest failure"))
        );
        assert_eq!(store.manifest().unwrap(), old);
        assert_eq!(store.read_small_state().unwrap(), small);
        assert_eq!(leaf_rows(&store), Some(1));
        assert_eq!(
            store
                .conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name = 'small_sections'",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap(),
            0
        );
        store
            .conn
            .execute_batch("DROP TRIGGER abort_migration_manifest")
            .unwrap();
        assert!(migrate_store(&mut store, &sig()).unwrap());
        assert_eq!(
            leaf_rows(&store),
            None,
            "the migration drops the leaf table"
        );
        assert_eq!(store.read_small_state().unwrap(), small);
        assert_eq!(&store_to_image(&store).unwrap(), image.image());
        // The epoch, the counters and the token carry over.
        assert_eq!(store.manifest().unwrap(), current);
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM small_sections", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            32
        );
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM small_state", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(!migrate_store(&mut store, &sig()).unwrap());
    }

    /// The migration write compares, inside its transaction, the durable
    /// manifest with the one the migration read, and writes nothing (the
    /// old row-leaf hashes included) when another writer moved the store.
    #[test]
    fn the_migration_write_refuses_a_moved_store() {
        use ironhorse_snapshot::store::StoreManifest;
        let mut machine = Interp::new();
        assert!(machine.run(&PROG_A).completed);
        let image = machine.snapshot_image(&sig()).unwrap();
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        store
            .commit(&image_to_batch(&image, 1, CommitToken::ZERO))
            .unwrap();
        store
            .conn
            .execute_batch(
                "CREATE TABLE leaf_hashes (
                   kind INTEGER NOT NULL, idx INTEGER NOT NULL, hash BLOB NOT NULL,
                   PRIMARY KEY (kind, idx)
                 );
                 INSERT INTO leaf_hashes VALUES (0, 0, zeroblob(32));",
            )
            .unwrap();
        let current = store.manifest().unwrap();
        let small = store.read_small_state().unwrap();
        let moved = StoreManifest {
            epoch: current.epoch + 1,
            ..current.clone()
        };
        let older = StoreManifest {
            store_schema: STORE_SCHEMA_VERSION - 1,
            ..current.clone()
        };
        let label = |m: &StoreManifest| {
            format!(
                "schema {} epoch {} token {}",
                m.store_schema, m.epoch, m.token
            )
        };
        assert_eq!(
            store.replace_for_migration(&moved, &older, &small),
            Err(StoreError::BaselineMismatch {
                expected: label(&moved),
                found: label(&current),
            })
        );
        assert_eq!(store.manifest().unwrap(), current);
        assert_eq!(
            store
                .conn
                .query_row("SELECT count(*) FROM leaf_hashes", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }

    #[test]
    fn normal_commits_cannot_change_store_schema() {
        let mut machine = Interp::new();
        assert!(machine.run(&PROG_A).completed);
        let image = machine.snapshot_image(&sig()).unwrap();
        for schema in [STORE_SCHEMA_VERSION - 1, STORE_SCHEMA_VERSION + 1] {
            let mut store = SqliteHeapStore::open_in_memory().unwrap();
            let first = image_to_batch(&image, 1, CommitToken::ZERO);
            store.commit(&first).unwrap();
            let mut next = image_to_batch(&image, 2, first.manifest.token);
            next.manifest.store_schema = schema;
            assert!(matches!(
                store.commit(&next),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "checkpoint requires current store schema"
                )))
            ));
            assert_eq!(store.manifest().unwrap(), first.manifest);
            assert_eq!(&store_to_image(&store).unwrap(), image.image());
        }
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

    /// Scratch-dir guard (the tests/common twin): pre-cleans any
    /// prior run's leftover, creates the directory, and removes it
    /// on drop — success or panic. Declare it before any store so
    /// the store drops first.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            // Per-PROCESS and per-CALL unique: keying on the bare name
            // meant two concurrent `cargo test` runs of this crate
            // resolved to the SAME directory and the `remove_dir_all`
            // below deleted each other's fixtures mid-run (review wave 5).
            static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let unique = format!(
                "{name}-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(unique);
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }
    }

    impl std::ops::Deref for TempDir {
        type Target = std::path::Path;
        fn deref(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp_dir(name: &str) -> TempDir {
        TempDir::new(&format!("ironhorse-sqlite-store-{name}"))
    }

    #[test]
    fn refused_commit_leaves_the_store_untouched() {
        // wave-3 reorder lock: every commit verification (succession,
        // grown region, boundary rows, lengths, summaries) now
        // runs BEFORE the first table mutation, so a refused batch
        // leaves the store at its prior epoch by construction — the
        // transaction rollback is the backstop for I/O failures, not
        // the mechanism a refusal depends on.
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        store
            .commit(&image_to_batch_unchecked(&image1, 1, CommitToken::ZERO))
            .unwrap();
        let prev = store.manifest().unwrap();

        // The engine suite's crafted omit-the-tail batch: shrink
        // chunk_len within the tail extent and drop that extent.
        let mut image2 = image1.clone();
        assert!(image2.chunks.len() >= 8, "fixture carries chunk bytes");
        image2.chunks.truncate(image2.chunks.len() - 4);
        let tail_ext = chunk_extent_count(image2.chunks.len() as u64) - 1;
        let mut crafted = image_to_batch_unchecked(&image2, 2, prev.token);
        crafted.chunk_extents.retain(|(e, _)| *e != tail_ext);
        // Wrapped: the omission is in the CALLER's batch, so the store is
        // not implicated and a supervisor refuses the request rather than
        // tearing the session down (review finding F157).
        assert_eq!(
            store.commit(&crafted),
            Err(StoreError::BatchRejected(Box::new(StoreError::MissingRow(
                "chunk extent",
                tail_ext
            ))))
        );

        assert_eq!(
            store.manifest().unwrap(),
            prev,
            "prior manifest intact after the refusal"
        );
        validate_store(&store, &sig()).expect("the refused commit left a valid store");
        store
            .commit(&image_to_batch_unchecked(&image2, 2, prev.token))
            .expect("the well-formed twin still commits");
        assert_eq!(store.manifest().unwrap().epoch, 2);
    }

    /// Exercise rollback after mutation has actually started. The trigger
    /// fires on `small_sections`, after pages, extents, free rows, and both
    /// edge tables have been updated inside the transaction.
    #[test]
    fn sql_abort_after_row_mutation_rolls_back() {
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        store
            .commit(&image_to_batch_unchecked(&image1, 1, CommitToken::ZERO))
            .unwrap();
        let prior = store.manifest().unwrap();
        let prior_image = store_to_image(&store).unwrap();
        let prior_counts: Vec<i64> = [
            "slot_pages",
            "chunk_exts",
            "free_segs",
            "page_edges",
            "edge_pairs",
            "small_state",
            "small_sections",
            "meta",
        ]
        .iter()
        .map(|table| {
            store
                .conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        })
        .collect();

        assert!(m.run(&PROG_B).completed);
        let image2 = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let batch2 = image_to_batch_unchecked(&image2, 2, prior.token);

        store
            .conn
            .execute_batch(
                "CREATE TEMP TRIGGER abort_late_commit
                 BEFORE UPDATE ON small_sections
                 BEGIN SELECT RAISE(ABORT, 'late commit failure'); END;",
            )
            .unwrap();
        match store.commit(&batch2) {
            Err(StoreError::Io(msg)) => {
                assert!(
                    msg.contains("late commit failure"),
                    "named SQL failure: {msg}"
                )
            }
            other => panic!("late SQL abort must refuse the commit: {other:?}"),
        }

        assert_eq!(
            store.manifest().unwrap(),
            prior,
            "manifest stayed at the previous epoch"
        );
        assert_eq!(
            store_to_image(&store).unwrap(),
            prior_image,
            "all content rolled back"
        );
        for (table, count) in [
            "slot_pages",
            "chunk_exts",
            "free_segs",
            "page_edges",
            "edge_pairs",
            "small_state",
            "small_sections",
            "meta",
        ]
        .iter()
        .zip(prior_counts)
        {
            let after: i64 = store
                .conn
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(after, count, "{table} row set rolled back");
        }
        validate_store(&store, &sig()).expect("the previous epoch still validates");
        drop(resume_from_store(&store, &sig()).expect("the previous epoch still resumes"));
        // The edge marker was rewritten inside the aborted transaction
        // too; it must roll back with the pairs it would have covered.
        assert!(
            edge_pairs_current(&store.conn, prior.epoch).unwrap(),
            "the edge marker still names the previous epoch"
        );

        store
            .conn
            .execute_batch("DROP TRIGGER abort_late_commit")
            .unwrap();
        store.commit(&batch2).expect("the honest retry succeeds");
        assert_eq!(store.manifest().unwrap().epoch, 2);
        assert!(
            edge_pairs_current(&store.conn, 2).unwrap(),
            "the durable retry records its own epoch"
        );
    }

    /// The edge marker is compared as the exact 8-byte big-endian
    /// epoch: anything else a foreign hand could leave in the row — a
    /// SQL integer holding the right number, a truncated blob — reads as
    /// stale, so open rebuilds rather than trusting it.
    #[test]
    fn edge_marker_other_than_the_encoded_epoch_reads_as_stale() {
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        assert!(
            !edge_pairs_current(&store.conn, 1).unwrap(),
            "a fresh store records no marker"
        );
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        assert!(edge_pairs_current(&store.conn, 1).unwrap());
        assert!(!edge_pairs_current(&store.conn, 2).unwrap());
        for (what, value) in [
            ("integer", rusqlite::types::Value::Integer(1)),
            ("short blob", rusqlite::types::Value::Blob(vec![1])),
            (
                "little-endian blob",
                rusqlite::types::Value::Blob(1u64.to_le_bytes().to_vec()),
            ),
        ] {
            store
                .conn
                .execute(
                    "UPDATE meta SET value = ?1 WHERE key = ?2",
                    params![value, META_EDGE_PAIRS_EPOCH],
                )
                .unwrap();
            assert!(
                !edge_pairs_current(&store.conn, 1).unwrap(),
                "{what} marker reads as stale"
            );
        }
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
        let bytes = m
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots");

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
            session
                .machine()
                .snapshot_image_for_testing(&sig())
                .expect("gated image")
        );

        assert!(session.machine_mut().run(&PROG_B).completed);
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
        assert_eq!(
            store_to_image(&store).unwrap(),
            session
                .machine()
                .snapshot_image_for_testing(&sig())
                .expect("gated image")
        );
        assert_eq!(
            export_to_container(&store).unwrap(),
            session
                .machine()
                .write_snapshot(&sig())
                .expect("quiescent machine snapshots")
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
        let expected = session
            .machine()
            .snapshot_image_for_testing(&sig())
            .expect("gated image");
        store.close().unwrap();

        let mut store = SqliteHeapStore::open(&path).unwrap();
        assert_eq!(store.manifest().unwrap().epoch, 2);
        assert_eq!(store_to_image(&store).unwrap(), expected);

        // A replayed batch is refused after reopen.
        let stale = image_to_batch_unchecked(&expected, 2, CommitToken::ZERO);
        assert_eq!(
            store.commit(&stale).unwrap_err(),
            StoreError::EpochMismatch {
                expected: 3,
                found: 2
            }
        );
    }

    /// The geometry-drop contract: a shrink deletes stale rows in the
    /// same transaction (SELECT count agrees with the new geometry).
    #[test]
    fn commit_drops_rows_beyond_the_new_geometry() {
        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image = m.snapshot_image_for_testing(&sig()).expect("gated image");
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        assert!(
            !image.chunks.is_empty(),
            "fixture must carry chunk bytes for the shrink to mean anything"
        );

        // A real compaction rewrites every stored chunk offset with the
        // bytes it moves; mirror that coherence (the wave-6 W6-14 heap
        // gate refuses an image whose slots point into chunks it lacks)
        // by degrading chunk-bearing slots to chunk-free values in
        // place - chain links, ids, and accounting untouched.
        let mut shrunk = image.clone();
        shrunk.chunks = Vec::new();
        for slot in shrunk.slots.iter_mut().chain(shrunk.stack.iter_mut()) {
            if slot.chunk_ref().is_some() {
                slot.kind = ironhorse_vm::Kind::Integer;
                slot.value = ironhorse_vm::Payload::Integer(0);
            }
        }
        shrunk.function_state = ironhorse_vm::snapshot_api::FunctionStateSnapshot::default();
        let prev = store.manifest().unwrap().token;
        let mut batch = image_to_batch_unchecked(&shrunk, 2, prev);
        batch.chunk_extents.clear();
        store.commit(&batch).unwrap();

        let exts: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM chunk_exts", [], |r| r.get(0))
            .unwrap();
        assert_eq!(exts, 0, "stale extents deleted transactionally");
        assert_eq!(store_to_image(&store).unwrap().chunks, Vec::<u8>::new());
    }

    /// A page whose outgoing summary transitions non-empty → EMPTY
    /// across commits must have its stale pairs cleared: the
    /// commit-side maintenance deletes a traveling page's pairs
    /// BEFORE inserting the (possibly zero) new ones, and guarding
    /// that delete behind `!targets.is_empty()` would pass every
    /// other suite while leaving ghost edges that inflate the CTE's
    /// reachability forever (review-wave-2 coverage finding). The
    /// empty-transition batch is legitimate by construction:
    /// `image_to_batch_unchecked` re-derives the summaries from the mutated
    /// rows, so the batch stays self-consistent through the commit's
    /// summary coupling.
    #[test]
    fn commit_clears_pairs_when_a_page_loses_all_edges() {
        use ironhorse_snapshot::store::SLOTS_PER_PAGE;

        let mut store = SqliteHeapStore::open_in_memory().unwrap();
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image_for_testing(&sig()).expect("gated image");
        store
            .commit(&image_to_batch_unchecked(&image1, 1, CommitToken::ZERO))
            .unwrap();

        // Pick a page with outgoing edges (the boot region guarantees
        // cross-page references exist).
        let p: i64 = store
            .conn
            .query_row(
                "SELECT page FROM edge_pairs ORDER BY page LIMIT 1",
                [],
                |r| r.get(0),
            )
            .expect("fixture has at least one outgoing edge");
        let before: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM edge_pairs WHERE page = ?1",
                params![p],
                |r| r.get(0),
            )
            .unwrap();
        assert!(before > 0, "picked page starts with pairs");

        // Zero the page's records: no references, null next — its
        // derived summary becomes the empty list.
        let mut image2 = image1.clone();
        let start = p as usize * SLOTS_PER_PAGE as usize;
        let end = (start + SLOTS_PER_PAGE as usize).min(image2.slots.len());
        for s in &mut image2.slots[start..end] {
            *s = ironhorse_vm::Slot::undefined();
        }
        let prev = store.manifest().unwrap().token;
        store
            .commit(&image_to_batch_unchecked(&image2, 2, prev))
            .unwrap();

        let after: i64 = store
            .conn
            .query_row(
                "SELECT COUNT(*) FROM edge_pairs WHERE page = ?1",
                params![p],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after, 0, "empty transition clears the page's stale pairs");

        // And the whole index still mirrors the committed rows: every
        // decoded blob edge has its pair and nothing else remains.
        let blob_edges: i64 = store
            .conn
            .query_row(
                "SELECT COALESCE(SUM(length(targets) / 4), 0) FROM page_edges",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let pairs: i64 = store
            .conn
            .query_row("SELECT COUNT(*) FROM edge_pairs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            blob_edges, pairs,
            "pairs mirror the committed rows after the transition"
        );
    }

    /// A file that is not a SQLite database fails closed at open, as a
    /// corrupt store a retry cannot change.
    #[test]
    fn foreign_file_fails_closed() {
        let dir = tmp_dir("foreign");
        let path = dir.join("not-a-db.sqlite");
        std::fs::write(&path, b"IHSTORE1 this is the wrong kind of store").unwrap();
        let error = SqliteHeapStore::open(&path).unwrap_err();
        assert_eq!(
            error,
            StoreError::Snapshot(SnapshotError::Corrupt("sqlite: not a database"))
        );
        assert_eq!(
            error.classify(),
            ironhorse_snapshot::store::StoreFailure::Poisoned
        );
    }

    /// A SQLite database that is not a heap store (another application's
    /// id, or tables without our stamp) is refused at open as a foreign
    /// store, the file store's foreign-magic refusal in the same
    /// vocabulary, which a retry cannot change.
    #[test]
    fn foreign_sqlite_database_is_refused_as_foreign() {
        let dir = tmp_dir("foreign-sqlite");
        for (name, setup, refusal) in [
            (
                "stamped.sqlite",
                "PRAGMA application_id = 7; CREATE TABLE t (x);",
                "sqlite: foreign database (application_id)",
            ),
            (
                "unstamped.sqlite",
                "CREATE TABLE t (x);",
                "sqlite: foreign database (populated, unstamped)",
            ),
        ] {
            let path = dir.join(name);
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(setup).unwrap();
            conn.close().unwrap();
            let error = SqliteHeapStore::open(&path).unwrap_err();
            assert_eq!(error, StoreError::Snapshot(SnapshotError::Corrupt(refusal)));
            assert_ne!(
                error.classify(),
                ironhorse_snapshot::store::StoreFailure::Transient,
                "a foreign database is not worth retrying"
            );
        }
    }

    /// Review wave 4, F1: an unsupported-schema store fails closed at
    /// open BEFORE `rebuild_edge_pairs` (a committed DELETE+INSERT) runs,
    /// so the store's rows are untouched by an open that refuses it. The
    /// canary `edge_pairs` row — not derivable from any `page_edges`
    /// summary, so a rebuild would delete it and never restore it —
    /// survives the refused open, proving the derived-table rebuild did
    /// not run. The edge marker is deleted too, so the index is stale
    /// and only the gate's position keeps the rebuild from running: an
    /// index its marker covers would survive any open, refused or not.
    #[test]
    fn unsupported_schema_refused_before_rebuild_touches_rows() {
        let dir = tmp_dir("unsupported-schema");
        let path = dir.join("worker-heap.sqlite");

        // A valid current-schema store to edit.
        let mut store = SqliteHeapStore::open(&path).unwrap();
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let mut session = begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .unwrap();
        assert!(session.machine_mut().run(&PROG_B).completed);
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
        drop(session);

        // Plant the canary and restamp the manifest to an unsupported
        // (too-new) schema, all under this store's connection.
        const CANARY_TARGET: i64 = 7_654_321;
        const CANARY_PAGE: i64 = 1_234_567;
        store
            .conn
            .execute(
                "INSERT INTO edge_pairs (target, page) VALUES (?1, ?2)",
                params![CANARY_TARGET, CANARY_PAGE],
            )
            .unwrap();
        let blob: Vec<u8> = store
            .conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![META_MANIFEST],
                |r| r.get(0),
            )
            .unwrap();
        let mut manifest = StoreManifest::decode(&blob).unwrap();
        manifest.store_schema = STORE_SCHEMA_VERSION + 1;
        store
            .conn
            .execute(
                "UPDATE meta SET value = ?1 WHERE key = ?2",
                params![manifest.encode(), META_MANIFEST],
            )
            .unwrap();
        assert_eq!(
            store
                .conn
                .execute(
                    "DELETE FROM meta WHERE key = ?1",
                    params![META_EDGE_PAIRS_EPOCH],
                )
                .unwrap(),
            1,
            "the committed store carried an edge marker to delete"
        );
        store.close().unwrap();

        // Reopen: the schema gate refuses before the rebuild.
        match SqliteHeapStore::open(&path) {
            Err(StoreError::Snapshot(SnapshotError::Corrupt(msg))) => {
                assert!(msg.contains("schema"), "named failure: {msg}");
            }
            other => panic!("expected unsupported-schema refusal, got {other:?}"),
        }

        // The canary survives: `rebuild_edge_pairs` never ran.
        let conn = Connection::open(&path).unwrap();
        let hits: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM edge_pairs WHERE target = ?1 AND page = ?2",
                params![CANARY_TARGET, CANARY_PAGE],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "refused open left the derived table untouched");
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
        let image1 = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let first = image_to_batch_unchecked(&image1, 1, CommitToken::ZERO);
        sqlite.commit(&first).unwrap();
        memory.commit(&first).unwrap();

        assert!(m.run(&PROG_B).completed);
        let image2 = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let second = image_to_batch_unchecked(&image2, 2, first.manifest.token);
        sqlite.commit(&second).unwrap();
        memory.commit(&second).unwrap();

        assert_eq!(
            export_to_container(&sqlite).unwrap(),
            export_to_container(&memory).unwrap(),
            "backends are interchangeable byte-for-byte"
        );
    }
}
