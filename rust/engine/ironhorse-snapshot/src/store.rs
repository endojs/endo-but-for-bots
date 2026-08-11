//! The **snapshot store seam** (design
//! `designs/ironhorse-snapshot-store-seam.md`, phase 1): the paged
//! logical image and the [`HeapStore`] trait that lets the whole-heap
//! snapshot artifact be replaced by a keyed store, so a later phase can
//! checkpoint dirty pages incrementally and reify large heaps lazily.
//!
//! The seam sits **below the atom grammar and above the arenas**: pages
//! and extents reuse the existing canonical encodings (the
//! [`crate::slot_codec`] record for slots, the raw chunk-arena bytes for
//! chunks, the [`crate::image`] payload codecs for the small state), so
//! there is one logical format with two containers — the `XS_M` atom
//! container for interchange and a keyed store for residence. The
//! identity locks below ([`export_to_container`] /
//! [`import_from_container`]) hold the two forms byte-equivalent.
//!
//! # What a store holds
//!
//! | Object | Content | Atom equivalent |
//! |---|---|---|
//! | Slot page `p` | up to [`SLOTS_PER_PAGE`] × 20-byte slot records, index order | a fixed span of the `HEAP` record array |
//! | Chunk extent `e` | up to [`CHUNK_EXTENT_BYTES`] raw chunk-arena bytes | a fixed span of `BLOC` |
//! | Small state | stack, free list, keys/names/symbols, meter | `STAC`, the `HEAP` header, `KEYS`/`NAME`/`SYMB`, `METR` |
//! | Manifest | version + signature + creation + geometry + epoch | `VERS`/`SIGN`/`CREA` |
//!
//! The free list is persisted verbatim — its LIFO order is load-bearing
//! for deterministic slot reuse after resume — and at quiescence the
//! stack is empty and the tables are small, so the small state is
//! genuinely small and travels whole on every commit.
//!
//! # Fail-closed discipline
//!
//! A store is validated **exhaustively at open** ([`validate_store`]):
//! the manifest gates (ironhorse magic, format + store schema version,
//! host callback-table signature), the meter's cost-table version, the
//! live/free/count accounting, and a full page/extent inventory (every
//! row the geometry promises must exist with the exact expected
//! length). Exhaustive open-time validation is what confines later
//! faults to genuine I/O errors — a store that opened cannot produce a
//! wrong answer, only a crashed crank. Every decoder clamps
//! pre-reservations to what the payload can hold, the same
//! malformed-count discipline as [`crate::image`]'s fuzz trophies.
//!
//! Like the rest of the crate this module is `forbid(unsafe_code)` and
//! dependency-free; the SQLite backend lives daemon-side behind this
//! trait (design § Crate and dependency layout), and the in-crate
//! reference stores are [`MemoryStore`] here and
//! [`crate::store_file::FileStore`].

use crate::format::{Signature, SnapshotError, Version};
use crate::image::{
    decode_stack, decode_strings, decode_u32s, encode_stack, encode_strings, encode_u32s,
    CreationParams, MachineImage, MeterImage,
};
use crate::slot_codec::{decode_slots, encode_slot, SLOT_RECORD_BYTES};
use ironhorse_vm::{Slot, COST_TABLE_VERSION};

/// The canonical page/extent geometry, owned by the vm because the
/// arenas' dirty bitmaps are keyed to it (`ironhorse_vm::value`) and the
/// dependency runs snapshot → vm. A page blob is `SLOTS_PER_PAGE ×`
/// [`SLOT_RECORD_BYTES`] bytes and an extent is `CHUNK_EXTENT_BYTES`
/// raw bytes (the last of each may be shorter). Changing either is a
/// store-schema version bump, not a silent re-read.
pub use ironhorse_vm::{CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE};

/// The store schema version, independent of the snapshot
/// [`crate::format::IRONHORSE_FORMAT_VERSION`] (which governs the record
/// encodings both containers share). Bumped on any change to the page
/// geometry, the manifest layout, or the small-state layout.
pub const STORE_SCHEMA_VERSION: u32 = 4;

/// A store that cannot be used, or an operation on it that failed.
/// Gate failures reuse the [`SnapshotError`] taxonomy so a foreign or
/// mismatched store fails with exactly the vocabulary the container
/// reader uses.
#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The store has no committed epoch yet (a fresh store). Callers
    /// that require content (resume, export) fail on this; the first
    /// checkpoint expects it.
    Empty,
    /// An underlying I/O failure, rendered as text so the error stays
    /// `Eq`-comparable in tests (the pattern [`crate::machine`] uses for
    /// its own error split).
    Io(String),
    /// A decode/validation failure in the shared snapshot vocabulary
    /// (version, signature, cost-table, corrupt payload).
    Snapshot(SnapshotError),
    /// The geometry promises a row the store cannot produce — a missing
    /// slot page or chunk extent, named by kind and index.
    MissingRow(&'static str, u32),
    /// A row exists but its length disagrees with the geometry.
    RowLength {
        kind: &'static str,
        index: u32,
        expected: usize,
        found: usize,
    },
    /// A commit whose epoch does not advance the stored epoch by
    /// exactly one (or does not start at 1 on an empty store) — the
    /// split-brain / replayed-batch guard.
    EpochMismatch { expected: u64, found: u64 },
    /// A commit whose `prev_seal` does not match the stored manifest's
    /// seal, or a session whose recorded seal no longer matches the
    /// store — an equal-epoch fork, copy, or foreign store (the
    /// adversarial-review finding a bare epoch counter cannot catch).
    BaselineMismatch { expected: String, found: String },
    /// A first (full-write) checkpoint was aimed at a store that
    /// already holds an epoch. Adopting existing content is the resume
    /// path's job; silently overwriting it would discard a heap.
    NotEmpty { epoch: u64 },
    /// A stored page-edge summary vector whose length disagrees with
    /// the manifest geometry. Refused before any reachability decision
    /// is made from the summaries: the partial collector FREES pages
    /// based on them, so a short vector (a truncated table) must fail
    /// closed rather than read as "no outgoing edges".
    SummaryCount { expected: u32, found: u32 },
}

impl From<SnapshotError> for StoreError {
    fn from(e: SnapshotError) -> Self {
        StoreError::Snapshot(e)
    }
}

/// The per-epoch store header: the snapshot gates plus the paging
/// geometry. Rewritten whole on every commit (it is tiny); the
/// geometry names how many rows the store must hold, and every count
/// derives from `slot_count`/`chunk_len` via [`slot_page_count`] /
/// [`chunk_extent_count`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreManifest {
    /// The shared snapshot format discriminator (ironhorse magic, format
    /// version, slot record width, endianness) — the `VERS` gate.
    pub version: Version,
    /// The store schema version ([`STORE_SCHEMA_VERSION`]) — page
    /// geometry and manifest/small-state layout.
    pub store_schema: u32,
    /// The host callback-table signature — the `SIGN` gate.
    pub signature: Signature,
    /// Machine creation parameters — the `CREA` payload.
    pub creation: CreationParams,
    /// Total slot records (live and free alike) — the `HEAP` record
    /// count. Monotone: the slot arena never shrinks its record array.
    pub slot_count: u32,
    /// Live slot count (`currentHeapCount`).
    pub slot_live: u32,
    /// Chunk-arena byte length. May shrink across a GC compaction.
    pub chunk_len: u64,
    /// Total free-list entries (store seam phase 9): the free list
    /// lives in dirty-diffed segment rows, and this is their geometry
    /// the same way `slot_count` is the pages'.
    pub free_len: u32,
    /// The checkpoint generation. 0 never appears in a committed
    /// manifest; the first commit is epoch 1.
    pub epoch: u64,
    /// The **row-hash tree root** (store seam design, phase 5): SHA-256
    /// (hex) over the small-state leaf and every row leaf
    /// ([`combine_root`]). Unlike the seal — which chains commit
    /// *deltas* — the root attests the store's complete CURRENT
    /// content, so a length-preserving byte flip at rest fails closed
    /// (at open for a leaf flip, at first read for a row flip)
    /// instead of resuming a different machine. Store-native identity;
    /// the CAS blob key remains SHA-256 of the canonical export.
    pub root: String,
    /// The commit-seal chain: SHA-256 (hex) over the previous seal and
    /// this commit's content ([`seal_commit`]). Together with
    /// [`check_succession`] it binds every commit to the exact store
    /// state it was computed against — an epoch number alone cannot
    /// distinguish forks, copies, or unrelated stores at equal height.
    /// The seal hashes the whole manifest, so it also signs `root`.
    pub seal: String,
}

