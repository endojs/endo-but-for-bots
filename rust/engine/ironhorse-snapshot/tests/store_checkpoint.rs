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
    image_to_batch, seal_commit, slot_page_count, store_to_image, CheckpointBatch, HeapStore,
    MemoryStore, StoreError,
};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

mod common;

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

fn file_store(name: &str) -> (FileStore, common::TempDir) {
    let dir = common::TempDir::new(&format!("ironhorse-store-checkpoint-{name}"));
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
    let (mut store, _dir) = file_store("tracks");
    ironhorse_snapshot::store_suite::checkpoint_acceptance(&mut store);
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
        session.machine().snapshot_image(&sig()).expect("gated image")
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
    let (mut store, _dir) = file_store("resume");
    ironhorse_snapshot::store_suite::resume_equals_uninterrupted(&mut store);
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
    let expected = session.machine().snapshot_image(&sig()).expect("gated image");
    assert_eq!(store_to_image(&store).unwrap(), expected);

    drop(store);
    let store = FileStore::open(&path).unwrap();
    assert_eq!(store_to_image(&store).unwrap(), expected);
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
}

/// A replayed full batch (import shape) into a non-empty store is
/// refused by succession, exactly as before.
#[test]
fn replayed_batch_is_refused() {
    let mut store = MemoryStore::new();
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let image = m.snapshot_image(&sig()).expect("gated image");
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
        s2.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots")
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
    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        self.inner.borrow().leaf_hashes()
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.inner.borrow().page_edges()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.borrow().read_free_seg(seg)
    }
    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        self.inner.borrow().free_leaf_hashes()
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
    let batch2 = image_to_batch(&session.machine().snapshot_image(&sig()).expect("gated image"), 2, &seal1);
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


/// The two seal findings from the third review pass, locked: a seal
/// binds the COMPLETE manifest identity (same rows under a different
/// host signature seal differently), and a batch whose seal does not
/// hash its own contents is refused before any backend persists it.
#[test]
fn seal_binds_full_manifest_identity_and_forgeries_are_refused() {
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let image = m.snapshot_image(&sig()).expect("gated image");
    let batch = image_to_batch(&image, 1, "");

    let mut foreign = batch.manifest.clone();
    foreign.signature = Signature::new("some-other-host-v9");
    let foreign_seal = seal_commit(
        "",
        &foreign,
        &batch.small,
        &batch.slot_pages,
        &batch.chunk_extents,
        &batch.free_segs,
        &batch.page_edges,
    );
    assert_ne!(
        batch.manifest.seal, foreign_seal,
        "identical rows under a different signature must not share a seal"
    );

    let mut forged = image_to_batch(&image, 1, "");
    forged.manifest.seal = batch.manifest.seal.clone();
    forged.slot_pages[0].1[0] ^= 0xff; // content no longer matches the seal
    let mut store = MemoryStore::new();
    match store.commit(&forged) {
        Err(StoreError::BaselineMismatch { .. }) => {}
        other => panic!("expected forged-seal refusal, got {other:?}"),
    }
}

