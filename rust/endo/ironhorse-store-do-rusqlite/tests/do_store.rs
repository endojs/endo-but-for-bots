//! What is particular to the Durable Object store: chunked sections, the
//! stamp, the store ids, the value cap, migration, the failure record, and
//! the host contract the store's atomicity rests on (one host transaction
//! around each committing call), shown here with SQLite's own transactions.

use std::cell::Cell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, StoreSession,
};
use ironhorse_snapshot::store::{
    export_to_container, migrate_store, validate_store_content, HeapStore, StoreError,
    StoreFailure, StoreManifest, STORE_SCHEMA_VERSION,
};
use ironhorse_snapshot::store_sections::{
    small_state_at_schema, split_small_state, SMALL_SECTION_COUNT,
};
use ironhorse_snapshot::{MachineSnapshot, SnapshotError};
use ironhorse_store_do::{DoStore, SqlExecutor, Value, MAX_VALUE_BYTES, SECTION_CHUNK_BYTES};
use ironhorse_store_do_rusqlite::RusqliteExecutor;
use rusqlite::params;

mod common;
use common::{compile, machine, sig, TempDir};

const LOST: StoreError = StoreError::Snapshot(SnapshotError::Corrupt(
    "do sql: a small section lost a chunk",
));

/// Twenty thousand closures: a Functions section of about 1.1 MB, more than
/// one chunk at the default size.
const MANY_FUNCTIONS: &str =
    "var fs = []; for (var i = 0; i < 20000; i++) fs.push(function () { return i; }); 0";

fn begin(store: &mut dyn HeapStore, source: &str) -> StoreSession {
    begin_store_session(machine(source), &sig(), store)
        .map_err(|(_, error)| error)
        .expect("begin")
}

/// Run `source` as one crank of `session` and answer its result.
fn crank(session: &mut StoreSession, source: &str) -> String {
    let (code, names) = compile(source);
    let code = session
        .machine_mut()
        .relink_crank(&code, &names)
        .expect("relinks");
    let outcome = session.machine_mut().run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome.result
}

/// `(section id, chunk count, total bytes)` for every section of `store`.
fn chunk_counts(conn: &rusqlite::Connection, store: u32) -> Vec<(u32, u32, usize)> {
    let mut statement = conn
        .prepare(
            "SELECT id, COUNT(*), SUM(length(bytes)) FROM ih_sections WHERE store = ?1 \
             GROUP BY id ORDER BY id",
        )
        .unwrap();
    let rows = statement
        .query_map(params![store], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get::<_, i64>(2)? as usize))
        })
        .unwrap();
    rows.map(Result::unwrap).collect()
}

fn delete_chunk(conn: &rusqlite::Connection, store: u32, id: u32, chunk: u32) {
    let deleted = conn
        .execute(
            "DELETE FROM ih_sections WHERE store = ?1 AND id = ?2 AND chunk = ?3",
            params![store, id, chunk],
        )
        .unwrap();
    assert_eq!(deleted, 1);
}

/// Whether `store` holds exactly the state of `session`'s machine.
fn holds(store: &dyn HeapStore, session: &StoreSession) -> bool {
    validate_store_content(store, &sig()).is_ok()
        && export_to_container(store).unwrap() == session.machine().write_snapshot(&sig()).unwrap()
}

#[test]
fn a_section_larger_than_one_chunk_round_trips_at_the_default_size() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let mut store = DoStore::open(executor.clone(), 1).unwrap();
    let mut session = begin(&mut store, MANY_FUNCTIONS);
    let counts = chunk_counts(executor.connection(), 1);
    let (id, chunks, bytes) = *counts.iter().max_by_key(|(_, _, bytes)| *bytes).unwrap();
    assert!(bytes > SECTION_CHUNK_BYTES, "section {id} spans chunks");
    assert_eq!(chunks as usize, bytes / SECTION_CHUNK_BYTES + 1);
    assert!(holds(&store, &session));
    // A crank that touches the large section rewrites it whole; it still
    // round-trips, and a resumed machine sees every closure.
    crank(
        &mut session,
        "var fs; fs.push(function () { return -1; }); 0",
    );
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    assert!(holds(&store, &session));
    let mut resumed = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(
        crank(&mut resumed, "var fs; fs.length + ':' + fs[20000]()"),
        "20001:-1"
    );
}

