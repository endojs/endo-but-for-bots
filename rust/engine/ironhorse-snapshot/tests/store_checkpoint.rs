//! The store-backed checkpoint acceptance locks (store seam design,
//! phase 2, revised by the adversarial review): after any checkpoint
//! the store equals the bound machine exactly; incremental commits
//! write only the dirty rows; a resume from the store continues result
//! AND computron count identically to an uninterrupted machine; and
//! the succession guards (epoch + commit-seal lineage, owning
//! sessions) fail closed. Machine-level locks run against both
//! reference backends.

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, resume_from_store_lazy,
    MachineSnapshot, StoreSession,
};
use ironhorse_snapshot::store::{
    image_to_batch, slot_page_count, store_to_image, CheckpointBatch, HeapStore, MemoryStore,
    StoreError,
};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

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

fn begin(m: Interp, store: &mut dyn HeapStore) -> StoreSession {
    begin_store_session(m, &sig(), store).map_err(|(_, e)| panic!("begin: {e:?}")).unwrap()
}

/// The central invariant and the row-6 bar now live in the shared
/// backend-parameterized suite (`ironhorse_snapshot::store_suite`), so
/// the SQLite backend runs the identical locks; these tests
/// instantiate it for the two reference backends.
#[test]
fn store_tracks_live_machine_memory() {
    let mut store = MemoryStore::new();
    ironhorse_snapshot::store_suite::checkpoint_acceptance(&mut store);
}

#[test]
fn store_tracks_live_machine_file() {
    let (mut store, dir) = file_store("tracks");
    ironhorse_snapshot::store_suite::checkpoint_acceptance(&mut store);
    let _ = std::fs::remove_dir_all(&dir);
}

/// The incrementality bar, measured exactly as before the session
/// refactor.
#[test]
fn incremental_checkpoint_writes_only_dirty_rows() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin(m, &mut store);
    let total_pages = slot_page_count(store.manifest().unwrap().slot_count) as usize;
    assert_eq!(store.last_commit_stats().slot_pages_written, total_pages);

    assert!(session.machine_mut().run(&PROG_B).completed);
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    let stats = store.last_commit_stats();
    assert!(stats.slot_pages_written > 0);
    let total_pages = slot_page_count(store.manifest().unwrap().slot_count) as usize;
    assert!(
        stats.slot_pages_written < total_pages,
        "wrote {} of {}",
        stats.slot_pages_written,
        total_pages
    );
    assert_eq!(
        store_to_image(&store).unwrap(),
        session.machine().snapshot_image(&sig())
    );

    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    let stats = store.last_commit_stats();
    assert_eq!(stats.slot_pages_written, 0, "no false dirt");
    assert_eq!(stats.chunk_extents_written, 0, "no false dirt");
}

#[test]
fn resume_equals_uninterrupted_memory() {
    let mut store = MemoryStore::new();
    ironhorse_snapshot::store_suite::resume_equals_uninterrupted(&mut store);
}

#[test]
fn resume_equals_uninterrupted_file() {
    let (mut store, dir) = file_store("resume");
    ironhorse_snapshot::store_suite::resume_equals_uninterrupted(&mut store);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Resume, run, checkpoint incrementally, across file-store reopens.
#[test]
fn resumed_session_checkpoints_incrementally_across_reopen() {
    let (mut store, dir) = file_store("lifecycle");
    let path = dir.join("heap.ihstore");

    let mut m1 = Interp::new();
    assert!(m1.run(&PROG_A).completed);
    drop(begin(m1, &mut store));
    drop(store);

    let mut store = FileStore::open(&path).unwrap();
    let mut session = resume_from_store(&store, &sig()).unwrap();
    assert!(session.machine_mut().run(&PROG_B).completed);
    let epoch = checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    assert_eq!(epoch, 2);
    let expected = session.machine().snapshot_image(&sig());
    assert_eq!(store_to_image(&store).unwrap(), expected);

    drop(store);
    let store = FileStore::open(&path).unwrap();
    assert_eq!(store_to_image(&store).unwrap(), expected);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Binding to a non-empty store is refused, and the machine is handed
/// back intact.
#[test]
fn begin_on_a_nonempty_store_is_refused() {
    let mut store = MemoryStore::new();
    let mut m1 = Interp::new();
    assert!(m1.run(&PROG_A).completed);
    drop(begin(m1, &mut store));

    let m2 = Interp::new();
    match begin_store_session(m2, &sig(), &mut store) {
        Err((returned, StoreError::NotEmpty { epoch: 1 })) => {
            // The machine survives the refusal.
            let _ = returned.meter_state();
        }
        Err((_, e)) => panic!("expected NotEmpty, got {e:?}"),
        Ok(_) => panic!("expected NotEmpty, got a session"),
    }
}

/// The succession guards: a session may only checkpoint into the store
/// holding its own previous commit — wrong store (empty), advanced
/// store (epoch), and equal-epoch foreign store (seal) all fail closed.
#[test]
fn checkpoint_pairing_guards_fail_closed() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin(m, &mut store);

    // Wrong store: empty.
    let mut other = MemoryStore::new();
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut other).unwrap_err(),
        StoreError::Empty
    );

    // Equal-epoch FOREIGN store: a different machine's epoch-1 store.
    // The bare epoch matches the session; the seal lineage does not
    // (the adversarial review's fork finding).
    let mut foreign = MemoryStore::new();
    let mut fm = Interp::new();
    assert!(fm.run(&PROG_B).completed);
    drop(begin(fm, &mut foreign));
    match checkpoint_to_store(&mut session, &sig(), &mut foreign) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected BaselineMismatch on a foreign equal-epoch store, got {other:?}"),
    }

    // Advanced store: another session moved it past this session.
    let mut s2 = resume_from_store(&store, &sig()).unwrap();
    checkpoint_to_store(&mut s2, &sig(), &mut store).unwrap();
    assert_eq!(
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap_err(),
        StoreError::EpochMismatch {
            expected: 1,
            found: 2
        }
    );
}

