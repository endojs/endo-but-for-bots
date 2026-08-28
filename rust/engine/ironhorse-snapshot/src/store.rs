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
/// geometry, the manifest layout, the small-state layout, the
/// addition of a persisted row class, or a change to the integrity
/// root's or seal's inputs — the phase-6 near-miss (a new persisted
/// row class with no bump) is exactly what the widened trigger list
/// exists to prevent.
///
/// v5: page-edge summaries joined the integrity root (with a section
/// geometry header and length-prefixed edge entries in both the root
/// and the seal encodings), and commit verifies summaries against the
/// rows they travel with.
///
/// v6: the flat root became per-class Merkle trees ([`compute_root`];
/// same leaves, new combination), enabling O(dirty·log n) commit
/// maintenance. v5→v6 migration verifies then restamps in place.
///
/// v7 (the side-table ledger): the small state grew three sections —
/// arrays, collections, `Symbol.for` registry — so resumed machines
/// keep their bulk side tables. v6→v7 migration appends the three
/// sections EMPTY (a pure 12-byte suffix; a v6-era machine had
/// nothing persisted in them by definition) and restamps the root for
/// the changed small leaf.
pub const STORE_SCHEMA_VERSION: u32 = 12;
/// The oldest schema [`migrate_store`] can upgrade in place. Decode
/// accepts the whole supported range; validation refuses an
/// un-migrated older store with [`StoreError::NeedsMigration`], and
/// anything newer than CURRENT fails closed (no downgrade path).
pub const STORE_SCHEMA_MIN_SUPPORTED: u32 = 5;

