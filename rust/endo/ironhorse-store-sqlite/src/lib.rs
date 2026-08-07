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
//! contract, not re-invented here: epoch discipline via
//! [`ironhorse_snapshot::store::check_epoch`], rows beyond the new
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
    check_succession, chunk_extent_count, slot_page_count, CheckpointBatch, HeapStore,
    StoreError, StoreManifest,
};
use rusqlite::{params, Connection, OptionalExtension};

/// Map a rusqlite failure into the store vocabulary. SQLite errors
/// after a successful open are I/O-class faults (a crashed crank at
/// the machine surface), never silently absorbed.
fn sql_err(e: rusqlite::Error) -> StoreError {
    StoreError::Io(format!("sqlite: {e}"))
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
        Self::init(conn)
    }

    /// An in-memory store for tests and ephemeral use. Same schema and
    /// semantics; nothing durable.
    pub fn open_in_memory() -> Result<SqliteHeapStore, StoreError> {
        let conn = Connection::open_in_memory().map_err(sql_err)?;
        Self::init(conn)
    }

    /// The `PRAGMA application_id` stamp: `IRON` as a big-endian u32 —
    /// the SQLite analogue of the file store's magic. A SQLite database
    /// that is not a heap store fails closed at open instead of being
    /// silently adopted as "empty" and grafted with our schema (the
    /// review's foreign-database finding).
    const APPLICATION_ID: i32 = i32::from_be_bytes(*b"IRON");

    fn init(conn: Connection) -> Result<SqliteHeapStore, StoreError> {
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
        let mode: String = conn
            .query_row("PRAGMA journal_mode=WAL", [], |r| r.get(0))
            .map_err(sql_err)?;
        if mode != "wal" && mode != "memory" {
            return Err(StoreError::Io(format!(
                "sqlite: journal_mode=WAL refused (got {mode})"
            )));
        }
        conn.execute_batch("PRAGMA wal_autocheckpoint = 1000")
            .map_err(sql_err)?;
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
             -- One row set per side-table ledger row, populated as the
             -- Pending atoms land paired with their store rows (design
             -- § Side tables: the ledger governs the schema).
             CREATE TABLE IF NOT EXISTS side_tables (
               name  TEXT NOT NULL,
               key   BLOB NOT NULL,
               bytes BLOB NOT NULL,
               PRIMARY KEY (name, key)
             );",
        )
        .map_err(sql_err)?;
        Ok(SqliteHeapStore { conn })
    }

    /// The full last-connection close of the shutdown-checkpoint
    /// contract: checkpoints the WAL into the main file and removes the
    /// sidecars, leaving a self-contained single file safe to copy or
    /// hand off. Consume-on-close mirrors the daemon's "no database
    /// request after close" invariant.
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
}

impl HeapStore for SqliteHeapStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        Self::stored_manifest(&self.conn)?.ok_or(StoreError::Empty)
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

    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        {
            let stored = Self::stored_manifest(&tx)?;
            check_succession(stored.as_ref(), batch)?;

            // A grown geometry's new rows must be in the batch (the
            // reference-backend semantic): failing later at validate
            // would leave a committed-but-unresumable lineage.
            let pages = slot_page_count(batch.manifest.slot_count);
            let exts = chunk_extent_count(batch.manifest.chunk_len);
            let mut have_page = tx
                .prepare("SELECT 1 FROM slot_pages WHERE page = ?1")
                .map_err(sql_err)?;
            for page in 0..pages {
                if !batch.slot_pages.iter().any(|(p, _)| *p == page)
                    && !have_page.exists(params![page as i64]).map_err(sql_err)?
                {
                    return Err(StoreError::MissingRow("slot page", page));
                }
            }
            let mut have_ext = tx
                .prepare("SELECT 1 FROM chunk_exts WHERE ext = ?1")
                .map_err(sql_err)?;
            for ext in 0..exts {
                if !batch.chunk_extents.iter().any(|(e, _)| *e == ext)
                    && !have_ext.exists(params![ext as i64]).map_err(sql_err)?
                {
                    return Err(StoreError::MissingRow("chunk extent", ext));
                }
            }

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
