//! Cross-version migration lock, SQLite backend: the committed v5
//! fixture (frozen before the v6 root-tree bump) must open, migrate
//! in place inside `SqliteHeapStore::open`, verify against the v6
//! root, resume, and continue its commit chain under current code.
//! `migration_fixtures.rs` documents how the fixture was frozen and
//! pins the crank sources/results re-asserted here.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{checkpoint_to_store, resume_from_store};
use ironhorse_snapshot::store::{
    migrate_store, validate_store, HeapStore, StoreError, STORE_SCHEMA_VERSION,
};
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_store_sqlite::SqliteHeapStore;

/// The frozen fixture's second crank and its pinned completion value
/// (see `migration_fixtures.rs`): re-running it on the migrated store
/// dereferences state the v5-era cranks wrote (`keep.v + keep.w`), so
/// the assertion proves content survived, not just the version stamp.
const READ_CRANK: &str = "var keep; var g; var i; var t; \
     t = keep.v + keep.w; t";
const READ_RESULT: &str = "3";

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

#[test]
fn v5_sqlite_store_migrates_in_place_and_keeps_working() {
    let dir = TempDir::new("ih-migrate-sqlite");
    let path = dir.join("store.sqlite");
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v5.sqlite"),
        &path,
    )
    .expect("copy fixture");

    // Open no longer migrates (review wave 4, F2): the caller runs the
    // signature-gated migration (restamp schema + v6 root; the seal
    // chain is untouched — links stay opaque history).
    let mut store = SqliteHeapStore::open(&path).expect("open v5 store");
    assert!(
        migrate_store(&mut store, &sig()).expect("migrate v5 store"),
        "migrate_store reports it ran the ladder"
    );
    let manifest = store.manifest().expect("manifest");
    assert_eq!(
        manifest.store_schema, STORE_SCHEMA_VERSION,
        "migration restamped the store to the current schema"
    );
    validate_store(&store, &sig()).expect("migrated store recombines to its v6 root");

    // Resume, re-read the v5-era content, and extend the chain.
    let (bytecode, _symbols) =
        ironhorse_compile::compile_atoms(READ_CRANK).expect("read crank compiles");
    let epoch_before = manifest.epoch;
    let mut session = resume_from_store(&store, &sig()).expect("resume from migrated store");
    let o = session.machine_mut().run(&bytecode);
    assert!(o.completed, "read crank completes: {}", o.result);
    assert_eq!(o.result, READ_RESULT);
    let epoch = checkpoint_to_store(&mut session, &sig(), &mut store).expect("checkpoint");
    assert_eq!(epoch, epoch_before + 1, "epoch chain continues");
    drop(session);
    store.close().expect("close");

    // Reopen: the second migrate finds a current-schema store — it is
    // idempotent (reports no migration) and the extended chain still
    // validates.
    let mut store = SqliteHeapStore::open(&path).expect("reopen migrated store");
    assert!(
        !migrate_store(&mut store, &sig()).expect("re-migrate is a no-op"),
        "an already-current store reports no migration"
    );
    let manifest = store.manifest().expect("manifest");
    assert_eq!(manifest.store_schema, STORE_SCHEMA_VERSION);
    assert_eq!(manifest.epoch, epoch);
    validate_store(&store, &sig()).expect("still valid on reopen");
}

/// Review wave 4, F2/F3: the signature gate fires before the first
/// restamp, so a daemon whose callback table the store predates cannot
/// one-way upgrade it out from under its rightful owner — and an
/// un-migrated store fails closed by name rather than being silently
/// adopted.
#[test]
fn migrate_refuses_incompatible_signature_and_resume_names_the_gap() {
    let dir = TempDir::new("ih-migrate-sqlite-sig");
    let path = dir.join("store.sqlite");
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v5.sqlite"),
        &path,
    )
    .expect("copy fixture");

    let mut store = SqliteHeapStore::open(&path).expect("open v5 store");
    match migrate_store(&mut store, &Signature::new("some-other-host")) {
        Err(StoreError::Snapshot(SnapshotError::SignatureMismatch { .. })) => {}
        other => panic!("expected SignatureMismatch, got {other:?}"),
    }
    // Refused: the store is still v5, un-restamped, and resuming it
    // un-migrated fails closed by name.
    assert_eq!(
        store.manifest().expect("manifest").store_schema,
        5,
        "a signature-refused migration leaves the schema stamp alone"
    );
    match resume_from_store(&store, &sig()) {
        Err(StoreError::NeedsMigration { found: 5 }) => {}
        other => panic!("expected NeedsMigration {{ found: 5 }}, got {other:?}"),
    }
    // The rightful owner (compatible signature) can still migrate it.
    assert!(
        migrate_store(&mut store, &sig()).expect("rightful owner migrates"),
        "the refusal did not consume the pending migration"
    );
    assert_eq!(
        store.manifest().expect("manifest").store_schema,
        STORE_SCHEMA_VERSION
    );
}
