//! Store seam hardening (design phase 4): seeded, deterministic
//! fuzz-shaped property tests. These are the runnable form of the
//! design's phase-4 fuzz arms — promotion into `ironhorse-fuzz`
//! cargo-fuzz targets (whose crate links the XS oracle and needs its
//! submodule + a libFuzzer toolchain) is mechanical once that
//! environment is available; the substance is here where CI runs it.
//!
//! Arms:
//! 1. **Malformed-store mutation sweep** — random single-byte
//!    corruptions and truncations of a committed `FileStore` file must
//!    fail closed with a structured error or decode to *something*,
//!    never panic (the decode-safety property; content-level
//!    corruption detection is the design's named open question, since
//!    rows are not individually checksummed).
//! 2. **Randomized mutate/checkpoint/restore schedules** — arbitrary
//!    interleavings of slot/chunk mutation, GC compaction, incremental
//!    checkpoint, and restore must keep the store byte-equal to the
//!    live arenas at every checkpoint (the dirty-tracking soundness
//!    property under schedules no hand-written test would compose).
//! 3. **Randomized fault schedules** — any lazy touch order over a
//!    committed store reifies to the identical image (the residency-
//!    schedule-irrelevance property at the arena level).
//! 4. **Dirty-fraction sweep** — the phase-2 bar made exact: touching
//!    k pages commits exactly k page rows, across the fraction range.
//!
//! All randomness is a seeded LCG: every run is reproducible from the
//! printed seed.

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::format::Signature;
use ironhorse_snapshot::image::{MachineImage, MeterImage};
use ironhorse_snapshot::store::{
    chunk_extent_count, image_to_batch, seal_commit, slot_page_count, store_to_image,
    validate_store, CheckpointBatch, HeapStore, MemoryStore, SmallState, StoreManifest,
    STORE_SCHEMA_VERSION,
};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::{Version, SLOT_RECORD_BYTES};
use ironhorse_vm::{
    Heap, Kind, PageSource, Payload, Slot, SlotArena, SlotIndex, CHUNK_EXTENT_BYTES,
};

mod common;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

/// A deterministic LCG (Knuth's MMIX constants); no external dep, no
/// wall-clock, every failure reproducible from the seed.
struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        (self.next() >> 16) % n.max(1)
    }
}

/// A live heap plus the shadow bookkeeping the schedule driver needs
/// to mutate it meaningfully (live slot indices, chunk-holding slots).
struct Machine {
    heap: Heap,
    live: Vec<SlotIndex>,
}

impl Machine {
    fn new() -> Machine {
        Machine {
            heap: Heap::new(),
            live: Vec::new(),
        }
    }

    fn image(&self, epoch_names: &[String]) -> MachineImage {
        MachineImage::from_arenas(
            sig(),
            &self.heap.slots,
            &self.heap.chunks,
            &[],
            epoch_names.to_vec(),
            Vec::new(),
            ironhorse_snapshot::image::SymbolKeyImage::default(),
        )
    }

    /// One random mutation step.
    fn step(&mut self, rng: &mut Lcg) {
        match rng.below(10) {
            // Allocate a plain slot.
            0..=2 => {
                let s = Slot::integer(rng.next() as i32);
                let idx = self.heap.slots.alloc(s);
                self.live.push(idx);
            }
            // Allocate a string slot with a random-sized chunk.
            3..=4 => {
                let len = rng.below(200) as usize + 1;
                let byte = (rng.next() & 0xff) as u8;
                let off = self.heap.chunks.alloc(&vec![byte; len]);
                let idx = self.heap.slots.alloc(Slot::of(Kind::String, Payload::String(off)));
                self.live.push(idx);
            }
            // Mutate a random live slot in place.
            5..=6 => {
                if !self.live.is_empty() {
                    let k = rng.below(self.live.len() as u64) as usize;
                    let idx = self.live[k];
                    let s = self.heap.slots.get_mut(idx);
                    if !matches!(s.value, Payload::String(_)) {
                        s.value = Payload::Integer(rng.next() as i32);
                    }
                    s.flag = (rng.next() & 0xff) as u8;
                }
            }
            // Free a random live slot.
            7 => {
                if self.live.len() > 1 {
                    let k = rng.below(self.live.len() as u64) as usize;
                    let idx = self.live.swap_remove(k);
                    self.heap.slots.free(idx);
                }
            }
            // Overwrite part of a random live string's chunk bytes.
            8 => {
                let strings: Vec<SlotIndex> = self
                    .live
                    .iter()
                    .copied()
                    .filter(|&i| matches!(self.heap.slots.get(i).value, Payload::String(_)))
                    .collect();
                if !strings.is_empty() {
                    let idx = strings[rng.below(strings.len() as u64) as usize];
                    if let Payload::String(off) = self.heap.slots.get(idx).value {
                        let len = self.heap.chunks.len_of(off);
                        if len > 0 {
                            let byte = (rng.next() & 0xff) as u8;
                            self.heap.chunks.slice_mut(off, len)[len / 2] = byte;
                        }
                    }
                }
            }
            // GC: collect with the shadow-live set as roots (compacts
            // the chunk space — the whole-extent-dirty shape).
            _ => {
                let roots = self.live.clone();
                self.heap.collect(&roots);
            }
        }
    }
}