/// Slot pages a `slot_count`-record arena occupies (the last page may
/// be partial).
pub fn slot_page_count(slot_count: u32) -> u32 {
    slot_count.div_ceil(SLOTS_PER_PAGE)
}

/// Chunk extents a `chunk_len`-byte arena occupies (the last extent
/// may be partial).
pub fn chunk_extent_count(chunk_len: u64) -> u32 {
    let per = CHUNK_EXTENT_BYTES as u64;
    u32::try_from(chunk_len.div_ceil(per)).unwrap_or(u32::MAX)
}

/// The record count of slot page `page` under `slot_count` (the last
/// page's remainder, [`SLOTS_PER_PAGE`] otherwise; 0 past the end).
pub fn slot_page_len(slot_count: u32, page: u32) -> usize {
    let start = (page as u64) * (SLOTS_PER_PAGE as u64);
    let end = ((page as u64) + 1) * (SLOTS_PER_PAGE as u64);
    let count = slot_count as u64;
    (count.min(end).saturating_sub(start)) as usize
}

/// The byte length of chunk extent `ext` under `chunk_len`.
pub fn chunk_extent_len(chunk_len: u64, ext: u32) -> usize {
    let per = CHUNK_EXTENT_BYTES as u64;
    let start = (ext as u64) * per;
    let end = ((ext as u64) + 1) * per;
    (chunk_len.min(end).saturating_sub(start)) as usize
}

impl StoreManifest {
    /// Serialize the manifest. Layout, all multi-byte fields
    /// big-endian: the 10-byte `VERS` payload, `store_schema` (u32),
    /// signature (u32 length + bytes), the 8-byte `CREA` payload,
    /// `slot_count` (u32), `slot_live` (u32), `chunk_len` (u64),
    /// `epoch` (u64).
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&self.version.encode());
        v.extend_from_slice(&self.store_schema.to_be_bytes());
        let sig = self.signature.encode();
        v.extend_from_slice(&(sig.len() as u32).to_be_bytes());
        v.extend_from_slice(&sig);
        v.extend_from_slice(&self.creation.encode());
        v.extend_from_slice(&self.slot_count.to_be_bytes());
        v.extend_from_slice(&self.slot_live.to_be_bytes());
        v.extend_from_slice(&self.chunk_len.to_be_bytes());
        v.extend_from_slice(&self.free_len.to_be_bytes());
        v.extend_from_slice(&self.epoch.to_be_bytes());
        let rb = self.root.as_bytes();
        v.extend_from_slice(&(rb.len() as u32).to_be_bytes());
        v.extend_from_slice(rb);
        let sb = self.seal.as_bytes();
        v.extend_from_slice(&(sb.len() as u32).to_be_bytes());
        v.extend_from_slice(sb);
        v
    }

    /// Decode a manifest, enforcing the ironhorse `VERS` gate and the
    /// store schema version. Fails closed on truncation; the signature
    /// length is bounds-checked before any reservation (the
    /// malformed-count discipline).
    pub fn decode(p: &[u8]) -> Result<StoreManifest, StoreError> {
        if p.len() < 10 {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest truncated",
            )));
        }
        let version = Version::decode(&p[0..10]).map_err(SnapshotError::Version)?;
        let mut i = 10usize;
        let take4 = |i: &mut usize| -> Result<[u8; 4], StoreError> {
            if *i + 4 > p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store manifest truncated",
                )));
            }
            let a = [p[*i], p[*i + 1], p[*i + 2], p[*i + 3]];
            *i += 4;
            Ok(a)
        };
        let take8 = |i: &mut usize| -> Result<[u8; 8], StoreError> {
            if *i + 8 > p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store manifest truncated",
                )));
            }
            let mut a = [0u8; 8];
            a.copy_from_slice(&p[*i..*i + 8]);
            *i += 8;
            Ok(a)
        };
        let store_schema = u32::from_be_bytes(take4(&mut i)?);
        if store_schema != STORE_SCHEMA_VERSION {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "unsupported store schema version",
            )));
        }
        let sig_len = u32::from_be_bytes(take4(&mut i)?) as usize;
        if i + sig_len > p.len() {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest signature truncated",
            )));
        }
        let signature =
            Signature::decode(&p[i..i + sig_len]).map_err(SnapshotError::Signature)?;
        i += sig_len;
        let crea_hi = take4(&mut i)?;
        let crea_lo = take4(&mut i)?;
        let mut crea = [0u8; 8];
        crea[0..4].copy_from_slice(&crea_hi);
        crea[4..8].copy_from_slice(&crea_lo);
        let creation = CreationParams::decode(&crea)?;
        let slot_count = u32::from_be_bytes(take4(&mut i)?);
        let slot_live = u32::from_be_bytes(take4(&mut i)?);
        let chunk_len = u64::from_be_bytes(take8(&mut i)?);
        let free_len = u32::from_be_bytes(take4(&mut i)?);
        let epoch = u64::from_be_bytes(take8(&mut i)?);
        let root_len = u32::from_be_bytes(take4(&mut i)?) as usize;
        if i + root_len > p.len() {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest root truncated",
            )));
        }
        let root = std::str::from_utf8(&p[i..i + root_len])
            .map_err(|_| SnapshotError::Corrupt("store manifest root not utf8"))?
            .to_string();
        i += root_len;
        let seal_len = u32::from_be_bytes(take4(&mut i)?) as usize;
        if i + seal_len > p.len() {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest seal truncated",
            )));
        }
        let seal = std::str::from_utf8(&p[i..i + seal_len])
            .map_err(|_| SnapshotError::Corrupt("store manifest seal not utf8"))?
            .to_string();
        i += seal_len;
        // Store contents are untrusted; a manifest that decodes but
        // carries extra bytes is malformed, not forward-compatible —
        // format evolution goes through the schema version gate above.
        if i != p.len() {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest trailing bytes",
            )));
        }
        Ok(StoreManifest {
            version,
            store_schema,
            signature,
            creation,
            slot_count,
            slot_live,
            chunk_len,
            free_len,
            epoch,
            root,
            seal,
        })
    }
}

/// Compute a commit's seal: SHA-256 (hex) over the previous seal, the
/// manifest's core fields, the small state, and every row in the batch
/// (index-tagged, in the batch's sorted order). Two commits agree in
/// seal only if their whole lineage and content agree, which is what
/// lets [`check_succession`] refuse equal-epoch forks.
pub fn seal_commit(
    prev_seal: &str,
    manifest_core: &StoreManifest,
    small: &[u8],
    slot_pages: &[(u32, Vec<u8>)],
    chunk_extents: &[(u32, Vec<u8>)],
    free_segs: &[(u32, Vec<u8>)],
    page_edges: &[(u32, Vec<u32>)],
) -> String {
    let mut h = crate::sha256::Sha256::new();
    h.update(prev_seal.as_bytes());
    // The COMPLETE manifest with only the seal field cleared (that is
    // what is being computed): version, store schema, host callback
    // signature, and creation parameters are store identity — two
    // stores with identical rows but different signatures must not
    // share a seal, or the pairing guard would pass a session against
    // another host's store (the PR-review finding).
    let mut sealed = manifest_core.clone();
    sealed.seal = String::new();
    h.update(&sealed.encode());
    h.update(small);
    for (i, bytes) in slot_pages {
        h.update(b"P");
        h.update(&i.to_be_bytes());
        h.update(bytes);
    }
    for (i, bytes) in chunk_extents {
        h.update(b"X");
        h.update(&i.to_be_bytes());
        h.update(bytes);
    }
    for (i, bytes) in free_segs {
        h.update(b"F");
        h.update(&i.to_be_bytes());
        h.update(bytes);
    }
    for (i, targets) in page_edges {
        h.update(b"E");
        h.update(&i.to_be_bytes());
        for t in targets {
            h.update(&t.to_be_bytes());
        }
    }
    crate::sha256::hex(&h.finalize())
}