#[test]
fn many_chunks_round_trip_with_the_final_chunk_shorter_than_the_rest() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    // First learn a section's length, then open a second store whose chunk
    // size divides it exactly, so that section ends in an empty chunk.
    let mut probe = DoStore::open(executor.clone(), 1).unwrap();
    drop(begin(&mut probe, "var a = { n: 1 }; 0"));
    let sections = probe.read_small_state().unwrap();
    let lengths: Vec<usize> = split_small_state(&sections)
        .unwrap()
        .iter()
        .map(|s| s.len())
        .collect();
    let exact = *lengths.iter().max().unwrap();
    for chunk_bytes in [1, 7, exact / 2, exact] {
        let id = 10 + chunk_bytes as u32;
        let mut store = DoStore::open(executor.clone(), id)
            .unwrap()
            .with_section_chunk_bytes(chunk_bytes)
            .unwrap();
        let session = begin(&mut store, "var a = { n: 1 }; 0");
        for (section, chunks, bytes) in chunk_counts(executor.connection(), id) {
            assert_eq!(bytes, lengths[section as usize]);
            assert_eq!(
                chunks as usize,
                bytes / chunk_bytes + 1,
                "section {section}"
            );
        }
        assert!(holds(&store, &session), "chunks of {chunk_bytes}");
        // The same rows read with another chunk size fail closed.
        if chunk_bytes != exact {
            let other = DoStore::open(executor.clone(), id)
                .unwrap()
                .with_section_chunk_bytes(exact)
                .unwrap();
            assert!(other.read_small_state().is_err());
        }
        // In one-byte chunks the last section spans several, and losing its
        // final chunk leaves no later section to notice: the end of the rows
        // has to.
        if chunk_bytes == 1 {
            let last = (SMALL_SECTION_COUNT - 1) as u32;
            let (_, chunks, _) = chunk_counts(executor.connection(), id)[last as usize];
            assert!(chunks > 2);
            delete_chunk(executor.connection(), id, last, chunks - 1);
            assert_eq!(store.read_small_state(), Err(LOST));
        }
    }
    // With chunks of the largest section's length, that section is one full
    // chunk and an empty one; losing the empty one is a lost chunk too.
    let id = 10 + exact as u32;
    let section = lengths.iter().position(|&len| len == exact).unwrap() as u32;
    let store = DoStore::open(executor.clone(), id)
        .unwrap()
        .with_section_chunk_bytes(exact)
        .unwrap();
    delete_chunk(executor.connection(), id, section, 1);
    assert_eq!(store.read_small_state(), Err(LOST));
}

#[test]
fn a_lost_chunk_is_reported_as_corruption() {
    const CHUNK: usize = 16;
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let open = |id| {
        DoStore::open(executor.clone(), id)
            .unwrap()
            .with_section_chunk_bytes(CHUNK)
            .unwrap()
    };
    let conn = executor.connection();
    // A middle chunk, the last chunk, and a whole section, each in a store
    // of its own.
    for (id, lose) in [(1, "middle"), (2, "last"), (3, "first"), (4, "section")] {
        let mut store = open(id);
        drop(begin(
            &mut store,
            "var a = { n: 1, s: 'a string of some length' }; 0",
        ));
        let (section, chunks, _) = *chunk_counts(conn, id)
            .iter()
            .find(|(_, chunks, _)| *chunks >= 3)
            .expect("a section of three chunks or more");
        let missing = match lose {
            "middle" => {
                delete_chunk(conn, id, section, 1);
                false
            }
            "last" => {
                delete_chunk(conn, id, section, chunks - 1);
                false
            }
            "first" => {
                delete_chunk(conn, id, section, 0);
                false
            }
            _ => {
                conn.execute(
                    "DELETE FROM ih_sections WHERE store = ?1 AND id = ?2",
                    params![id, section],
                )
                .unwrap();
                true
            }
        };
        let expected = || {
            if missing {
                StoreError::MissingRow("small section", section)
            } else {
                LOST
            }
        };
        assert_eq!(store.read_small_state(), Err(expected()), "{lose}");
        assert_eq!(expected().classify(), StoreFailure::Poisoned);
        assert_eq!(
            resume_from_store(&store, &sig()).err(),
            Some(expected()),
            "{lose}"
        );
    }
}

