//! The snapshot store's corner cases: tampered blobs, malformed names, and
//! reclamation boundaries.

use slot_machine_transcript::{
    ContentAddressedStore, ContentAddressedStoreError, FaultMode, FaultPlan,
};

fn store() -> (tempfile::TempDir, ContentAddressedStore) {
    let root = tempfile::tempdir().unwrap();
    let blob_store = ContentAddressedStore::open(root.path().join("blob_store")).unwrap();
    (root, blob_store)
}

fn names(root: &tempfile::TempDir) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.path().join("blob_store"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_tampered_blob_is_refused_as_corrupt() {
    let (root, blob_store) = store();
    let hash = blob_store.write_blob(b"heap").unwrap();
    std::fs::write(root.path().join("blob_store").join(&hash), b"heap!").unwrap();
    match blob_store.read_blob(&hash) {
        Err(ContentAddressedStoreError::Corrupt { expected, actual }) => {
            assert_eq!(expected, hash);
            assert_ne!(actual, hash);
        }
        other => panic!("expected corrupt, got {other:?}"),
    }
}

#[test]
fn a_name_one_digit_too_long_is_not_a_blob_name() {
    let (_root, blob_store) = store();
    let hash = blob_store.write_blob(b"heap").unwrap();
    let long = format!("{hash}0");
    assert!(matches!(
        blob_store.read_blob(&long),
        Err(ContentAddressedStoreError::InvalidName(name)) if name == long
    ));
}

#[test]
fn reclaim_with_an_empty_keep_list_empties_the_store() {
    let (root, blob_store) = store();
    blob_store.write_blob(b"a").unwrap();
    blob_store.write_blob(b"b").unwrap();
    assert_eq!(blob_store.reclaim(&[]).unwrap(), 2);
    assert!(names(&root).is_empty());
}

#[test]
fn reclaim_keeping_every_blob_removes_nothing() {
    let (root, blob_store) = store();
    let keep = vec![
        blob_store.write_blob(b"a").unwrap(),
        blob_store.write_blob(b"b").unwrap(),
    ];
    assert_eq!(blob_store.reclaim(&keep).unwrap(), 0);
    assert_eq!(names(&root).len(), 2);
}

#[test]
fn reclaim_removes_orphan_temporaries_alone() {
    let (root, blob_store) = store();
    let keep = vec![blob_store.write_blob(b"a").unwrap()];
    std::fs::write(
        root.path()
            .join("blob_store")
            .join(".transcript-blob.1.0.tmp"),
        b"half",
    )
    .unwrap();
    assert_eq!(blob_store.reclaim(&keep).unwrap(), 1);
    assert_eq!(names(&root), keep);
}

#[test]
fn reclaim_tolerates_a_kept_hash_that_is_missing() {
    let (root, blob_store) = store();
    let kept = blob_store.write_blob(b"a").unwrap();
    let missing = "0".repeat(64);
    assert_eq!(blob_store.reclaim(&[kept.clone(), missing]).unwrap(), 0);
    assert_eq!(names(&root), vec![kept]);
}

#[test]
fn a_blob_temporary_does_not_share_the_heap_snapshot_prefix() {
    // `xsnap::Machine::suspend_to_cas` names its temporaries
    // `.snapshot.<pid>.<seq>.tmp` in the same directory; a blob temporary
    // left by a crash must not be mistaken for, or collide with, one.
    let root = tempfile::tempdir().unwrap();
    let blob_store = ContentAddressedStore::open(root.path().join("blob_store"))
        .unwrap()
        .with_fault_plan(FaultPlan::fail_at(2, FaultMode::Crash));
    assert!(blob_store.write_blob(b"heap").is_err());
    let names = names(&root);
    assert_eq!(names.len(), 1, "{names:?}");
    assert!(names[0].starts_with(".transcript-blob."), "{names:?}");
    assert!(names[0].ends_with(".tmp"), "{names:?}");
}
