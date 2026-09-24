//! Frozen store fixtures for the cross-version migration tests: the
//! `regenerate_` test runs ONCE per schema era and its bytes are
//! COMMITTED — the committed artifacts are the OLD-version stores
//! future code must migrate (regenerating after a bump produces
//! current-version fixtures, which is not the point). The v5 set was
//! frozen at `STORE_SCHEMA_VERSION` 5, before the v6 root-tree bump.
//!
//! The fixture machine is tiny but non-trivial: two cranks, live
//! globals, a dropped chain, an incremental second checkpoint — so a
//! migrated store proves content, succession, and resumability, not
//! just a version stamp.

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, full_collect, resume_from_store_lazy,
};
use ironhorse_snapshot::store::{check_stored_digests, export_to_container};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    (bytecode, parse_symbols(&symbols))
}

pub const FIXTURE_CRANKS: [&str; 2] = [
    "var keep = 0; var g = 0; var i = 0; var t = 0; \
     keep = { v: 1, w: 2 }; \
     for (i = 0; i < 200; i = i + 1) { g = { v: i, w: i }; } \
     g = 0; t = 7; t",
    "var keep; var g; var i; var t; \
     t = keep.v + keep.w; t",
];

/// The completion values the fixture cranks pin, for migration tests
/// to re-assert on the migrated store's resumed machine.
pub const FIXTURE_RESULTS: [&str; 2] = ["7", "3"];

#[test]
#[ignore]
fn regenerate_file_store_fixture() {
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        FIXTURE_CRANKS.iter().map(|s| compile(s)).collect();
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    std::fs::create_dir_all(&dir).unwrap();

    let mut store = FileStore::open(dir.join("store-v5.ihstore")).unwrap();
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

    std::fs::write(
        dir.join("store-v5.container"),
        export_to_container(&store).unwrap(),
    )
    .unwrap();
    println!("fixtures written under {} — commit them", dir.display());
}

/// The stage-1 fixture's cranks: one that leaves garbage and a string
/// behind, one run after a lazy resume, and one run after a full
/// collection.
pub const STAGE1_CRANKS: [&str; 3] = [
    "var keep = 0; var g = 0; var i = 0; var t = 0; \
     keep = { v: 1, w: 2, s: 'kept' }; \
     for (i = 0; i < 300; i = i + 1) { g = { v: i, w: 'garbage-' + i }; } \
     g = 0; t = 7; t",
    "var keep; var g; var i; var t; \
     for (i = 0; i < 100; i = i + 1) { g = { v: i }; } \
     g = 0; t = keep.v + keep.w; t",
    "var keep; var g; var i; var t; t = keep.s; t",
];

/// The completion values the stage-1 cranks pin.
pub const STAGE1_RESULTS: [&str; 3] = ["7", "3", "kept"];

/// A crank the tests that open the stage-1 fixture run, with its
/// completion: `1 + 2 + 'kept'.length`.
pub const STAGE1_PROBE: (&str, &str) = (
    "var keep; var g; var i; var t; t = keep.v + keep.w + keep.s.length; t",
    "7",
);

/// Write the stage-1 history into a fresh file store at `path`: epoch 1
/// by a full write, then a lazy resume on a fresh handle, the first
/// checkpoint after it (which rebuilds the root ledger from the stored
/// metadata), a full collection, and incremental checkpoints, ending at
/// epoch 4. Also run by `tests/migration.rs` into a scratch directory, so
/// the digests of what this history writes are checked on every run.
pub fn write_stage1_file_store(path: &std::path::Path) {
    let compiled: Vec<(Vec<u8>, Vec<ironhorse_vm::SymbolName>)> =
        STAGE1_CRANKS.iter().map(|s| compile(s)).collect();
    let mut store = FileStore::open(path).unwrap();
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
    drop(store);

    let store = Rc::new(RefCell::new(FileStore::open(path).unwrap()));
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
    // The probe the fixture's readers run, uncommitted.
    let (bytecode, names) = compile(STAGE1_PROBE.0);
    let code = session
        .machine_mut()
        .relink_crank(&bytecode, &names)
        .expect("probe relinks");
    assert_eq!(session.machine_mut().run(&code).result, STAGE1_PROBE.1);
}

/// The stage-1 fixture: a schema-35 store written by stage 1 of the
/// store-seam design's phase 13, which stops checking the store's
/// digests but keeps writing them for the build before it, which still
/// verifies them at open. Frozen for stage 2, which migrates it. Written
/// beside the fixture and renamed into place, so a reader never copies a
/// half-written file.
#[test]
#[ignore]
fn regenerate_stage1_file_store_fixture() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    std::fs::create_dir_all(&dir).unwrap();
    let staging = dir.join(".store-v35-stage1.ihstore.staging");
    let _ = std::fs::remove_file(&staging);
    write_stage1_file_store(&staging);
    let path = dir.join("store-v35-stage1.ihstore");
    std::fs::rename(&staging, &path).unwrap();
    println!("fixture written at {} — commit it", path.display());
}