/// Phase 5 acceptance: the row-hash tree discharges named integrity
/// limitation 1 — a length-preserving byte flip at rest can no longer
/// resume a different machine. A flipped ROW byte fails closed at the
/// point of read (eager resume error; lazy fault dies as the named
/// panic), and a flipped LEAF byte fails closed at open (the leaves no
/// longer recombine to the sealed root).
#[test]
fn length_preserving_flip_at_rest_fails_closed() {
    let (mut store, dir) = file_store("integrity");
    let path = dir.join("heap.ihstore");
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    drop(begin(m, &mut store));
    drop(store);
    let pristine = std::fs::read(&path).unwrap();

    // 1. Flip the file's LAST byte — blob content (blobs are the tail
    //    of the layout), so the store still loads structurally.
    let mut flipped = pristine.clone();
    *flipped.last_mut().unwrap() ^= 0xff;
    std::fs::write(&path, &flipped).unwrap();
    let store = FileStore::open(&path).expect("structural load still succeeds");
    match resume_from_store(&store, &sig()) {
        Err(_) => {}
        Ok(_) => panic!("eager resume must refuse a flipped row byte"),
    }

    // The same flip under LAZY resume dies at the fault that reads the
    // row, as the named leaf-hash panic — never a different machine.
    let shared = std::rc::Rc::new(std::cell::RefCell::new(FileStore::open(&path).unwrap()));
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let session = resume_from_store_lazy(shared.clone(), &sig())?;
        let manifest = shared.borrow().manifest().unwrap();
        for ext in 0..ironhorse_snapshot::store::chunk_extent_count(manifest.chunk_len) {
            session.machine().chunks.touch_extent(ext);
        }
        for page in 0..slot_page_count(manifest.slot_count) {
            session.machine().slots.touch_page(page);
        }
        Ok::<(), StoreError>(())
    }));
    match outcome {
        Err(payload) => {
            let msg = payload.downcast_ref::<String>().map(String::as_str).unwrap_or("");
            assert!(
                msg.contains("fails its leaf hash"),
                "expected the named leaf-hash panic, got: {msg}"
            );
        }
        Ok(Err(_)) => {} // refused before attach: equally fail-closed
        Ok(Ok(())) => panic!("lazy resume must not serve a flipped row byte"),
    }

    // 2. Flip a byte inside the LEAF-HASH region: refused at open
    //    (leaves no longer recombine to the sealed root).
    let be32 = |b: &[u8], at: usize| u32::from_be_bytes(b[at..at + 4].try_into().unwrap()) as usize;
    let mlen = be32(&pristine, 8);
    let slen = be32(&pristine, 12 + mlen);
    let counts_at = 12 + mlen + 4 + slen;
    let n_pages = be32(&pristine, counts_at);
    let n_exts = be32(&pristine, counts_at + 4);
    let leaves_at = counts_at + 8 + 12 * (n_pages + n_exts);
    let mut leaf_flipped = pristine.clone();
    leaf_flipped[leaves_at] ^= 0xff;
    std::fs::write(&path, &leaf_flipped).unwrap();
    let store = FileStore::open(&path).expect("structural load still succeeds");
    match resume_from_store(&store, &sig()) {
        Err(_) => {}
        Ok(_) => panic!("a flipped leaf hash must fail closed at open"),
    }

}

/// Phase 6: reachability over the persisted summaries is answered
/// entirely from indexed metadata — ZERO row-content reads. This is
/// the substrate for GC-shaped questions as store queries.
#[test]
fn reachability_query_reads_no_row_content() {
    use std::cell::Cell;

    struct CountingStore {
        inner: MemoryStore,
        content_reads: Cell<u32>,
    }
    impl HeapStore for CountingStore {
        fn manifest(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
            self.inner.manifest()
        }
        fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
            self.inner.read_small_state()
        }
        fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
            self.content_reads.set(self.content_reads.get() + 1);
            self.inner.read_slot_page(page)
        }
        fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
            self.content_reads.set(self.content_reads.get() + 1);
            self.inner.read_chunk_extent(ext)
        }
        fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
            self.inner.inventory()
        }
        fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
            self.inner.leaf_hashes()
        }
        fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
            self.inner.page_edges()
        }
        fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
            self.inner.read_free_seg(seg)
        }
        fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
            self.inner.free_leaf_hashes()
        }
        fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
            self.inner.commit(batch)
        }
    }

    let mut store = CountingStore {
        inner: MemoryStore::new(),
        content_reads: Cell::new(0),
    };
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    drop(begin(m, &mut store));

    store.content_reads.set(0);
    let reached =
        ironhorse_snapshot::store::reachable_pages(&store, [0u32]).expect("query succeeds");
    assert!(!reached.is_empty(), "page 0 reaches itself at least");
    assert_eq!(
        store.content_reads.get(),
        0,
        "reachability must be answered from summaries alone"
    );
}

