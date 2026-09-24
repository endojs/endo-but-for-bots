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
    check_stored_digests, validate_store_content, HeapStore, StoreError,
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
/// checkpoint after it (which rebuilds both root ledgers from the stored
/// metadata), a full collection, and incremental checkpoints, ending at
/// epoch 4 with the store closed (the WAL folded in).
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
        check_stored_digests(&*store.borrow()).expect("stage 1 writes consistent digests");
        if i == 1 {
            full_collect(&mut session, &*store.borrow()).expect("collects");
            checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut())
                .expect("checkpoint after the collection");
            check_stored_digests(&*store.borrow()).expect("stage 1 writes consistent digests");
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
/// store-seam design's phase 13, which stops checking the store's
/// digests but keeps writing them for the build before it, which still
/// verifies them at open. Frozen for stage 2, which migrates it. Written
/// beside the fixture and renamed into place, so a reader never copies a
/// half-written file.
#[test]
#[ignore]
fn regenerate_stage1_sqlite_store_fixture() {
    let path = stage1_fixture();
    let staging = path.with_file_name(".store-v35-stage1.sqlite.staging");
    let _ = std::fs::remove_file(&staging);
    write_stage1_sqlite_store(&staging);
    std::fs::rename(&staging, &path).unwrap();
    println!("fixture written at {} — commit it", path.display());
}

/// The committed stage-1 fixture keeps the digests the build before the
/// store-seam design's phase 13 verifies at open, passes both validator
/// levels (including the edge-index parity hook), and resumes where it
/// stopped; a checkpoint of the resumed machine keeps the digests
/// consistent too. The fixture's history is frozen, so a build whose boot
/// layout or cost table differs from the one that wrote it cannot resume
/// it: the deterministic-math provider skips the rest after the digest
/// checks, and any other build fails until the fixture is regenerated.
#[test]
fn stage1_sqlite_fixture_keeps_its_digests_and_resumes() {
    let dir = TempDir::new("ih-stage1-sqlite-fixture");
    let path = dir.join("heap.sqlite");
    std::fs::copy(stage1_fixture(), &path).unwrap();
    let mut store = SqliteHeapStore::open(&path).unwrap();
    assert_eq!(store.manifest().unwrap().store_schema, 35);
    check_stored_digests(&store).expect("stage 1 wrote consistent digests");
    match validate_store_content(&store, &sig()) {
        Ok(_) => {}
        // The fixture was written under the platform math provider, whose
        // boot layout the deterministic-math lane does not share; any other
        // build that refuses it needs the fixture regenerated.
        Err(StoreError::Snapshot(
            SnapshotError::BootLayoutMismatch { .. } | SnapshotError::CostTableMismatch { .. },
        )) if ironhorse_vm::MATH_PROVIDER != "platform" => return,
        Err(other) => panic!(
            "the fixture must validate (regenerate it if the boot layout or cost table \
             changed): {other:?}"
        ),
    }
    let mut session = resume_from_store(&store, &sig()).expect("the fixture resumes");
    assert_eq!(session.epoch(), 4);
    let (bytecode, names) = compile(STAGE1_PROBE.0);
    let code = session
        .machine_mut()
        .relink_crank(&bytecode, &names)
        .expect("probe relinks");
    let o = session.machine_mut().run(&code);
    assert!(o.completed, "{:?}", o.halt);
    assert_eq!(o.result, STAGE1_PROBE.1);
    checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoints");
    check_stored_digests(&store).expect("the checkpoint keeps the digests consistent");
}

/// The stage-1 history, written fresh on every run, leaves consistent
/// digests after each checkpoint and a store that passes the full
/// validator.
#[test]
fn stage1_history_writes_consistent_digests() {
    let dir = TempDir::new("ih-stage1-sqlite-history");
    let path = dir.join("heap.sqlite");
    write_stage1_sqlite_store(&path);
    validate_store_content(&SqliteHeapStore::open(&path).unwrap(), &sig()).expect("validates");
}
