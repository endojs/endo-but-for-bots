//! SQLite storage-schema migration tests use synthetic v5 copies carrying the
//! current meter identity. The original name-only fixture remains unchanged and
//! is explicitly refused. A legacy boot signature isolates storage migration
//! from current engine adoption; this is not an old-cost compatibility claim.

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
    Signature::decode(b"ironhorse-worker-v1").expect("frozen fixture signature")
}

fn copy_original(path: &std::path::Path) {
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v5.sqlite"),
        path,
    )
    .expect("copy frozen fixture");
}

// These are storage-schema fixtures, not evidence that an old engine used
// today's weights. Explicitly transplant ONLY the identity of a frozen meter;
// retain counters, heap rows, and legacy schema, and authenticate the new bytes.
fn synthetic_meter_identity(old: &[u8]) -> Vec<u8> {
    let n = u32::from_be_bytes(old[24..28].try_into().unwrap()) as usize;
    assert_eq!(old.len(), 28 + n, "fixture has the legacy name-only record");
    assert_eq!(&old[28..], b"ironhorse-meter-1");
    let version = ironhorse_vm::COST_TABLE_VERSION.as_bytes();
    let mut new = old[..24].to_vec();
    new.extend_from_slice(&(version.len() as u32).to_be_bytes());
    new.extend_from_slice(version);
    new.extend_from_slice(&ironhorse_vm::cost_table::digest());
    new
}

fn copy_synthetic_v5_store(path: &std::path::Path) {
    use ironhorse_snapshot::store::{combine_root, leaf_hash, seal_commit, LEAF_SMALL};
    copy_original(path);
    let mut store = SqliteHeapStore::open(path).unwrap();
    let old = store.read_small_state().unwrap();
    let mut at = 0;
    for _ in 0..5 {
        let n = u32::from_be_bytes(old[at..at + 4].try_into().unwrap()) as usize;
        at += 4 + n;
    }
    let n = u32::from_be_bytes(old[at..at + 4].try_into().unwrap()) as usize;
    let meter = synthetic_meter_identity(&old[at + 4..at + 4 + n]);
    let mut small = old[..at].to_vec();
    small.extend_from_slice(&(meter.len() as u32).to_be_bytes());
    small.extend_from_slice(&meter);
    small.extend_from_slice(&old[at + 4 + n..]);
    let mut manifest = store.manifest().unwrap();
    let (pages, chunks) = store.leaf_hashes().unwrap();
    let frees = store.free_leaf_hashes().unwrap();
    let edges = store.page_edges().unwrap();
    manifest.root = combine_root(
        &leaf_hash(LEAF_SMALL, 0, &small),
        &pages,
        &chunks,
        &frees,
        &edges,
    );
    let page_rows: Vec<_> = (0..pages.len())
        .map(|i| (i as u32, store.read_slot_page(i as u32).unwrap()))
        .collect();
    let chunk_rows: Vec<_> = (0..chunks.len())
        .map(|i| (i as u32, store.read_chunk_extent(i as u32).unwrap()))
        .collect();
    let free_rows: Vec<_> = (0..frees.len())
        .map(|i| (i as u32, store.read_free_seg(i as u32).unwrap()))
        .collect();
    let edge_rows: Vec<_> = edges
        .into_iter()
        .enumerate()
        .map(|(i, row)| (i as u32, row))
        .collect();
    manifest.seal = seal_commit(
        "",
        &manifest,
        &small,
        &page_rows,
        &chunk_rows,
        &free_rows,
        &edge_rows,
    );
    store
        .replace_manifest_and_small_for_migration(&manifest, &small)
        .unwrap();
    store.close().unwrap();
}

#[test]
fn v5_sqlite_store_migrates_in_place_and_keeps_working() {
    let dir = TempDir::new("ih-migrate-sqlite");
    let path = dir.join("store.sqlite");
    copy_synthetic_v5_store(&path);

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
    copy_synthetic_v5_store(&path);

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

#[test]
fn original_name_only_meter_is_refused_without_restamping() {
    let dir = TempDir::new("ih-migrate-sqlite-name-only");
    let path = dir.join("store.sqlite");
    copy_original(&path);
    let mut store = SqliteHeapStore::open(&path).unwrap();
    let manifest = store.manifest().unwrap().encode();
    let small = store.read_small_state().unwrap();
    let leaves = store.leaf_hashes().unwrap();
    let frees = store.free_leaf_hashes().unwrap();
    let edges = store.page_edges().unwrap();
    assert!(matches!(
        migrate_store(&mut store, &sig()),
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "METR version string"
        )))
    ));
    assert_eq!(store.manifest().unwrap().encode(), manifest);
    assert_eq!(store.read_small_state().unwrap(), small);
    assert_eq!(store.leaf_hashes().unwrap(), leaves);
    assert_eq!(store.free_leaf_hashes().unwrap(), frees);
    assert_eq!(store.page_edges().unwrap(), edges);
    store.close().unwrap();
    let mut reopened = SqliteHeapStore::open(&path).unwrap();
    assert_eq!(reopened.manifest().unwrap().encode(), manifest);
    assert_eq!(reopened.read_small_state().unwrap(), small);
    assert!(migrate_store(&mut reopened, &sig()).is_err());
}