/// Phase 8 review regression: a row the session ITSELF committed is
/// clean again — evictable — and its re-fault must verify against the
/// leaves that commit refreshed, at the committed geometry. Frozen
/// attach-time leaves would misdiagnose the healthy re-fault as
/// "corrupt store"; frozen attach-time geometry would fail the tail
/// row's length assert once the heap grew. Sequence: lazy resume →
/// mutate + grow → checkpoint → evict everything → re-fault
/// everything (write_snapshot) and demand byte equality.
#[test]
fn evict_after_own_checkpoint_refaults_cleanly() {
    use ironhorse_snapshot::store::chunk_extent_count;
    use ironhorse_vm::{Slot, SLOTS_PER_PAGE};
    use std::cell::RefCell;
    use std::rc::Rc;

    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let session = begin(m, &mut *store.borrow_mut());
    drop(session);

    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    assert!(session.machine_mut().run(&PROG_B).completed);
    // Grow well past the attach-time tail page so the committed tail
    // row is longer than the attach-time one — the geometry half of
    // the finding.
    for _ in 0..(2 * SLOTS_PER_PAGE + 17) {
        session.machine_mut().slots.alloc(Slot::integer(7));
    }
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");

    // Reference bytes, faulting everything in (all rows resident).
    let expect = session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots");

    // Evict every clean row — including the rows the checkpoint just
    // rewrote and the pages appended past the attach range.
    let manifest = store.borrow().manifest().unwrap();
    let mut evictions = 0u32;
    for page in 0..slot_page_count(manifest.slot_count) {
        evictions += session.machine().slots.evict_page(page) as u32;
    }
    for ext in 0..chunk_extent_count(manifest.chunk_len) {
        evictions += session.machine().chunks.evict_extent(ext) as u32;
    }
    assert!(evictions > 0, "nothing was evicted — the regression is untested");

    // Every re-fault must verify against the REFRESHED leaves at the
    // COMMITTED geometry and reinstall identical content.
    assert_eq!(
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        expect,
        "post-commit eviction re-faults reinstall the committed bytes"
    );
}

/// Review wave 5: the same sequence with the checkpoint going into a
/// TWIN store instead of the pinned one. The wave-4 guard covered the
/// appended TAIL of exactly this state and left the backed BODY.
///
/// A twin commit clears the dirty bits — the twin does hold the bytes —
/// while the PINNED store, which every fault reads, still holds the old
/// ones. A page modified during the crank therefore looked clean, and
/// therefore evictable, and its re-fault silently reverted it. Eviction
/// is supposed to be observationally irrelevant, so the image must be
/// identical whether or not the sweep ran.
///
/// Bite check: with `clear_dirty_after_commit`'s twin case reverted to
/// a plain dirty clear, the post-sweep image differs from the reference.
#[test]
fn evict_after_a_twin_store_checkpoint_keeps_the_modified_body() {
    use ironhorse_snapshot::store::chunk_extent_count;
    use std::cell::RefCell;
    use std::rc::Rc;

    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    let session = begin(m, &mut *store.borrow_mut());
    drop(session);

    // Resume against `store` — that is the PIN, and every fault reads
    // it. The checkpoint below goes somewhere else.
    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    assert!(session.machine_mut().run(&PROG_B).completed);
    // Modify records the store ALREADY backs, so the divergence is in
    // the body rather than in an appended tail. Rewriting record 0 of
    // every attach-time page guarantees at least one such page.
    let backed_pages = slot_page_count(store.borrow().manifest().unwrap().slot_count);
    for page in 0..backed_pages {
        let idx = ironhorse_vm::SlotIndex(page * ironhorse_vm::SLOTS_PER_PAGE);
        session.machine_mut().slots.get_mut(idx).id = 0;
        session.machine_mut().slots.get_mut(idx).value =
            ironhorse_vm::Payload::Integer(0x5EED + page as i32);
    }

    // The twin is a byte-identical copy of the pinned store, so the
    // commit succeeds on succession — it is a legitimate operation, and
    // the pin deliberately stays put.
    let mut twin = MemoryStore::new();
    twin.commit(&image_to_batch(
        &store_to_image(&*store.borrow()).expect("export the pinned store"),
        1,
        "",
    ))
    .expect("seed the twin");
    checkpoint_to_store(&mut session, &sig(), &mut twin).expect("twin checkpoint");

    // Reference bytes with everything resident.
    let expect = session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots");

    let manifest = store.borrow().manifest().unwrap();
    let mut evictions = 0u32;
    for page in 0..slot_page_count(manifest.slot_count) {
        evictions += session.machine().slots.evict_page(page) as u32;
    }
    for ext in 0..chunk_extent_count(manifest.chunk_len) {
        evictions += session.machine().chunks.evict_extent(ext) as u32;
    }
    // Some rows are untouched and still evictable, so the sweep is not
    // vacuously refused; what must not happen is losing the edits.
    let _ = evictions;

    assert_eq!(
        session.machine().write_snapshot(&sig()).expect("quiescent machine snapshots"),
        expect,
        "an evict sweep after a twin-store checkpoint must not revert the body"
    );
}

