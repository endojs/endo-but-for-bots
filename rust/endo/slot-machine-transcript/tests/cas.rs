//! The snapshot store's corner cases: tampered blobs, malformed names, and
//! reclamation boundaries.

use slot_machine_transcript::{CasError, ContentAddressedStore};

fn store() -> (tempfile::TempDir, ContentAddressedStore) {
    let root = tempfile::tempdir().unwrap();
    let cas = ContentAddressedStore::open(root.path().join("cas")).unwrap();
    (root, cas)
}

fn names(root: &tempfile::TempDir) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root.path().join("cas"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_tampered_blob_is_refused_as_corrupt() {
    let (root, cas) = store();
    let hash = cas.write_blob(b"heap").unwrap();
    std::fs::write(root.path().join("cas").join(&hash), b"heap!").unwrap();
    match cas.read_blob(&hash) {
        Err(CasError::Corrupt { expected, actual }) => {
            assert_eq!(expected, hash);
            assert_ne!(actual, hash);
        }
        other => panic!("expected corrupt, got {other:?}"),
    }
}

#[test]
fn a_name_one_digit_too_long_is_not_a_blob_name() {
    let (_root, cas) = store();
    let hash = cas.write_blob(b"heap").unwrap();
    let long = format!("{hash}0");
    assert!(matches!(
        cas.read_blob(&long),
        Err(CasError::InvalidName(name)) if name == long
    ));
}

#[test]
fn reclaim_with_an_empty_keep_list_empties_the_store() {
    let (root, cas) = store();
    cas.write_blob(b"a").unwrap();
    cas.write_blob(b"b").unwrap();
    assert_eq!(cas.reclaim(&[]).unwrap(), 2);
    assert!(names(&root).is_empty());
}

#[test]
fn reclaim_keeping_every_blob_removes_nothing() {
    let (root, cas) = store();
    let keep = vec![cas.write_blob(b"a").unwrap(), cas.write_blob(b"b").unwrap()];
    assert_eq!(cas.reclaim(&keep).unwrap(), 0);
    assert_eq!(names(&root).len(), 2);
}

#[test]
fn reclaim_removes_orphan_temporaries_alone() {
    let (root, cas) = store();
    let keep = vec![cas.write_blob(b"a").unwrap()];
    std::fs::write(
        root.path().join("cas").join(".transcript-blob.1.0.tmp"),
        b"half",
    )
    .unwrap();
    assert_eq!(cas.reclaim(&keep).unwrap(), 1);
    assert_eq!(names(&root), keep);
}

#[test]
fn reclaim_tolerates_a_kept_hash_that_is_missing() {
    let (root, cas) = store();
    let kept = cas.write_blob(b"a").unwrap();
    let missing = "0".repeat(64);
    assert_eq!(cas.reclaim(&[kept.clone(), missing]).unwrap(), 0);
    assert_eq!(names(&root), vec![kept]);
}