/// A store that cannot be used, or an operation on it that failed.
/// Gate failures reuse the [`SnapshotError`] taxonomy so a foreign or
/// mismatched store fails with exactly the vocabulary the container
/// reader uses.
#[derive(Debug, PartialEq, Eq)]
pub enum StoreError {
    /// The machine holds a live function whose body lives in a dynamic
    /// (`eval` / dynamic-`Function`) code segment. Segment buffers are
    /// realm session state that no snapshot carries — the ledger's
    /// segments row does not exist yet — so persisting the heap would
    /// resume a callable whose body is gone. Refused fail-closed at
    /// `begin_store_session` and `checkpoint_to_store`; unreachable
    /// today on the daemon path, which installs no source compiler,
    /// so `eval` halts before any segment exists.
    DynamicSegmentsUnsupported,
    /// The machine is not at a quiescent crank boundary (wave-6 W6-10):
    /// its last crank halted. Rewind or complete a crank before
    /// persisting.
    MachineNotQuiescent,
    /// The heap holds live state in a SILENT-WRONG Pending side table
    /// (wave-6 W6-9): a resumed machine would answer wrong values, so
    /// persist refuses by name until the row's atom lands.
    PendingStateUnsupported { row: &'static str },
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
    /// A decodable store written by an OLDER supported schema that
    /// has not been migrated yet — the open paths run
    /// [`migrate_store`] and never surface this; a read-only caller
    /// that cannot migrate reports it by name.
    NeedsMigration { found: u32 },
    /// A stored page-edge summary vector whose length disagrees with
    /// the manifest geometry. Refused before any reachability decision
    /// is made from the summaries: the partial collector FREES pages
    /// based on them, so a short vector (a truncated table) must fail
    /// closed rather than read as "no outgoing edges".
    SummaryCount { expected: u32, found: u32 },
    /// A batch's page-edge summary disagrees with the page row it
    /// travels beside (or a summary travels without its row / a row
    /// without its summary). Commit recomputes every traveling
    /// summary from the row's records — the summaries must stay a
    /// pure function of row content, or the collector's stored
    /// reachability diverges from the heap it frees from.
    SummaryMismatch { page: u32 },
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
    /// Total COMPLETED cranks this store has absorbed (store schema 8).
    ///
    /// The cadence schedule is derived from THIS, not from a session
    /// counter, which is what makes it resume-invariant: a replica that
    /// suspends mid-window resumes with the same absolute count and so
    /// collects after exactly the same cranks as one that never
    /// suspended. Review wave 5 measured the alternative — a
    /// session-local `cranks_since_collect` that `open()` zeroed made an
    /// ordinary suspend/resume fork the durable heap, with identical
    /// per-crank results and computrons hiding it.
    ///
    /// Absolute rather than "since the last collection" so the schedule
    /// cannot drift: two replicas at the same crank total agree on
    /// whether a collection is due, whatever their suspend histories.
    /// Advanced by exactly the number of cranks a commit makes durable,
    /// so `epoch` counts checkpoints and this counts cranks — they
    /// coincide only at `checkpoint_every: 1`.
    ///
    /// Reads 0 from a schema-7 store, which is correct: such a store
    /// predates the counter, and 0 is where a fresh one starts.
    pub cranks: u64,
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
        // Schema 8 tail, appended AFTER the seal and ONLY when the
        // stamp says 8 — symmetric with the decoder, which reads it
        // under the same condition. The symmetry is load-bearing for
        // the ladder: `migrate_v6_to_v7` writes a manifest stamped 7,
        // and encoding a tail there would produce bytes its own decoder
        // rejects as trailing garbage, breaking the intermediate step.
        if self.store_schema >= 8 {
            v.extend_from_slice(&self.cranks.to_be_bytes());
        }
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
        if !(STORE_SCHEMA_MIN_SUPPORTED..=STORE_SCHEMA_VERSION).contains(&store_schema) {
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
        // Schema 8 added the completed-crank counter as a tail field.
        // An older store simply does not carry it, and 0 is the right
        // reading: it predates the counter, and 0 is where a fresh
        // store starts — so a migrated store's schedule begins from the
        // migration rather than from a number it never recorded.
        let cranks = if store_schema >= 8 {
            u64::from_be_bytes(take8(&mut i)?)
        } else {
            0
        };
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
            cranks,
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
        // Length prefix (v5): entries are variable-width, so without
        // it two different summary lists could serialize to one byte
        // stream (unreachable at sane page indices, but framing
        // should be structural, not incidental).
        h.update(&(targets.len() as u32).to_be_bytes());
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
    Ok(bfs_pages(&store.page_edges()?, roots))
}

/// The dense in-Rust BFS both [`reachable_pages`] and the
/// [`HeapStore::reachable_page_set`] default body share: roots are in
/// the result even when out of range (edgeless), matching the SQLite
/// backend's CTE semantics (parity-locked there).
pub(crate) fn bfs_pages(
    edges: &[Vec<u32>],
    roots: impl IntoIterator<Item = u32>,
) -> std::collections::BTreeSet<u32> {
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
    seen
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

// ---- The v6 ROOT TREE (store schema 6) --------------------------
//
// Schema 5's root was a FLAT hash over every leaf, so every commit
// re-read every stored leaf to recombine it — the measured O(pages)
// seal-metadata term. Schema 6 keeps the SAME leaves but combines
// them through one binary Merkle tree per row class (slot pages,
// chunk extents, free segments, page-edge summaries), with the
// interior nodes PERSISTED beside the leaves: a commit recomputes
// only the dirty leaves' root paths — O(dirty · log n) selective
// reads — and the full recombination remains the open-time
// validator. An odd node at any level is hashed with itself
// (duplicate-last), and an empty class contributes a tagged empty
// root, so widths are unambiguous given the counts the combined
// root also covers.

/// Class tags for the four leaf trees (also the node-hash domain
/// separators).
pub const TREE_PAGES: u8 = b'p';
pub const TREE_EXTS: u8 = b'x';
pub const TREE_FREES: u8 = b'f';
pub const TREE_EDGES: u8 = b's';

/// The page-edge summary row's LEAF hash (the other classes reuse
/// [`leaf_hash`] over their raw bytes; summaries hash their decoded
/// target list exactly as the v5 flat root did).
pub fn edge_leaf_hash(index: u32, targets: &[u32]) -> [u8; 32] {
    let mut h = crate::sha256::Sha256::new();
    h.update(b"E");
    h.update(&index.to_be_bytes());
    h.update(&(targets.len() as u32).to_be_bytes());
    for t in targets {
        h.update(&t.to_be_bytes());
    }
    h.finalize()
}

fn tree_node_hash(tag: u8, level: u32, left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut h = crate::sha256::Sha256::new();
    h.update(&[b'N', tag]);
    h.update(&level.to_be_bytes());
    h.update(left);
    h.update(right);
    h.finalize()
}

fn tree_empty_root(tag: u8) -> [u8; 32] {
    let mut h = crate::sha256::Sha256::new();
    h.update(&[b'0', tag]);
    h.finalize()
}

/// Build every interior level of a class tree from its leaves —
/// `levels[0]` is the level ABOVE the leaves; the last level has one
/// node, the class root. Empty or single-leaf input builds no
/// levels (the class root is [`tree_empty_root`] or the leaf).
pub fn build_class_tree(tag: u8, leaves: &[[u8; 32]]) -> Vec<Vec<[u8; 32]>> {
    let mut levels: Vec<Vec<[u8; 32]>> = Vec::new();
    let mut level_no = 0u32;
    loop {
        let cur: &[[u8; 32]] = match levels.last() {
            None => leaves,
            Some(l) => l,
        };
        if cur.len() <= 1 {
            break;
        }
        let mut next: Vec<[u8; 32]> = Vec::with_capacity(cur.len().div_ceil(2));
        for pair in cur.chunks(2) {
            let right = pair.get(1).unwrap_or(&pair[0]);
            next.push(tree_node_hash(tag, level_no, &pair[0], right));
        }
        levels.push(next);
        level_no += 1;
    }
    levels
}

/// The class root given its leaves and interior levels.
pub fn class_tree_root(tag: u8, leaves: &[[u8; 32]], levels: &[Vec<[u8; 32]>]) -> [u8; 32] {
    match (leaves.len(), levels.last()) {
        (0, _) => tree_empty_root(tag),
        (_, None) => leaves[0],
        (_, Some(top)) => top[0],
    }
}

/// Recompute the interior paths for `dirty` leaf indices in place —
/// the O(dirty · log n) incremental maintenance a v6 commit performs.
/// `levels` must describe the SAME leaf count as `leaves` (a commit
/// that grows or shrinks a class rebuilds via [`build_class_tree`] —
/// width changes reshape every level's tail, and rebuild cost is
/// bounded by the growth the commit already paid for).
pub fn update_class_tree(
    tag: u8,
    leaves: &[[u8; 32]],
    levels: &mut [Vec<[u8; 32]>],
    dirty: &[u32],
) {
    let mut touched: Vec<u32> = dirty.to_vec();
    touched.sort_unstable();
    touched.dedup();
    for k in 0..levels.len() {
        let (read_below, level): (&[[u8; 32]], &mut Vec<[u8; 32]>) = if k == 0 {
            let (first, _) = levels.split_at_mut(1);
            (leaves, &mut first[0])
        } else {
            let (below, above) = levels.split_at_mut(k);
            (&below[k - 1][..], &mut above[0])
        };
        let width = read_below.len();
        let mut parents: Vec<u32> = Vec::with_capacity(touched.len());
        for &i in &touched {
            let pair = i & !1;
            let l = read_below[pair as usize];
            let r = if ((pair + 1) as usize) < width {
                read_below[(pair + 1) as usize]
            } else {
                l
            };
            level[(i / 2) as usize] = tree_node_hash(tag, k as u32, &l, &r);
            if parents.last() != Some(&(i / 2)) {
                parents.push(i / 2);
            }
        }
        touched = parents;
    }
}

/// The CURRENT-schema root over full leaf/summary vectors — schema
/// 6's class-tree combination. The v5 flat formula stays available
/// as [`combine_root`] for migration verification only.
pub fn compute_root(
    small_leaf: &[u8; 32],
    pages: &[[u8; 32]],
    exts: &[[u8; 32]],
    frees: &[[u8; 32]],
    edges: &[Vec<u32>],
) -> String {
    let edge_leaves: Vec<[u8; 32]> = edges
        .iter()
        .enumerate()
        .map(|(i, t)| edge_leaf_hash(i as u32, t))
        .collect();
    let pr = class_tree_root(TREE_PAGES, pages, &build_class_tree(TREE_PAGES, pages));
    let xr = class_tree_root(TREE_EXTS, exts, &build_class_tree(TREE_EXTS, exts));
    let fr = class_tree_root(TREE_FREES, frees, &build_class_tree(TREE_FREES, frees));
    let sr = class_tree_root(TREE_EDGES, &edge_leaves, &build_class_tree(TREE_EDGES, &edge_leaves));
    combine_class_roots(
        small_leaf,
        [pages.len() as u32, exts.len() as u32, frees.len() as u32],
        [&pr, &xr, &fr, &sr],
    )
}

/// The v6 combined root: counts, the small-state leaf, and the four
/// class-tree roots (page, extent, free, edge order). The counts bind
/// the widths, exactly as the v5 flat root's count header did.
pub fn combine_class_roots(
    small_leaf: &[u8; 32],
    counts: [u32; 3],
    roots: [&[u8; 32]; 4],
) -> String {
    let mut h = crate::sha256::Sha256::new();
    h.update(b"C6");
    for n in counts {
        h.update(&n.to_be_bytes());
    }
    h.update(small_leaf);
    for r in roots {
        h.update(r);
    }
    crate::sha256::hex(&h.finalize())
}

/// A live copy of the store's root metadata — the four leaf-hash
/// vectors, the small-state leaf, and the class-tree interior levels.
/// The levels are a DERIVED CACHE: only the leaves persist anywhere;
/// a ledger rebuilds them at construction and maintains them
/// incrementally. Holding one across commits is what turns per-commit
/// root maintenance from "re-read and re-hash every stored leaf" into
/// O(dirty · log n): [`RootLedger::apply`] patches exactly the
/// traveling rows' leaves and recomputes only their root paths.
///
/// Coherence discipline: build a ledger only from VERIFIED state (an
/// open-time validation, or vectors a full [`apply_batch`] just
/// recombined) and advance it only by the commits its owner performs;
/// on ANY failed or refused commit the owner must DROP it and rebuild
/// on the next slow path — never patch around a failure. The
/// (epoch, seal) pairing guards refuse interleaved foreign commits,
/// so a live ledger cannot silently diverge from the store it
/// mirrors; what it deliberately trades away is [`apply_batch`]'s
/// per-commit re-hash of untouched leaves, moving at-rest-edit
/// detection to the open-time validator and the per-read row/leaf
/// verification (the v6 design's stated discipline).
pub struct RootLedger {
    small_leaf: [u8; 32],
    pages: Vec<[u8; 32]>,
    exts: Vec<[u8; 32]>,
    frees: Vec<[u8; 32]>,
    edge_leaves: Vec<[u8; 32]>,
    pages_levels: Vec<Vec<[u8; 32]>>,
    exts_levels: Vec<Vec<[u8; 32]>>,
    frees_levels: Vec<Vec<[u8; 32]>>,
    edges_levels: Vec<Vec<[u8; 32]>>,
}

impl std::fmt::Debug for RootLedger {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootLedger")
            .field("widths", &self.widths())
            .finish_non_exhaustive()
    }
}

impl RootLedger {
    /// Build from full leaf vectors and raw page-edge summaries
    /// (hashing the edge leaves and every interior level once —
    /// O(n), the constructor's price; commits then pay O(dirty·log)).
    pub fn build(
        small: &[u8],
        pages: Vec<[u8; 32]>,
        exts: Vec<[u8; 32]>,
        frees: Vec<[u8; 32]>,
        edges: &[Vec<u32>],
    ) -> RootLedger {
        let edge_leaves: Vec<[u8; 32]> = edges
            .iter()
            .enumerate()
            .map(|(i, t)| edge_leaf_hash(i as u32, t))
            .collect();
        let pages_levels = build_class_tree(TREE_PAGES, &pages);
        let exts_levels = build_class_tree(TREE_EXTS, &exts);
        let frees_levels = build_class_tree(TREE_FREES, &frees);
        let edges_levels = build_class_tree(TREE_EDGES, &edge_leaves);
        RootLedger {
            small_leaf: leaf_hash(LEAF_SMALL, 0, small),
            pages,
            exts,
            frees,
            edge_leaves,
            pages_levels,
            exts_levels,
            frees_levels,
            edges_levels,
        }
    }

    /// The prior free-segment leaves — the checkpoint producer's
    /// dirty-diff baseline, read before [`Self::apply`] advances them.
    pub fn free_leaves(&self) -> &[[u8; 32]] {
        &self.frees
    }

    /// Current class widths `[pages, exts, frees]` — the prior-length
    /// argument [`check_batch`] wants.
    pub fn widths(&self) -> [usize; 3] {
        [self.pages.len(), self.exts.len(), self.frees.len()]
    }

    /// The combined root over the ledger's current state.
    pub fn root(&self) -> String {
        combine_class_roots(
            &self.small_leaf,
            [
                self.pages.len() as u32,
                self.exts.len() as u32,
                self.frees.len() as u32,
            ],
            [
                &class_tree_root(TREE_PAGES, &self.pages, &self.pages_levels),
                &class_tree_root(TREE_EXTS, &self.exts, &self.exts_levels),
                &class_tree_root(TREE_FREES, &self.frees, &self.frees_levels),
                &class_tree_root(TREE_EDGES, &self.edge_leaves, &self.edges_levels),
            ],
        )
    }

    /// Advance the ledger by one commit's rows and return the new
    /// root. Pure maintenance — admission is [`check_batch`]'s job
    /// and root comparison is the caller's; an out-of-range row index
    /// still fails closed here rather than panicking. A class whose
    /// width changed rebuilds its levels (the reshape touches every
    /// level's tail; the cost is bounded by the growth the commit
    /// already shipped); an unchanged-width class updates only the
    /// dirty leaves' paths.
    pub fn apply(
        &mut self,
        manifest: &StoreManifest,
        small: &[u8],
        slot_pages: &[(u32, Vec<u8>)],
        chunk_extents: &[(u32, Vec<u8>)],
        free_segs: &[(u32, Vec<u8>)],
        page_edges: &[(u32, Vec<u32>)],
    ) -> Result<String, StoreError> {
        fn patch_class(
            tag: u8,
            kind: &'static str,
            leaves: &mut Vec<[u8; 32]>,
            levels: &mut Vec<Vec<[u8; 32]>>,
            new_width: usize,
            dirty: &[(u32, [u8; 32])],
        ) -> Result<(), StoreError> {
            for (i, _) in dirty {
                if *i as usize >= new_width {
                    return Err(StoreError::MissingRow(kind, *i));
                }
            }
            if new_width != leaves.len() {
                leaves.resize(new_width, [0u8; 32]);
                for (i, h) in dirty {
                    leaves[*i as usize] = *h;
                }
                *levels = build_class_tree(tag, leaves);
            } else if !dirty.is_empty() {
                let mut indices: Vec<u32> = Vec::with_capacity(dirty.len());
                for (i, h) in dirty {
                    leaves[*i as usize] = *h;
                    indices.push(*i);
                }
                update_class_tree(tag, leaves, levels, &indices);
            }
            Ok(())
        }
        let page_dirty: Vec<(u32, [u8; 32])> = slot_pages
            .iter()
            .map(|(i, b)| (*i, leaf_hash(LEAF_PAGE, *i, b)))
            .collect();
        let ext_dirty: Vec<(u32, [u8; 32])> = chunk_extents
            .iter()
            .map(|(i, b)| (*i, leaf_hash(LEAF_EXT, *i, b)))
            .collect();
        let free_dirty: Vec<(u32, [u8; 32])> = free_segs
            .iter()
            .map(|(i, b)| (*i, leaf_hash(LEAF_FREE, *i, b)))
            .collect();
        let edge_dirty: Vec<(u32, [u8; 32])> = page_edges
            .iter()
            .map(|(i, t)| (*i, edge_leaf_hash(*i, t)))
            .collect();
        let n_pages = slot_page_count(manifest.slot_count) as usize;
        patch_class(
            TREE_PAGES,
            "slot page",
            &mut self.pages,
            &mut self.pages_levels,
            n_pages,
            &page_dirty,
        )?;
        patch_class(
            TREE_EXTS,
            "chunk extent",
            &mut self.exts,
            &mut self.exts_levels,
            chunk_extent_count(manifest.chunk_len) as usize,
            &ext_dirty,
        )?;
        patch_class(
            TREE_FREES,
            "free segment",
            &mut self.frees,
            &mut self.frees_levels,
            free_seg_count(manifest.free_len) as usize,
            &free_dirty,
        )?;
        patch_class(
            TREE_EDGES,
            "page-edge summary",
            &mut self.edge_leaves,
            &mut self.edges_levels,
            n_pages,
            &edge_dirty,
        )?;
        self.small_leaf = leaf_hash(LEAF_SMALL, 0, small);
        Ok(self.root())
    }
}

/// The v5 flat root, kept ONLY so migration can verify a v5 store
/// against its own stored root before restamping: SHA-256 (hex) over
/// a section geometry header, the small-state leaf, every page,
/// extent, and free-segment leaf in index order, and every page-edge
/// summary. The counts header makes the section boundaries structural
/// (two stores with different `(pages, exts, frees)` splits of one
/// leaf sequence must not share a root), and the edge section puts
/// the summaries under the same at-rest integrity as the rows — both
/// properties [`compute_root`] carries forward.
pub fn combine_root(
    small_leaf: &[u8; 32],
    pages: &[[u8; 32]],
    exts: &[[u8; 32]],
    frees: &[[u8; 32]],
    edges: &[Vec<u32>],
) -> String {
    let mut h = crate::sha256::Sha256::new();
    h.update(b"C");
    h.update(&(pages.len() as u32).to_be_bytes());
    h.update(&(exts.len() as u32).to_be_bytes());
    h.update(&(frees.len() as u32).to_be_bytes());
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
    for (i, targets) in edges.iter().enumerate() {
        h.update(b"E");
        h.update(&(i as u32).to_be_bytes());
        h.update(&(targets.len() as u32).to_be_bytes());
        for t in targets {
            h.update(&t.to_be_bytes());
        }
    }
    crate::sha256::hex(&h.finalize())
}

/// The batch admission checks — the shared per-commit verification
/// every backend runs BEFORE persisting anything, so all three refuse
/// the same batches for the same reasons (the review's parity
/// findings: free-segment grown-region and summary coupling were
/// previously checked in some backends and not others):
///
/// 1. Grown-region presence: every row of a grown geometry region
///    (pages, extents, free segments alike) must travel in the batch
///    — O(grown), prior rows exist by induction.
/// 2. Row lengths against the batch's OWN manifest geometry — a
///    short/long row otherwise hashes into a self-consistent root and
///    fails only at the next open (deferred fail-closed).
/// 3. Summary coupling (v5): page-edge summaries travel for EXACTLY
///    the traveling page rows, and each equals
///    [`derive_page_edges`] of the row beside it — recomputed here,
///    so stored summaries are derivation-verified at every write.
///
/// Everything [`apply_batch`] verifies EXCEPT its item 4 (the root
/// recombination), phrased against the prior state's leaf-vector
/// LENGTHS (`[pages, exts, frees]`) rather than the vectors — the
/// checks never read prior leaf contents, so the [`RootLedger`] fast
/// path, holding only cached leaves, runs the identical gauntlet.
///
/// NOT a complete gate on its own: a row whose index is past the
/// batch's geometry has an expected length of 0 (the length functions
/// return 0 past the end) and an empty edge summary derives correctly,
/// so a zero-length out-of-range row passes every check here (review
/// wave 4, P3c). It is refused downstream — by the maintenance stage on
/// both paths, `MissingRow` either way, probe-confirmed — so this is a
/// note for a future backend, not a live hole: a backend that treats
/// `check_batch` as the whole admission gate and then writes rows by
/// index must range-check them itself, or this function must grow the
/// index-range check.
pub fn check_batch(
    prior: Option<(&StoreManifest, [usize; 3])>,
    batch: &CheckpointBatch,
) -> Result<(), StoreError> {
    let n_pages = slot_page_count(batch.manifest.slot_count) as usize;
    let n_exts = chunk_extent_count(batch.manifest.chunk_len) as usize;
    let n_frees = free_seg_count(batch.manifest.free_len) as usize;
    let [prior_pages_len, prior_exts_len, prior_frees_len] =
        prior.map(|(_, lens)| lens).unwrap_or([0, 0, 0]);

    // The grown-region checks below key off the PRIOR LEAF VECTORS'
    // lengths while the boundary checks key off the PRIOR MANIFEST's
    // geometry. Every backend maintains leaves sized to its stored
    // manifest (and open-time validation re-checks it), but the two
    // baselines arrive through different arguments — assert the
    // coupling so a desynced caller fails closed HERE instead of
    // skewing which rows the two checks require (wave-3 finding).
    if let Some((prev, _)) = prior {
        if prior_pages_len != slot_page_count(prev.slot_count) as usize
            || prior_exts_len != chunk_extent_count(prev.chunk_len) as usize
            || prior_frees_len != free_seg_count(prev.free_len) as usize
        {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "prior leaf tables disagree with the prior manifest geometry",
            )));
        }
    }

    let batch_pages: std::collections::HashSet<u32> =
        batch.slot_pages.iter().map(|(p, _)| *p).collect();
    let batch_exts: std::collections::HashSet<u32> =
        batch.chunk_extents.iter().map(|(e, _)| *e).collect();
    let batch_frees: std::collections::HashSet<u32> =
        batch.free_segs.iter().map(|(f, _)| *f).collect();
    for page in prior_pages_len as u32..n_pages as u32 {
        if !batch_pages.contains(&page) {
            return Err(StoreError::MissingRow("slot page", page));
        }
    }
    for ext in prior_exts_len as u32..n_exts as u32 {
        if !batch_exts.contains(&ext) {
            return Err(StoreError::MissingRow("chunk extent", ext));
        }
    }
    for seg in prior_frees_len as u32..n_frees as u32 {
        if !batch_frees.contains(&seg) {
            return Err(StoreError::MissingRow("free segment", seg));
        }
    }

    // Boundary rows (the second review pass's finding): the growth
    // checks above cover indexes the new geometry ADDS, but a total
    // (`slot_count`/`chunk_len`/`free_len`) that changes WITHIN an
    // existing row changes that row's geometry-derived length without
    // adding any index — a crafted batch could omit the affected tail
    // row and land a store whose retained row disagrees with its new
    // manifest (caught only at the next open). Require the prior tail
    // and the new tail of each class to travel whenever their
    // expected length changes between the prior and the new manifest.
    // Every legitimate producer already satisfies this: growth writes
    // the tail page, compaction rewrites the tail extent, free churn
    // ships the changed segments.
    if let Some((prev, _)) = prior {
        fn require_boundaries(
            kind: &'static str,
            count0: u32,
            count1: u32,
            len0: impl Fn(u32) -> usize,
            len1: impl Fn(u32) -> usize,
            traveling: &std::collections::HashSet<u32>,
        ) -> Result<(), StoreError> {
            let check = |idx: u32| -> Result<(), StoreError> {
                if len0(idx) != len1(idx) && !traveling.contains(&idx) {
                    return Err(StoreError::MissingRow(kind, idx));
                }
                Ok(())
            };
            // The prior tail, when retained under the new geometry.
            if count0 > 0 && count0 - 1 < count1 {
                check(count0 - 1)?;
            }
            // The new tail, when it already existed under the prior
            // geometry (distinct from the prior tail).
            if count1 > 0 && count1 - 1 < count0 && count1 != count0 {
                check(count1 - 1)?;
            }
            Ok(())
        }
        require_boundaries(
            "slot page",
            slot_page_count(prev.slot_count),
            n_pages as u32,
            |i| slot_page_len(prev.slot_count, i),
            |i| slot_page_len(batch.manifest.slot_count, i),
            &batch_pages,
        )?;
        require_boundaries(
            "chunk extent",
            chunk_extent_count(prev.chunk_len),
            n_exts as u32,
            |e| chunk_extent_len(prev.chunk_len, e),
            |e| chunk_extent_len(batch.manifest.chunk_len, e),
            &batch_exts,
        )?;
        require_boundaries(
            "free segment",
            free_seg_count(prev.free_len),
            n_frees as u32,
            |s| free_seg_len(prev.free_len, s),
            |s| free_seg_len(batch.manifest.free_len, s),
            &batch_frees,
        )?;
    }

    for (i, bytes) in &batch.slot_pages {
        let expected = slot_page_len(batch.manifest.slot_count, *i) * SLOT_RECORD_BYTES;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "slot page",
                index: *i,
                expected,
                found: bytes.len(),
            });
        }
    }
    for (e, bytes) in &batch.chunk_extents {
        let expected = chunk_extent_len(batch.manifest.chunk_len, *e);
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "chunk extent",
                index: *e,
                expected,
                found: bytes.len(),
            });
        }
    }
    for (s, bytes) in &batch.free_segs {
        let expected = free_seg_len(batch.manifest.free_len, *s) * 4;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "free segment",
                index: *s,
                expected,
                found: bytes.len(),
            });
        }
    }

    let rows_by_page: std::collections::HashMap<u32, &Vec<u8>> =
        batch.slot_pages.iter().map(|(p, b)| (*p, b)).collect();
    let edge_pages: std::collections::HashSet<u32> =
        batch.page_edges.iter().map(|(p, _)| *p).collect();
    if let Some(&odd) = batch_pages.symmetric_difference(&edge_pages).next() {
        return Err(StoreError::SummaryMismatch { page: odd });
    }
    for (i, targets) in &batch.page_edges {
        let bytes = rows_by_page[i];
        let records = decode_slots(bytes)
            .map_err(|_| StoreError::Snapshot(SnapshotError::Corrupt("store slot page record")))?;
        if derive_page_edges(*i, &records) != *targets {
            return Err(StoreError::SummaryMismatch { page: *i });
        }
    }
    Ok(())
}