#[test]
fn a_foreign_stamp_is_refused() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    DoStore::open(executor.clone(), 1).unwrap();
    const FOREIGN: StoreError =
        StoreError::Snapshot(SnapshotError::Corrupt("do sql: foreign database (stamp)"));
    for stamp in [
        rusqlite::types::Value::Blob(b"NOPE".to_vec()),
        rusqlite::types::Value::Text("IRON".into()),
        rusqlite::types::Value::Integer(0x4952_4f4e),
    ] {
        executor
            .connection()
            .execute(
                "UPDATE ih_meta SET value = ?1 WHERE store = 0 AND key = 'stamp'",
                params![stamp],
            )
            .unwrap();
        assert_eq!(DoStore::open(executor.clone(), 1).err(), Some(FOREIGN));
    }
    assert_eq!(FOREIGN.classify(), StoreFailure::Poisoned);
    // A database stamped by the store opens again, for every id.
    executor
        .connection()
        .execute(
            "UPDATE ih_meta SET value = X'49524F4E' WHERE store = 0 AND key = 'stamp'",
            [],
        )
        .unwrap();
    DoStore::open(executor.clone(), 1).unwrap();
    DoStore::open(executor, u32::MAX).unwrap();
}

#[test]
fn store_id_zero_is_refused() {
    let error = DoStore::open(RusqliteExecutor::open_in_memory().unwrap(), 0).unwrap_err();
    assert_eq!(
        error,
        StoreError::Unsupported("do sql: store id 0 holds the database's stamp")
    );
    assert_eq!(error.classify(), StoreFailure::Refused);
}

/// How many rows store `id` holds, over all six tables.
fn rows_of(conn: &rusqlite::Connection, id: u32) -> i64 {
    conn.query_row(
        "SELECT (SELECT COUNT(*) FROM ih_meta WHERE store = ?1) \
         + (SELECT COUNT(*) FROM ih_slot_pages WHERE store = ?1) \
         + (SELECT COUNT(*) FROM ih_chunk_exts WHERE store = ?1) \
         + (SELECT COUNT(*) FROM ih_free_segs WHERE store = ?1) \
         + (SELECT COUNT(*) FROM ih_page_edges WHERE store = ?1) \
         + (SELECT COUNT(*) FROM ih_sections WHERE store = ?1)",
        params![id],
        |row| row.get(0),
    )
    .unwrap()
}

/// With the cap lowered to a slot page's size, a first checkpoint's chunk
/// extents are over it: refused as `Unsupported`, with nothing written,
/// although the slot pages planned before them fit.
#[test]
fn an_over_cap_value_is_refused_as_unsupported_before_any_write() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let mut store = DoStore::open(executor.clone(), 1)
        .unwrap()
        .with_value_cap(ironhorse_snapshot::SLOTS_PER_PAGE as usize * 20)
        .unwrap();
    let error = begin_store_session(machine("var n = 7; n"), &sig(), &mut store)
        .err()
        .map(|(_, e)| e)
        .expect("refused");
    assert_eq!(
        error,
        StoreError::Unsupported("do sql: a value exceeds the 2,000,000-byte cap")
    );
    assert_eq!(error.classify(), StoreFailure::Refused);
    assert_eq!(rows_of(executor.connection(), 1), 0, "nothing was written");
    assert_eq!(store.manifest(), Err(StoreError::Empty));
    // The knobs stay inside the real cap.
    for bytes in [0, MAX_VALUE_BYTES + 1] {
        let store = DoStore::open(executor.clone(), 2).unwrap();
        assert!(matches!(
            store.with_section_chunk_bytes(bytes),
            Err(StoreError::Unsupported(_))
        ));
        let store = DoStore::open(executor.clone(), 2).unwrap();
        assert!(matches!(
            store.with_value_cap(bytes),
            Err(StoreError::Unsupported(_))
        ));
    }
}