/// A copied store file is a fork: after the original advances, a
/// session over the copy cannot checkpoint into the original even when
/// the epochs align (the file-copy split-brain the review traced).
#[test]
fn forked_file_store_fails_closed_on_seal() {
    let (mut store, dir) = file_store("fork");
    let path = dir.join("heap.ihstore");
    let copy_path = dir.join("copy.ihstore");

    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin(m, &mut store);
    std::fs::copy(&path, &copy_path).unwrap();

    // Both lineages advance once with DIFFERENT cranks: equal heights,
    // divergent content, divergent seals. (An identical-content fork
    // has an identical seal and converges harmlessly — the states are
    // indistinguishable; only divergence is the corruption case.)
    assert!(session.machine_mut().run(&PROG_B).completed);
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();

    let mut copy = FileStore::open(&copy_path).unwrap();
    let mut copy_session = resume_from_store(&copy, &sig()).unwrap();
    assert!(copy_session.machine_mut().run(&PROG_A).completed);
    checkpoint_to_store(&mut copy_session, &sig(), &mut copy).unwrap();

    // The copy's session lands on the ORIGINAL: epoch aligns (2 == 2),
    // the seal does not.
    match checkpoint_to_store(&mut copy_session, &sig(), &mut store) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected BaselineMismatch across the fork, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Two handles on one path: the slower handle's commit must fail
/// closed against the durable file, not silently rename over the
/// faster handle's checkpoint (the review's ping-pong finding).
#[test]
fn second_file_handle_cannot_clobber_a_commit() {
    let (mut store_a, dir) = file_store("two-handles");
    let path = dir.join("heap.ihstore");

    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session_a = begin(m, &mut store_a);

    // Handle B opens the same path and advances the durable file.
    let mut store_b = FileStore::open(&path).unwrap();
    let mut session_b = resume_from_store(&store_b, &sig()).unwrap();
    assert!(session_b.machine_mut().run(&PROG_B).completed);
    checkpoint_to_store(&mut session_b, &sig(), &mut store_b).unwrap();

    // Handle A's commit re-reads the durable file and refuses.
    assert!(session_a.machine_mut().run(&PROG_B).completed);
    match checkpoint_to_store(&mut session_a, &sig(), &mut store_a) {
        Err(StoreError::EpochMismatch { .. }) | Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected fail-closed on stale handle, got {other:?}"),
    }
    // B's checkpoint survives on disk.
    let reread = FileStore::open(&path).unwrap();
    assert_eq!(reread.manifest().unwrap().epoch, 2);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A replayed full batch (import shape) into a non-empty store is
/// refused by succession, exactly as before.
#[test]
fn replayed_batch_is_refused() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let image = m.snapshot_image(&sig());
    store.commit(&image_to_batch(&image, 1, "")).unwrap();
    assert_eq!(
        store.commit(&image_to_batch(&image, 1, "")).unwrap_err(),
        StoreError::EpochMismatch {
            expected: 2,
            found: 1
        }
    );
}

/// Resume reads merged state (dirty rows over preserved rows).
#[test]
fn resume_after_incremental_checkpoint_reads_merged_state() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin(m, &mut store);
    assert!(session.machine_mut().run(&PROG_B).completed);
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();

    let s2 = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(s2.machine().meter_state(), session.machine().meter_state());
    assert_eq!(
        s2.machine().write_snapshot(&sig()),
        session.machine().write_snapshot(&sig())
    );
}

