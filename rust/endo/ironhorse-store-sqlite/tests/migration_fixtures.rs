//! Frozen SQLite store fixture for the cross-version migration tests
//! (the engine crate's twin freezes the file-store artifact). Run the
//! `regenerate_` test ONCE per schema era and COMMIT the bytes; the
//! v5 artifact was frozen at STORE_SCHEMA_VERSION 5, before the v6
//! root-tree bump. `close()` folds the WAL, so the committed .sqlite
//! is one self-contained deterministic-enough file (page content is
//! what migration reads; free-page noise is irrelevant to it).

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
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
    let compiled: Vec<(Vec<u8>, Vec<String>)> =
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
