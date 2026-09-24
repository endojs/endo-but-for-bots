//! The store-backed checkpoint acceptance locks (store seam design,
//! phase 2, revised by the adversarial review): after any checkpoint
//! the store equals the bound machine exactly; incremental commits
//! write only the dirty rows; a resume from the store continues result
//! AND computron count identically to an uninterrupted machine; and
//! the succession guards (epoch + commit token, owning sessions) fail
//! closed. Machine-level locks run against both
//! reference backends.

use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, resume_from_store, resume_from_store_lazy,
    MachineSnapshot, StoreSession,
};
use ironhorse_snapshot::store::HeapStoreCommit;
use ironhorse_snapshot::store::{
    image_to_batch_unchecked, slot_page_count, store_to_image, HeapStore, MemoryStore, StoreError,
};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::CommitToken;
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

mod common;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

const PROG_A: [u8; 44] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01, 0x00,
    0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0,
    0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
];
const PROG_B: [u8; 51] = [
    0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x1c, 0x0b, 0x00, 0xe0, 0x38, 0x00, 0x00, 0x2e,
    0x06, 0x0b, 0x00, 0x72, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72, 0x04,
    0x28, 0xab, 0x00, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72, 0x04, 0x28, 0xab,
    0x00, 0xbb, 0xa9,
];

fn file_store(name: &str) -> (FileStore, common::TempDir) {
    let dir = common::TempDir::new(&format!("ironhorse-store-checkpoint-{name}"));
    (FileStore::open(dir.join("heap.ihstore")).unwrap(), dir)
}