/// Build the incremental batch for the machine's current state from
/// public pieces only — the same construction the machine surface
/// performs, exercised here under arbitrary schedules.
fn incremental_batch(
    m: &Machine,
    store: &dyn HeapStore,
    epoch: u64,
    prev_seal: &str,
) -> CheckpointBatch {
    let slots = &m.heap.slots;
    let chunks = &m.heap.chunks;
    let manifest = StoreManifest {
        version: Version::current(),
        store_schema: STORE_SCHEMA_VERSION,
        signature: sig(),
        // The exact `from_arenas` formula, so store_to_image equality
        // against a from_arenas image holds field-for-field (the same
        // consistency the machine surface's manifest_of keeps).
        creation: ironhorse_snapshot::CreationParams {
            initial_slot_count: slots.capacity(),
            initial_chunk_bytes: chunks.byte_size() as u32,
        },
        slot_count: slots.capacity(),
        slot_live: slots.live_count(),
        chunk_len: chunks.byte_size() as u64,
        free_len: slots.free_list().len() as u32,
        epoch,
        // This harness builds batches directly, outside the cadence, so
        // it records no crank history.
        cranks: 0,
        root: String::new(),
        seal: String::new(),
    };
    let small = SmallState {
        stack: Vec::new(),
        slot_free: slots.free_list().to_vec(),
        keys: Vec::new(),
        names: Vec::new(),
        symbols: ironhorse_snapshot::image::SymbolKeyImage::default(),
        meter: MeterImage::current(),
        arrays: Vec::new(),
        collections: Vec::new(),
        registry: Vec::new(),
        errors: Vec::new(),
        buffers: Vec::new(),
        typed_arrays: Vec::new(),
        data_views: Vec::new(),
        wrappers: Vec::new(),
        regexps: Vec::new(),
        dates: Vec::new(),
        function_state: ironhorse_vm::FunctionStateSnapshot::default(),
        arguments_brands: Vec::new(),
        temporal: ironhorse_snapshot::image::TemporalImage::default(),
        intl: ironhorse_vm::IntlTables::default(),
        name_floor: None,
        iterators: Vec::new(),
    };
    let mut page_edges: Vec<(u32, Vec<u32>)> = Vec::new();
    let slot_pages: Vec<(u32, Vec<u8>)> = slots
        .dirty_pages()
        .into_iter()
        .map(|page| {
            let records = slots.page_records(page);
            page_edges.push((
                page,
                ironhorse_snapshot::store::derive_page_edges(page, &records),
            ));
            let mut bytes = Vec::new();
            for s in &records {
                ironhorse_snapshot::encode_slot(s, &mut bytes);
            }
            (page, bytes)
        })
        .collect();
    let ext_count = chunk_extent_count(manifest.chunk_len);
    let chunk_extents: Vec<(u32, Vec<u8>)> = chunks
        .dirty_extents()
        .into_iter()
        .filter(|&e| e < ext_count)
        .map(|e| (e, chunks.extent_bytes(e)))
        .collect();
    let small_bytes = small.encode();
    // Free segments: diff against stored leaves, exactly as the
    // machine surface does.
    let prior_frees = store.free_leaf_hashes().unwrap_or_default();
    let free_segs: Vec<(u32, Vec<u8>)> =
        ironhorse_snapshot::store::encode_all_free_segs(slots.free_list())
            .into_iter()
            .filter(|(i, bytes)| {
                prior_frees.get(*i as usize).copied()
                    != Some(ironhorse_snapshot::store::leaf_hash(
                        ironhorse_snapshot::store::LEAF_FREE,
                        *i,
                        bytes,
                    ))
            })
            .collect();
    let mut manifest = manifest;
    // Root maintenance exactly as checkpoint_to_store performs it:
    // prior stored leaves/summaries + this batch's dirty ones (v6:
    // the class trees recombine over the full leaf sets).
    let (mut lp, mut le) = store.leaf_hashes().unwrap_or_default();
    let mut lf = prior_frees.clone();
    let mut edges_all = store.page_edges().unwrap_or_default();
    lp.resize(ironhorse_snapshot::store::slot_page_count(manifest.slot_count) as usize, [0u8; 32]);
    le.resize(chunk_extent_count(manifest.chunk_len) as usize, [0u8; 32]);
    lf.resize(
        ironhorse_snapshot::store::free_seg_count(manifest.free_len) as usize,
        [0u8; 32],
    );
    for (i, bytes) in &slot_pages {
        lp[*i as usize] = ironhorse_snapshot::store::leaf_hash(ironhorse_snapshot::store::LEAF_PAGE, *i, bytes);
    }
    for (i, bytes) in &chunk_extents {
        le[*i as usize] = ironhorse_snapshot::store::leaf_hash(ironhorse_snapshot::store::LEAF_EXT, *i, bytes);
    }
    for (i, bytes) in &free_segs {
        lf[*i as usize] = ironhorse_snapshot::store::leaf_hash(ironhorse_snapshot::store::LEAF_FREE, *i, bytes);
    }
    edges_all.resize(
        ironhorse_snapshot::store::slot_page_count(manifest.slot_count) as usize,
        Vec::new(),
    );
    for (i, targets) in &page_edges {
        edges_all[*i as usize] = targets.clone();
    }
    manifest.root = ironhorse_snapshot::store::compute_root(
        &ironhorse_snapshot::store::leaf_hash(ironhorse_snapshot::store::LEAF_SMALL, 0, &small_bytes),
        &lp,
        &le,
        &lf,
        &edges_all,
    );
    manifest.seal = seal_commit(
        prev_seal,
        &manifest,
        &small_bytes,
        &slot_pages,
        &chunk_extents,
        &free_segs,
        &page_edges,
    );
    CheckpointBatch {
        prev_seal: prev_seal.to_string(),
        manifest,
        small: small_bytes,
        slot_pages,
        chunk_extents,
        free_segs,
        page_edges,
    }
}