/// Apply a batch to a store's PRIOR leaf/summary state and return the
/// new root: [`check_batch`]'s admission gauntlet, then leaf/summary
/// maintenance and a FULL from-scratch root recombination against
/// `batch.manifest.root` — a mis-rooted batch fails closed, and a
/// prior leaf edited at rest fails the recombination HERE rather than
/// laundering into this commit's sealed root. This is the reference
/// commit path (Memory and File stores always take it); a backend
/// holding a live [`RootLedger`] may replace the recombination with
/// the ledger's O(dirty · log n) maintenance, trading this check's
/// at-rest-edit detection for the open-time validator's.
///
/// `pages`/`exts`/`frees`/`edges` are the PRIOR vectors (sized to the
/// stored geometry by invariant); on success they hold the new state.
pub fn apply_batch(
    pages: &mut Vec<[u8; 32]>,
    exts: &mut Vec<[u8; 32]>,
    frees: &mut Vec<[u8; 32]>,
    edges: &mut Vec<Vec<u32>>,
    prior: Option<&StoreManifest>,
    batch: &CheckpointBatch,
) -> Result<String, StoreError> {
    check_batch(
        prior.map(|p| (p, [pages.len(), exts.len(), frees.len()])),
        batch,
    )?;
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
    edges.resize(n_pages, Vec::new());
    for (i, targets) in &batch.page_edges {
        let slot = edges
            .get_mut(*i as usize)
            .ok_or(StoreError::MissingRow("page-edge summary", *i))?;
        *slot = targets.clone();
    }
    let small_leaf = leaf_hash(LEAF_SMALL, 0, &batch.small);
    let root = compute_root(&small_leaf, pages, exts, frees, edges);
    if root != batch.manifest.root {
        return Err(StoreError::BaselineMismatch {
            expected: root,
            found: batch.manifest.root.clone(),
        });
    }
    Ok(root)
}