/// A page's outgoing edge summary: the sorted, deduplicated set of
/// pages its records reference (self-edges excluded — a page trivially
/// reaches itself). A pure function of the page's records, so stored
/// summaries are recomputable from content — the phase-6 determinism
/// lock.
pub fn derive_page_edges(page: u32, records: &[Slot]) -> Vec<u32> {
    let mut targets = std::collections::BTreeSet::new();
    for r in records {
        r.each_ref_slot(|t| {
            // NULL is a link terminator, not a page; recording it
            // would fabricate an edge to page u32::MAX / SLOTS_PER_PAGE.
            if t.is_null() {
                return;
            }
            let tp = t.0 / SLOTS_PER_PAGE;
            if tp != page {
                targets.insert(tp);
            }
        });
    }
    targets.into_iter().collect()
}

/// Reachability over the STORED page-edge summaries alone: BFS from
/// `roots` (page indices) through [`HeapStore::page_edges`], never
/// reading row content — GC-shaped questions as indexed queries.
pub fn reachable_pages(
    store: &dyn HeapStore,
    roots: impl IntoIterator<Item = u32>,
) -> Result<std::collections::BTreeSet<u32>, StoreError> {
    let edges = store.page_edges()?;
    let mut seen = std::collections::BTreeSet::new();
    let mut work: Vec<u32> = roots.into_iter().collect();
    while let Some(p) = work.pop() {
        if !seen.insert(p) {
            continue;
        }
        if let Some(ts) = edges.get(p as usize) {
            for &t in ts {
                if !seen.contains(&t) {
                    work.push(t);
                }
            }
        }
    }
    Ok(seen)
}

/// Recompute a batch's seal after direct surgery on its contents —
/// test/tooling support. Legitimate producers ([`image_to_batch`],
/// the machine checkpoint) seal correctly by construction; a mutated
/// batch without a reseal fails [`check_succession`]'s recomputation.
pub fn reseal_batch(batch: &mut CheckpointBatch) {
    batch.manifest.seal = seal_commit(
        &batch.prev_seal,
        &batch.manifest,
        &batch.small,
        &batch.slot_pages,
        &batch.chunk_extents,
        &batch.free_segs,
        &batch.page_edges,
    );
}

/// Row-leaf domain tags for the [`leaf_hash`] tree: slot page, chunk
/// extent, free-list segment, small state.
pub const LEAF_PAGE: u8 = b'P';
pub const LEAF_EXT: u8 = b'X';
pub const LEAF_FREE: u8 = b'F';
pub const LEAF_SMALL: u8 = b'S';

/// Free-list entries per stored segment (store seam phase 9): the
/// free list leaves small state and becomes dirty-diffed segment rows,
/// so LIFO churn rewrites only the tail segment and per-commit
/// small-state bytes are O(1) in heap size.
pub const FREE_SEG_ENTRIES: u32 = 4096;

/// Segments a `free_len`-entry free list occupies.
pub fn free_seg_count(free_len: u32) -> u32 {
    free_len.div_ceil(FREE_SEG_ENTRIES)
}

/// Entry count of segment `seg` under `free_len`.
pub fn free_seg_len(free_len: u32, seg: u32) -> usize {
    let start = (seg as u64) * (FREE_SEG_ENTRIES as u64);
    let end = ((seg as u64) + 1) * (FREE_SEG_ENTRIES as u64);
    ((free_len as u64).min(end).saturating_sub(start)) as usize
}

/// Encode one free-list segment (big-endian u32 entries).
pub fn encode_free_seg(entries: &[u32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(entries.len() * 4);
    for e in entries {
        v.extend_from_slice(&e.to_be_bytes());
    }
    v
}

/// Split a full free list into `(segment index, encoded bytes)` rows.
pub fn encode_all_free_segs(free: &[u32]) -> Vec<(u32, Vec<u8>)> {
    let n = free_seg_count(free.len() as u32);
    (0..n)
        .map(|seg| {
            let start = (seg * FREE_SEG_ENTRIES) as usize;
            let end = free.len().min(start + FREE_SEG_ENTRIES as usize);
            (seg, encode_free_seg(&free[start..end]))
        })
        .collect()
}

/// One leaf of the row-hash tree: SHA-256 over the domain tag, the
/// big-endian row index, and the row's exact stored bytes.
pub fn leaf_hash(kind: u8, index: u32, bytes: &[u8]) -> [u8; 32] {
    let mut h = crate::sha256::Sha256::new();
    h.update(&[kind]);
    h.update(&index.to_be_bytes());
    h.update(bytes);
    h.finalize()
}

/// The row-hash tree root: SHA-256 (hex) over the small-state leaf and
/// every page and extent leaf, in index order. Linear combine — the
/// leaves are 32 bytes each, so recombining is metadata-scale even for
/// large heaps; an interior tree is the named upgrade if leaf counts
/// ever make this measurable.
pub fn combine_root(
    small_leaf: &[u8; 32],
    pages: &[[u8; 32]],
    exts: &[[u8; 32]],
    frees: &[[u8; 32]],
) -> String {
    let mut h = crate::sha256::Sha256::new();
    h.update(small_leaf);
    for l in pages {
        h.update(l);
    }
    for l in exts {
        h.update(l);
    }
    for l in frees {
        h.update(l);
    }
    crate::sha256::hex(&h.finalize())
}

/// Apply a batch's dirty rows to a stored leaf set and return the new
/// root — the shared per-commit maintenance every backend runs (and
/// verifies against `batch.manifest.root` before persisting, so a
/// mis-rooted batch fails closed). `pages`/`exts` are the PRIOR leaf
/// vectors; the geometry is resized to the batch's manifest (grown
/// rows must be in the batch — already enforced by the grown-region
/// presence checks).
pub fn apply_batch_leaves(
    pages: &mut Vec<[u8; 32]>,
    exts: &mut Vec<[u8; 32]>,
    frees: &mut Vec<[u8; 32]>,
    batch: &CheckpointBatch,
) -> Result<String, StoreError> {
    let n_pages = slot_page_count(batch.manifest.slot_count) as usize;
    let n_exts = chunk_extent_count(batch.manifest.chunk_len) as usize;
    let n_frees = free_seg_count(batch.manifest.free_len) as usize;
    pages.resize(n_pages, [0u8; 32]);
    exts.resize(n_exts, [0u8; 32]);
    frees.resize(n_frees, [0u8; 32]);
    for (i, bytes) in &batch.slot_pages {
        let slot = pages
            .get_mut(*i as usize)
            .ok_or(StoreError::MissingRow("slot page", *i))?;
        *slot = leaf_hash(LEAF_PAGE, *i, bytes);
    }
    for (i, bytes) in &batch.chunk_extents {
        let slot = exts
            .get_mut(*i as usize)
            .ok_or(StoreError::MissingRow("chunk extent", *i))?;
        *slot = leaf_hash(LEAF_EXT, *i, bytes);
    }
    for (i, bytes) in &batch.free_segs {
        let slot = frees
            .get_mut(*i as usize)
            .ok_or(StoreError::MissingRow("free segment", *i))?;
        *slot = leaf_hash(LEAF_FREE, *i, bytes);
    }
    let small_leaf = leaf_hash(LEAF_SMALL, 0, &batch.small);
    let root = combine_root(&small_leaf, pages, exts, frees);
    if root != batch.manifest.root {
        return Err(StoreError::BaselineMismatch {
            expected: root,
            found: batch.manifest.root.clone(),
        });
    }
    Ok(root)
}

/// The whole-on-every-commit remainder of the machine state: the value
/// stack, the slot free list, the key/name/symbol tables, and the
/// meter. Each section reuses its atom payload encoding verbatim.
#[derive(Clone, Debug, PartialEq)]
pub struct SmallState {
    pub stack: Vec<Slot>,
    pub slot_free: Vec<u32>,
    pub keys: Vec<String>,
    pub names: Vec<String>,
    pub symbols: Vec<u32>,
    pub meter: MeterImage,
}

impl SmallState {
    /// Serialize: six sections, each `u32` length-prefixed, in the
    /// fixed order stack, free list, keys, names, symbols, meter.
    /// Since store schema v4 the free-list section is always EMPTY in
    /// stored small state — the list lives in dirty-diffed segment
    /// rows (phase 9) — but the section slot stays so the layout is
    /// stable; the atom container path still carries the list via the
    /// image, not this encoding.
    pub fn encode(&self) -> Vec<u8> {
        let sections: [Vec<u8>; 6] = [
            encode_stack(&self.stack),
            encode_u32s(&[]),
            encode_strings(&self.keys),
            encode_strings(&self.names),
            encode_u32s(&self.symbols),
            self.meter.encode(),
        ];
        let mut v = Vec::new();
        for s in sections {
            v.extend_from_slice(&(s.len() as u32).to_be_bytes());
            v.extend_from_slice(&s);
        }
        v
    }

    /// Decode the six sections. Every section length is bounds-checked
    /// against the remaining payload before it is sliced.
    pub fn decode(p: &[u8]) -> Result<SmallState, StoreError> {
        let mut i = 0usize;
        let mut section = |name: &'static str| -> Result<&[u8], StoreError> {
            if i + 4 > p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(name)));
            }
            let len = u32::from_be_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]]) as usize;
            i += 4;
            if i + len > p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(name)));
            }
            let s = &p[i..i + len];
            i += len;
            Ok(s)
        };
        let stack = decode_stack(section("small state stack section")?)?;
        let slot_free = decode_u32s(section("small state free-list section")?)?;
        let keys = decode_strings(section("small state keys section")?)?;
        let names = decode_strings(section("small state names section")?)?;
        let symbols = decode_u32s(section("small state symbols section")?)?;
        let meter = MeterImage::decode(section("small state meter section")?)?;
        // Same exact-consumption rule as the manifest: six sections and
        // nothing after them, or the small state fails closed.
        if i != p.len() {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "small state trailing bytes",
            )));
        }
        Ok(SmallState {
            stack,
            slot_free,
            keys,
            names,
            symbols,
            meter,
        })
    }
}