/// Arm 2: randomized mutate/checkpoint/restore schedules against both
/// reference backends. After every checkpoint the store must equal the
/// live arenas exactly; a mid-schedule restore must reproduce them and
/// keep checkpointing incrementally.
#[test]
fn randomized_schedules_keep_store_equal_to_live_arenas() {
    for seed in [1u64, 7, 42, 1234, 987654321] {
        println!("schedule seed {seed}");
        let mut rng = Lcg(seed);
        let dir = common::TempDir::new(&format!("ironhorse-hardening-sched-{seed}"));
        let mut file_store = FileStore::open(dir.join("heap.ihstore")).unwrap();
        let mut mem_store = MemoryStore::new();

        let mut m = Machine::new();
        // Prime with enough state to span pages.
        for _ in 0..600 {
            m.step(&mut rng);
        }
        let full = image_to_batch(&m.image(&[]), 1, "");
        // The full batch encodes the whole arenas, so the live dirty
        // bits are consumed by it.
        m.heap.slots.clear_dirty();
        m.heap.chunks.clear_dirty();
        mem_store.commit(&full).unwrap();
        file_store.commit(&full).unwrap();

        let mut epoch = 1;
        for round in 0..12 {
            let steps = rng.below(120) + 5;
            for _ in 0..steps {
                m.step(&mut rng);
            }
            epoch += 1;
            let prev = mem_store.manifest().unwrap().seal;
            let batch = incremental_batch(&m, &mem_store, epoch, &prev);
            m.heap.slots.clear_dirty();
            m.heap.chunks.clear_dirty();
            mem_store.commit(&batch).unwrap();
            file_store.commit(&batch).unwrap();

            let expected = m.image(&[]);
            assert_eq!(
                store_to_image(&mem_store).unwrap(),
                expected,
                "seed {seed} round {round}: memory store equals live arenas"
            );
            assert_eq!(
                store_to_image(&file_store).unwrap(),
                expected,
                "seed {seed} round {round}: file store equals live arenas"
            );

            // Occasionally restore mid-schedule and continue from the
            // restored arenas (their dirty bits start clean).
            if rng.below(3) == 0 {
                let image = store_to_image(&mem_store).unwrap();
                let (slots, chunks) = image.to_arenas();
                m.heap = Heap { slots, chunks };
                // Rebuild shadow liveness: every non-free record index.
                let free: std::collections::HashSet<u32> =
                    image.slot_free.iter().copied().collect();
                m.live = (0..image.slots.len() as u32)
                    .filter(|i| !free.contains(i))
                    .map(SlotIndex)
                    .collect();
            }
        }
    }
}