/// The whole-on-every-commit remainder of the machine state: the value
/// stack, the slot free list, the key/name/symbol tables, the meter,
/// and (store schema 7, the side-table ledger) the bulk side tables
/// and `Symbol.for` registry. Each section reuses its atom payload
/// encoding verbatim.
#[derive(Clone, Debug, PartialEq)]
pub struct SmallState {
    pub stack: Vec<Slot>,
    pub slot_free: Vec<u32>,
    pub keys: Vec<String>,
    pub names: Vec<String>,
    /// The symbol-key id table (see [`crate::image::SymbolKeyImage`]).
    pub symbols: crate::image::SymbolKeyImage,
    pub meter: MeterImage,
    /// The arrays side table (schema 7; the `ARRY` atom's encoding).
    /// Whole-on-every-commit like the stack — O(side tables) bytes per
    /// checkpoint; dirty-diffed side-table ROWS are the named upgrade
    /// if attached machines carry bulk state wide enough to measure.
    pub arrays: Vec<crate::image::ArrayImage>,
    /// The collections side table (schema 7; the `COLL` encoding).
    pub collections: Vec<crate::image::CollectionImage>,
    /// The `Symbol.for` registry (schema 7; the `REGY` encoding).
    pub registry: Vec<crate::image::RegistryImage>,
    /// The error-data side table (schema 9; the `ERRD` encoding).
    pub errors: Vec<crate::image::ErrorImage>,
    /// The array-buffers side table (schema 10; the `ABUF` encoding).
    pub buffers: Vec<crate::image::BufferImage>,
    /// The typed-arrays side table (schema 10; the `TARR` encoding).
    pub typed_arrays: Vec<crate::image::TypedArrayImage>,
    /// The data-views side table (schema 10; the `DVIW` encoding).
    pub data_views: Vec<crate::image::DataViewImage>,
    /// The primitive-wrapper side table (schema 11; the `WRAP` encoding).
    pub wrappers: Vec<crate::image::WrapperImage>,
    /// The regexp side table (schema 11; the `REGX` encoding).
    pub regexps: Vec<crate::image::RegExpImage>,
    /// The arguments-exotic brand owners (schema 11; the `ARGB` encoding).
    pub arguments_brands: Vec<u32>,
    /// The Temporal record tables (schema 11; the `TMPR` encoding).
    pub temporal: crate::image::TemporalImage,
    /// The Intl record tables (schema 12; the `INTL` encoding).
    pub intl: ironhorse_vm::IntlTables,
    /// The installed-names floor (schema 12; the `NFLR` semantics:
    /// `None` — an empty section — restores the conservative
    /// full-table default).
    pub name_floor: Option<u32>,
}

impl SmallState {
    /// Serialize: nineteen sections, each `u32` length-prefixed, in
    /// the fixed order stack, free list, keys, names, symbols, meter,
    /// arrays, collections, registry, errors, buffers, typed arrays,
    /// data views, wrappers, regexps, arguments brands, temporal,
    /// intl, name floor
    /// (arrays/collections/registry since store schema 7 — the
    /// side-table ledger; the 6→7 migration appends them empty, a
    /// pure 12-byte suffix — errors since schema 9, the typed-array
    /// family since schema 10, the data-only language rows since
    /// schema 11, and the Intl record tables plus the installed-names
    /// floor since schema 12, whose migrations append their empty
    /// sections the same way). Since store schema v4 the free-list section is
    /// always EMPTY in stored small state — the list lives in
    /// dirty-diffed segment rows (phase 9) — but the section slot
    /// stays so the layout is stable; the atom container path still
    /// carries the list via the image, not this encoding.
    pub fn encode(&self) -> Vec<u8> {
        let sections: [Vec<u8>; 19] = [
            encode_stack(&self.stack),
            encode_u32s(&[]),
            encode_strings(&self.keys),
            encode_strings(&self.names),
            crate::image::encode_symbol_keys(&self.symbols),
            self.meter.encode(),
            crate::image::encode_arrays(&self.arrays),
            crate::image::encode_collections(&self.collections),
            crate::image::encode_registry(&self.registry),
            crate::image::encode_errors(&self.errors),
            crate::image::encode_buffers(&self.buffers),
            crate::image::encode_typed_arrays(&self.typed_arrays),
            crate::image::encode_data_views(&self.data_views),
            crate::image::encode_wrappers(&self.wrappers),
            crate::image::encode_regexps(&self.regexps),
            crate::image::encode_arguments_brands(&self.arguments_brands),
            crate::image::encode_temporal(&self.temporal),
            crate::image::encode_intl(&self.intl),
            match self.name_floor {
                Some(floor) => floor.to_be_bytes().to_vec(),
                None => Vec::new(),
            },
        ];
        let mut v = Vec::new();
        for s in sections {
            v.extend_from_slice(&(s.len() as u32).to_be_bytes());
            v.extend_from_slice(&s);
        }
        v
    }

    /// Decode the nineteen sections. Every section length is
    /// bounds-checked against the remaining payload before it is
    /// sliced.
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
        let symbols = crate::image::decode_symbol_keys(section("small state symbols section")?)
            .map_err(StoreError::Snapshot)?;
        let meter = MeterImage::decode(section("small state meter section")?)?;
        // Schema-7 sections (the side-table ledger). An EMPTY section
        // (zero length, distinct from an empty LIST's 4-byte count
        // header) is accepted as the empty table: it is exactly what
        // the 6→7 migration appends, and it keeps that append a pure
        // suffix rather than a re-encode of bytes the old root signed.
        let arrays_bytes = section("small state arrays section")?;
        let arrays = if arrays_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_arrays(arrays_bytes)?
        };
        let collections_bytes = section("small state collections section")?;
        let collections = if collections_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_collections(collections_bytes)?
        };
        let registry_bytes = section("small state registry section")?;
        let registry = if registry_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_registry(registry_bytes)?
        };
        // Schema-9 section (the error-data row), same empty-section
        // rule: the 8→9 migration appends exactly this.
        let errors_bytes = section("small state errors section")?;
        let errors = if errors_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_errors(errors_bytes)?
        };
        // Schema-10 sections (the typed-array family), same rule.
        let buffers_bytes = section("small state buffers section")?;
        let buffers = if buffers_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_buffers(buffers_bytes)?
        };
        let typed_arrays_bytes = section("small state typed-arrays section")?;
        let typed_arrays = if typed_arrays_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_typed_arrays(typed_arrays_bytes)?
        };
        let data_views_bytes = section("small state data-views section")?;
        let data_views = if data_views_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_data_views(data_views_bytes)?
        };
        // Schema-11 sections (the data-only language rows), same rule.
        let wrappers_bytes = section("small state wrappers section")?;
        let wrappers = if wrappers_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_wrappers(wrappers_bytes)?
        };
        let regexps_bytes = section("small state regexps section")?;
        let regexps = if regexps_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_regexps(regexps_bytes)?
        };
        let arguments_bytes = section("small state arguments section")?;
        let arguments_brands = if arguments_bytes.is_empty() {
            Vec::new()
        } else {
            crate::image::decode_arguments_brands(arguments_bytes)?
        };
        let temporal_bytes = section("small state temporal section")?;
        let temporal = if temporal_bytes.is_empty() {
            crate::image::TemporalImage::default()
        } else {
            crate::image::decode_temporal(temporal_bytes)?
        };
        // Schema-12 sections (the Intl record tables and the
        // installed-names floor), same rule.
        let intl_bytes = section("small state intl section")?;
        let intl = if intl_bytes.is_empty() {
            ironhorse_vm::IntlTables::default()
        } else {
            crate::image::decode_intl(intl_bytes).map_err(StoreError::Snapshot)?
        };
        let floor_bytes = section("small state name-floor section")?;
        let name_floor = match floor_bytes.len() {
            0 => None,
            4 => Some(u32::from_be_bytes([
                floor_bytes[0],
                floor_bytes[1],
                floor_bytes[2],
                floor_bytes[3],
            ])),
            _ => {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "small state name-floor section size",
                )))
            }
        };
        // A floor past the name table cannot come from an honest
        // suspension (the store mirror of `read_machine`'s check).
        if name_floor.is_some_and(|floor| floor as usize > names.len()) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "installed-names floor past the name table",
            )));
        }
        // Same exact-consumption rule as the manifest: nineteen
        // sections and nothing after them, or the small state fails
        // closed.
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
            arrays,
            collections,
            registry,
            errors,
            buffers,
            typed_arrays,
            data_views,
            wrappers,
            regexps,
            arguments_brands,
            temporal,
            intl,
            name_floor,
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
    /// How many page-edge summaries the store holds — the geometry
    /// gate the partial collector checks before deciding anything
    /// from the summaries (a truncated store must fail closed, not
    /// read as maximal garbage). Provided: counts the dense read;
    /// backends answer from metadata (the SQLite backend's
    /// `COUNT(*)`).
    fn summary_page_count(&self) -> Result<u32, StoreError> {
        Ok(self.page_edges()?.len() as u32)
    }
    /// Page reachability from `roots` over the stored summaries — the
    /// decision query of summary-driven partial collection. Provided:
    /// reads the whole edge set and BFSes in Rust (O(pages) transfer
    /// however small the answer). Backends with an indexed edge
    /// representation override it with a query whose transfer is
    /// proportional to the ANSWER — the SQLite backend serves it as a
    /// recursive CTE over its normalized pairs (phase 10), with
    /// dense/CTE parity locked by test. Roots appear in the result
    /// even when out of range (they are edgeless), on both paths.
    fn reachable_page_set(
        &self,
        roots: &[u32],
    ) -> Result<std::collections::BTreeSet<u32>, StoreError> {
        Ok(bfs_pages(&self.page_edges()?, roots.iter().copied()))
    }

    /// Re-read the manifest from DURABLE state, bypassing any cached
    /// view this handle holds.
    ///
    /// [`migrate_store`] decides each ladder step from this rather than
    /// from [`Self::manifest`]. Since `open()` stopped migrating, the
    /// gap between opening a store and upgrading it is caller-controlled
    /// and unbounded, so a handle that cached a v5 header at open can
    /// reach the ladder long after another handle upgraded the file —
    /// and splice a stale intermediate manifest onto a newer body,
    /// bricking it (review wave 5). Reading durably instead, that handle
    /// sees the current schema and correctly reports nothing to do.
    ///
    /// The default is [`Self::manifest`], which is exact for a backend
    /// that holds no cache — the in-memory and SQLite stores both read
    /// their state on every call. `FileStore`, which caches its header,
    /// overrides it.
    ///
    /// This narrows the window to the width of one ladder step; closing
    /// it entirely needs a compare-and-swap in the write, which the
    /// single-writer premise this seam documents does not pay for.
    fn reread_manifest(&self) -> Result<StoreManifest, StoreError> {
        self.manifest()
    }

    /// Replace the stored manifest VERBATIM — [`migrate_store`]'s
    /// write surface and nothing else's: it bypasses succession
    /// because a migration restamps the schema and root FORMULA of
    /// unchanged content. Implementations persist atomically. The
    /// default refuses, so read-only or exotic backends stay honest.
    fn replace_manifest_for_migration(
        &mut self,
        manifest: &StoreManifest,
    ) -> Result<(), StoreError> {
        let _ = manifest;
        Err(StoreError::Io(
            "this backend does not support in-place migration".to_string(),
        ))
    }

    /// Replace the stored manifest AND small state together, verbatim
    /// — the write surface for ladder steps that rewrite the small
    /// state (6→7's ledger-section append). One atomic write: a
    /// manifest stamped v7 must never be paired with a v6 small (its
    /// root would not recombine). Same contract and default refusal
    /// as [`Self::replace_manifest_for_migration`].
    fn replace_manifest_and_small_for_migration(
        &mut self,
        manifest: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        let _ = (manifest, small);
        Err(StoreError::Io(
            "this backend does not support in-place migration".to_string(),
        ))
    }

    /// The subset of `targets` with at least one inbound edge from a
    /// page OUTSIDE `targets` — the generational collector's
    /// old-generation seed query (an un-dirtied page's stored edges
    /// are its current edges, so an inbound edge from one is a live
    /// retention path). Dense default reads the whole edge table;
    /// indexed backends answer from the reverse index with transfer
    /// proportional to the ANSWER.
    fn externally_referenced(&self, targets: &[u32]) -> Result<Vec<u32>, StoreError> {
        let tset: std::collections::BTreeSet<u32> = targets.iter().copied().collect();
        let edges = self.page_edges()?;
        let mut hit: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        for (page, outs) in edges.iter().enumerate() {
            if tset.contains(&(page as u32)) {
                continue;
            }
            for t in outs {
                if tset.contains(t) {
                    hit.insert(*t);
                }
            }
        }
        Ok(hit.into_iter().collect())
    }

    /// Reachability from `roots` RESTRICTED to the `within` set (the
    /// generational collector's dirty-region expansion: edges leaving
    /// the region land on old pages, which the generational pass
    /// never frees, so the walk stops at the region boundary). Roots
    /// outside `within` contribute nothing. Dense default; indexed
    /// backends can serve it with a bounded recursive query.
    fn reachable_within(
        &self,
        roots: &[u32],
        within: &[u32],
    ) -> Result<std::collections::BTreeSet<u32>, StoreError> {
        let wset: std::collections::BTreeSet<u32> = within.iter().copied().collect();
        let edges = self.page_edges()?;
        let mut seen: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        let mut frontier: Vec<u32> = roots
            .iter()
            .copied()
            .filter(|r| wset.contains(r))
            .collect();
        for &r in &frontier {
            seen.insert(r);
        }
        while let Some(p) = frontier.pop() {
            if let Some(outs) = edges.get(p as usize) {
                for &t in outs {
                    if wset.contains(&t) && seen.insert(t) {
                        frontier.push(t);
                    }
                }
            }
        }
        Ok(seen)
    }
}