/// One atomic checkpoint: the full (tiny) manifest and small state,
/// plus only the **dirty** slot pages and chunk extents, already
/// encoded. `commit` applies all of it or none of it, and drops any
/// stored row beyond the new geometry (a chunk arena may shrink across
/// a GC compaction; stale rows must not survive to satisfy a later,
/// larger geometry).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointBatch {
    /// The seal of the store state this batch was computed against
    /// (empty for the epoch-1 full write into an empty store). Every
    /// backend refuses a batch whose `prev_seal` differs from the
    /// stored manifest's seal ([`check_succession`]).
    pub prev_seal: String,
    pub manifest: StoreManifest,
    /// Encoded [`SmallState`].
    pub small: Vec<u8>,
    /// `(page index, encoded records)` for each dirty slot page.
    pub slot_pages: Vec<(u32, Vec<u8>)>,
    /// `(extent index, raw bytes)` for each dirty chunk extent.
    pub chunk_extents: Vec<(u32, Vec<u8>)>,
    /// `(segment index, encoded entries)` for each dirty free-list
    /// segment (store seam phase 9). Dirty-diffed at checkpoint via
    /// the leaf tree, so LIFO churn carries only the tail segment.
    pub free_segs: Vec<(u32, Vec<u8>)>,
    /// `(page index, sorted outgoing page targets)` for each dirty
    /// slot page — the **persisted page-edge summaries** (phase 6):
    /// which pages this page's records reference. Derived purely from
    /// the page's records ([`derive_page_edges`]), sealed with the
    /// commit, and the substrate for reachability-as-indexed-queries
    /// ([`reachable_pages`]) — a collector consulting them never
    /// faults row content.
    pub page_edges: Vec<(u32, Vec<u32>)>,
}

/// The keyed snapshot store: point reads by page/extent index and one
/// atomic batch commit. Implementations: [`MemoryStore`] (tests and
/// reference), [`crate::store_file::FileStore`] (single-file reference,
/// pure Rust), and the daemon-side SQLite backend (design § Crate and
/// dependency layout — deliberately outside this `forbid(unsafe_code)`
/// workspace).
///
/// Reads return the raw stored bytes; [`store_to_image`] and the
/// resume path decode them through the shared codecs, so a backend
/// never re-implements an encoding.
pub trait HeapStore {
    /// The current manifest, or [`StoreError::Empty`] before the first
    /// commit.
    fn manifest(&self) -> Result<StoreManifest, StoreError>;
    /// The encoded [`SmallState`] of the current epoch.
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError>;
    /// The raw bytes of slot page `page`.
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError>;
    /// The raw bytes of chunk extent `ext`.
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError>;
    /// Row lengths WITHOUT row contents, index-ordered: `(slot page
    /// byte lengths, chunk extent byte lengths)`. The open-time
    /// inventory validates against this so a lazy resume does no
    /// O(heap) content I/O (the PR-review finding); backends serve it
    /// from metadata (directory entries, `length(bytes)` aggregates).
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError>;
    /// The stored row-leaf hashes, index-ordered (pages, extents) —
    /// 32 bytes per row, so metadata-scale like [`Self::inventory`].
    /// Maintained by `commit` via [`apply_batch_leaves`]; the open-time
    /// validation recombines them against the manifest root, and the
    /// fault path verifies each row read against its leaf.
    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError>;
    /// The raw bytes of free-list segment `seg` (phase 9).
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError>;
    /// The stored free-segment leaf hashes, index-ordered (phase 9).
    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError>;
    /// The stored page-edge summaries, index-ordered (phase 6): one
    /// sorted target list per slot page. Metadata-scale; maintained by
    /// `commit` from the batch's `page_edges`.
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError>;
    /// Apply one checkpoint atomically. Must enforce the epoch
    /// discipline via [`check_epoch`] and drop rows beyond the new
    /// geometry.
    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError>;
}

/// The epoch discipline every [`HeapStore::commit`] enforces: the first
/// commit into an empty store is epoch 1; every later commit advances
/// the stored epoch by exactly one. Anything else is a replayed or
/// forked batch and fails closed.
pub fn check_succession(
    stored: Option<&StoreManifest>,
    batch: &CheckpointBatch,
) -> Result<(), StoreError> {
    check_epoch(stored.map(|m| m.epoch), batch.manifest.epoch)?;
    let expected = stored.map(|m| m.seal.as_str()).unwrap_or("");
    if batch.prev_seal != expected {
        return Err(StoreError::BaselineMismatch {
            expected: expected.to_string(),
            found: batch.prev_seal.clone(),
        });
    }
    // The batch's own seal must actually hash this batch:
    // `CheckpointBatch` is a public type, so without recomputation a
    // forged constant seal could stitch divergent stores into one
    // apparent lineage and defeat the equal-epoch fork guard (the
    // PR-review finding). Every backend calls this before persisting.
    let recomputed = seal_commit(
        &batch.prev_seal,
        &batch.manifest,
        &batch.small,
        &batch.slot_pages,
        &batch.chunk_extents,
        &batch.free_segs,
        &batch.page_edges,
    );
    if batch.manifest.seal != recomputed {
        return Err(StoreError::BaselineMismatch {
            expected: recomputed,
            found: batch.manifest.seal.clone(),
        });
    }
    Ok(())
}

pub fn check_epoch(stored: Option<u64>, batch_epoch: u64) -> Result<(), StoreError> {
    // A decoded manifest may legally carry u64::MAX; an exhausted
    // epoch is corrupt input, not a wrap to epoch 0.
    let expected = match stored {
        None => 1,
        Some(e) => e.checked_add(1).ok_or(StoreError::Snapshot(
            crate::format::SnapshotError::Corrupt("store epoch exhausted"),
        ))?,
    };
    if batch_epoch != expected {
        return Err(StoreError::EpochMismatch {
            expected,
            found: batch_epoch,
        });
    }
    Ok(())
}