/// Arm 3: any fault schedule reifies to the identical image. Lazy
/// arenas over a committed store are touched in seeded random orders
/// (with random partial coverage before a full sweep) and must always
/// equal the eager image.
#[test]
fn randomized_fault_schedules_reify_identically() {
    // One committed store from a randomized machine.
    let mut rng = Lcg(0xC0FFEE);
    let mut m = Machine::new();
    for _ in 0..2000 {
        m.step(&mut rng);
    }
    let image = m.image(&[]);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    store.borrow_mut().commit(&image_to_batch(&image, 1, "")).unwrap();
    let manifest = store.borrow().manifest().unwrap();

    struct Src(Rc<RefCell<MemoryStore>>);
    impl PageSource for Src {
        fn slot_page(&self, page: u32) -> Vec<Slot> {
            let bytes = self.0.borrow().read_slot_page(page).unwrap();
            ironhorse_snapshot::decode_slots(&bytes).unwrap()
        }
        fn chunk_extent(&self, ext: u32) -> Vec<u8> {
            self.0.borrow().read_chunk_extent(ext).unwrap()
        }
    }

    for seed in [3u64, 11, 99, 4242] {
        println!("fault-schedule seed {seed}");
        let mut rng = Lcg(seed);
        let source = Rc::new(Src(store.clone()));
        let slots = SlotArena::lazy_from_parts(
            manifest.slot_count,
            image.slot_free.clone(),
            manifest.slot_live,
            source.clone(),
            manifest.chunk_len,
        );
        let chunks =
            ironhorse_vm::ChunkArena::lazy_from_parts(manifest.chunk_len as usize, source);

        // Random partial touches in random order…
        let pages = slot_page_count(manifest.slot_count);
        let exts = chunk_extent_count(manifest.chunk_len);
        for _ in 0..rng.below((pages + exts + 2) as u64 * 2) {
            if rng.below(2) == 0 && pages > 0 {
                slots.touch_page(rng.below(pages as u64) as u32);
            } else if exts > 0 {
                chunks.touch_extent(rng.below(exts as u64) as u32);
            }
        }
        // …then full reification must equal the eager image exactly.
        assert_eq!(slots.records(), image.slots, "seed {seed}: slot records");
        assert_eq!(chunks.raw_vec(), image.chunks, "seed {seed}: chunk bytes");
    }
}

/// Arm 1: single-byte corruptions and truncations of a committed store
/// file never panic: they fail closed with a structured error. Since
/// phase 5 (row leaves) and v5 (small state and page-edge summaries in
/// the root), content flips refuse at validate/read rather than
/// decoding to a different machine — the "decoded" outcome is reserved
/// for flips in the handful of open-time-unverifiable manifest bytes
/// (the stored seal string, the epoch), which the seal chain catches
/// at the next commit instead.
#[test]
fn corrupted_store_files_never_panic() {
    let mut rng = Lcg(0xDEAD);
    let mut m = Machine::new();
    for _ in 0..800 {
        m.step(&mut rng);
    }
    let dir = common::TempDir::new("ironhorse-hardening-corrupt");
    let path = dir.join("heap.ihstore");
    let mut store = FileStore::open(&path).unwrap();
    store.commit(&image_to_batch(&m.image(&[]), 1, "")).unwrap();
    drop(store);
    let pristine = std::fs::read(&path).unwrap();

    let mut outcomes = [0usize; 3]; // [open-error, validate-error, decoded]
    for i in 0..400u64 {
        let mut bytes = pristine.clone();
        if i % 4 == 3 {
            // Truncation at a random point.
            let cut = rng.below(bytes.len() as u64) as usize;
            bytes.truncate(cut);
        } else {
            // Single random byte flip.
            let pos = rng.below(bytes.len() as u64) as usize;
            let flip = 1u8 << rng.below(8);
            bytes[pos] ^= flip;
        }
        std::fs::write(&path, &bytes).unwrap();
        match FileStore::open(&path) {
            Err(_) => outcomes[0] += 1,
            Ok(s) => match validate_store(&s, &sig()) {
                Err(_) => outcomes[1] += 1,
                Ok(_) => match store_to_image(&s) {
                    Err(_) => outcomes[1] += 1,
                    Ok(_) => outcomes[2] += 1,
                },
            },
        }
    }
    println!(
        "corruption sweep: {} refused at open, {} refused at validate/read, {} decoded",
        outcomes[0], outcomes[1], outcomes[2]
    );
    // The sweep is meaningful only if it exercised both refusal and
    // survival paths.
    assert!(outcomes[0] + outcomes[1] > 0, "some corruptions refused");
}