/// A reason over the cap is cut at a character boundary, not refused, so
/// a quarantine always has its record.
#[test]
fn a_failure_reason_over_the_cap_is_cut_to_fit() {
    const MARKER: &str = " [truncated]";
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let cut = MAX_VALUE_BYTES - MARKER.len();
    // A two-byte character straddling the cut.
    let reason = format!("{}é{}", "a".repeat(cut - 1), "b".repeat(MARKER.len()));
    assert_eq!(reason.len(), MAX_VALUE_BYTES + 1);
    assert!(!reason.is_char_boundary(cut));
    let mut store = DoStore::open(executor.clone(), 1).unwrap();
    assert!(store.record_failure(&reason).unwrap());
    let stored = store.failure().unwrap().unwrap();
    assert_eq!(stored, format!("{}{MARKER}", "a".repeat(cut - 1)));
    assert_eq!(stored.len(), MAX_VALUE_BYTES - 1);
    assert!(!store.record_failure("a later failure").unwrap());
    assert_eq!(store.failure().unwrap().unwrap(), stored);
    // A reason of exactly the cap is kept whole.
    let mut store = DoStore::open(executor, 2).unwrap();
    assert!(store.record_failure(&"x".repeat(MAX_VALUE_BYTES)).unwrap());
    assert_eq!(store.failure().unwrap(), Some("x".repeat(MAX_VALUE_BYTES)));
}

/// The tables of a database, by name.
fn tables(conn: &rusqlite::Connection) -> Vec<String> {
    let mut statement = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .unwrap();
    let names = statement.query_map([], |row| row.get(0)).unwrap();
    names.map(Result::unwrap).collect()
}

fn stamp(conn: &rusqlite::Connection) -> Option<Vec<u8>> {
    conn.query_row(
        "SELECT value FROM ih_meta WHERE store = 0 AND key = 'stamp'",
        [],
        |row| row.get(0),
    )
    .ok()
}

#[test]
fn an_empty_database_is_stamped() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    DoStore::open(executor.clone(), 1).unwrap();
    let conn = executor.connection();
    assert_eq!(stamp(conn).as_deref(), Some(&b"IRON"[..]));
    assert_eq!(tables(conn).len(), 6);
    // Tables present but empty, the stamp gone: still a fresh database.
    conn.execute("DELETE FROM ih_meta", []).unwrap();
    conn.execute("DROP TABLE ih_sections", []).unwrap();
    DoStore::open(executor.clone(), 1).unwrap();
    assert_eq!(stamp(conn).as_deref(), Some(&b"IRON"[..]));
    assert_eq!(tables(conn).len(), 6);
}

/// A database that lost its stamp while a store holds rows is refused, and
/// nothing is written: neither the stamp nor a missing table comes back.
#[test]
fn a_populated_database_without_a_stamp_is_refused() {
    const UNSTAMPED: StoreError = StoreError::Snapshot(SnapshotError::Corrupt(
        "do sql: foreign database (populated, unstamped)",
    ));
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let mut store = DoStore::open(executor.clone(), 3).unwrap();
    drop(begin(&mut store, "var n = 7; n"));
    drop(store);
    let conn = executor.connection();
    conn.execute("DELETE FROM ih_meta WHERE store = 0", [])
        .unwrap();
    conn.execute("DROP TABLE ih_free_segs", []).unwrap();
    let before = tables(conn);
    for id in [1, 3] {
        assert_eq!(DoStore::open(executor.clone(), id).err(), Some(UNSTAMPED));
    }
    assert_eq!(UNSTAMPED.classify(), StoreFailure::Poisoned);
    assert_eq!(stamp(conn), None);
    assert_eq!(tables(conn), before, "no table was created");
    // Rows in a table other than ih_meta, with ih_meta gone, refuse too.
    conn.execute("DROP TABLE ih_meta", []).unwrap();
    assert_eq!(DoStore::open(executor.clone(), 1).err(), Some(UNSTAMPED));
    assert!(!tables(conn).contains(&"ih_meta".to_owned()));
}

/// The known limit `DoStore::open` documents: an `ih_meta` of another shape
/// fails the stamp lookup with the executor's own error (`Io` from
/// rusqlite), and nothing is written.
#[test]
fn a_foreign_shaped_meta_table_fails_with_the_executors_error() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let conn = executor.connection();
    conn.execute("CREATE TABLE ih_meta (a, b)", []).unwrap();
    let error = DoStore::open(executor.clone(), 1).unwrap_err();
    assert!(matches!(error, StoreError::Io(_)), "{error:?}");
    assert_eq!(tables(conn), vec!["ih_meta".to_owned()]);
}