// --- image ↔ paged form ---

/// Split a flat record array into `(page, bytes)` rows for every page —
/// the full (epoch-1) batch shape. Later phases produce dirty subsets
/// from the arena's dirty bitmap instead.
pub fn encode_all_slot_pages(slots: &[Slot]) -> Vec<(u32, Vec<u8>)> {
    let count = slots.len() as u32;
    let pages = slot_page_count(count);
    let mut out = Vec::with_capacity(pages as usize);
    for page in 0..pages {
        out.push((page, encode_slot_page(slots, page)));
    }
    out
}

/// Encode one slot page from the flat record array.
pub fn encode_slot_page(slots: &[Slot], page: u32) -> Vec<u8> {
    let count = slots.len() as u32;
    let len = slot_page_len(count, page);
    let start = (page * SLOTS_PER_PAGE) as usize;
    let mut bytes = Vec::with_capacity(len * SLOT_RECORD_BYTES);
    for slot in &slots[start..start + len] {
        encode_slot(slot, &mut bytes);
    }
    bytes
}

/// Split the chunk arena's raw bytes into `(extent, bytes)` rows for
/// every extent.
pub fn encode_all_chunk_extents(chunks: &[u8]) -> Vec<(u32, Vec<u8>)> {
    let len = chunks.len() as u64;
    let exts = chunk_extent_count(len);
    let mut out = Vec::with_capacity(exts as usize);
    for ext in 0..exts {
        out.push((ext, encode_chunk_extent(chunks, ext)));
    }
    out
}

/// Slice one chunk extent out of the arena's raw bytes.
pub fn encode_chunk_extent(chunks: &[u8], ext: u32) -> Vec<u8> {
    let len = chunk_extent_len(chunks.len() as u64, ext);
    let start = (ext as u64 * CHUNK_EXTENT_BYTES as u64) as usize;
    chunks[start..start + len].to_vec()
}

/// The full-write batch of a [`MachineImage`] at `epoch` — every page,
/// every extent. This is the first-checkpoint and
/// [`import_from_container`] shape; incremental batches are built by
/// the machine surface from dirty bits.
pub fn image_to_batch(image: &MachineImage, epoch: u64, prev_seal: &str) -> CheckpointBatch {
    let mut manifest = StoreManifest {
        version: image.version.clone(),
        store_schema: STORE_SCHEMA_VERSION,
        signature: image.signature.clone(),
        creation: image.creation.clone(),
        slot_count: image.slots.len() as u32,
        slot_live: image.slot_live,
        chunk_len: image.chunks.len() as u64,
        free_len: image.slot_free.len() as u32,
        epoch,
        root: String::new(),
        seal: String::new(),
    };
    let small = SmallState {
        stack: image.stack.clone(),
        slot_free: image.slot_free.clone(),
        keys: image.keys.clone(),
        names: image.names.clone(),
        symbols: image.symbols.clone(),
        meter: image.meter.clone(),
    };
    let small_bytes = small.encode();
    let slot_pages = encode_all_slot_pages(&image.slots);
    let chunk_extents = encode_all_chunk_extents(&image.chunks);
    let free_segs = encode_all_free_segs(&image.slot_free);
    let page_edges: Vec<(u32, Vec<u32>)> = (0..slot_page_count(manifest.slot_count))
        .map(|page| {
            let start = (page * SLOTS_PER_PAGE) as usize;
            let end = image.slots.len().min(start + SLOTS_PER_PAGE as usize);
            (page, derive_page_edges(page, &image.slots[start..end]))
        })
        .collect();
    // Root first (a full batch carries every row), then the seal —
    // which hashes the whole manifest and therefore signs the root.
    let pages: Vec<[u8; 32]> = slot_pages
        .iter()
        .map(|(i, b)| leaf_hash(LEAF_PAGE, *i, b))
        .collect();
    let exts: Vec<[u8; 32]> = chunk_extents
        .iter()
        .map(|(i, b)| leaf_hash(LEAF_EXT, *i, b))
        .collect();
    let frees: Vec<[u8; 32]> = free_segs
        .iter()
        .map(|(i, b)| leaf_hash(LEAF_FREE, *i, b))
        .collect();
    manifest.root = combine_root(&leaf_hash(LEAF_SMALL, 0, &small_bytes), &pages, &exts, &frees);
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

/// Read a whole store back into the plain-data [`MachineImage`] — the
/// eager-reify path, and the bridge to the atom container. The inverse
/// of [`image_to_batch`] + [`HeapStore::commit`].
pub fn store_to_image(store: &dyn HeapStore) -> Result<MachineImage, StoreError> {
    let manifest = store.manifest()?;
    let small_bytes = store.read_small_state()?;
    let mut small = SmallState::decode(&small_bytes)?;
    if manifest.cost_gate_mismatch(&small) {
        return Err(StoreError::Snapshot(SnapshotError::CostTableMismatch {
            expected: COST_TABLE_VERSION.to_string(),
            found: small.meter.cost_table_version.clone(),
        }));
    }

    // Row-content integrity (phase 5): every row read below is checked
    // against its stored leaf hash, so eager reification — and the
    // export/root_hash paths riding on it — cannot absorb a
    // length-preserving flip.
    let (leaf_pages, leaf_exts) = store.leaf_hashes()?;

    let pages = slot_page_count(manifest.slot_count);
    // Clamp the pre-reservation: the manifest count is untrusted until
    // the row reads below confirm it (the over-allocation trophy class;
    // export/root_hash reach here without validate_store).
    let mut slots: Vec<Slot> = Vec::with_capacity((manifest.slot_count as usize).min(1 << 16));
    for page in 0..pages {
        let bytes = store.read_slot_page(page)?;
        let expected = slot_page_len(manifest.slot_count, page) * SLOT_RECORD_BYTES;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "slot page",
                index: page,
                expected,
                found: bytes.len(),
            });
        }
        if leaf_pages.get(page as usize).copied() != Some(leaf_hash(LEAF_PAGE, page, &bytes)) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store slot page fails its leaf hash",
            )));
        }
        slots.extend(
            decode_slots(&bytes)
                .map_err(|_| SnapshotError::Corrupt("store slot page record"))?,
        );
    }

    let exts = chunk_extent_count(manifest.chunk_len);
    // Same clamp discipline as the slot reservation above.
    let mut chunks: Vec<u8> = Vec::with_capacity((manifest.chunk_len as usize).min(1 << 24));
    for ext in 0..exts {
        let bytes = store.read_chunk_extent(ext)?;
        let expected = chunk_extent_len(manifest.chunk_len, ext);
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "chunk extent",
                index: ext,
                expected,
                found: bytes.len(),
            });
        }
        if leaf_exts.get(ext as usize).copied() != Some(leaf_hash(LEAF_EXT, ext, &bytes)) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store chunk extent fails its leaf hash",
            )));
        }
        chunks.extend_from_slice(&bytes);
    }

    let free_leaves = store.free_leaf_hashes()?;
    let mut slot_free: Vec<u32> = Vec::with_capacity((manifest.free_len as usize).min(1 << 16));
    for seg in 0..free_seg_count(manifest.free_len) {
        let bytes = store.read_free_seg(seg)?;
        let expected = free_seg_len(manifest.free_len, seg) * 4;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "free segment",
                index: seg,
                expected,
                found: bytes.len(),
            });
        }
        if free_leaves.get(seg as usize).copied() != Some(leaf_hash(LEAF_FREE, seg, &bytes)) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store free segment fails its leaf hash",
            )));
        }
        slot_free.extend(
            bytes
                .chunks_exact(4)
                .map(|c| u32::from_be_bytes(c.try_into().unwrap())),
        );
    }

    Ok(MachineImage {
        version: manifest.version,
        signature: manifest.signature,
        creation: manifest.creation,
        chunks,
        slots,
        slot_free,
        slot_live: manifest.slot_live,
        stack: small.stack,
        keys: small.keys,
        names: small.names,
        symbols: small.symbols,
        meter: small.meter,
    })
}