/// Upgrade a decodable OLDER store in place to the current schema.
/// Returns true when a migration ran, false when the store was
/// already current (or empty). Forward only — validation refuses
/// anything newer than current. v5 → v6: verify the stored FLAT
/// root (the v5 formula) over the stored leaves, recompute the v6
/// class-tree root over the SAME leaves, and stamp the manifest with
/// schema 6 and the new root. The SEAL is left exactly as stored:
/// historical seals are opaque chain links, and the next commit
/// chains from the stored seal precisely as it would have.
///
/// Restamping is authorized by the SAME callback-table signature the
/// resume path checks: a store whose signature is incompatible with
/// `expected_sig` is refused HERE, before any bytes change, so a
/// mis-pointed daemon can never one-way restamp a foreign store out
/// from under its rightful owner (review wave 4, F2). Migration
/// therefore lives with the caller that knows the signature — the
/// raw `open()` no longer runs it — and this is the reason it takes
/// `expected_sig` rather than reading only the store.
pub fn migrate_store(
    store: &mut dyn HeapStore,
    expected_sig: &Signature,
) -> Result<bool, StoreError> {
    let manifest = match store.manifest() {
        Ok(m) => m,
        Err(StoreError::Empty) => return Ok(false),
        Err(e) => return Err(e),
    };
    if manifest.store_schema == STORE_SCHEMA_VERSION {
        return Ok(false);
    }
    if !(STORE_SCHEMA_MIN_SUPPORTED..STORE_SCHEMA_VERSION).contains(&manifest.store_schema) {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "unsupported store schema version",
        )));
    }
    // Signature gate BEFORE the first restamp: only a daemon that
    // could actually resume this store (compatible callback table)
    // may upgrade it. An incompatible signature fails closed with the
    // same error `validate_store` would raise, leaving the store's
    // bytes untouched for its rightful owner.
    if !manifest.signature.is_compatible_with(expected_sig) {
        return Err(StoreError::Snapshot(SnapshotError::SignatureMismatch {
            expected: expected_sig.clone(),
            found: manifest.signature.clone(),
        }));
    }
    // The ladder: one verified in-place step at a time, each leaving a
    // COMPLETE valid store of the intermediate schema — a crash
    // between steps resumes the ladder at the next open, never a
    // half-migrated hybrid.
    let mut migrated = false;
    let mut prev_schema = None;
    loop {
        // DURABLE, not the handle's cached view: another handle may have
        // upgraded the store since this one opened it, and stepping from
        // a stale schema would splice an older manifest onto a newer body
        // (review wave 5). A backend with no cache answers identically.
        let manifest = store.reread_manifest()?;
        let schema = manifest.store_schema;
        // Progress guard: every ladder step must ADVANCE the stored
        // schema, strictly. A backend whose migration write silently
        // no-ops (returns Ok without persisting) would otherwise spin
        // here forever (review wave 4, F5) — and one that CYCLES,
        // 5→6→5→6, evaded the equal-to-previous form this replaces
        // while spinning just as hard (review wave 5). Strict advance
        // over a bounded schema range also bounds the loop by
        // construction, so no separate step counter is needed.
        if prev_schema.is_some_and(|prev| schema <= prev) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "migration did not advance the store schema",
            )));
        }
        prev_schema = Some(schema);
        match schema {
            v if v == STORE_SCHEMA_VERSION => return Ok(migrated),
            5 => migrate_v5_to_v6(store)?,
            6 => migrate_v6_to_v7(store)?,
            7 => migrate_v7_to_v8(store)?,
            8 => migrate_v8_to_v9(store)?,
            9 => migrate_v9_to_v10(store)?,
            10 => migrate_v10_to_v11(store)?,
            11 => migrate_v11_to_v12(store)?,
            _ => {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "unsupported store schema version",
                )))
            }
        }
        migrated = true;
    }
}

/// Ladder step 5→6: same leaves, new root FORMULA (flat combine →
/// per-class trees). Verifies the v5 content against its OWN flat
/// root first — never migrating what does not verify — then restamps
/// schema + v6-formula root. Small state and every row are untouched.
fn migrate_v5_to_v6(store: &mut dyn HeapStore) -> Result<(), StoreError> {
    let mut manifest = store.manifest()?;
    let small = store.read_small_state()?;
    let small_leaf = leaf_hash(LEAF_SMALL, 0, &small);
    let (pages, exts) = store.leaf_hashes()?;
    let frees = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    let old = combine_root(&small_leaf, &pages, &exts, &frees, &edges);
    if old != manifest.root {
        // Convention (matching validate_store / apply_batch): `expected`
        // is the root recomputed from content, `found` the root the
        // manifest claims (review wave 4, F4).
        return Err(StoreError::BaselineMismatch {
            expected: old,
            found: manifest.root.clone(),
        });
    }
    manifest.store_schema = 6;
    manifest.root = compute_root(&small_leaf, &pages, &exts, &frees, &edges);
    store.replace_manifest_for_migration(&manifest)
}

/// Ladder step 6→7 (the side-table ledger): the small state grows the
/// three ledger sections EMPTY — a pure 12-byte suffix of zero-length
/// section headers, provably content-preserving (nothing a v6-era
/// machine persisted lives in them). Verifies the v6 content against
/// its stored root first, then writes the new small and the restamped
/// manifest (new small leaf → new root) through the backend's one
/// atomic migration write.
fn migrate_v6_to_v7(store: &mut dyn HeapStore) -> Result<(), StoreError> {
    let mut manifest = store.manifest()?;
    let small = store.read_small_state()?;
    let (pages, exts) = store.leaf_hashes()?;
    let frees = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    let old = compute_root(&leaf_hash(LEAF_SMALL, 0, &small), &pages, &exts, &frees, &edges);
    if old != manifest.root {
        // `expected` = recomputed root, `found` = manifest's claim
        // (review wave 4, F4).
        return Err(StoreError::BaselineMismatch {
            expected: old,
            found: manifest.root.clone(),
        });
    }
    let mut new_small = small;
    new_small.extend_from_slice(&[0u8; 12]);
    manifest.store_schema = 7;
    manifest.root = compute_root(
        &leaf_hash(LEAF_SMALL, 0, &new_small),
        &pages,
        &exts,
        &frees,
        &edges,
    );
    store.replace_manifest_and_small_for_migration(&manifest, &new_small)
}

/// Ladder step 7→8 (the durable crank counter): the manifest grows one
/// `u64` tail field and nothing else moves. Content-preserving by
/// construction — the ROOT is computed over the small-state leaf and the
/// row leaves, and the manifest is in neither, so the root this step
/// writes is the root it read. The seal is left exactly as stored, like
/// every other step: historical seals are opaque chain links.
///
/// `cranks` starts at 0, which is the honest reading of a store that
/// predates the counter: it never recorded one, and a schedule derived
/// from it begins at the migration rather than pretending to a history
/// it cannot know.
fn migrate_v7_to_v8(store: &mut dyn HeapStore) -> Result<(), StoreError> {
    let mut manifest = store.manifest()?;
    let small = store.read_small_state()?;
    let (pages, exts) = store.leaf_hashes()?;
    let frees = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    let old = compute_root(&leaf_hash(LEAF_SMALL, 0, &small), &pages, &exts, &frees, &edges);
    if old != manifest.root {
        // `expected` = recomputed root, `found` = manifest's claim.
        return Err(StoreError::BaselineMismatch {
            expected: old,
            found: manifest.root.clone(),
        });
    }
    manifest.store_schema = 8;
    manifest.cranks = 0;
    // Same small state, same root — but the MANIFEST changes length, so
    // this goes through the write that can shift the file's directory
    // offsets rather than the same-length splice.
    store.replace_manifest_and_small_for_migration(&manifest, &small)
}