/// A store wrapper whose next `commit` fails with an injected I/O
/// error AFTER the shared verification would have passed — the
/// durable-write failure a real backend can hit at any time.
struct FailOnceStore {
    inner: MemoryStore,
    fail_next: std::cell::Cell<bool>,
}

impl HeapStore for FailOnceStore {
    fn manifest(&self) -> Result<ironhorse_snapshot::store::StoreManifest, StoreError> {
        self.inner.manifest()
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.inner.read_small_state()
    }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_slot_page(page)
    }
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_chunk_extent(ext)
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        self.inner.inventory()
    }
    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        self.inner.leaf_hashes()
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.inner.page_edges()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_free_seg(seg)
    }
    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        self.inner.free_leaf_hashes()
    }
    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
        if self.fail_next.replace(false) {
            return Err(StoreError::Io("injected commit failure".to_string()));
        }
        self.inner.commit(batch)
    }
}

/// V6-c recovery lock: a failed commit drops the session's root
/// ledger (never advancing it past a store that did not move), the
/// NEXT checkpoint takes the slow path — stored-metadata read,
/// laundering pre-verify, full recombination — and succeeds, and the
/// one after that is back on the fast path. Every surviving epoch
/// must validate and resume identically to an unbroken history.
#[test]
fn checkpoint_recovers_through_a_failed_commit() {
    let mut store = FailOnceStore {
        inner: MemoryStore::new(),
        fail_next: std::cell::Cell::new(false),
    };
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin(m, &mut store);

    // Injected failure: the machine keeps its dirt, the store keeps
    // its epoch, and the session must NOT have advanced.
    assert!(session.machine_mut().run(&PROG_B).completed);
    store.fail_next.set(true);
    match checkpoint_to_store(&mut session, &sig(), &mut store) {
        Err(StoreError::Io(msg)) => assert_eq!(msg, "injected commit failure"),
        other => panic!("expected the injected failure, got {other:?}"),
    }
    assert_eq!(store.manifest().unwrap().epoch, 1, "store did not move");
    assert_eq!(session.epoch(), 1, "session did not move");

    // Slow-path retry: the SAME dirt commits (nothing was cleared by
    // the failure), the ledger rebuilds, and the store equals the
    // machine exactly.
    let epoch = checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    assert_eq!(epoch, 2);
    assert_eq!(
        store_to_image(&store).unwrap(),
        session.machine().snapshot_image(&sig()).expect("gated image"),
        "retried checkpoint equals the live machine"
    );

    // Fast path again on the next crank; the chain stays valid and
    // resumable.
    assert!(session.machine_mut().run(&PROG_A).completed);
    let epoch = checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    assert_eq!(epoch, 3);
    ironhorse_snapshot::store::validate_store(&store, &sig()).unwrap();
    let resumed = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(
        resumed.machine().snapshot_image(&sig()).expect("gated image"),
        session.machine().snapshot_image(&sig()).expect("gated image"),
        "a resume sees exactly the recovered history"
    );
}
