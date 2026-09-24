//! V6-c root-ledger cache locks for the SQLite backend: the fast path
//! refuses a batch whose root disagrees with the leaves it writes and
//! recovers through its drop-on-failure discipline, and while the store
//! is open its EXCLUSIVE lock keeps every other writer out, so the cached
//! leaves cannot move under it. Nothing checks the stored leaves against
//! the rows: under the store-seam design's trust model the store is
//! trusted, and phase 13 removes the leaves, the root and this cache.

mod common;

use common::TempDir;
use ironhorse_snapshot::store::HeapStoreCommit;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, MachineSnapshot};
use ironhorse_snapshot::store::{
    check_stored_digests, image_to_batch_unchecked, reseal_batch, validate_store, HeapStore,
    StoreError,
};
use ironhorse_snapshot::Signature;
use ironhorse_store_sqlite::SqliteHeapStore;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

const PROG_A: [u8; 44] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01, 0x00,
    0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0,
    0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
];

/// Epoch 1+2 through the machine path (epoch 1 seeds the cache via
/// the slow path, the epoch-2 checkpoint advances it via the fast
/// one), returning the live store and the machine's image for
/// hand-built successor batches.
fn two_epochs(
    path: &std::path::Path,
) -> (SqliteHeapStore, ironhorse_snapshot::image::MachineImage) {
    let mut store = SqliteHeapStore::open(path).unwrap();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin_store_session(m, &sig(), &mut store)
        .map_err(|(_, e)| e)
        .expect("begin");
    assert!(session.machine_mut().run(&PROG_A).completed);
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap(),
        2
    );
    let image = session
        .machine()
        .snapshot_image_for_testing(&sig())
        .expect("gated image");
    (store, image)
}

/// Try to zero a stored slot-page LEAF row through a second connection.
/// Succeeds only between opens: the backend's `locking_mode=EXCLUSIVE`
/// shuts a live store's file to other writers, so a warm attempt comes
/// back `DatabaseBusy`.
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

#[test]
fn warm_refusal_drops_the_cache_and_recovers() {
    let dir = TempDir::new("ih-root-cache-refusal");
    let (mut store, image) = two_epochs(&dir.join("heap.sqlite"));
    let seal2 = store.manifest().unwrap().seal;

    // A mis-rooted epoch-3 batch, resealed so succession passes: the
    // WARM fast path must refuse it, since the root it would write does
    // not combine from the leaves it would write.
    let mut crafted = image_to_batch_unchecked(&image, 3, &seal2);
    crafted.manifest.root = format!("{:0>64}", "bad");
    reseal_batch(&mut crafted);
    match store.commit(&crafted) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected the fast path to refuse the root, got {other:?}"),
    }
    assert_eq!(
        store.manifest().unwrap().epoch,
        2,
        "refused batch left no trace"
    );

    // The refusal dropped the cache; the honest successor lands via
    // the slow path (the ledger rebuilt from the stored leaves), and one
    // more lands via the re-armed fast path.
    let honest3 = image_to_batch_unchecked(&image, 3, &seal2);
    store
        .commit(&honest3)
        .expect("honest successor after a refusal");
    let honest4 = image_to_batch_unchecked(&image, 4, &store.manifest().unwrap().seal);
    store.commit(&honest4).expect("fast path re-armed");
    validate_store(&store, &sig()).expect("chain stays valid");
    // Both paths keep the digests the build before stage 1 verifies.
    check_stored_digests(&store).expect("the digests stay consistent");
}

#[test]
fn warm_store_excludes_other_writers() {
    // While the store is open, `locking_mode=EXCLUSIVE` shuts the file to
    // any other writer, so the leaves the warm cache holds are the stored
    // ones: the single-writer premise the store-seam design's trust model
    // rests on, rather than a check of the leaves.
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
    let batch3 = image_to_batch_unchecked(&image, 3, &seal2);
    store.commit(&batch3).expect("warm fast-path commit");
    validate_store(&store, &sig()).expect("the chain stays valid");
    check_stored_digests(&store).expect("the digests stay consistent");
    store.close().unwrap();

    // Closed, the file takes any writer.
    corrupt_leaf_at_rest(&path).expect("closed store accepts the writer");
}