/// Ladder step 8→9 (the error-data row): the small state grows the one
/// `ERRD` section EMPTY — a pure 4-byte suffix of a zero-length section
/// header, provably content-preserving (nothing a v8-era machine
/// persisted lives in it: the persist gates refused any heap holding a
/// live error row). Verifies the v8 content against its stored root
/// first, then writes the new small and the restamped manifest through
/// the backend's one atomic migration write — the `migrate_v6_to_v7`
/// pattern exactly.
fn migrate_v8_to_v9(store: &mut dyn HeapStore) -> Result<(), StoreError> {
    let mut manifest = store.manifest()?;
    let small = store.read_small_state()?;
    let (pages, exts) = store.leaf_hashes()?;
    let frees = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    let old = compute_root(&leaf_hash(LEAF_SMALL, 0, &small), &pages, &exts, &frees, &edges);
    if old != manifest.root {
        // `expected` = recomputed root, `found` = manifest's claim.
        return Err(StoreError::BaselineMismatch {
            expected: old,
            found: manifest.root.clone(),
        });
    }
    let mut new_small = small;
    new_small.extend_from_slice(&[0u8; 4]);
    manifest.store_schema = 9;
    manifest.root = compute_root(
        &leaf_hash(LEAF_SMALL, 0, &new_small),
        &pages,
        &exts,
        &frees,
        &edges,
    );
    store.replace_manifest_and_small_for_migration(&manifest, &new_small)
}

/// Ladder step 9→10 (the typed-array family): the small state grows
/// the three `ABUF`/`TARR`/`DVIW` sections EMPTY — a pure 12-byte
/// suffix of zero-length section headers, provably content-preserving
/// (nothing a v9-era machine persisted lives in them: the persist
/// gates refused any heap holding a live row). The `migrate_v6_to_v7`
/// pattern exactly.
fn migrate_v9_to_v10(store: &mut dyn HeapStore) -> Result<(), StoreError> {
    let mut manifest = store.manifest()?;
    let small = store.read_small_state()?;
    let (pages, exts) = store.leaf_hashes()?;
    let frees = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    let old = compute_root(&leaf_hash(LEAF_SMALL, 0, &small), &pages, &exts, &frees, &edges);
    if old != manifest.root {
        // `expected` = recomputed root, `found` = manifest's claim.
        return Err(StoreError::BaselineMismatch {
            expected: old,
            found: manifest.root.clone(),
        });
    }
    let mut new_small = small;
    new_small.extend_from_slice(&[0u8; 12]);
    manifest.store_schema = 10;
    manifest.root = compute_root(
        &leaf_hash(LEAF_SMALL, 0, &new_small),
        &pages,
        &exts,
        &frees,
        &edges,
    );
    store.replace_manifest_and_small_for_migration(&manifest, &new_small)
}

/// Ladder step 10→11 (the data-only language rows): the small state
/// grows the four `WRAP`/`REGX`/`ARGB`/`TMPR` sections EMPTY — a pure
/// 16-byte suffix of zero-length section headers, content-preserving
/// by the same argument as every ladder step (a v10-era machine
/// persisted nothing in them: these rows were silently dropped by
/// resume, which is exactly what the carry fixes going forward). The
/// `migrate_v6_to_v7` pattern exactly.
fn migrate_v10_to_v11(store: &mut dyn HeapStore) -> Result<(), StoreError> {
    let mut manifest = store.manifest()?;
    let small = store.read_small_state()?;
    let (pages, exts) = store.leaf_hashes()?;
    let frees = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    let old = compute_root(&leaf_hash(LEAF_SMALL, 0, &small), &pages, &exts, &frees, &edges);
    if old != manifest.root {
        // `expected` = recomputed root, `found` = manifest's claim.
        return Err(StoreError::BaselineMismatch {
            expected: old,
            found: manifest.root.clone(),
        });
    }
    let mut new_small = small;
    new_small.extend_from_slice(&[0u8; 16]);
    manifest.store_schema = 11;
    manifest.root = compute_root(
        &leaf_hash(LEAF_SMALL, 0, &new_small),
        &pages,
        &exts,
        &frees,
        &edges,
    );
    store.replace_manifest_and_small_for_migration(&manifest, &new_small)
}

/// 11 → 12: the Intl record tables (the ledger's `IntlRecords`
/// graduation) and the installed-names floor join the small state.
/// Both new sections append EMPTY — a pure 8-byte suffix (two
/// zero-length section headers), content-preserving by construction:
/// the v11 persist path had no Intl atom and (before the
/// accessor-seed exemption that landed with schema 12) any
/// Intl-touching heap was refused at persist by the `accessors` gate,
/// and an absent floor restores to exactly the full-table default
/// every v11 resume already used. Verify the store against its OWN
/// root first, then restamp schema and root together.
fn migrate_v11_to_v12(store: &mut dyn HeapStore) -> Result<(), StoreError> {
    let mut manifest = store.manifest()?;
    let small = store.read_small_state()?;
    let (pages, exts) = store.leaf_hashes()?;
    let frees = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    let old = compute_root(&leaf_hash(LEAF_SMALL, 0, &small), &pages, &exts, &frees, &edges);
    if old != manifest.root {
        // `expected` = recomputed root, `found` = manifest's claim.
        return Err(StoreError::BaselineMismatch {
            expected: old,
            found: manifest.root.clone(),
        });
    }
    let mut new_small = small;
    new_small.extend_from_slice(&[0u8; 8]);
    manifest.store_schema = 12;
    manifest.root = compute_root(
        &leaf_hash(LEAF_SMALL, 0, &new_small),
        &pages,
        &exts,
        &frees,
        &edges,
    );
    store.replace_manifest_and_small_for_migration(&manifest, &new_small)
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
        // A container carries no crank history — importing one starts
        // the cadence schedule from zero, exactly like a fresh store.
        cranks: 0,
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
        arrays: image.arrays.clone(),
        collections: image.collections.clone(),
        registry: image.registry.clone(),
        errors: image.errors.clone(),
        buffers: image.buffers.clone(),
        typed_arrays: image.typed_arrays.clone(),
        data_views: image.data_views.clone(),
        wrappers: image.wrappers.clone(),
        regexps: image.regexps.clone(),
        arguments_brands: image.arguments_brands.clone(),
        temporal: image.temporal.clone(),
        intl: image.intl.clone(),
        name_floor: image.name_floor,
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
    // A full batch's summaries are dense by construction — the root's
    // edge section (v5) combines over them in page order.
    let dense_edges: Vec<Vec<u32>> = page_edges.iter().map(|(_, t)| t.clone()).collect();
    manifest.root = compute_root(
        &leaf_hash(LEAF_SMALL, 0, &small_bytes),
        &pages,
        &exts,
        &frees,
        &dense_edges,
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

/// Read a whole store back into the plain-data [`MachineImage`] — the
/// eager-reify path, and the bridge to the atom container. The inverse
/// of [`image_to_batch`] + [`HeapStore::commit`].
pub fn store_to_image(store: &dyn HeapStore) -> Result<MachineImage, StoreError> {
    let manifest = store.manifest()?;
    // Schema gate FIRST. The root below is recomputed with the CURRENT
    // formula, so a merely-old store fails the root check and gets
    // reported as `BaselineMismatch` — "this store is corrupt" — when
    // the truth is that it needs migrating. `root_hash` and
    // `export_to_container` ride this path, so that misdiagnosis reached
    // callers who had done nothing wrong (review wave 5).
    if manifest.store_schema < STORE_SCHEMA_VERSION {
        return Err(StoreError::NeedsMigration {
            found: manifest.store_schema,
        });
    }
    if manifest.store_schema > STORE_SCHEMA_VERSION {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "unsupported store schema version",
        )));
    }
    let small_bytes = store.read_small_state()?;
    let small = SmallState::decode(&small_bytes)?;
    if manifest.cost_gate_mismatch(&small) {
        return Err(StoreError::Snapshot(SnapshotError::CostTableMismatch {
            expected: COST_TABLE_VERSION.to_string(),
            found: small.meter.cost_table_version.clone(),
        }));
    }
    // The semantic bounds gate runs in TWO places: `validate_store`
    // covers the stack/side-table/symbol references on BOTH resume
    // paths (wave 5), and the HEAP rows are covered per path — the
    // full-image gate at the end of this function for the eager path
    // (wave-6 W6-14: leaf hashes prove bytes authentic-to-commit, not
    // in-arena, so a consistently-resealed hostile store passed here
    // and panicked at the first collection), and a per-page slot-ref
    // bound at the lazy fault installer (the chunk-offset half of the
    // lazy path is a recorded remainder — the slot-ref bound removes
    // the collector-panic vector).

    // Row-content integrity (phase 5, completed by the review wave):
    // every row read below — INCLUDING the small state — is checked
    // against its stored leaf hash, and the whole leaf/summary set is
    // recombined against the sealed root first, so eager reification —
    // and the export/root_hash paths riding on it, which deliberately
    // skip `validate_store` — cannot absorb a length-preserving flip
    // or a coordinated row+leaf edit at rest.
    let (leaf_pages, leaf_exts) = store.leaf_hashes()?;
    let leaf_frees_all = store.free_leaf_hashes()?;
    let edges = store.page_edges()?;
    if edges.len() != slot_page_count(manifest.slot_count) as usize {
        return Err(StoreError::SummaryCount {
            expected: slot_page_count(manifest.slot_count),
            found: edges.len() as u32,
        });
    }
    let small_leaf = leaf_hash(LEAF_SMALL, 0, &small_bytes);
    let root = compute_root(&small_leaf, &leaf_pages, &leaf_exts, &leaf_frees_all, &edges);
    if root != manifest.root {
        return Err(StoreError::BaselineMismatch {
            expected: root,
            found: manifest.root.clone(),
        });
    }

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

    let free_leaves = leaf_frees_all;
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

    crate::image::check_image_slot_bounds(
        &slots,
        &small.stack,
        &small.arrays,
        &small.collections,
        &small.registry,
        &small.errors,
        &small.buffers,
        &small.typed_arrays,
        &small.data_views,
        &crate::image::LangRows {
            wrappers: &small.wrappers,
            regexps: &small.regexps,
            arguments_brands: &small.arguments_brands,
            temporal: &small.temporal,
            intl: &small.intl,
        },
        &small.symbols,
        slots.len() as u32,
        chunks.len(),
    )
    .map_err(StoreError::Snapshot)?;

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
        arrays: small.arrays,
        collections: small.collections,
        registry: small.registry,
        errors: small.errors,
        buffers: small.buffers,
        typed_arrays: small.typed_arrays,
        data_views: small.data_views,
        wrappers: small.wrappers,
        regexps: small.regexps,
        arguments_brands: small.arguments_brands,
        temporal: small.temporal,
        intl: small.intl,
        name_floor: small.name_floor,
    })
}

impl StoreManifest {
    fn cost_gate_mismatch(&self, small: &SmallState) -> bool {
        small.meter.cost_table_version != COST_TABLE_VERSION
    }
}

/// The verified row-leaf hashes [`validate_store`] hands back so the
/// resume paths can verify every later row read against them without
/// re-trusting the store.
#[derive(Clone, Debug)]
pub struct StoreLeaves {
    pub pages: Vec<[u8; 32]>,
    pub exts: Vec<[u8; 32]>,
    pub frees: Vec<[u8; 32]>,
}