/// Arm 4: the dirty-fraction sweep, exact — touching k pages commits
/// exactly k page rows (and zero when nothing is touched), across the
/// fraction range. This closes phase 2's "commit cost proportional to
/// dirty pages" bar with equality, not monotonicity.
#[test]
fn dirty_fraction_sweep_commits_exactly_the_touched_pages() {
    // A machine wide enough for a meaningful sweep: ≥ 16 pages.
    let mut slots = SlotArena::new();
    let total_records = 16 * ironhorse_vm::SLOTS_PER_PAGE + 40;
    for i in 0..total_records {
        slots.alloc(Slot::integer(i as i32));
    }
    let chunks = ironhorse_vm::ChunkArena::new();
    let image = MachineImage::from_arenas(
        sig(),
        &slots,
        &chunks,
        &[],
        Vec::new(),
        Vec::new(),
        ironhorse_snapshot::image::SymbolKeyImage::default(),
    );
    let mut store = MemoryStore::new();
    store.commit(&image_to_batch(&image, 1, "")).unwrap();
    slots.clear_dirty();

    let pages = slot_page_count(slots.capacity()) as usize;
    assert!(pages >= 16);
    let mut epoch = 1;
    for touched in [0usize, 1, pages / 8, pages / 4, pages / 2, pages] {
        // Touch exactly `touched` distinct pages via one record each.
        for p in 0..touched {
            let idx = SlotIndex((p as u32) * ironhorse_vm::SLOTS_PER_PAGE);
            slots.get_mut(idx).value = Payload::Integer(epoch as i32);
        }
        epoch += 1;
        let m = Machine {
            heap: Heap {
                slots: std::mem::take(&mut slots),
                chunks: ironhorse_vm::ChunkArena::new(),
            },
            live: Vec::new(),
        };
        let prev = store.manifest().unwrap().seal;
        let batch = incremental_batch(&m, &store, epoch, &prev);
        slots = m.heap.slots;
        slots.clear_dirty();
        store.commit(&batch).unwrap();
        assert_eq!(
            store.last_commit_stats().slot_pages_written,
            touched,
            "touching {touched} pages must commit exactly {touched} page rows"
        );
    }
    // And CHUNK_EXTENT_BYTES participates in the same discipline: one
    // extent-sized alloc dirties exactly its covering extents.
    let mut chunks = ironhorse_vm::ChunkArena::new();
    chunks.alloc(&vec![7u8; CHUNK_EXTENT_BYTES as usize / 2]);
    assert_eq!(chunks.dirty_extents(), vec![0]);
    let _ = SLOT_RECORD_BYTES; // geometry sanity anchor
}