fn begin(m: Interp, store: &mut dyn HeapStore) -> StoreSession {
    begin_store_session(m, &sig(), store)
        .map_err(|(_, e)| panic!("begin: {e:?}"))
        .unwrap()
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

#[test]
fn sparse_sections_match_full_snapshots_on_reference_backends() {
    ironhorse_snapshot::store_suite::sparse_section_acceptance(MemoryStore::new);
    let dir = common::TempDir::new("sparse-sections");
    let mut counter = 0;
    ironhorse_snapshot::store_suite::sparse_section_acceptance(|| {
        counter += 1;
        FileStore::open(dir.join(format!("heap-{counter}.ihstore"))).unwrap()
    });
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
        session
            .machine()
            .snapshot_image_for_testing(&sig())
            .expect("gated image")
    );

    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    let stats = store.last_commit_stats();
    assert_eq!(stats.slot_pages_written, 0, "no false dirt");
    assert_eq!(stats.chunk_extents_written, 0, "no false dirt");
    assert_eq!(stats.small_sections_written, 0, "no false section dirt");
    assert_eq!(
        stats.small_bytes_written, 0,
        "unchanged payloads stay in store"
    );
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
    let expected = session
        .machine()
        .snapshot_image_for_testing(&sig())
        .expect("gated image");
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
/// store (epoch), and equal-epoch foreign store (token) all fail closed.
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
    // The bare epoch matches the session; the commit token does not
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
fn forked_file_store_fails_closed_on_the_token() {
    let (mut store, dir) = file_store("fork");
    let path = dir.join("heap.ihstore");
    let copy_path = dir.join("copy.ihstore");

    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let mut session = begin(m, &mut store);
    std::fs::copy(&path, &copy_path).unwrap();

    // Both lineages advance once with DIFFERENT cranks: equal heights,
    // divergent content, divergent tokens. (Every commit mints its own
    // token, so even an identical-content fork diverges now; with the
    // retired seal, it converged.)
    assert!(session.machine_mut().run(&PROG_B).completed);
    checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();

    let mut copy = FileStore::open(&copy_path).unwrap();
    let mut copy_session = resume_from_store(&copy, &sig()).unwrap();
    assert!(copy_session.machine_mut().run(&PROG_A).completed);
    checkpoint_to_store(&mut copy_session, &sig(), &mut copy).unwrap();

    // The copy's session lands on the ORIGINAL: epoch aligns (2 == 2),
    // the token does not.
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
    let image = m.snapshot_image_for_testing(&sig()).expect("gated image");
    store
        .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
        .unwrap();
    assert_eq!(
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap_err(),
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
        s2.machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
        session
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots")
    );
}

/// The commit token pairs a batch with the store state it was built on and
/// says nothing about its content. Of two batches built on the same state,
/// the first commits and the second, whose predecessor is gone, is refused;
/// rebuilt on the current state, its changed content commits as given,
/// because the store keeps no digest a changed row could disagree with.
#[test]
fn a_batch_pairs_with_the_state_it_was_built_on() {
    let mut m = Interp::new();
    assert!(m.run(&PROG_A).completed);
    let image = m.snapshot_image_for_testing(&sig()).expect("gated image");
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
        .unwrap();
    let base = store.manifest().unwrap().token;
    let first = image_to_batch_unchecked(&image, 2, base);
    let mut second = image_to_batch_unchecked(&image, 3, base);
    *second.chunk_extents[0].1.last_mut().unwrap() ^= 1; // valid geometry, changed content
    store.commit(&first).unwrap();
    assert_eq!(
        store.commit(&second),
        Err(StoreError::BaselineMismatch {
            expected: first.manifest.token.to_hex(),
            found: base.to_hex(),
        })
    );
    assert_eq!(store.manifest().unwrap(), first.manifest);
    second.prev_token = first.manifest.token;
    store.commit(&second).unwrap();
    assert_eq!(
        store.read_chunk_extent(0).unwrap(),
        second.chunk_extents[0].1
    );
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
        fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
            self.inner.page_edges()
        }
        fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
            self.inner.read_free_seg(seg)
        }
        fn commit_verified(
            &mut self,
            verify: &mut ironhorse_snapshot::store::CommitVerifier<'_>,
        ) -> Result<(), StoreError> {
            self.inner.commit_verified(verify)
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
/// clean again — evictable — and its re-fault must read the committed
/// row at the committed geometry. A frozen attach-time geometry would
/// fail the tail row's length check once the heap grew. Sequence: lazy
/// resume → mutate + grow → checkpoint → evict everything → re-fault
/// everything (write_snapshot) and demand byte equality.
#[test]
fn evict_after_own_checkpoint_refaults_cleanly() {
    use ironhorse_snapshot::store::chunk_extent_count;
    use ironhorse_vm::{Opcode, SLOTS_PER_PAGE};
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
        assert!(
            session
                .machine_mut()
                .run(&[
                    Opcode::XS_CODE_OBJECT as u8,
                    Opcode::XS_CODE_POP as u8,
                    Opcode::XS_CODE_RETURN as u8
                ])
                .completed
        );
    }
    checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()).expect("checkpoint");

    // Reference bytes, faulting everything in (all rows resident).
    let expect = session
        .machine()
        .write_snapshot(&sig())
        .expect("quiescent machine snapshots");

    // Evict every clean row — including the rows the checkpoint just
    // rewrote and the pages appended past the attach range.
    let manifest = store.borrow().manifest().unwrap();
    let mut evictions = 0u32;
    for page in 0..slot_page_count(manifest.slot_count) {
        evictions += session.machine().slots().evict_page(page) as u32;
    }
    for ext in 0..chunk_extent_count(manifest.chunk_len) {
        evictions += session.machine().chunks().evict_extent(ext) as u32;
    }
    assert!(
        evictions > 0,
        "nothing was evicted — the regression is untested"
    );

    // Every re-fault reads the committed row at the COMMITTED geometry
    // and reinstalls identical content.
    assert_eq!(
        session
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
        expect,
        "post-commit eviction re-faults reinstall the committed bytes"
    );
}

