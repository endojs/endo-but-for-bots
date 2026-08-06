//! The store-backed checkpoint acceptance locks (store seam design,
//! phase 2): after any checkpoint the store equals the live machine
//! exactly; incremental commits write only the dirty rows; a resume
//! from the store continues result AND computron count identically to
//! an uninterrupted machine; and the session/store pairing guards fail
//! closed. Every machine-level lock runs against both reference
//! backends (memory and file) — the parity every future backend
//! (SQLite daemon-side) must also meet.

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, MachineSnapshot,
};
use ironhorse_snapshot::store::{
    export_to_container, slot_page_count, store_to_image, HeapStore, MemoryStore, StoreError,
};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

// The captured oracle bytecodes the blob-path suspend/resume tests use
// (`src/machine.rs`): PROG_A completes "6", PROG_B completes "1".
const PROG_A: [u8; 44] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
    0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
    0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
];
const PROG_B: [u8; 51] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x1c, 0x0b, 0x00, 0xe0, 0x38, 0x00, 0x00,
    0x2e, 0x06, 0x0b, 0x00, 0x72, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00,
    0x72, 0x04, 0x28, 0xab, 0x00, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72,
    0x04, 0x28, 0xab, 0x00, 0xbb, 0xa9,
];

fn file_store(name: &str) -> (FileStore, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("ironhorse-store-checkpoint-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    (FileStore::open(dir.join("heap.ihstore")).unwrap(), dir)
}

/// The central invariant: after every checkpoint — full or incremental
/// — reading the whole store back yields exactly the live machine's
/// snapshot image, and the store's canonical export is byte-identical
/// to the blob the machine itself would write.
fn store_tracks_live_machine(store: &mut dyn HeapStore) {
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin_store_session(&mut m, &sig(), store).expect("full first write");
    assert_eq!(session.epoch(), 1);
    assert_eq!(store_to_image(store).unwrap(), m.snapshot_image(&sig()));
    assert_eq!(
        export_to_container(store).unwrap(),
        m.write_snapshot(&sig()),
        "store export byte-equals the machine's own blob"
    );

    assert!(m.run(&PROG_B).completed);
    let epoch = checkpoint_to_store(&mut session, &mut m, &sig(), store).expect("incremental");
    assert_eq!(epoch, 2);
    assert_eq!(store_to_image(store).unwrap(), m.snapshot_image(&sig()));
    assert_eq!(export_to_container(store).unwrap(), m.write_snapshot(&sig()));
}

#[test]
fn store_tracks_live_machine_memory() {
    let mut store = MemoryStore::new();
    store_tracks_live_machine(&mut store);
}

#[test]
fn store_tracks_live_machine_file() {
    let (mut store, dir) = file_store("tracks");
    store_tracks_live_machine(&mut store);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The incrementality bar, measured: the second checkpoint writes
/// strictly fewer slot pages than the store holds (only the dirty
/// ones), and a checkpoint with nothing dirty writes zero rows — while
/// both still leave the store exactly equal to the live machine.
#[test]
fn incremental_checkpoint_writes_only_dirty_rows() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin_store_session(&mut m, &sig(), &mut store).unwrap();
    let total_pages = slot_page_count(store.manifest().unwrap().slot_count) as usize;
    assert_eq!(
        store.last_commit_stats().slot_pages_written,
        total_pages,
        "the first write is full by construction"
    );

    assert!(m.run(&PROG_B).completed);
    checkpoint_to_store(&mut session, &mut m, &sig(), &mut store).unwrap();
    let stats = store.last_commit_stats();
    assert!(
        stats.slot_pages_written > 0,
        "crank B allocated, so something is dirty"
    );
    let total_pages = slot_page_count(store.manifest().unwrap().slot_count) as usize;
    assert!(
        stats.slot_pages_written < total_pages,
        "an incremental commit must not rewrite the whole heap: wrote {} of {}",
        stats.slot_pages_written,
        total_pages
    );
    assert_eq!(store_to_image(&store).unwrap(), m.snapshot_image(&sig()));

    // Nothing ran since: a third checkpoint carries zero dirty rows
    // (manifest + small state only) and the store still agrees.
    checkpoint_to_store(&mut session, &mut m, &sig(), &mut store).unwrap();
    let stats = store.last_commit_stats();
    assert_eq!(stats.slot_pages_written, 0, "no false dirt");
    assert_eq!(stats.chunk_extents_written, 0, "no false dirt");
    assert_eq!(store_to_image(&store).unwrap(), m.snapshot_image(&sig()));
}

/// The row-6 bar through the store: crank A, checkpoint, resume from
/// the store, crank B — result and final computron count equal the
/// uninterrupted machine's, on both backends.
fn resume_equals_uninterrupted(store: &mut dyn HeapStore) {
    let mut uninterrupted = Interp::new();
    assert!(uninterrupted.run(&PROG_A).completed);
    let ub = uninterrupted.run(&PROG_B);
    assert!(ub.completed);

    let mut m1 = Interp::new();
    assert!(m1.run(&PROG_A).completed);
    let session = begin_store_session(&mut m1, &sig(), store).unwrap();
    drop(m1); // the suspended worker's machine is gone

    let (mut m2, resumed) = resume_from_store(store, &sig()).expect("resumes");
    assert_eq!(resumed.epoch(), session.epoch());
    let b2 = m2.run(&PROG_B);
    assert_eq!(b2.result, ub.result, "result equals the uninterrupted run");
    assert_eq!(
        b2.computrons, ub.computrons,
        "computron count equals the uninterrupted run (meter continued)"
    );
}

#[test]
fn resume_equals_uninterrupted_memory() {
    let mut store = MemoryStore::new();
    resume_equals_uninterrupted(&mut store);
}

#[test]
fn resume_equals_uninterrupted_file() {
    let (mut store, dir) = file_store("resume");
    resume_equals_uninterrupted(&mut store);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A resumed session continues checkpointing incrementally: resume,
/// run another crank, checkpoint — the store follows the resumed
/// machine, across a file-store reopen (the suspended-worker
/// lifecycle end to end).
#[test]
fn resumed_session_checkpoints_incrementally_across_reopen() {
    let (mut store, dir) = file_store("lifecycle");
    let path = dir.join("heap.ihstore");

    let mut m1 = Interp::new();
    assert!(m1.run(&PROG_A).completed);
    begin_store_session(&mut m1, &sig(), &mut store).unwrap();
    drop(m1);
    drop(store);

    let store = FileStore::open(&path).unwrap();
    let (mut m2, mut session) = resume_from_store(&store, &sig()).unwrap();
    let mut store = store;
    assert!(m2.run(&PROG_B).completed);
    let epoch = checkpoint_to_store(&mut session, &mut m2, &sig(), &mut store).unwrap();
    assert_eq!(epoch, 2);
    assert_eq!(store_to_image(&store).unwrap(), m2.snapshot_image(&sig()));

    // And the final state survives one more reopen.
    drop(store);
    let store = FileStore::open(&path).unwrap();
    assert_eq!(store_to_image(&store).unwrap(), m2.snapshot_image(&sig()));
    let _ = std::fs::remove_dir_all(&dir);
}

/// Binding a machine to a store that already holds an epoch is refused
/// — resume is the adoption path, and a silent overwrite would discard
/// a heap.
#[test]
fn begin_on_a_nonempty_store_is_refused() {
    let mut store = MemoryStore::new();
    let mut m1 = Interp::new();
    assert!(m1.run(&PROG_A).completed);
    begin_store_session(&mut m1, &sig(), &mut store).unwrap();

    let mut m2 = Interp::new();
    assert_eq!(
        begin_store_session(&mut m2, &sig(), &mut store).unwrap_err(),
        StoreError::NotEmpty { epoch: 1 }
    );
}

/// A session may only checkpoint into the store holding its own
/// previous epoch: a fresh (empty) store and a store advanced by
/// another session both fail closed, so a dirty set can never land on
/// the wrong baseline.
#[test]
fn checkpoint_pairing_guards_fail_closed() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin_store_session(&mut m, &sig(), &mut store).unwrap();

    // Wrong store: empty.
    let mut other = MemoryStore::new();
    assert_eq!(
        checkpoint_to_store(&mut session, &mut m, &sig(), &mut other).unwrap_err(),
        StoreError::Empty
    );

    // Wrong store: advanced past the session by someone else.
    let (mut m2, mut session2) = resume_from_store(&store, &sig()).unwrap();
    checkpoint_to_store(&mut session2, &mut m2, &sig(), &mut store).unwrap();
    assert_eq!(
        checkpoint_to_store(&mut session, &mut m, &sig(), &mut store).unwrap_err(),
        StoreError::EpochMismatch {
            expected: 1,
            found: 2
        }
    );
}

/// A resume from a store that was checkpointed incrementally reads the
/// merged state — dirty rows over preserved rows — not just the last
/// batch (guards against a backend that forgets clean rows).
#[test]
fn resume_after_incremental_checkpoint_reads_merged_state() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin_store_session(&mut m, &sig(), &mut store).unwrap();
    assert!(m.run(&PROG_B).completed);
    checkpoint_to_store(&mut session, &mut m, &sig(), &mut store).unwrap();

    let (m2, _) = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(m2.meter_state(), m.meter_state());
    assert_eq!(m2.write_snapshot(&sig()), m.write_snapshot(&sig()));
}
