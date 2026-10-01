//! Frozen SQLite store fixture for the cross-version migration tests
//! (the engine crate's twin freezes the file-store artifact). Run the
//! `regenerate_` test ONCE per schema era and COMMIT the bytes; the
//! v5 artifact was frozen at STORE_SCHEMA_VERSION 5, before the v6
//! root-tree bump. `close()` folds the WAL, so the committed .sqlite
//! is one self-contained deterministic-enough file (page content is
//! what migration reads; free-page noise is irrelevant to it).

mod common;

use std::cell::RefCell;
use std::rc::Rc;

use common::TempDir;
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, full_collect, resume_from_store,
    resume_from_store_lazy,
};
use ironhorse_snapshot::store::{
    migrate_store, validate_store, validate_store_content, HeapStore, StoreError, StoreManifest,
    STORE_SCHEMA_VERSION,
};
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

const FIXTURE_CRANKS: [&str; 2] = [
    "var keep = 0; var g = 0; var i = 0; var t = 0; \
     keep = { v: 1, w: 2 }; \
     for (i = 0; i < 200; i = i + 1) { g = { v: i, w: i }; } \
     g = 0; t = 7; t",
    "var keep; var g; var i; var t; \
     t = keep.v + keep.w; t",
];
const FIXTURE_RESULTS: [&str; 2] = ["7", "3"];

#[test]
#[ignore]
fn regenerate_sqlite_store_fixture() {
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        FIXTURE_CRANKS.iter().map(|s| compile(s)).collect();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("store-v5.sqlite");
    let _ = std::fs::remove_file(&path);

    let mut store = SqliteHeapStore::open(&path).unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o = m.run(&compiled[0].0);
    assert!(o.completed);
    assert_eq!(o.result, FIXTURE_RESULTS[0]);
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    let o = session.machine_mut().run(&compiled[1].0);
    assert!(o.completed);
    assert_eq!(o.result, FIXTURE_RESULTS[1]);
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    drop(session);
    store.close().expect("full close folds the WAL");
    println!("fixture written at {} — commit it", path.display());
}

/// The stage-1 fixture's cranks, the engine crate's file-store twin's:
/// one that leaves garbage and a string behind, one run after a lazy
/// resume, and one run after a full collection.
const STAGE1_CRANKS: [&str; 3] = [
    "var keep = 0; var g = 0; var i = 0; var t = 0; \
     keep = { v: 1, w: 2, s: 'kept' }; \
     for (i = 0; i < 300; i = i + 1) { g = { v: i, w: 'garbage-' + i }; } \
     g = 0; t = 7; t",
    "var keep; var g; var i; var t; \
     for (i = 0; i < 100; i = i + 1) { g = { v: i }; } \
     g = 0; t = keep.v + keep.w; t",
    "var keep; var g; var i; var t; t = keep.s; t",
];
const STAGE1_RESULTS: [&str; 3] = ["7", "3", "kept"];
/// Run by the test that opens the fixture: `1 + 2 + 'kept'.length`.
const STAGE1_PROBE: (&str, &str) = (
    "var keep; var g; var i; var t; t = keep.v + keep.w + keep.s.length; t",
    "7",
);

fn stage1_fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v35-stage1.sqlite")
}