impl StoreManifest {
    fn cost_gate_mismatch(&self, small: &SmallState) -> bool {
        small.meter.cost_table_version != COST_TABLE_VERSION
    }
}

/// Validate a store exhaustively: manifest gates, signature, meter
/// cost-table version, live/free/count accounting, and the full row
/// inventory (existence and exact length of every page and extent the
/// geometry promises). Returns the manifest and decoded small state so
/// a resume does not re-read them.
///
/// This is the open-time gate that makes later read faults pure I/O
/// errors (design decision 7): after `validate_store` succeeds, every
/// row a lazy fault can ask for has been proven present and
/// well-sized.
/// The verified row-leaf hashes [`validate_store`] hands back so the
/// resume paths can verify every later row read against them without
/// re-trusting the store.
#[derive(Clone, Debug)]
pub struct StoreLeaves {
    pub pages: Vec<[u8; 32]>,
    pub exts: Vec<[u8; 32]>,
    pub frees: Vec<[u8; 32]>,
}

pub fn validate_store(
    store: &dyn HeapStore,
    expected_sig: &Signature,
) -> Result<(StoreManifest, SmallState, StoreLeaves), StoreError> {
    let manifest = store.manifest()?;
    if manifest.version != Version::current() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store version stamp mismatch",
        )));
    }
    if manifest.store_schema != STORE_SCHEMA_VERSION {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "unsupported store schema version",
        )));
    }
    if !manifest.signature.is_compatible_with(expected_sig) {
        return Err(StoreError::Snapshot(SnapshotError::SignatureMismatch {
            expected: expected_sig.clone(),
            found: manifest.signature.clone(),
        }));
    }
    if manifest.epoch == 0 {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store manifest epoch 0",
        )));
    }

    let small_bytes = store.read_small_state()?;
    let mut small = SmallState::decode(&small_bytes)?;
    if manifest.cost_gate_mismatch(&small) {
        return Err(StoreError::Snapshot(SnapshotError::CostTableMismatch {
            expected: COST_TABLE_VERSION.to_string(),
            found: small.meter.cost_table_version.clone(),
        }));
    }

    // Accounting: every record is live or on the free list. The count
    // side uses the manifest's free_len (the list itself is segment
    // rows, reassembled below, where the per-entry checks run).
    if manifest.free_len as u64 + manifest.slot_live as u64 != manifest.slot_count as u64 {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store live/free/count accounting mismatch",
        )));
    }

    // Row inventory: every promised row exists at its exact length —
    // from METADATA, not contents, so validation (and therefore lazy
    // resume) does no O(heap) row I/O.
    let (page_lens, ext_lens) = store.inventory()?;
    let n_pages = slot_page_count(manifest.slot_count);
    if page_lens.len() != n_pages as usize {
        return Err(StoreError::MissingRow("slot page", page_lens.len() as u32));
    }
    for (page, found) in page_lens.iter().enumerate() {
        let expected = slot_page_len(manifest.slot_count, page as u32) * SLOT_RECORD_BYTES;
        if *found != expected {
            return Err(StoreError::RowLength {
                kind: "slot page",
                index: page as u32,
                expected,
                found: *found,
            });
        }
    }
    let n_exts = chunk_extent_count(manifest.chunk_len);
    if ext_lens.len() != n_exts as usize {
        return Err(StoreError::MissingRow("chunk extent", ext_lens.len() as u32));
    }
    for (ext, found) in ext_lens.iter().enumerate() {
        let expected = chunk_extent_len(manifest.chunk_len, ext as u32);
        if *found != expected {
            return Err(StoreError::RowLength {
                kind: "chunk extent",
                index: ext as u32,
                expected,
                found: *found,
            });
        }
    }

    // Row-hash tree (phase 5): the stored leaves must recombine to the
    // manifest's sealed root — metadata-scale (32 bytes per row). Row
    // CONTENT is then verified against these leaves at the point of
    // read (eager reify or lazy fault), so a length-preserving flip at
    // rest can never resume a different machine.
    let (leaf_pages, leaf_exts, leaf_frees) = {
        let (p, e) = store.leaf_hashes()?;
        (p, e, store.free_leaf_hashes()?)
    };
    let n_frees = free_seg_count(manifest.free_len);
    if leaf_pages.len() != n_pages as usize
        || leaf_exts.len() != n_exts as usize
        || leaf_frees.len() != n_frees as usize
    {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store leaf-hash inventory disagrees with geometry",
        )));
    }
    let small_leaf = leaf_hash(LEAF_SMALL, 0, &small_bytes);
    let root = combine_root(&small_leaf, &leaf_pages, &leaf_exts, &leaf_frees);
    if root != manifest.root {
        return Err(StoreError::BaselineMismatch {
            expected: root,
            found: manifest.root.clone(),
        });
    }

    // Reassemble the free list from its segment rows (phase 9), each
    // verified against its leaf; the accounting checks above already
    // ran against this list.
    let mut free: Vec<u32> = Vec::with_capacity((manifest.free_len as usize).min(1 << 16));
    for seg in 0..n_frees {
        let bytes = store.read_free_seg(seg)?;
        let expected = free_seg_len(manifest.free_len, seg) * 4;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "free segment",
                index: seg,
                expected,
                found: bytes.len(),
            });
        }
        if leaf_frees.get(seg as usize).copied() != Some(leaf_hash(LEAF_FREE, seg, &bytes)) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store free segment fails its leaf hash",
            )));
        }
        free.extend(
            bytes
                .chunks_exact(4)
                .map(|c| u32::from_be_bytes(c.try_into().unwrap())),
        );
    }
    if free.iter().any(|&f| f >= manifest.slot_count) {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store free-list index out of range",
        )));
    }
    // Distinctness: a duplicated free index passes the sum check but
    // aliases one record to two allocations after resume (the
    // adversarial-review aliasing finding). With distinctness, the sum
    // check makes the live/free partition exact.
    {
        let mut seen = std::collections::HashSet::with_capacity(free.len());
        if !free.iter().all(|f| seen.insert(*f)) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store free-list contains duplicate indices",
            )));
        }
    }
    small.slot_free = free;

    Ok((
        manifest,
        small,
        StoreLeaves {
            pages: leaf_pages,
            exts: leaf_exts,
            frees: leaf_frees,
        },
    ))
}

// --- container ↔ store (the identity locks) ---

/// Export the store's current epoch as canonical `XS_M` container
/// bytes — the same bytes [`crate::image::write_machine`] produces for
/// the equivalent live machine, so a store state keeps CAS-grade
/// content identity (design decision 6) and full interchange with the
/// blob path.
pub fn export_to_container(store: &dyn HeapStore) -> Result<Vec<u8>, StoreError> {
    Ok(crate::image::write_machine(&store_to_image(store)?))
}

/// Seed a store from canonical container bytes (a full epoch-1 write),
/// enforcing the container gates against `expected_sig` exactly as
/// [`crate::image::read_machine`] does. The identity lock is
/// `export_to_container(import_from_container(bytes)) == bytes`.
pub fn import_from_container(
    bytes: &[u8],
    expected_sig: &Signature,
    store: &mut dyn HeapStore,
) -> Result<(), StoreError> {
    let image = crate::image::read_machine(bytes, expected_sig)?;
    store.commit(&image_to_batch(&image, 1, ""))
}

/// The store state's **logical identity**: the SHA-256 of its canonical
/// export (design decision 6 — identity is logical, not file bytes,
/// because a database file is not byte-canonical). Equals the CAS key
/// [`crate::machine::MachineSnapshot::suspend_to_cas`] would produce
/// for the same machine state, so blob-suspended and store-checkpointed
/// workers share one content-address space. Computed via a full export
/// today; an incrementally maintained page-hash tree is the design's
/// named future work for when this becomes hot.
pub fn root_hash(store: &dyn HeapStore) -> Result<String, StoreError> {
    Ok(crate::sha256::hex_sha256(&export_to_container(store)?))
}

// --- the in-memory reference store ---