/// The random sweep above is dominated by blob-content bytes, which
/// under-samples the decode paths an attacker actually targets
/// (collaborator-review follow-up). This arm concentrates every
/// mutation on the header/manifest/directory span — the first bytes
/// of the file, where the magic, the length-prefixed manifest and
/// small-state blocks, the row counts, and the directories live — and
/// requires the same taxonomy: a structured error or a clean decode,
/// never a panic, never an allocation blow-up.
#[test]
fn corrupted_store_headers_never_panic() {
    let mut rng = Lcg(0xBEEF);
    let mut m = Machine::new();
    for _ in 0..800 {
        m.step(&mut rng);
    }
    let dir = common::TempDir::new("ironhorse-hardening-corrupt-header");
    let path = dir.join("heap.ihstore");
    let mut store = FileStore::open(&path).unwrap();
    store.commit(&image_to_batch(&m.image(&[]), 1, "")).unwrap();
    drop(store);
    let pristine = std::fs::read(&path).unwrap();

    // The whole structural span, computed by walking the actual
    // layout: magic, manifest block, small-state block (v5 put the
    // small state under its leaf and the root, so flips there now
    // REFUSE rather than legitimately decode), counts, directories,
    // leaf-hash blocks, page-edge summaries (v5: root-verified, and
    // their nested length fields get the hostile-count treatment the
    // review found untested), free segments, and free-leaf hashes.
    // Only blob content is out of scope here — arm 1 samples it, and
    // its flips refuse at read via the row leaves.
    let be32 = |b: &[u8], at: usize| u32::from_be_bytes(b[at..at + 4].try_into().unwrap()) as usize;
    let mlen = be32(&pristine, 8);
    let manifest_end = 12 + mlen;
    let small_len = be32(&pristine, manifest_end);
    let small_end = manifest_end + 4 + small_len;
    let n_pages = be32(&pristine, small_end);
    let n_exts = be32(&pristine, small_end + 4);
    let dir_end = small_end + 8 + 12 * (n_pages + n_exts);
    let mut cursor = dir_end + 32 * (n_pages + n_exts);
    for _ in 0..n_pages {
        let len = be32(&pristine, cursor);
        cursor += 4 + 4 * len;
    }
    let n_frees = be32(&pristine, cursor);
    cursor += 4;
    for _ in 0..n_frees {
        let len = be32(&pristine, cursor);
        cursor += 4 + len;
    }
    cursor += 32 * n_frees;
    let structural = cursor; // everything before the first blob

    let mut outcomes = [0usize; 3];
    for i in 0..400u64 {
        let mut bytes = pristine.clone();
        let pos = rng.below(structural as u64) as usize;
        if i % 4 == 3 {
            // Overwrite with a hostile length-shaped value.
            let hostile = [0xFFu8, 0xFF, 0xFF, 0xFF];
            let end = (pos + 4).min(bytes.len());
            bytes[pos..end].copy_from_slice(&hostile[..end - pos]);
        } else {
            let flip = 1u8 << rng.below(8);
            bytes[pos] ^= flip;
        }
        std::fs::write(&path, &bytes).unwrap();
        match FileStore::open(&path) {
            Err(_) => outcomes[0] += 1,
            Ok(s) => match validate_store(&s, &sig()) {
                Err(_) => outcomes[1] += 1,
                Ok(_) => match store_to_image(&s) {
                    Err(_) => outcomes[1] += 1,
                    Ok(_) => outcomes[2] += 1,
                },
            },
        }
    }
    // Sanity: the arm actually exercises refusal paths. The clean
    // remainder is real and bounded: flips inside the stored seal
    // string or the epoch decode as a structurally valid store at
    // open — the seal is a chain link, verifiable only against the
    // NEXT commit's `prev_seal` (where `check_succession` enforces
    // it), never against the store's own content at open. Everything
    // the root covers (leaves, summaries, small state) refuses here.
    assert!(
        outcomes[0] + outcomes[1] > 250,
        "structural corruption should overwhelmingly refuse: {outcomes:?}"
    );
}

