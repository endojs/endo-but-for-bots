//! The snapshot store's corner cases: tampered blobs, malformed names,
//! ownership, and reclamation boundaries.

use slot_machine_transcript::{
    ContentAddressedStore, ContentAddressedStoreError, FaultMode, FaultPlan,
};

fn store() -> (tempfile::TempDir, ContentAddressedStore) {
    let root = tempfile::tempdir().unwrap();
    let blob_store = ContentAddressedStore::open(root.path().join("blob_store"), "w").unwrap();
    (root, blob_store)
}

fn names(root: &tempfile::TempDir) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.path().join("blob_store"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name != ".owner")
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
fn an_uppercase_name_is_not_a_blob_name() {
    let (_root, blob_store) = store();
    let upper = blob_store.write_blob(b"heap").unwrap().to_uppercase();
    assert!(matches!(
        blob_store.read_blob(&upper),
        Err(ContentAddressedStoreError::InvalidName(name)) if name == upper
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
            // No process can hold the largest pid, so its writer is dead.
            .join(".transcript-blob.4294967295.0.tmp"),
        b"half",
    )
    .unwrap();
    assert_eq!(blob_store.reclaim(&keep).unwrap(), 1);
    assert_eq!(names(&root), keep);
}

#[test]
fn reclaim_spares_live_temporaries_foreign_files_and_subdirectories() {
    let (root, blob_store) = store();
    let directory = root.path().join("blob_store");
    let garbage = blob_store.write_blob(b"garbage").unwrap();
    let live = format!(".transcript-blob.{}.0.tmp", std::process::id());
    let spared = [
        live.as_str(),
        ".snapshot.4294967295.0.tmp",
        "README",
        ".transcript-blob.not-a-pid.0.tmp",
    ];
    for name in spared {
        std::fs::write(directory.join(name), b"x").unwrap();
    }
    std::fs::create_dir(directory.join("nested")).unwrap();
    assert_eq!(blob_store.reclaim(&[]).unwrap(), 1);
    let remaining = names(&root);
    assert!(!remaining.contains(&garbage), "{remaining:?}");
    for name in spared {
        assert!(
            remaining.iter().any(|n| n == name),
            "{name} in {remaining:?}"
        );
    }
    assert!(directory.join("nested").is_dir());
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
    // `.snapshot.<pid>.<sequence>.tmp` in the same directory; a blob temporary
    // left by a crash must not be mistaken for, or collide with, one.
    let root = tempfile::tempdir().unwrap();
    let blob_store = ContentAddressedStore::open(root.path().join("blob_store"), "w")
        .unwrap()
        .with_fault_plan(FaultPlan::fail_at(2, FaultMode::Crash));
    assert!(blob_store.write_blob(b"heap").is_err());
    let names = names(&root);
    assert_eq!(names.len(), 1, "{names:?}");
    assert!(names[0].starts_with(".transcript-blob."), "{names:?}");
    assert!(names[0].ends_with(".tmp"), "{names:?}");
}

#[test]
fn a_store_has_one_owner_so_reclaim_cannot_delete_a_co_tenants_snapshot() {
    use slot_machine_transcript::{Transcript, TranscriptConfig};

    let root = tempfile::tempdir().unwrap();
    let shared = root.path().join("blob_store");
    let meta = slot_machine_transcript::SnapshotMeta {
        engine_signature: b"toy".to_vec(),
        panic_on_reference_error: false,
    };
    let store_a = ContentAddressedStore::open(&shared, "a").unwrap();
    let (mut a, _) =
        Transcript::open(root.path().join("a.sqlite"), TranscriptConfig::new("a")).unwrap();
    let published = a.publish_snapshot(&store_a, b"heap-a", meta).unwrap();

    // A second transcript cannot adopt the same directory: its reclaim would
    // keep only its own snapshot and delete worker a's.
    let error = ContentAddressedStore::open(&shared, "b").unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists);

    // The owner reopens its store, and reclaiming keeps the marker and the
    // published blob.
    let reopened = ContentAddressedStore::open(&shared, "a").unwrap();
    assert_eq!(
        reopened
            .reclaim(std::slice::from_ref(&published.hash))
            .unwrap(),
        0
    );
    assert!(shared.join(".owner").exists());
    assert_eq!(reopened.read_blob(&published.hash).unwrap(), b"heap-a");

    // A separate directory per worker is the supported layout.
    let store_b = ContentAddressedStore::open(root.path().join("blob_store_b"), "b").unwrap();
    let (mut b, _) =
        Transcript::open(root.path().join("b.sqlite"), TranscriptConfig::new("b")).unwrap();
    b.publish_snapshot(
        &store_b,
        b"heap-b",
        slot_machine_transcript::SnapshotMeta {
            engine_signature: b"toy".to_vec(),
            panic_on_reference_error: false,
        },
    )
    .unwrap();
    assert_eq!(store_b.reclaim(&[]).unwrap(), 1);
    assert_eq!(reopened.read_blob(&published.hash).unwrap(), b"heap-a");
}
