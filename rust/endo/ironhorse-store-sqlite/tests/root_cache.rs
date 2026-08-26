//! V6-c root-ledger cache locks for the SQLite backend: the fast
//! path refuses mis-rooted batches and recovers through its
//! drop-on-failure discipline, and the deliberate detection trade
//! (no per-commit re-scan of untouched stored leaves while the cache
//! is warm) is pinned in BOTH directions — a cold commit still
//! catches an at-rest leaf edit, a warm commit defers it to the
//! open-time validator.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, MachineSnapshot};
use ironhorse_snapshot::store::{
    image_to_batch, reseal_batch, validate_store, CheckpointBatch, HeapStore, StoreError,
};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

const PROG_A: [u8; 44] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
    0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
    0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
];

/// Epoch 1+2 through the machine path (epoch 1 seeds the cache via
/// the slow path, the epoch-2 checkpoint advances it via the fast
/// one), returning the live store and the machine's image for
/// hand-built successor batches.
fn two_epochs(path: &std::path::Path) -> (SqliteHeapStore, ironhorse_snapshot::image::MachineImage) {
    let mut store = SqliteHeapStore::open(path).unwrap();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    assert!(session.machine_mut().run(&PROG_A).completed);
    assert_eq!(checkpoint_to_store(&mut session, &sig(), &mut store).unwrap(), 2);
    let image = session.machine().snapshot_image(&sig());
    (store, image)
}

/// Try to zero a stored slot-page LEAF row through a second
/// connection — the at-rest edit the detection contract is about.
/// Succeeds only between opens: the backend's `locking_mode=
/// EXCLUSIVE` shuts a live store's file to other writers, so a warm
/// attempt comes back `DatabaseBusy`. The successor batches below
/// OMIT page 0 (see [`omit_page`]), so nothing upserts over a landed
/// edit.
fn corrupt_leaf_at_rest(path: &std::path::Path) -> Result<(), rusqlite::Error> {
    let raw = rusqlite::Connection::open(path)?;
    raw.busy_timeout(std::time::Duration::from_millis(100))?;
    let n = raw.execute(
        "UPDATE leaf_hashes SET hash = zeroblob(32) WHERE kind = 0 AND idx = 0",
        [],
    )?;
    assert_eq!(n, 1, "the fixture leaf row exists");
    Ok(())
}

/// Drop one page's row (and its coupled edge summary) from a FULL
/// batch, resealing: the batch becomes incremental-shaped — the
/// omitted page's stored leaf is the baseline the commit builds on,
/// which is exactly what the at-rest-edit arms need. The manifest
/// root is untouched: the machine content did not change, so the
/// honest full root still describes the intended store state.
fn omit_page(mut batch: CheckpointBatch, page: u32) -> CheckpointBatch {
    batch.slot_pages.retain(|(p, _)| *p != page);
    batch.page_edges.retain(|(p, _)| *p != page);
    reseal_batch(&mut batch);
    batch
}

#[test]
fn warm_refusal_drops_the_cache_and_recovers() {
    let dir = TempDir::new("ih-root-cache-refusal");
    let (mut store, image) = two_epochs(&dir.join("heap.sqlite"));
    let seal2 = store.manifest().unwrap().seal;

    // A mis-rooted epoch-3 batch, resealed so succession passes: the
    // WARM fast path must refuse it on root disagreement alone.
    let mut crafted = image_to_batch(&image, 3, &seal2);
    crafted.manifest.root = format!("{:0>64}", "bad");
    reseal_batch(&mut crafted);
    match store.commit(&crafted) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected the fast path to refuse the root, got {other:?}"),
    }
    assert_eq!(store.manifest().unwrap().epoch, 2, "refused batch left no trace");

    // The refusal dropped the cache; the honest successor lands via
    // the slow path (full recombination over the real rows), and one
    // more lands via the re-armed fast path.
    let honest3 = image_to_batch(&image, 3, &seal2);
    store.commit(&honest3).expect("honest successor after a refusal");
    let honest4 = image_to_batch(&image, 4, &store.manifest().unwrap().seal);
    store.commit(&honest4).expect("fast path re-armed");
    validate_store(&store, &sig()).expect("chain stays valid");
}

#[test]
fn cold_commit_refuses_an_at_rest_leaf_edit() {
    let dir = TempDir::new("ih-root-cache-cold");
    let path = dir.join("heap.sqlite");
    let (store, image) = two_epochs(&path);
    let seal2 = store.manifest().unwrap().seal;
    store.close().unwrap();
    corrupt_leaf_at_rest(&path).expect("closed store accepts the writer");

    // A fresh open has no ledger: the next commit's SLOW path reads
    // every stored leaf and the full recombination refuses to build
    // on the edited baseline — detection AT COMMIT, the reference
    // (Memory/File) backends' standing behavior.
    let mut store = SqliteHeapStore::open(&path).unwrap();
    let batch3 = omit_page(image_to_batch(&image, 3, &seal2), 0);
    match store.commit(&batch3) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected the cold slow path to catch the edit, got {other:?}"),
    }
}

#[test]
fn warm_store_excludes_writers_and_open_time_validation_catches_the_rest() {
    // The fast path stops re-scanning untouched stored leaves at
    // every commit. On this backend that trades away nothing: while
    // the store is WARM its `locking_mode=EXCLUSIVE` shuts the file
    // to any other writer — the at-rest-edit window the scan used to
    // patrol cannot even open — and an edit landing BETWEEN opens is
    // the cold story: open-time validation (and the cold slow path,
    // previous test) fails it closed.
    let dir = TempDir::new("ih-root-cache-warm");
    let path = dir.join("heap.sqlite");
    let (mut store, image) = two_epochs(&path);
    let seal2 = store.manifest().unwrap().seal;

    // Warm: the second connection cannot write at all.
    match corrupt_leaf_at_rest(&path) {
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::DatabaseBusy => {}
        other => panic!("expected the EXCLUSIVE lock to refuse the writer, got {other:?}"),
    }

    // The warm fast path commits without re-reading any stored leaf.
    let batch3 = omit_page(image_to_batch(&image, 3, &seal2), 0);
    store.commit(&batch3).expect("warm fast-path commit");
    store.close().unwrap();

    // Between opens the edit lands — and the reopen's validator is
    // where it dies, exactly as the v6 design states.
    corrupt_leaf_at_rest(&path).expect("closed store accepts the writer");
    let reopened = SqliteHeapStore::open(&path).unwrap();
    match validate_store(&reopened, &sig()) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected open-time detection, got {other:?}"),
    }
}