/// v5 deterministic lock: a flip inside the stored page-edge section
/// refuses at open or validation — never a silent reachability shrink.
/// The summaries decide what `partial_collect` FREES, so they sit
/// under the root exactly like row leaves; before v5 this flip passed
/// every gate (the review's fail-open finding).
#[test]
fn edge_summary_flip_at_rest_fails_closed() {
    // A reference chain crossing three pages, so the summaries are
    // genuinely nonempty (the random Machine allocates only integers
    // and strings — no arena edges).
    let mut slots = SlotArena::new();
    let n = 3 * ironhorse_vm::SLOTS_PER_PAGE;
    for i in 0..n {
        let next = if i + 1 < n {
            SlotIndex(i + 1)
        } else {
            SlotIndex::NULL
        };
        slots.alloc(Slot::of(Kind::Reference, Payload::Reference(next)));
    }
    let image = MachineImage::from_arenas(
        sig(),
        &slots,
        &ironhorse_vm::ChunkArena::new(),
        &[],
        Vec::new(),
        Vec::new(),
        ironhorse_snapshot::image::SymbolKeyImage::default(),
    );
    let dir = common::TempDir::new("ironhorse-hardening-edge-flip");
    let path = dir.join("heap.ihstore");
    let mut store = FileStore::open(&path).unwrap();
    store.commit(&image_to_batch(&image, 1, "")).unwrap();
    drop(store);
    let pristine = std::fs::read(&path).unwrap();

    // Walk the layout to the edge section (same arithmetic as the
    // header arm above).
    let be32 = |b: &[u8], at: usize| u32::from_be_bytes(b[at..at + 4].try_into().unwrap()) as usize;
    let mlen = be32(&pristine, 8);
    let manifest_end = 12 + mlen;
    let small_len = be32(&pristine, manifest_end);
    let small_end = manifest_end + 4 + small_len;
    let n_pages = be32(&pristine, small_end);
    let n_exts = be32(&pristine, small_end + 4);
    let dir_end = small_end + 8 + 12 * (n_pages + n_exts);
    let edges_start = dir_end + 32 * (n_pages + n_exts);
    let mut edges_end = edges_start;
    for _ in 0..n_pages {
        let len = be32(&pristine, edges_end);
        edges_end += 4 + 4 * len;
    }
    assert!(
        edges_end > edges_start + 4 * n_pages,
        "fixture must have at least one nonempty summary"
    );

    // Flip one byte at every word boundary across the section (both
    // length prefixes and target words): every flip must refuse.
    let mut tried = 0;
    for pos in (edges_start..edges_end).step_by(4) {
        let mut bytes = pristine.clone();
        bytes[pos] ^= 0x01;
        std::fs::write(&path, &bytes).unwrap();
        let refused = match FileStore::open(&path) {
            Err(_) => true,
            Ok(s) => validate_store(&s, &sig()).is_err(),
        };
        assert!(refused, "edge-section flip at byte {pos} must fail closed");
        tried += 1;
    }
    assert!(tried >= 4, "the sweep must cover a real section, got {tried}");
}

/// Review wave 4, H1-a: a lazy arena that has grown PAST its backed row
/// count holds records in `[snapshot_count, capacity)` that live in no
/// store row. Evicting the page containing them would drop the box, and
/// the re-fault — bounded by `snapshot_count` — would reinstall only the
/// backed prefix, silently turning the appended tail into `undefined`.
/// Pre-H1's dense vec retained them; `evict_page` must refuse instead.
///
/// The state this guards is a commit whose bytes DID land in the
/// backing but after which `advance_backing` has not run — the
/// `into_machine`→rebind shape. (The twin-store commit reaches the same
/// page through the `unbacked` bitmap instead, which
/// `evict_after_a_twin_store_checkpoint_keeps_the_modified_body` pins;
/// asking for the clear with `landed_in_backing = true` here is what
/// keeps THIS test on THIS guard rather than passing through that one.)
/// No in-tree driver reaches the state, so the property is asserted at
/// the arena surface where it actually lives.
#[test]
fn evict_refuses_a_page_holding_records_past_the_backed_rows() {
    use ironhorse_vm::SLOTS_PER_PAGE;

    // One PARTIALLY backed page: the row stops two records short of the
    // page boundary, so an append lands on the same page as backed
    // records. (A page-aligned row would put the append on a page
    // outside the residency bitmap, which `evict_page` already refuses
    // for an unrelated reason — the test would pass without the guard.)
    const BACKED: u32 = SLOTS_PER_PAGE - 2;
    struct OnePage;
    impl PageSource for OnePage {
        fn slot_page(&self, page: u32) -> Vec<Slot> {
            assert_eq!(page, 0, "fixture has exactly one backed page");
            (0..BACKED)
                .map(|i| Slot::of(Kind::Integer, Payload::Integer(i as i32)))
                .collect()
        }
        fn chunk_extent(&self, _ext: u32) -> Vec<u8> {
            Vec::new()
        }
    }

    let mut slots = SlotArena::lazy_from_parts(BACKED, Vec::new(), BACKED, Rc::new(OnePage), 0);

    // Fully backed and clean: page 0 evicts, as it always has. (The
    // guard must not cost the RAM win on a quiescent resumed arena.)
    slots.touch_page(0);
    assert!(slots.evict_page(0), "a fully backed clean page still evicts");
    slots.touch_page(0);

    // Now grow past the backing WITHOUT advancing it — the appended
    // record shares page 0 with backed records... unless the page is
    // full, in which case it opens page 1. Either way the appended
    // record is past `snapshot_count`.
    let appended = slots.alloc(Slot::of(Kind::Integer, Payload::Integer(4242)));
    slots.clear_dirty_after_commit(true);

    // Every page that could hold the appended record must refuse.
    let appended_page = appended.0 / SLOTS_PER_PAGE;
    assert!(
        !slots.evict_page(appended_page),
        "the page holding records past the backed rows must refuse eviction"
    );

    // And the record is still readable — the property the refusal buys.
    assert_eq!(
        slots.records()[appended.0 as usize].value,
        Payload::Integer(4242),
        "the appended record survives an evict sweep"
    );

    // A full sweep must not lose it either.
    for page in 0..slots.capacity().div_ceil(SLOTS_PER_PAGE) {
        let _ = slots.evict_page(page);
    }
    assert_eq!(
        slots.records()[appended.0 as usize].value,
        Payload::Integer(4242),
        "the appended record survives a whole-arena evict sweep"
    );
    // The backed prefix still reads back exactly.
    assert_eq!(
        slots.records()[7].value,
        Payload::Integer(7),
        "backed records re-fault unchanged"
    );
}

