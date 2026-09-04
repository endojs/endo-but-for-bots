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

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store};
use ironhorse_snapshot::store::export_to_container;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
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
    let compiled: Vec<(Vec<u8>, Vec<String>)> = FIXTURE_CRANKS.iter().map(|s| compile(s)).collect();
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
    println!(
        "fixtures written under {} — commit them",
        dir.display()
    );
}