/// As the native worker's `an_older_schema_heap_is_migrated_before_it_resumes`
/// builds one: a heap written by this build and restamped as schema 35, the
/// last schema before the commit token, whose small state is framed as that
/// schema framed it (32 sections).
#[test]
fn an_older_schema_store_migrates_and_resumes() {
    let dir = TempDir::new("ironhorse-do-migrate");
    let path = dir.join("object.sqlite");
    let open = || DoStore::open(RusqliteExecutor::open(&path).unwrap(), 7).unwrap();
    let mut store = open();
    drop(begin(&mut store, "var n = 7; n"));
    let current = store.manifest().unwrap();
    let older = StoreManifest {
        store_schema: 35,
        ..current.clone()
    };
    let small = small_state_at_schema(&store.read_small_state().unwrap(), 35).unwrap();
    assert!(store.record_failure("kept across the migration").unwrap());
    store
        .replace_for_migration(&current, &older, &small)
        .unwrap();
    assert_eq!(store.read_small_state().unwrap(), small);
    assert_eq!(
        store.small_section_hashes(),
        Err(StoreError::NeedsMigration { found: 35 })
    );
    drop(store);

    let mut store = open();
    // Resume refuses an unmigrated store, and a first checkpoint still
    // refuses to overwrite it.
    assert!(resume_from_store(&store, &sig()).is_err());
    assert_eq!(
        begin_store_session(machine("0"), &sig(), &mut store)
            .err()
            .map(|(_, e)| e),
        Some(StoreError::NotEmpty {
            epoch: current.epoch
        })
    );
    assert!(migrate_store(&mut store, &sig()).unwrap());
    assert_eq!(
        store.manifest().unwrap(),
        StoreManifest {
            store_schema: STORE_SCHEMA_VERSION,
            ..current.clone()
        }
    );
    assert!(
        !migrate_store(&mut store, &sig()).unwrap(),
        "already current"
    );
    validate_store_content(&store, &sig()).unwrap();
    assert_eq!(
        store.failure().unwrap().as_deref(),
        Some("kept across the migration")
    );
    drop(store);
    let store = open();
    let mut session = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(crank(&mut session, "var n; n + 1"), "8");
}

#[test]
fn replace_for_migration_writes_nothing_when_it_refuses() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let mut store = DoStore::open(executor, 1).unwrap();
    drop(begin(&mut store, "var n = 7; n"));
    let current = store.manifest().unwrap();
    let small = store.read_small_state().unwrap();
    let before = export_to_container(&store).unwrap();
    let stale = StoreManifest {
        epoch: current.epoch + 1,
        ..current.clone()
    };
    let older = StoreManifest {
        store_schema: 35,
        ..current.clone()
    };
    assert!(matches!(
        store.replace_for_migration(&stale, &older, &small),
        Err(StoreError::BaselineMismatch { .. })
    ));
    let whole = StoreManifest {
        store_schema: 27,
        ..current.clone()
    };
    assert_eq!(
        store.replace_for_migration(&current, &whole, &small),
        Err(StoreError::Unsupported(
            "do sql: a small state framed whole (a store schema before 28)"
        ))
    );
    // A small state framed for the wrong schema is refused by the framing.
    assert!(store
        .replace_for_migration(&current, &older, &small)
        .is_err());
    assert_eq!(store.manifest().unwrap(), current);
    assert_eq!(export_to_container(&store).unwrap(), before);
    let mut fresh = DoStore::open(RusqliteExecutor::open_in_memory().unwrap(), 1).unwrap();
    assert_eq!(
        fresh.replace_for_migration(&current, &older, &small),
        Err(StoreError::Empty)
    );
}

#[test]
fn a_production_open_keeps_the_store_and_begin_refuses_to_overwrite_it() {
    let dir = TempDir::new("ironhorse-do-not-empty");
    let path = dir.join("object.sqlite");
    let open = |id| DoStore::open(RusqliteExecutor::open(&path).unwrap(), id).unwrap();
    let mut store = open(1);
    let session = begin(&mut store, "var n = 7; n");
    let epoch = session.epoch();
    drop((session, store));
    let mut store = open(1);
    assert_eq!(store.manifest().unwrap().epoch, epoch);
    let refused = begin_store_session(machine("var n = 9; n"), &sig(), &mut store)
        .err()
        .map(|(_, e)| e);
    assert_eq!(refused, Some(StoreError::NotEmpty { epoch }));
    let mut session = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(crank(&mut session, "var n; n"), "7");
}