/// A caller with a runnable machine can acknowledge a twin commit, but
/// cannot claim a pinned commit with an unrelated backing capability.
#[test]
fn unrelated_backing_authority_cannot_make_uncommitted_pages_evictable() {
    use ironhorse_vm::{BackingCommitAuthority, PageSource, Slot};
    use std::{cell::RefCell, rc::Rc};
    struct UnusedSource;
    impl PageSource for UnusedSource {
        fn slot_page(&self, _: u32) -> Vec<Slot> {
            panic!("no reads expected")
        }
        fn chunk_extent(&self, _: u32) -> Vec<u8> {
            panic!("no reads expected")
        }
    }
    let (code, names) =
        ironhorse_compile::compile_atoms("var item = { value: 7 }; item.value").unwrap();
    let mut machine = Interp::new();
    machine.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
    assert!(machine.run(&code).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(begin(machine, &mut *store.borrow_mut()));
    let mut session = resume_from_store_lazy(store.clone(), &sig()).unwrap();
    let (code, names) = ironhorse_compile::compile_atoms("item.value = 9; item.value").unwrap();
    let code = session
        .machine_mut()
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&names))
        .unwrap();
    assert_eq!(session.machine_mut().run(&code).result, "9");
    let dirty = session.machine().slots().dirty_pages();
    assert!(!dirty.is_empty());
    let (_, _, mut other) =
        BackingCommitAuthority::lazy_arenas(0, vec![], 0, 0, Rc::new(UnusedSource)).unwrap();
    assert!(session
        .machine_mut()
        .acknowledge_backing_commit(&mut other)
        .is_err());
    assert_eq!(session.machine().slots().dirty_pages(), dirty);
    session.machine_mut().acknowledge_arena_commit();
    for page in dirty {
        assert!(!session.machine().slots().evict_page(page));
    }
    let (code, names) = ironhorse_compile::compile_atoms("item.value").unwrap();
    let code = session
        .machine_mut()
        .relink_crank(&code, &ironhorse_vm::parse_symbols(&names))
        .unwrap();
    assert_eq!(session.machine_mut().run(&code).result, "9");
    assert_eq!(store.borrow().manifest().unwrap().epoch, 1);
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

    let (build, names) = ironhorse_compile::compile_atoms(
        "var backed = []; for (var i = 0; i < 2048; i++) backed.push({value: 7});",
    )
    .unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
    assert!(m.run(&build).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(begin(m, &mut *store.borrow_mut()));

    // Change properties distributed across the existing backed heap through
    // guest execution, rather than manufacturing malformed arena records.
    let mut session = resume_from_store_lazy(store.clone(), &sig()).expect("lazy resume");
    let (mutate, names) = ironhorse_compile::compile_atoms(
        "for (var i = 0; i < backed.length; i++) backed[i].value = 0x5eed + i;",
    )
    .unwrap();
    let code = session
        .machine_mut()
        .relink_crank(&mutate, &ironhorse_vm::parse_symbols(&names))
        .unwrap();
    assert!(session.machine_mut().run(&code).completed);
    let backed_pages = slot_page_count(store.borrow().manifest().unwrap().slot_count);
    assert!(
        session
            .machine()
            .slots()
            .dirty_pages()
            .iter()
            .filter(|&&page| page < backed_pages)
            .count()
            > 1
    );

    // The twin is a copy of the pinned store, commit token included, so
    // the commit succeeds on succession — it is a legitimate operation,
    // and the pin deliberately stays put.
    let mut twin = MemoryStore::new();
    let mut seed = image_to_batch_unchecked(
        &store_to_image(&*store.borrow()).expect("export the pinned store"),
        1,
        CommitToken::ZERO,
    );
    seed.manifest.token = store.borrow().manifest().unwrap().token;
    twin.commit(&seed).expect("seed the twin");
    checkpoint_to_store(&mut session, &sig(), &mut twin).expect("twin checkpoint");

    // Reference bytes with everything resident.
    let expect = session
        .machine()
        .write_snapshot(&sig())
        .expect("quiescent machine snapshots");

    let manifest = store.borrow().manifest().unwrap();
    let mut evictions = 0u32;
    for page in 0..slot_page_count(manifest.slot_count) {
        evictions += session.machine().slots().evict_page(page) as u32;
    }
    for ext in 0..chunk_extent_count(manifest.chunk_len) {
        evictions += session.machine().chunks().evict_extent(ext) as u32;
    }
    // Some rows are untouched and still evictable, so the sweep is not
    // vacuously refused; what must not happen is losing the edits.
    let _ = evictions;

    assert_eq!(
        session
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
        expect,
        "an evict sweep after a twin-store checkpoint must not revert the body"
    );
}