/// What one [`MemoryStore::commit`] wrote, for the incremental-
/// checkpoint acceptance tests (the phase-2 bar: commit cost is
/// proportional to dirty rows, measured, not asserted from hope).
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitStats {
    pub slot_pages_written: usize,
    pub chunk_extents_written: usize,
}

/// The in-memory [`HeapStore`]: the reference semantics every backend
/// must match, and the store the crate's own tests run against.
#[derive(Default)]
pub struct MemoryStore {
    manifest: Option<StoreManifest>,
    small: Vec<u8>,
    slot_pages: std::collections::HashMap<u32, Vec<u8>>,
    chunk_extents: std::collections::HashMap<u32, Vec<u8>>,
    leaf_pages: Vec<[u8; 32]>,
    leaf_exts: Vec<[u8; 32]>,
    leaf_frees: Vec<[u8; 32]>,
    free_segs: std::collections::HashMap<u32, Vec<u8>>,
    edges: Vec<Vec<u32>>,
    last_commit: CommitStats,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }

    /// Row counts written by the most recent commit.
    pub fn last_commit_stats(&self) -> CommitStats {
        self.last_commit
    }
}

impl HeapStore for MemoryStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.manifest.clone().ok_or(StoreError::Empty)
    }

    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        Ok(self.small.clone())
    }

    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.slot_pages
            .get(&page)
            .cloned()
            .ok_or(StoreError::MissingRow("slot page", page))
    }

    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.chunk_extents
            .get(&ext)
            .cloned()
            .ok_or(StoreError::MissingRow("chunk extent", ext))
    }

    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        let m = self.manifest()?;
        let mut pages = Vec::with_capacity(slot_page_count(m.slot_count) as usize);
        for page in 0..slot_page_count(m.slot_count) {
            pages.push(
                self.slot_pages
                    .get(&page)
                    .ok_or(StoreError::MissingRow("slot page", page))?
                    .len(),
            );
        }
        let mut exts = Vec::with_capacity(chunk_extent_count(m.chunk_len) as usize);
        for ext in 0..chunk_extent_count(m.chunk_len) {
            exts.push(
                self.chunk_extents
                    .get(&ext)
                    .ok_or(StoreError::MissingRow("chunk extent", ext))?
                    .len(),
            );
        }
        Ok((pages, exts))
    }

    fn leaf_hashes(&self) -> Result<(Vec<[u8; 32]>, Vec<[u8; 32]>), StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        Ok((self.leaf_pages.clone(), self.leaf_exts.clone()))
    }

    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        Ok(self.edges.clone())
    }

    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.free_segs
            .get(&seg)
            .cloned()
            .ok_or(StoreError::MissingRow("free segment", seg))
    }

    fn free_leaf_hashes(&self) -> Result<Vec<[u8; 32]>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        Ok(self.leaf_frees.clone())
    }

    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
        check_succession(self.manifest.as_ref(), batch)?;
        // A grown geometry's new rows must be in the batch. Prior rows
        // exist by induction (they were committed), so only the grown
        // region is checked — O(grown + dirty), not O(heap) (the
        // PR-review finding).
        let pages = slot_page_count(batch.manifest.slot_count);
        let exts = chunk_extent_count(batch.manifest.chunk_len);
        let prior_pages = self.manifest.as_ref().map_or(0, |m| slot_page_count(m.slot_count));
        let prior_exts = self.manifest.as_ref().map_or(0, |m| chunk_extent_count(m.chunk_len));
        let batch_pages: std::collections::HashSet<u32> =
            batch.slot_pages.iter().map(|(p, _)| *p).collect();
        let batch_exts: std::collections::HashSet<u32> =
            batch.chunk_extents.iter().map(|(e, _)| *e).collect();
        for page in prior_pages..pages {
            if !batch_pages.contains(&page) {
                return Err(StoreError::MissingRow("slot page", page));
            }
        }
        for ext in prior_exts..exts {
            if !batch_exts.contains(&ext) {
                return Err(StoreError::MissingRow("chunk extent", ext));
            }
        }
        let prior_frees = self.manifest.as_ref().map_or(0, |m| free_seg_count(m.free_len));
        let batch_frees: std::collections::HashSet<u32> =
            batch.free_segs.iter().map(|(f, _)| *f).collect();
        for seg in prior_frees..free_seg_count(batch.manifest.free_len) {
            if !batch_frees.contains(&seg) {
                return Err(StoreError::MissingRow("free segment", seg));
            }
        }
        // Leaf maintenance + root verification BEFORE persisting: a
        // batch whose sealed root does not match its own rows fails
        // closed here (phase 5).
        let mut leaf_pages = self.leaf_pages.clone();
        let mut leaf_exts = self.leaf_exts.clone();
        let mut leaf_frees = self.leaf_frees.clone();
        apply_batch_leaves(&mut leaf_pages, &mut leaf_exts, &mut leaf_frees, batch)?;
        for (page, bytes) in &batch.slot_pages {
            self.slot_pages.insert(*page, bytes.clone());
        }
        for (ext, bytes) in &batch.chunk_extents {
            self.chunk_extents.insert(*ext, bytes.clone());
        }
        self.leaf_pages = leaf_pages;
        self.leaf_exts = leaf_exts;
        self.leaf_frees = leaf_frees;
        for (seg, bytes) in &batch.free_segs {
            self.free_segs.insert(*seg, bytes.clone());
        }
        let n_frees = free_seg_count(batch.manifest.free_len);
        self.free_segs.retain(|&s, _| s < n_frees);
        self.edges.resize(pages as usize, Vec::new());
        for (page, targets) in &batch.page_edges {
            if let Some(slot) = self.edges.get_mut(*page as usize) {
                *slot = targets.clone();
            }
        }
        self.edges.truncate(pages as usize);
        // Drop rows beyond the new geometry (chunk shrink across a GC
        // compaction; slot pages are monotone but the sweep is uniform).
        self.slot_pages.retain(|&p, _| p < pages);
        self.chunk_extents.retain(|&e, _| e < exts);
        self.small = batch.small.clone();
        self.manifest = Some(batch.manifest.clone());
        self.last_commit = CommitStats {
            slot_pages_written: batch.slot_pages.len(),
            chunk_extents_written: batch.chunk_extents.len(),
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{read_machine, write_machine};
    use crate::machine::MachineSnapshot;
    use ironhorse_vm::Interp;

    fn sig() -> Signature {
        Signature::new("ironhorse-store-test-v1")
    }

    // The captured oracle bytecodes the machine-level snapshot tests
    // use (`crate::machine::tests`): PROG_A completes "6", PROG_B "1".
    const PROG_A: [u8; 44] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
        0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
        0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
    ];

    fn ran_image() -> MachineImage {
        let mut m = Interp::new();
        let a = m.run(&PROG_A);
        assert!(a.completed);
        m.snapshot_image(&sig())
    }

    #[test]
    fn paging_math_covers_partial_tails() {
        assert_eq!(slot_page_count(0), 0);
        assert_eq!(slot_page_count(1), 1);
        assert_eq!(slot_page_count(SLOTS_PER_PAGE), 1);
        assert_eq!(slot_page_count(SLOTS_PER_PAGE + 1), 2);
        assert_eq!(slot_page_len(SLOTS_PER_PAGE + 1, 0), SLOTS_PER_PAGE as usize);
        assert_eq!(slot_page_len(SLOTS_PER_PAGE + 1, 1), 1);
        assert_eq!(slot_page_len(SLOTS_PER_PAGE + 1, 2), 0);
        let e = CHUNK_EXTENT_BYTES as u64;
        assert_eq!(chunk_extent_count(0), 0);
        assert_eq!(chunk_extent_count(e), 1);
        assert_eq!(chunk_extent_count(e + 1), 2);
        assert_eq!(chunk_extent_len(e + 1, 0), CHUNK_EXTENT_BYTES as usize);
        assert_eq!(chunk_extent_len(e + 1, 1), 1);
    }

    #[test]
    fn manifest_round_trips_and_gates() {
        let m = StoreManifest {
            version: Version::current(),
            store_schema: STORE_SCHEMA_VERSION,
            signature: sig(),
            creation: CreationParams {
                initial_slot_count: 7,
                initial_chunk_bytes: 9,
            },
            slot_count: 300,
            slot_live: 200,
            chunk_len: 70_000,
            free_len: 5,
            epoch: 3,
            root: "r00t".to_string(),
            seal: "abc123".to_string(),
        };
        let bytes = m.encode();
        assert_eq!(StoreManifest::decode(&bytes).unwrap(), m);

        // A foreign VERS magic fails closed through the shared gate.
        let mut foreign = bytes.clone();
        foreign[0..4].copy_from_slice(b"XSXS");
        match StoreManifest::decode(&foreign) {
            Err(StoreError::Snapshot(SnapshotError::Version(_))) => {}
            other => panic!("expected version gate, got {other:?}"),
        }

        // A claimed signature length past the payload fails closed
        // before any reservation (malformed-count discipline).
        let mut huge = bytes.clone();
        huge[14..18].copy_from_slice(&u32::MAX.to_be_bytes());
        match StoreManifest::decode(&huge) {
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest signature truncated",
            ))) => {}
            other => panic!("expected truncated signature, got {other:?}"),
        }

        // Exact consumption: a decodable manifest followed by any
        // trailing byte is malformed, not forward-compatible.
        let mut trailing = bytes.clone();
        trailing.push(0);
        match StoreManifest::decode(&trailing) {
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest trailing bytes",
            ))) => {}
            other => panic!("expected trailing-byte refusal, got {other:?}"),
        }
    }

    #[test]
    fn small_state_round_trips() {
        let s = SmallState {
            stack: vec![Slot::boolean(true), Slot::integer(-4)],
            slot_free: vec![9, 2, 5],
            keys: vec!["dyn".to_string()],
            names: vec!["Object".to_string(), "x".to_string()],
            symbols: vec![11, 22],
            meter: MeterImage::current(),
        };
        // Since schema v4 the free list does NOT ride in small state
        // (it lives in segment rows); the round-trip drops it.
        let mut expected = s.clone();
        expected.slot_free = Vec::new();
        assert_eq!(SmallState::decode(&s.encode()).unwrap(), expected);
    }

    #[test]
    fn small_state_truncation_fails_closed() {
        let s = SmallState {
            stack: vec![],
            slot_free: vec![],
            keys: vec![],
            names: vec![],
            symbols: vec![],
            meter: MeterImage::current(),
        };
        let bytes = s.encode();
        for cut in [0, 3, 7, bytes.len() - 1] {
            assert!(
                SmallState::decode(&bytes[..cut]).is_err(),
                "truncation at {cut} must fail closed"
            );
        }
        // And the mirror image: bytes past the sixth section are
        // malformed, not ignorable.
        let mut trailing = bytes.clone();
        trailing.push(0);
        match SmallState::decode(&trailing) {
            Err(StoreError::Snapshot(SnapshotError::Corrupt("small state trailing bytes"))) => {}
            other => panic!("expected trailing-byte refusal, got {other:?}"),
        }
    }

    #[test]
    fn epoch_discipline_is_enforced() {
        assert!(check_epoch(None, 1).is_ok());
        assert_eq!(
            check_epoch(None, 2),
            Err(StoreError::EpochMismatch {
                expected: 1,
                found: 2
            })
        );
        assert!(check_epoch(Some(4), 5).is_ok());
        assert_eq!(
            check_epoch(Some(4), 4),
            Err(StoreError::EpochMismatch {
                expected: 5,
                found: 4
            })
        );
    }

    /// The identity lock: container → store → container is
    /// byte-identical, so the two forms are the same logical format.
    #[test]
    fn container_import_export_is_byte_identical() {
        let image = ran_image();
        let bytes = write_machine(&image);

        let mut store = MemoryStore::new();
        import_from_container(&bytes, &sig(), &mut store).expect("imports");
        let exported = export_to_container(&store).expect("exports");
        assert_eq!(exported, bytes, "the round-trip is byte-identical");

        // And the exported bytes still pass the container reader's own
        // gates.
        assert_eq!(read_machine(&exported, &sig()).unwrap(), image);
    }

    /// A machine image survives the paged form exactly (every page and
    /// extent, partial tails included).
    #[test]
    fn image_batch_store_image_round_trips() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).expect("commits");
        let back = store_to_image(&store).expect("reads back");
        assert_eq!(back, image);
    }

    #[test]
    fn validate_accepts_a_committed_store() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        let (manifest, small, _leaves) = validate_store(&store, &sig()).expect("validates");
        assert_eq!(manifest.epoch, 1);
        assert_eq!(manifest.slot_count as usize, image.slots.len());
        assert_eq!(small.slot_free, image.slot_free);
    }

    #[test]
    fn validate_fails_closed_on_empty_store() {
        let store = MemoryStore::new();
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::Empty
        );
    }

    #[test]
    fn validate_fails_closed_on_signature_mismatch() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        match validate_store(&store, &Signature::new("other-host")) {
            Err(StoreError::Snapshot(SnapshotError::SignatureMismatch { .. })) => {}
            other => panic!("expected signature mismatch, got {other:?}"),
        }
    }

    #[test]
    fn validate_fails_closed_on_cost_table_mismatch() {
        let mut image = ran_image();
        image.meter.cost_table_version = "ironhorse-meter-999".to_string();
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        match validate_store(&store, &sig()) {
            Err(StoreError::Snapshot(SnapshotError::CostTableMismatch { .. })) => {}
            other => panic!("expected cost-table mismatch, got {other:?}"),
        }
    }

    #[test]
    fn validate_fails_closed_on_missing_row() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        // Drop a promised page: the inventory scan must name it.
        store.slot_pages.remove(&0);
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::MissingRow("slot page", 0)
        );
    }

    #[test]
    fn validate_fails_closed_on_row_length_mismatch() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        let short = store.slot_pages.get(&0).unwrap()[..SLOT_RECORD_BYTES].to_vec();
        store.slot_pages.insert(0, short);
        match validate_store(&store, &sig()) {
            Err(StoreError::RowLength {
                kind: "slot page",
                index: 0,
                ..
            }) => {}
            other => panic!("expected row-length failure, got {other:?}"),
        }
    }

    #[test]
    fn validate_fails_closed_on_accounting_mismatch() {
        let image = ran_image();
        let mut batch = image_to_batch(&image, 1, "");
        // Corrupt the live count so live + free != count — resealed,
        // so the accounting gate (not the seal check) is what trips.
        batch.manifest.slot_live += 1;
        reseal_batch(&mut batch);
        let mut store = MemoryStore::new();
        store.commit(&batch).unwrap();
        match validate_store(&store, &sig()) {
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store live/free/count accounting mismatch",
            ))) => {}
            other => panic!("expected accounting mismatch, got {other:?}"),
        }
    }

    /// A shrink (the GC-compaction shape) drops stale rows: a later
    /// geometry never resurrects bytes from a dead extent.
    #[test]
    fn commit_drops_rows_beyond_the_new_geometry() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image, 1, "")).unwrap();
        let exts_before = chunk_extent_count(store.manifest().unwrap().chunk_len);

        // Same machine state, chunk arena "compacted" to empty.
        let mut shrunk = image.clone();
        shrunk.chunks = Vec::new();
        let prev = store.manifest().unwrap().seal;
        let mut batch = image_to_batch(&shrunk, 2, &prev);
        batch.chunk_extents.clear(); // nothing to write; drop-only
        store.commit(&batch).unwrap();

        assert!(exts_before > 0, "the fixture must have had chunk bytes");
        assert!(store.chunk_extents.is_empty(), "stale extents dropped");
        // The exported form agrees with the shrunk image.
        assert_eq!(store_to_image(&store).unwrap().chunks, Vec::<u8>::new());
    }

    #[test]
    fn memory_store_reports_commit_stats() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        let batch = image_to_batch(&image, 1, "");
        store.commit(&batch).unwrap();
        assert_eq!(
            store.last_commit_stats(),
            CommitStats {
                slot_pages_written: batch.slot_pages.len(),
                chunk_extents_written: batch.chunk_extents.len(),
            }
        );
    }
}