#[test]
fn a_harness_reset_empties_one_store_and_no_other() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let mut one = DoStore::open(executor.clone(), 1).unwrap();
    let mut two = DoStore::open(executor.clone(), 2).unwrap();
    drop(begin(&mut one, "var n = 1; n"));
    drop(begin(&mut two, "var n = 2; n"));
    assert!(one.record_failure("one failed").unwrap());
    let two_before = export_to_container(&two).unwrap();
    one.reset_for_harness().unwrap();
    assert_eq!(one.manifest(), Err(StoreError::Empty));
    assert_eq!(one.failure().unwrap(), None);
    let count: i64 = executor
        .connection()
        .query_row(
            "SELECT (SELECT COUNT(*) FROM ih_meta WHERE store = 1) \
             + (SELECT COUNT(*) FROM ih_slot_pages WHERE store = 1) \
             + (SELECT COUNT(*) FROM ih_chunk_exts WHERE store = 1) \
             + (SELECT COUNT(*) FROM ih_free_segs WHERE store = 1) \
             + (SELECT COUNT(*) FROM ih_page_edges WHERE store = 1) \
             + (SELECT COUNT(*) FROM ih_sections WHERE store = 1)",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
    assert_eq!(export_to_container(&two).unwrap(), two_before);
    let mut session = begin(&mut one, "var n = 3; n");
    assert_eq!(crank(&mut session, "var n; n"), "3");
    // The stamp survives every reset.
    DoStore::open(executor, 1).unwrap();
}

/// Counts write statements, and fails the one numbered `fail_at` (from 0).
#[derive(Clone, Debug)]
struct Faulty {
    inner: RusqliteExecutor,
    writes: Rc<Cell<u32>>,
    fail_at: Rc<Cell<Option<u32>>>,
}

impl SqlExecutor for Faulty {
    fn exec(&self, sql: &str, params: &[Value]) -> Result<Vec<Vec<Value>>, StoreError> {
        if !sql.starts_with("SELECT") && !sql.starts_with("CREATE") {
            let n = self.writes.get();
            self.writes.set(n + 1);
            if self.fail_at.get() == Some(n) {
                return Err(StoreError::Io("injected write failure".into()));
            }
        }
        self.inner.exec(sql, params)
    }
}

fn faulty() -> (Faulty, DoStore<Faulty>) {
    let executor = Faulty {
        inner: RusqliteExecutor::open_in_memory().unwrap(),
        writes: Rc::default(),
        fail_at: Rc::default(),
    };
    let store = DoStore::open(executor.clone(), 1).unwrap();
    (executor, store)
}

/// A commit that fails part-way inside a host transaction rolls back to the
/// prior epoch: the host contract the store's atomicity rests on. Without the
/// transaction the same failure leaves a torn store, which is why the
/// contract is the host's to keep.
#[test]
fn a_commit_that_fails_part_way_rolls_back_with_the_host_transaction() {
    for in_transaction in [true, false] {
        let (executor, mut store) = faulty();
        let mut session = begin(
            &mut store,
            "var a = []; for (var i = 0; i < 600; i++) a.push({ i: i }); 0",
        );
        let prior = store.manifest().unwrap();
        let before = export_to_container(&store).unwrap();
        crank(
            &mut session,
            "var a; for (var i = 0; i < 600; i++) a[i].i = -i; 0",
        );
        let start = executor.writes.get();
        // Fail on the third write: two rows are already rewritten.
        executor.fail_at.set(Some(start + 2));
        let conn = executor.inner.connection();
        if in_transaction {
            conn.execute_batch("BEGIN IMMEDIATE").unwrap();
        }
        let error = checkpoint_to_store(&mut session, &sig(), &mut store).unwrap_err();
        assert_eq!(error, StoreError::Io("injected write failure".into()));
        assert_eq!(executor.writes.get(), start + 3);
        executor.fail_at.set(None);
        drop(session);
        if in_transaction {
            conn.execute_batch("ROLLBACK").unwrap();
            assert_eq!(store.manifest().unwrap(), prior);
            assert_eq!(export_to_container(&store).unwrap(), before);
            validate_store_content(&store, &sig()).unwrap();
            let mut resumed = resume_from_store(&store, &sig()).unwrap();
            assert_eq!(crank(&mut resumed, "var a; a[599].i"), "599");
        } else {
            // The manifest is the prior one, and the rows are not.
            assert_eq!(store.manifest().unwrap(), prior);
            assert_ne!(export_to_container(&store).unwrap(), before);
        }
    }
}