/// A `HeapStore` that delegates to a [`MemoryStore`] and applies one
/// queued successor commit in the middle of a chosen operation — the
/// cross-connection interleaving a shared SQLite file permits, made
/// deterministic. `Validation` fires after serving the inventory read
/// (coherent reads, store advances immediately after); `SlotRead`
/// fires before serving a slot-page read (the served row belongs to
/// the successor epoch while the fault's pre-check saw the pinned
/// one).
struct InterleavingStore {
    inner: std::cell::RefCell<MemoryStore>,
    pending: std::cell::RefCell<Option<CheckpointBatch>>,
    fire_on: Interleave,
    /// Lazy resume itself faults pages while rebuilding the machine
    /// (`restore_snapshot_state`), so the row-read trigger stays
    /// disarmed until the test has a session in hand.
    armed: std::cell::Cell<bool>,
}

#[derive(PartialEq)]
enum Interleave {
    Validation,
    RowRead,
}

impl InterleavingStore {
    fn fire(&self) {
        if !self.armed.get() {
            return;
        }
        if let Some(batch) = self.pending.borrow_mut().take() {
            self.inner
                .borrow_mut()
                .commit(&batch)
                .expect("queued interleaved commit is a valid successor");
        }
    }
}

impl HeapStore for InterleavingStore {
    fn manifest(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
        self.inner.borrow().manifest()
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.inner.borrow().read_small_state()
    }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        if self.fire_on == Interleave::RowRead {
            self.fire();
        }
        self.inner.borrow().read_slot_page(page)
    }
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        if self.fire_on == Interleave::RowRead {
            self.fire();
        }
        self.inner.borrow().read_chunk_extent(ext)
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        let served = self.inner.borrow().inventory();
        if self.fire_on == Interleave::Validation {
            self.fire();
        }
        served
    }
    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
        self.inner.borrow_mut().commit(batch)
    }
}

/// Builds an epoch-1 store plus a queued valid epoch-2 successor batch
/// (same image, so only the lineage advances), wrapped to fire at the
/// chosen interleave point.
fn interleaving_store(fire_on: Interleave) -> InterleavingStore {
    let mut inner = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let session = begin(m, &mut inner);
    let seal1 = inner.manifest().unwrap().seal;
    let batch2 = image_to_batch(&session.machine().snapshot_image(&sig()), 2, &seal1);
    drop(session);
    let armed = fire_on == Interleave::Validation;
    InterleavingStore {
        inner: std::cell::RefCell::new(inner),
        pending: std::cell::RefCell::new(Some(batch2)),
        fire_on,
        armed: std::cell::Cell::new(armed),
    }
}

/// A commit landing between validation's reads and the arena attach
/// must fail the resume closed (the post-validation manifest
/// re-check), never seed a session or its fault pin from mixed epochs.
#[test]
fn lazy_resume_refuses_store_advanced_during_validation() {
    let store = std::rc::Rc::new(std::cell::RefCell::new(interleaving_store(
        Interleave::Validation,
    )));
    match resume_from_store_lazy(store, &sig()) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected baseline mismatch, got {other:?}"),
    }
}

/// A commit landing between a fault's pin pre-check and its row read
/// must die as the named torn-read panic (the post-read pin
/// re-check), never install a row from the successor epoch.
#[test]
fn lazy_fault_refuses_row_read_across_a_foreign_commit() {
    let store = std::rc::Rc::new(std::cell::RefCell::new(interleaving_store(
        Interleave::RowRead,
    )));
    let session =
        resume_from_store_lazy(store.clone(), &sig()).expect("resumes while store is quiet");
    let manifest = store.borrow().manifest().unwrap();
    store.borrow().armed.set(true);
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        // Touch every page and extent: whichever row the resume left
        // unfaulted trips the armed interleave first.
        for page in 0..slot_page_count(manifest.slot_count) {
            session.machine().slots.touch_page(page);
        }
        for ext in 0..ironhorse_snapshot::store::chunk_extent_count(manifest.chunk_len) {
            session.machine().chunks.touch_extent(ext);
        }
        panic!("machine was fully resident before the interleave could fire");
    }));
    let payload = outcome.expect_err("fault across a foreign commit must die");
    let msg = payload
        .downcast_ref::<String>()
        .map(String::as_str)
        .unwrap_or("");
    assert!(
        msg.contains("store advanced under this machine"),
        "expected the named torn-read panic, got: {msg}"
    );
}