/// A machine unbound from a lazy session and bound to a new store stops
/// relying on the old one: `begin_store_session` faults every page in and
/// abandons the lazy backing, so no page or extent is evicted (a re-fault
/// would read the old store) and whatever happens to the old store later
/// cannot reach the machine. The page source's epoch pin used to fence
/// this case.
///
/// Bite check: without the `abandon_backing` call in `begin_store_core`
/// the clean faulted-in pages evict.
#[test]
fn rebinding_an_unbound_lazy_machine_abandons_its_old_backing() {
    use ironhorse_snapshot::store::{chunk_extent_count, export_to_container};
    use std::cell::RefCell;
    use std::rc::Rc;

    // Enough strings for several chunk extents.
    let pad = "x".repeat(100);
    let (build, names) = ironhorse_compile::compile_atoms(&format!(
        "var backed = []; for (var i = 0; i < 2048; i++) backed.push({{name: '{pad}' + i}});"
    ))
    .unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
    assert!(m.run(&build).completed);
    let old = Rc::new(RefCell::new(MemoryStore::new()));
    drop(begin(m, &mut *old.borrow_mut()));

    // Evict what the restore faulted in, so the rebind has rows of both
    // arenas to read from the old store.
    let lazy = resume_from_store_lazy(old.clone(), &sig()).expect("lazy resume");
    let manifest = old.borrow().manifest().unwrap();
    for page in 0..slot_page_count(manifest.slot_count) {
        let _ = lazy.machine().slots().evict_page(page);
    }
    for ext in 0..chunk_extent_count(manifest.chunk_len) {
        let _ = lazy.machine().chunks().evict_extent(ext);
    }
    let machine = lazy.into_machine();
    assert!(
        !machine.slots().is_fully_resident() && !machine.chunks().is_fully_resident(),
        "the rebind has pages and extents left to fault in"
    );
    let mut new = MemoryStore::new();
    let session = begin(machine, &mut new);
    let manifest = new.manifest().unwrap();
    for page in 0..slot_page_count(manifest.slot_count) {
        assert!(
            !session.machine().slots().evict_page(page),
            "page {page} no longer has a backing to re-fault from"
        );
    }
    for ext in 0..chunk_extent_count(manifest.chunk_len) {
        assert!(
            !session.machine().chunks().evict_extent(ext),
            "extent {ext} no longer has a backing to re-fault from"
        );
    }

    // The old store is emptied; nothing reads it again.
    *old.borrow_mut() = MemoryStore::new();
    assert_eq!(
        session
            .machine()
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots"),
        export_to_container(&new).expect("export the new store"),
    );
}