/// The failure record for quarantine, written outside the failed crank's
/// transaction, outlives that transaction's rollback; written inside it, it
/// would be rolled back with the crank.
#[test]
fn a_failure_recorded_outside_the_halted_crank_survives_its_rollback() {
    let dir = TempDir::new("ironhorse-do-failure-record");
    let path = dir.join("object.sqlite");
    let open = |id| DoStore::open(RusqliteExecutor::open(&path).unwrap(), id).unwrap();
    let executor = RusqliteExecutor::open(&path).unwrap();
    let mut store = DoStore::open(executor.clone(), 1).unwrap();
    let mut session = begin(&mut store, "var n = 7; n");
    let prior = store.manifest().unwrap();
    assert_eq!(store.failure().unwrap(), None);
    let conn = || executor.connection();

    // A crank whose checkpoint commits inside the host transaction, and a
    // failure recorded inside it as well: the rollback takes both.
    crank(&mut session, "var n; n = 8; n");
    conn().execute_batch("BEGIN IMMEDIATE").unwrap();
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    assert!(store.record_failure("inside the transaction").unwrap());
    conn().execute_batch("ROLLBACK").unwrap();
    assert_eq!(store.manifest().unwrap(), prior);
    assert_eq!(store.failure().unwrap(), None);
    drop(session);

    // The host's order: the crank's transaction rolls back, then the
    // failure is committed by itself.
    let mut session = resume_from_store(&store, &sig()).unwrap();
    crank(&mut session, "var n; n = 9; n");
    conn().execute_batch("BEGIN IMMEDIATE").unwrap();
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    conn().execute_batch("ROLLBACK").unwrap();
    drop(session);
    assert!(store.record_failure("halted: the crank of n = 9").unwrap());
    // The first record wins, and the caller is told.
    assert!(!store.record_failure("a later failure").unwrap());
    drop((store, executor));

    let mut store = open(1);
    assert_eq!(store.manifest().unwrap(), prior);
    assert_eq!(
        store.failure().unwrap().as_deref(),
        Some("halted: the crank of n = 9")
    );
    assert_eq!(open(2).failure().unwrap(), None, "per store id");
    // A commit leaves the record as it is; the store does not refuse one.
    let mut session = resume_from_store(&store, &sig()).unwrap();
    crank(&mut session, "var n; n = 10; n");
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    drop(session);
    assert_eq!(store.manifest().unwrap().epoch, prior.epoch + 1);
    assert_eq!(
        store.failure().unwrap().as_deref(),
        Some("halted: the crank of n = 9")
    );
}

#[test]
fn the_executor_runs_one_statement_per_call() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let error = executor
        .exec("SELECT 1; SELECT 2", &[])
        .expect_err("two statements");
    assert_eq!(
        error,
        StoreError::Unsupported("sqlite: an exec must carry exactly one statement")
    );
    assert!(executor.exec("-- nothing", &[]).is_err());
    assert_eq!(
        executor.exec(
            "SELECT 1, ?1, ?2",
            &[Value::Blob(vec![1]), Value::Text("t".into())]
        ),
        Ok(vec![vec![
            Value::Integer(1),
            Value::Blob(vec![1]),
            Value::Text("t".into())
        ]])
    );
    // A REAL that carries an integer reads as one; any other is refused.
    assert_eq!(
        executor.exec("SELECT 3.0", &[]),
        Ok(vec![vec![Value::Integer(3)]])
    );
    assert_eq!(
        executor.exec("SELECT 0.5", &[]).unwrap_err().classify(),
        StoreFailure::Poisoned
    );
}

#[test]
fn a_wrong_column_type_at_rest_poisons_rather_than_panics() {
    let executor = RusqliteExecutor::open_in_memory().unwrap();
    let mut store = DoStore::open(executor.clone(), 1).unwrap();
    drop(begin(&mut store, "var n = 7; n"));
    let conn = executor.connection();
    conn.execute(
        "UPDATE ih_slot_pages SET bytes = 'text' WHERE store = 1 AND page = 0",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE ih_sections SET chunk = -1 WHERE store = 1 AND id = 0",
        [],
    )
    .unwrap();
    for error in [
        store.read_slot_page(0).unwrap_err(),
        store.read_small_state().unwrap_err(),
    ] {
        assert_eq!(error.classify(), StoreFailure::Poisoned, "{error:?}");
    }
}