/// Write the stage-1 history into a fresh SQLite store at `path`: epoch
/// 1 by a full write, then a lazy resume on a fresh connection, the first
/// checkpoint after it (which reads the stored section digests), a full
/// collection, and incremental checkpoints, ending at epoch 4 with the
/// store closed (the WAL folded in).
fn write_stage1_sqlite_store(path: &std::path::Path) {
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        STAGE1_CRANKS.iter().map(|s| compile(s)).collect();
    let mut store = SqliteHeapStore::open(path).unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&compiled[0].1);
    let o = m.run(&compiled[0].0);
    assert!(o.completed);
    assert_eq!(o.result, STAGE1_RESULTS[0]);
    drop(
        begin_store_session(m, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("begin"),
    );
    store.close().expect("full close folds the WAL");

    let store = Rc::new(RefCell::new(SqliteHeapStore::open(path).unwrap()));
    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    for (i, (bytecode, names)) in compiled.iter().enumerate().skip(1) {
        let code = session
            .machine_mut()
            .relink_crank(bytecode, names)
            .expect("crank relinks");
        let o = session.machine_mut().run(&code);
        assert!(o.completed);
        assert_eq!(o.result, STAGE1_RESULTS[i]);
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");
        validate_store_content(&*store.borrow(), &sig()).expect("the history's stores validate");
        if i == 1 {
            full_collect(&mut session, &*store.borrow()).expect("collects");
            checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut())
                .expect("checkpoint after the collection");
            validate_store_content(&*store.borrow(), &sig())
                .expect("the history's stores validate");
        }
    }
    assert_eq!(session.epoch(), 4);
    drop(session);
    Rc::try_unwrap(store)
        .expect("the session released the store")
        .into_inner()
        .close()
        .expect("full close folds the WAL");
}

/// The stage-1 fixture: a schema-35 store written by stage 1 of the
/// store-seam design's phase 13, with its `leaf_hashes` table. Frozen for
/// stage 2, which migrates it: only a schema-35 build can write it, so a
/// later build refuses rather than overwrite it with a current-schema
/// store. Written beside the fixture and renamed into place, so a reader
/// never copies a half-written file.
#[test]
#[ignore]
fn regenerate_stage1_sqlite_store_fixture() {
    assert_eq!(
        STORE_SCHEMA_VERSION, 35,
        "the stage-1 fixture is frozen at store schema 35"
    );
    let path = stage1_fixture();
    let staging = path.with_file_name(".store-v35-stage1.sqlite.staging");
    let _ = std::fs::remove_file(&staging);
    write_stage1_sqlite_store(&staging);
    std::fs::rename(&staging, &path).unwrap();
    println!("fixture written at {} — commit it", path.display());
}

/// The boot layout of the build that wrote the stage-1 fixture
/// (`regenerate_stage1_sqlite_store_fixture`, which only a schema-35 build
/// can run). The fixture is frozen, so this is too.
const STAGE1_FIXTURE_BOOT: [u8; 32] = [
    210, 205, 173, 102, 192, 135, 146, 200, 62, 10, 111, 223, 170, 167, 104, 132, 31, 246, 118, 18,
    42, 255, 101, 204, 150, 227, 222, 102, 95, 182, 69, 250,
];

/// Whether the SQLite store at `path` still has the `leaf_hashes` table the
/// schemas before 36 kept. Read between opens: the store holds an exclusive
/// lock while it is open.
fn has_leaf_table(path: &std::path::Path) -> bool {
    rusqlite::Connection::open(path)
        .unwrap()
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE name = 'leaf_hashes'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
        == 1
}