/// Review wave 5, F1/F2: the bounds gate must be WIRED, not merely
/// present. Wave 4 shipped `check_image_slot_bounds` with both call
/// sites unlocked — deleting either left the whole suite green — and one
/// of them was on `store_to_image`, which serves only the EAGER resume,
/// so the lazy path `PersistentMachine` actually opens accepted crafted
/// bytes and panicked the collector in release.
///
/// These assert the REFUSAL at each untrusted boundary, so removing a
/// call site fails a test rather than waiting for a hostile store.
#[test]
fn crafted_slot_indices_are_refused_at_both_untrusted_boundaries() {
    use ironhorse_snapshot::image::{read_machine, write_machine};

    // An honest small machine, then one poisoned index per arm.
    let mut m = Machine::new();
    let mut rng = Lcg(0x5EED);
    for _ in 0..200 {
        m.step(&mut rng);
    }
    let honest = m.image(&[]);
    let n = honest.slots.len() as u32;

    // --- boundary 1: the container decoder ---
    for (what, poison) in [
        ("heap Reference", {
            let mut i = honest.clone();
            i.slots[5] = Slot::of(Kind::Reference, Payload::Reference(SlotIndex(n + 900_000)));
            i
        }),
        ("heap next link", {
            let mut i = honest.clone();
            i.slots[5].next = SlotIndex(n + 900_000);
            i
        }),
        ("stack Reference", {
            let mut i = honest.clone();
            i.stack = vec![Slot::of(Kind::Reference, Payload::Reference(SlotIndex(n + 900_000)))];
            i
        }),
        ("registry descriptor", {
            let mut i = honest.clone();
            i.registry = vec![ironhorse_snapshot::image::RegistryImage {
                key: b"k".to_vec(),
                descriptor: n + 1_000_000,
            }];
            i
        }),
    ] {
        let bytes = write_machine(&poison);
        assert!(
            read_machine(&bytes, &sig()).is_err(),
            "the container decoder must refuse a crafted {what}",
        );
    }

    // --- boundary 2: validate_store, which BOTH resume paths run ---
    // Side tables travel in the small state, so they reach the store
    // path; poison one and commit it behind a resealed manifest, exactly
    // as an attacker with write access would.
    let mut store = MemoryStore::new();
    let mut poisoned = honest.clone();
    poisoned.registry = vec![ironhorse_snapshot::image::RegistryImage {
        key: b"k".to_vec(),
        descriptor: n + 1_000_000,
    }];
    let mut batch = image_to_batch(&poisoned, 1, "");
    ironhorse_snapshot::store::reseal_batch(&mut batch);
    store.commit(&batch).expect("a crafted batch commits — the store is not the gate");
    match validate_store(&store, &sig()) {
        Err(_) => {}
        Ok(_) => panic!("validate_store must refuse a crafted side-table index"),
    }

    // And the assertion that actually motivated the move: the LAZY
    // resume — the path `PersistentMachine` opens — must refuse. Wave 4
    // gated `store_to_image`, which only the EAGER resume runs, so this
    // exact call accepted the crafted store and then panicked the
    // collector in release.
    let shared = std::rc::Rc::new(RefCell::new(store));
    match ironhorse_snapshot::machine::resume_from_store_lazy(shared.clone(), &sig()) {
        Err(_) => {}
        Ok(_) => panic!("the LAZY resume must refuse a crafted side-table index"),
    }
    // The eager path refuses too — it shares `validate_store`.
    let borrowed = shared.borrow();
    match ironhorse_snapshot::machine::resume_from_store(&*borrowed, &sig()) {
        Err(_) => {}
        Ok(_) => panic!("the eager resume must refuse a crafted side-table index"),
    }
}