/// Validate a store exhaustively: manifest gates, signature, meter
/// cost-table version, live/free/count accounting, the full row
/// inventory (existence and exact length of every page and extent the
/// geometry promises), leaf/summary recombination against the sealed
/// root, and the reassembled free list's semantic gates. Returns the
/// manifest and decoded small state so a resume does not re-read
/// them.
///
/// This is the open-time gate that makes later read faults pure I/O
/// errors (design decision 7): after `validate_store` succeeds, every
/// row a lazy fault can ask for has been proven present and
/// well-sized.
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
    if manifest.store_schema < STORE_SCHEMA_VERSION {
        // Decodable but old: the opener runs [`migrate_store`] (with
        // the signature that authorizes the restamp) before resuming;
        // reaching here un-migrated is a caller bug or a read-only
        // surface, and fails closed by name.
        return Err(StoreError::NeedsMigration {
            found: manifest.store_schema,
        });
    }
    if manifest.store_schema > STORE_SCHEMA_VERSION {
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
    // Semantic bounds gate for everything the small state carries —
    // stack, symbols, and the four side tables — against the
    // manifest's geometry. It lives HERE, not in `store_to_image`,
    // because `validate_store` is the one function BOTH resume paths
    // run: gating the eager path alone left `resume_from_store_lazy`
    // (the path `PersistentMachine` actually opens) accepting a crafted
    // store that then panics the collector in release (review wave 5).
    // The heap ROWS are not read at validation time by design — their
    // records are bounds-checked as they fault.
    crate::image::check_image_slot_bounds(
        &[],
        &small.stack,
        &small.arrays,
        &small.collections,
        &small.registry,
        &small.errors,
        &small.buffers,
        &small.typed_arrays,
        &small.data_views,
        &crate::image::LangRows {
            wrappers: &small.wrappers,
            regexps: &small.regexps,
            arguments_brands: &small.arguments_brands,
            temporal: &small.temporal,
            intl: &small.intl,
        },
        &small.symbols,
        manifest.slot_count,
        manifest.chunk_len as usize,
    )
    .map_err(StoreError::Snapshot)?;
    // The symbol-key counter must clear the name table — the store
    // mirror of `read_machine`'s check (a counter at or below the
    // table aliases a symbol id onto a string key at restore).
    if (small.symbols.next_id as usize) <= small.names.len() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "symbol-key table: counter inside the name table",
        )));
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

    // Row-hash tree (phase 5) + page-edge summaries (v5): the stored
    // leaves AND summaries must recombine to the manifest's sealed
    // root — metadata-scale (32 bytes per leaf, a few words per
    // summary). Row CONTENT is then verified against these leaves at
    // the point of read (eager reify or lazy fault), so a
    // length-preserving flip at rest — in a row, a leaf, or a
    // summary — can never resume a different machine or shrink the
    // partial collector's reachability.
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
    let edges = store.page_edges()?;
    if edges.len() != n_pages as usize {
        return Err(StoreError::SummaryCount {
            expected: n_pages,
            found: edges.len() as u32,
        });
    }
    let small_leaf = leaf_hash(LEAF_SMALL, 0, &small_bytes);
    let root = compute_root(&small_leaf, &leaf_pages, &leaf_exts, &leaf_frees, &edges);
    if root != manifest.root {
        return Err(StoreError::BaselineMismatch {
            expected: root,
            found: manifest.root.clone(),
        });
    }

    // Reassemble the free list from its segment rows (phase 9), each
    // verified against its leaf; the accounting checks above already
    // ran against this list. This is the one O(free-list) exception
    // to the metadata-only row discipline above: the machine needs
    // the list in memory at wake, so the read is inherent, not
    // incidental (the review's honesty note on the "no O(heap) row
    // I/O" claim).
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
    // The blob half of the id-space audit: nothing may ADOPT a
    // container whose heap stores a property id outside both key
    // tables — crafted or torn bytes, or a pre-unification blob that
    // persisted a then-unresumable intern (review wave 5). The scan is
    // O(heap) and this path already decoded the whole image.
    if image.stored_unregistered_key_id().is_some() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "stored property id outside the name and symbol-key tables",
        )));
    }
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
    /// Free-list segment rows written — the phase-9 proportionality
    /// axis (LIFO churn must rewrite only the tail segment), which
    /// the review found asserted in prose and observed by nothing.
    pub free_segs_written: usize,
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

    fn replace_manifest_for_migration(
        &mut self,
        manifest: &StoreManifest,
    ) -> Result<(), StoreError> {
        self.manifest = Some(manifest.clone());
        Ok(())
    }

    fn replace_manifest_and_small_for_migration(
        &mut self,
        manifest: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        self.manifest = Some(manifest.clone());
        self.small = small.to_vec();
        Ok(())
    }

    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        Ok(self.small.clone())
    }

    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        // Empty-store gate for point-read parity across backends: an
        // uncommitted store is `Empty`; `MissingRow` means a committed
        // store lacks the row (the review's parity table).
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        self.slot_pages
            .get(&page)
            .cloned()
            .ok_or(StoreError::MissingRow("slot page", page))
    }

    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
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
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
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
        // The shared per-commit verification (grown-region presence,
        // row lengths, summary coupling, leaf/summary maintenance,
        // root recombination) runs on CLONES first — a refused batch
        // must leave the store untouched.
        let pages = slot_page_count(batch.manifest.slot_count);
        let exts = chunk_extent_count(batch.manifest.chunk_len);
        let mut leaf_pages = self.leaf_pages.clone();
        let mut leaf_exts = self.leaf_exts.clone();
        let mut leaf_frees = self.leaf_frees.clone();
        let mut edges = self.edges.clone();
        apply_batch(&mut leaf_pages, &mut leaf_exts, &mut leaf_frees, &mut edges, self.manifest.as_ref(), batch)?;
        for (page, bytes) in &batch.slot_pages {
            self.slot_pages.insert(*page, bytes.clone());
        }
        for (ext, bytes) in &batch.chunk_extents {
            self.chunk_extents.insert(*ext, bytes.clone());
        }
        self.leaf_pages = leaf_pages;
        self.leaf_exts = leaf_exts;
        self.leaf_frees = leaf_frees;
        self.edges = edges;
        for (seg, bytes) in &batch.free_segs {
            self.free_segs.insert(*seg, bytes.clone());
        }
        let n_frees = free_seg_count(batch.manifest.free_len);
        self.free_segs.retain(|&s, _| s < n_frees);
        // Drop rows beyond the new geometry (chunk shrink across a GC
        // compaction; slot pages are monotone but the sweep is uniform).
        self.slot_pages.retain(|&p, _| p < pages);
        self.chunk_extents.retain(|&e, _| e < exts);
        self.small = batch.small.clone();
        self.manifest = Some(batch.manifest.clone());
        self.last_commit = CommitStats {
            slot_pages_written: batch.slot_pages.len(),
            chunk_extents_written: batch.chunk_extents.len(),
            free_segs_written: batch.free_segs.len(),
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
            cranks: 41,
            root: "r00t".to_string(),
            seal: "abc123".to_string(),
        };
        let bytes = m.encode();
        let back = StoreManifest::decode(&bytes).unwrap();
        assert_eq!(back, m);
        assert_eq!(back.cranks, 41, "the schema-8 crank counter round-trips");

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
            symbols: crate::image::SymbolKeyImage {
                next_id: u16::MAX - 2,
                pairs: vec![(u16::MAX - 1, 11), (u16::MAX, 22)],
            },
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
            arguments_brands: Vec::new(),
            temporal: crate::image::TemporalImage::default(),
            intl: ironhorse_vm::IntlTables::default(),
            name_floor: None,
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
            symbols: crate::image::SymbolKeyImage::default(),
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
            arguments_brands: Vec::new(),
            temporal: crate::image::TemporalImage::default(),
            intl: ironhorse_vm::IntlTables::default(),
            name_floor: None,
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

        // Same machine state, chunk arena "compacted" to empty. A real
        // compaction rewrites every stored chunk offset with the bytes
        // it moves; mirror that coherence (the wave-6 W6-14 heap gate
        // refuses an image whose slots point into chunks it lacks) by
        // degrading chunk-bearing slots to chunk-free values in place —
        // chain links, ids, and accounting untouched.
        let mut shrunk = image.clone();
        shrunk.chunks = Vec::new();
        for slot in shrunk.slots.iter_mut().chain(shrunk.stack.iter_mut()) {
            if slot.chunk_ref().is_some() {
                slot.kind = ironhorse_vm::Kind::Integer;
                slot.value = ironhorse_vm::Payload::Integer(0);
            }
        }
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
                free_segs_written: batch.free_segs.len(),
            }
        );
    }

    /// The segment split at exactly the `FREE_SEG_ENTRIES` boundary
    /// (and one past it, and empty): counts, per-segment lengths, and
    /// ORDER-exact reassembly — the LIFO reuse order is load-bearing
    /// (review follow-up: the 4096/4097 edges had no direct lock).
    #[test]
    fn free_seg_boundaries_split_and_reassemble_exactly() {
        let b = FREE_SEG_ENTRIES;
        for n in [0u32, 1, b - 1, b, b + 1, 2 * b, 2 * b + 1] {
            let free: Vec<u32> = (0..n).rev().collect();
            let segs = encode_all_free_segs(&free);
            assert_eq!(segs.len(), free_seg_count(n) as usize, "count at n={n}");
            let mut back: Vec<u32> = Vec::new();
            for (k, (idx, bytes)) in segs.iter().enumerate() {
                assert_eq!(*idx as usize, k, "dense ascending segment indices");
                assert_eq!(
                    bytes.len(),
                    free_seg_len(n, *idx) * 4,
                    "exact per-segment length at n={n}, seg={idx}"
                );
                back.extend(
                    bytes
                        .chunks_exact(4)
                        .map(|c| u32::from_be_bytes(c.try_into().unwrap())),
                );
            }
            assert_eq!(back, free, "order-exact reassembly at n={n}");
        }
    }

    #[test]
    fn commit_refuses_a_geometry_change_that_omits_the_affected_tail_row() {
        // The second review pass's finding: the grown-region check
        // covers indexes the new geometry ADDS, but a total that
        // changes WITHIN the existing tail row changes that row's
        // geometry-derived length without adding any index. A crafted
        // batch that shrinks `chunk_len` inside the same extent,
        // omits that extent, and seals correctly over the retained
        // prior leaf must be refused at COMMIT — not discovered at
        // the next open as a length mismatch.
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image(&sig());
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image1, 1, "")).unwrap();
        let prev = store.manifest().unwrap();

        let mut image2 = image1.clone();
        assert!(
            image2.chunks.len() >= 8,
            "fixture carries chunk bytes to shrink within the tail extent"
        );
        image2.chunks.truncate(image2.chunks.len() - 4);
        let tail_ext = chunk_extent_count(image2.chunks.len() as u64) - 1;

        // A well-formed batch for the shrunk image commits fine (the
        // tail extent travels with its new length)…
        let good = image_to_batch(&image2, 2, &prev.seal);
        assert!(
            good.chunk_extents.iter().any(|(e, _)| *e == tail_ext),
            "image_to_batch ships the affected tail extent"
        );
        {
            let mut s2 = MemoryStore::new();
            s2.commit(&image_to_batch(&image1, 1, "")).unwrap();
            s2.commit(&image_to_batch(&image2, 2, &prev.seal)).unwrap();
        }

        // …but the same batch with the tail extent OMITTED (and the
        // seal recomputed, so succession passes) is refused with the
        // precise missing-row error.
        let mut crafted = image_to_batch(&image2, 2, &prev.seal);
        crafted.chunk_extents.retain(|(e, _)| *e != tail_ext);
        reseal_batch(&mut crafted);
        assert_eq!(
            store.commit(&crafted),
            Err(StoreError::MissingRow("chunk extent", tail_ext)),
            "the boundary row must travel when its expected length changes"
        );
    }

    #[test]
    fn class_tree_incremental_equals_scratch() {
        // The v6 property lock: updating dirty paths in place agrees
        // with a from-scratch build, across widths (odd, power-of-two,
        // single, empty) and dirt patterns — the equivalence every
        // incremental commit rests on.
        let leaf = |i: u32, salt: u8| -> [u8; 32] { leaf_hash(salt, i, &i.to_be_bytes()) };
        for width in [0u32, 1, 2, 3, 4, 5, 7, 8, 9, 63, 64, 65, 200] {
            let mut leaves: Vec<[u8; 32]> = (0..width).map(|i| leaf(i, b'a')).collect();
            let mut levels = build_class_tree(TREE_PAGES, &leaves);
            let scratch_root = class_tree_root(TREE_PAGES, &leaves, &levels);
            // Deterministic pseudo-dirt: every third index, then the
            // edges, then a single middle index.
            for dirt in [
                (0..width).step_by(3).collect::<Vec<u32>>(),
                if width > 0 { vec![0, width - 1] } else { vec![] },
                if width > 2 { vec![width / 2] } else { vec![] },
            ] {
                if dirt.is_empty() {
                    continue;
                }
                for &i in &dirt {
                    leaves[i as usize] = leaf(i, b'b');
                }
                update_class_tree(TREE_PAGES, &leaves, &mut levels, &dirt);
                let expect_levels = build_class_tree(TREE_PAGES, &leaves);
                assert_eq!(levels, expect_levels, "width {width}, dirt {dirt:?}");
                assert_eq!(
                    class_tree_root(TREE_PAGES, &leaves, &levels),
                    class_tree_root(TREE_PAGES, &leaves, &expect_levels),
                );
            }
            let _ = scratch_root;
        }
    }

    #[test]
    fn class_trees_are_domain_separated() {
        let leaves: Vec<[u8; 32]> = (0..5).map(|i| leaf_hash(b'z', i, b"x")).collect();
        let a = class_tree_root(TREE_PAGES, &leaves, &build_class_tree(TREE_PAGES, &leaves));
        let b = class_tree_root(TREE_EXTS, &leaves, &build_class_tree(TREE_EXTS, &leaves));
        assert_ne!(a, b, "same leaves, different class tags, different roots");
        assert_ne!(
            tree_empty_root(TREE_PAGES),
            tree_empty_root(TREE_EXTS),
            "empty roots are tagged too"
        );
    }

    #[test]
    fn root_ledger_apply_equals_scratch_recombination() {
        // The V6-c lock: a ledger advanced by `apply` agrees with a
        // from-scratch `compute_root` over hand-patched full vectors,
        // across geometry changes (grow, shrink, stable width) and
        // dirt in every class. The manifest is a real one with its
        // geometry fields overridden — only the counts drive the math.
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image = m.snapshot_image(&sig());
        let template = image_to_batch(&image, 1, "").manifest;

        let leaf_bytes = |i: u32, salt: u8| -> Vec<u8> { vec![salt, i as u8, (i >> 8) as u8] };
        let mut small = b"small-0".to_vec();
        let mut pages: Vec<[u8; 32]> = Vec::new();
        let mut exts: Vec<[u8; 32]> = Vec::new();
        let mut frees: Vec<[u8; 32]> = Vec::new();
        let mut edges: Vec<Vec<u32>> = Vec::new();
        let mut ledger = RootLedger::build(
            &small,
            pages.clone(),
            exts.clone(),
            frees.clone(),
            &edges,
        );

        // (n_pages, n_exts, n_frees, salt): grow from empty, grow
        // more, stable-width dirt, shrink, mixed.
        for (step, &(n_pages, n_exts, n_frees, salt)) in [
            (3u32, 2u32, 1u32, b'a'),
            (8, 5, 4, b'b'),
            (8, 5, 4, b'c'),
            (2, 1, 1, b'd'),
            (5, 5, 2, b'e'),
        ]
        .iter()
        .enumerate()
        {
            let mut manifest = template.clone();
            manifest.slot_count = n_pages * SLOTS_PER_PAGE;
            manifest.chunk_len = n_exts as u64 * CHUNK_EXTENT_BYTES as u64;
            manifest.free_len = n_frees * FREE_SEG_ENTRIES;
            small = format!("small-{salt}").into_bytes();

            // Dirt: every grown row (the admission rule), plus row 0
            // of each nonempty class on stable steps.
            let dirty_rows = |prior: usize, n: u32| -> Vec<u32> {
                let mut v: Vec<u32> = (prior as u32..n).collect();
                if v.is_empty() && n > 0 {
                    v.push(0);
                }
                v
            };
            let slot_rows: Vec<(u32, Vec<u8>)> = dirty_rows(pages.len().min(n_pages as usize), n_pages)
                .into_iter()
                .map(|i| (i, leaf_bytes(i, salt)))
                .collect();
            let ext_rows: Vec<(u32, Vec<u8>)> = dirty_rows(exts.len().min(n_exts as usize), n_exts)
                .into_iter()
                .map(|i| (i, leaf_bytes(i, salt ^ 1)))
                .collect();
            let free_rows: Vec<(u32, Vec<u8>)> = dirty_rows(frees.len().min(n_frees as usize), n_frees)
                .into_iter()
                .map(|i| (i, leaf_bytes(i, salt ^ 2)))
                .collect();
            let edge_rows: Vec<(u32, Vec<u32>)> = slot_rows
                .iter()
                .map(|(i, _)| (*i, vec![*i, i + salt as u32]))
                .collect();

            // Model: hand-patch the full vectors.
            pages.resize(n_pages as usize, [0u8; 32]);
            exts.resize(n_exts as usize, [0u8; 32]);
            frees.resize(n_frees as usize, [0u8; 32]);
            edges.resize(n_pages as usize, Vec::new());
            for (i, b) in &slot_rows {
                pages[*i as usize] = leaf_hash(LEAF_PAGE, *i, b);
            }
            for (i, b) in &ext_rows {
                exts[*i as usize] = leaf_hash(LEAF_EXT, *i, b);
            }
            for (i, b) in &free_rows {
                frees[*i as usize] = leaf_hash(LEAF_FREE, *i, b);
            }
            for (i, t) in &edge_rows {
                edges[*i as usize] = t.clone();
            }
            let scratch = compute_root(
                &leaf_hash(LEAF_SMALL, 0, &small),
                &pages,
                &exts,
                &frees,
                &edges,
            );
            let incremental = ledger
                .apply(&manifest, &small, &slot_rows, &ext_rows, &free_rows, &edge_rows)
                .unwrap();
            assert_eq!(incremental, scratch, "step {step}");
            assert_eq!(ledger.root(), scratch, "step {step} re-read");
            assert_eq!(ledger.widths(), [
                n_pages as usize,
                n_exts as usize,
                n_frees as usize
            ]);
        }

        // An out-of-range row fails closed instead of panicking.
        let manifest = {
            let mut m2 = template.clone();
            m2.slot_count = 2 * SLOTS_PER_PAGE;
            m2.chunk_len = 0;
            m2.free_len = 0;
            m2
        };
        assert_eq!(
            ledger.apply(&manifest, &small, &[(9, vec![1])], &[], &[], &[]),
            Err(StoreError::MissingRow("slot page", 9)),
        );
    }

    #[test]
    fn root_ledger_tracks_real_batches() {
        // Tie the ledger to the real pipeline: build from the epoch-1
        // batch's rows, then apply the epoch-2 batch — the ledger's
        // root must equal the root `image_to_batch` computed and the
        // store accepted.
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image(&sig());
        let mut store = MemoryStore::new();
        let batch1 = image_to_batch(&image1, 1, "");
        store.commit(&batch1).unwrap();

        let mut ledger = RootLedger::build(&batch1.small, Vec::new(), Vec::new(), Vec::new(), &[]);
        let root1 = ledger
            .apply(
                &batch1.manifest,
                &batch1.small,
                &batch1.slot_pages,
                &batch1.chunk_extents,
                &batch1.free_segs,
                &batch1.page_edges,
            )
            .unwrap();
        assert_eq!(root1, batch1.manifest.root);

        assert!(m.run(&PROG_A).completed, "second crank grows the heap");
        let image2 = m.snapshot_image(&sig());
        let batch2 = image_to_batch(&image2, 2, &store.manifest().unwrap().seal);
        store.commit(&batch2).unwrap();
        let root2 = ledger
            .apply(
                &batch2.manifest,
                &batch2.small,
                &batch2.slot_pages,
                &batch2.chunk_extents,
                &batch2.free_segs,
                &batch2.page_edges,
            )
            .unwrap();
        assert_eq!(root2, batch2.manifest.root);
        assert_eq!(root2, store.manifest().unwrap().root);
    }

    #[test]
    fn commit_refuses_a_desynced_prior_leaf_baseline() {
        // The wave-3 coupling assertion: the grown-region checks key
        // off the prior LEAF VECTORS' lengths while the boundary
        // checks key off the prior MANIFEST's geometry. The backends
        // keep the two equal by construction; `apply_batch` itself
        // now refuses a caller whose baselines disagree instead of
        // letting its two checks require different rows.
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image(&sig());
        let mut store = MemoryStore::new();
        store.commit(&image_to_batch(&image1, 1, "")).unwrap();
        let prev = store.manifest().unwrap();

        let batch = image_to_batch(&image1, 2, &prev.seal);
        let mut pages = store.leaf_pages.clone();
        let mut exts = store.leaf_exts.clone();
        let mut frees = store.leaf_frees.clone();
        let mut edges = store.edges.clone();
        pages.pop(); // desync: one leaf short of the manifest's geometry
        assert_eq!(
            apply_batch(
                &mut pages,
                &mut exts,
                &mut frees,
                &mut edges,
                Some(&prev),
                &batch
            ),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "prior leaf tables disagree with the prior manifest geometry"
            ))),
        );
    }

}