/// The rebind reads the machine in full from its old store; when that
/// store can no longer produce a row, the read unwinds as a store fault
/// carrying the old store's error, and the machine goes with it, instead
/// of returning half read beside an error that would name the new store.
#[test]
fn rebinding_a_machine_whose_old_store_fails_a_read_unwinds_with_that_stores_error() {
    use ironhorse_snapshot::machine::store_fault_of;
    use std::cell::RefCell;
    use std::rc::Rc;

    let (build, names) = ironhorse_compile::compile_atoms(
        "var backed = []; for (var i = 0; i < 2048; i++) backed.push({v: i});",
    )
    .unwrap();
    let mut m = Interp::new();
    m.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
    assert!(m.run(&build).completed);
    let (store, dir) = file_store("rebind-fault");
    let old = Rc::new(RefCell::new(store));
    drop(begin(m, &mut *old.borrow_mut()));
    let lazy = resume_from_store_lazy(old.clone(), &sig()).expect("lazy resume");
    let manifest = old.borrow().manifest().unwrap();
    let mut evicted = 0;
    for page in 0..slot_page_count(manifest.slot_count) {
        evicted += lazy.machine().slots().evict_page(page) as u32;
    }
    assert!(
        evicted > 0,
        "the rebind has pages to read from the old store"
    );
    let machine = lazy.into_machine();

    // Empty the old store's file under its open handle: every row read now
    // fails as I/O.
    std::fs::OpenOptions::new()
        .write(true)
        .open(dir.join("heap.ihstore"))
        .unwrap()
        .set_len(0)
        .unwrap();
    let mut new = MemoryStore::new();
    let payload = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        begin_store_session(machine, &sig(), &mut new)
            .map(drop)
            .map_err(|(_, error)| error)
    }))
    .expect_err("the failed read unwinds out of the rebind");
    match store_fault_of(payload) {
        Ok(StoreError::Io(_)) => {}
        Ok(other) => panic!("expected the old store's I/O error, got {other:?}"),
        Err(_) => panic!("expected a store fault"),
    }
    assert_eq!(
        new.manifest(),
        Err(StoreError::Empty),
        "nothing was committed"
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
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.inner.page_edges()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_free_seg(seg)
    }
    fn commit_verified(
        &mut self,
        verify: &mut ironhorse_snapshot::store::CommitVerifier<'_>,
    ) -> Result<(), StoreError> {
        if self.fail_next.replace(false) {
            return Err(StoreError::Io("injected commit failure".to_string()));
        }
        self.inner.commit_verified(verify)
    }
}

/// Recovery lock: a failed commit leaves the session where it was (never
/// advancing it past a store that did not move), so the NEXT checkpoint
/// re-offers the same dirt, sections and free-list suffix against the
/// unchanged store and succeeds, and so does the one after it. Every
/// surviving epoch must validate and resume identically to an unbroken
/// history.
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

    // Retry: the SAME dirt commits (nothing was cleared by the failure),
    // and the store equals the machine exactly.
    let epoch = checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    assert_eq!(epoch, 2);
    assert_eq!(
        store_to_image(&store).unwrap(),
        session
            .machine()
            .snapshot_image_for_testing(&sig())
            .expect("gated image"),
        "retried checkpoint equals the live machine"
    );

    // And again on the next crank; the chain stays valid and
    // resumable.
    assert!(session.machine_mut().run(&PROG_A).completed);
    let epoch = checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
    assert_eq!(epoch, 3);
    ironhorse_snapshot::store::validate_store_content(&store, &sig()).unwrap();
    let resumed = resume_from_store(&store, &sig()).unwrap();
    assert_eq!(
        resumed
            .machine()
            .snapshot_image_for_testing(&sig())
            .expect("gated image"),
        session
            .machine()
            .snapshot_image_for_testing(&sig())
            .expect("gated image"),
        "a resume sees exactly the recovered history"
    );
}

#[test]
fn replacing_a_lazy_sessions_machine_refuses_before_durable_commit() {
    use std::{cell::RefCell, rc::Rc};
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(begin(Interp::new(), &mut *store.borrow_mut()));
    let mut session = resume_from_store_lazy(store.clone(), &sig()).unwrap();
    let before = store_to_image(&*store.borrow()).unwrap();
    let epoch = session.epoch();
    *session.machine_mut() = Interp::new();
    assert!(matches!(
        checkpoint_to_store(&mut session, &sig(), &mut *store.borrow_mut()),
        Err(StoreError::Snapshot(
            ironhorse_snapshot::SnapshotError::Corrupt(
                "commit authority does not match the machine's backing"
            )
        ))
    ));
    assert_eq!(session.epoch(), epoch);
    assert_eq!(store.borrow().manifest().unwrap().epoch, epoch);
    assert_eq!(store_to_image(&*store.borrow()).unwrap(), before);
}
