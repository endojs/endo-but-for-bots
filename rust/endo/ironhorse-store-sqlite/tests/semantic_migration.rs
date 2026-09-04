//! SQLite cross-version lock for the boot-layout compatibility gate. The
//! committed store was produced by exact commit `8047fd52f`, before the
//! current boot graph landed, and must be rejected before arena adoption.

mod common;

use common::TempDir;

use ironhorse_snapshot::machine::resume_from_store;
use ironhorse_snapshot::store::{migrate_store, StoreError};
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_store_sqlite::SqliteHeapStore;

fn signature() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

#[test]
fn incompatible_legacy_boot_store_is_rejected_before_adoption() {
    let dir = TempDir::new("ih-sqlite-semantic-migration");
    let path = dir.join("compat.sqlite");
    std::fs::copy(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/compat-8047.sqlite"),
        &path,
    )
    .expect("copy exact-8047 fixture");

    let before = std::fs::read(&path).expect("read old store");
    let mut store = SqliteHeapStore::open(&path).expect("open old store");
    match migrate_store(&mut store, &signature()) {
        Err(StoreError::Snapshot(SnapshotError::SignatureMismatch { .. })) => {}
        Ok(false) => {}
        Err(other) => panic!("legacy boot migration refused incorrectly: {other:?}"),
        Ok(true) => panic!("legacy boot layout must not be restamped"),
    }
    store.close().expect("close refused store");
    assert_eq!(
        std::fs::read(&path).expect("reread refused store"),
        before,
        "the boot-layout gate fires before SQLite mutation"
    );

    let store = SqliteHeapStore::open(&path).expect("reopen old store");
    match resume_from_store(&store, &signature()) {
        Err(StoreError::Snapshot(SnapshotError::SignatureMismatch { .. })) => {}
        Err(other) => panic!("legacy boot refused for the wrong reason: {other:?}"),
        Ok(_) => panic!("legacy boot layout must not reach arena adoption"),
    }
}