/// The committed stage-1 fixture, a schema-35 SQLite store with its
/// `leaf_hashes` table, is refused by this build and left untouched.
///
/// The fixture's history is frozen, so only a build with the boot layout
/// that wrote it could migrate it, and no build since the realm's
/// `%ThrowTypeError%`, `@@species` getters and Number formatting methods
/// has that layout (the deterministic-math provider never had it). The
/// migration's boot gate refuses before writing and names both layouts.
/// [`stage1_history_at_schema_35_migrates_and_resumes`] migrates the same
/// history under this build's own layout.
#[test]
fn stage1_sqlite_fixture_refuses_a_later_boot_layout() {
    let dir = TempDir::new("ih-stage1-sqlite-fixture");
    let path = dir.join("heap.sqlite");
    std::fs::copy(stage1_fixture(), &path).unwrap();
    let before = std::fs::read(&path).unwrap();
    assert!(has_leaf_table(&path), "stage 1 kept the leaf table");
    let mut store = SqliteHeapStore::open(&path).unwrap();
    assert_eq!(store.manifest().unwrap().store_schema, 35);
    let current = Interp::boot_fingerprint();
    assert_ne!(current, STAGE1_FIXTURE_BOOT);
    match migrate_store(&mut store, &sig()) {
        Err(StoreError::Snapshot(SnapshotError::BootLayoutMismatch { expected, found })) => {
            assert_eq!(expected, current);
            assert_eq!(found, Some(STAGE1_FIXTURE_BOOT));
        }
        other => panic!("the fixture must be refused: {other:?}"),
    }
    store.close().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

/// A schema-35 SQLite store of the stage-1 history under this build's own
/// boot layout migrates in place: the `leaf_hashes` table is dropped, the
/// manifest moves to the current schema and nothing else, the store passes
/// both validator levels (including the edge-index parity hook), and it
/// resumes where it stopped and checkpoints.
///
/// The history is written fresh, its manifest restamped to schema 35
/// through the migration hook, and the leaf table a schema-35 store kept is
/// planted beside it, as an older build's store would read.
#[test]
fn stage1_history_at_schema_35_migrates_and_resumes() {
    let dir = TempDir::new("ih-stage1-sqlite-v35");
    let path = dir.join("heap.sqlite");
    write_stage1_sqlite_store(&path);
    let mut store = SqliteHeapStore::open(&path).unwrap();
    let current = store.manifest().unwrap();
    let small = store.read_small_state().unwrap();
    let old = StoreManifest {
        store_schema: 35,
        ..current.clone()
    };
    store.replace_for_migration(&current, &old, &small).unwrap();
    store.close().unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute_batch(
            "CREATE TABLE leaf_hashes (
               kind INTEGER NOT NULL, idx INTEGER NOT NULL, hash BLOB NOT NULL,
               PRIMARY KEY (kind, idx)
             );
             INSERT INTO leaf_hashes VALUES (0, 0, zeroblob(32));",
        )
        .unwrap();
    assert!(has_leaf_table(&path));

    let mut store = SqliteHeapStore::open(&path).unwrap();
    assert_eq!(store.manifest().unwrap(), old);
    assert!(migrate_store(&mut store, &sig()).expect("migrates"));
    store.close().unwrap();
    assert!(!has_leaf_table(&path), "migration drops the leaf table");
    let mut store = SqliteHeapStore::open(&path).unwrap();
    let migrated = store.manifest().unwrap();
    assert_eq!(
        migrated,
        StoreManifest {
            store_schema: STORE_SCHEMA_VERSION,
            ..old
        },
        "only the schema moves"
    );
    validate_store(&store, &sig()).expect("metadata-scale validation");
    validate_store_content(&store, &sig()).expect("full validation");
    let mut session = resume_from_store(&store, &sig()).expect("the store resumes");
    assert_eq!((session.epoch(), session.token()), (4, migrated.token));
    let (bytecode, names) = compile(STAGE1_PROBE.0);
    let code = session
        .machine_mut()
        .relink_crank(&bytecode, &names)
        .expect("probe relinks");
    let o = session.machine_mut().run(&code);
    assert!(o.completed, "{:?}", o.halt);
    assert_eq!(o.result, STAGE1_PROBE.1);
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoints"),
        5
    );
    validate_store_content(&store, &sig()).expect("validates after the checkpoint");
}

/// The stage-1 fixture's history, written fresh on every run at the current
/// schema, leaves a store that passes the full validator after each
/// checkpoint.
#[test]
fn stage1_history_writes_valid_stores() {
    let dir = TempDir::new("ih-stage1-sqlite-history");
    let path = dir.join("heap.sqlite");
    write_stage1_sqlite_store(&path);
    validate_store_content(&SqliteHeapStore::open(&path).unwrap(), &sig()).expect("validates");
}
