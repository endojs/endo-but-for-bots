//! While a SQLite heap store is open, its `locking_mode=EXCLUSIVE` keeps
//! every other writer out: the single-writer premise the store-seam
//! design's trust model rests on, rather than any check of what the store
//! holds. Closed, the file takes any writer.

mod common;

use common::TempDir;
use ironhorse_snapshot::store::HeapStoreCommit;

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, MachineSnapshot};
use ironhorse_snapshot::store::{image_to_batch_unchecked, validate_store_content, HeapStore};
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

/// Epochs 1 and 2 through the machine path, returning the live store and
/// the machine's image for hand-built successor batches.
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

/// Rewrite a stored slot-page row in place through a second connection.
/// Succeeds only between opens.
fn write_at_rest(path: &std::path::Path) -> Result<(), rusqlite::Error> {
    let raw = rusqlite::Connection::open(path)?;
    raw.busy_timeout(std::time::Duration::from_millis(100))?;
    let n = raw.execute("UPDATE slot_pages SET bytes = bytes WHERE page = 0", [])?;
    assert_eq!(n, 1, "the fixture row exists");
    Ok(())
}

#[test]
fn an_open_store_excludes_other_writers() {
    let dir = TempDir::new("ih-sqlite-writer-exclusion");
    let path = dir.join("heap.sqlite");
    let (mut store, image) = two_epochs(&path);

    // Open: the second connection cannot write at all.
    match write_at_rest(&path) {
        Err(rusqlite::Error::SqliteFailure(e, _))
            if e.code == rusqlite::ErrorCode::DatabaseBusy => {}
        other => panic!("expected the EXCLUSIVE lock to refuse the writer, got {other:?}"),
    }

    let batch3 = image_to_batch_unchecked(&image, 3, store.manifest().unwrap().token);
    store.commit(&batch3).expect("commit");
    validate_store_content(&store, &sig()).expect("the store stays valid");
    store.close().unwrap();

    // Closed, the file takes any writer.
    write_at_rest(&path).expect("closed store accepts the writer");
}
