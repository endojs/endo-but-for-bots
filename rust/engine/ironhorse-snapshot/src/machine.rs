//! The **`Machine`-level snapshot surface** (stage-6 child 3): the
//! xsnap-shaped `write_snapshot_to_file` / `from_snapshot_file` /
//! `suspend_to_cas` verbs the daemon supervisor's suspend/resume and CAS
//! integration call (design `designs/daemon-xs-worker-snapshot.md`). It
//! matches, verb-for-verb, what the `xsnap` crate exposes today
//! (`rust/endo/xsnap/src/lib.rs`), so the embedder swaps the C engine for
//! ironhorse without touching the supervisor:
//!
//! - [`MachineSnapshot::write_snapshot_to_file`] — stream the machine's
//!   heap image to a file, computing SHA-256 on the fly, returning the hex
//!   digest.
//! - [`MachineSnapshot::suspend_to_cas`] — write to a temp file in the CAS
//!   directory then rename to `{cas_dir}/{sha256_hex}` (the atomic CAS
//!   publish), returning the digest the supervisor holds as an ephemeral
//!   GC root.
//! - [`from_snapshot_file`] / [`resume_from_cas`] — rebuild a live machine
//!   from a snapshot file / a CAS-stored blob.
//!
//! **Why a trait, not inherent methods.** The `Interp`↔image conversion
//! stays in the engine (`ironhorse_vm`, via its `stack_slots`/`meter_state`/
//! `restore_snapshot_state` primitives) while the `XS_M` atom *format*
//! stays here — and `ironhorse_vm` cannot depend on `ironhorse-snapshot` (the
//! dependency runs the other way). So the surface is an **extension
//! trait** on `Interp`, giving `interp.write_snapshot_to_file(…)`
//! ergonomics from the crate that can see both the engine and the format.
//! Construction (`from_snapshot_file`/`resume_from_cas`) cannot be an
//! inherent `Interp::` associated function across the crate boundary, so
//! it is a free function here that returns an `Interp`.
//!
//! ## Suspend-point contract (job spec item 4 — the honest narrower shape)
//!
//! A snapshot is taken at **machine quiescence — between top-level `run`
//! cranks**, never mid-dispatch. This is not a shortcut; it is exactly the
//! `fxWriteSnapshot` constraint (design § Constraints: "outside any XS
//! callback … the machine must be quiescent — no running JS") and exactly
//! the xsnap embedding, which snapshots between deliveries. ironhorse's
//! `Interp::run` is atomic per crank: it runs a program to its `END` (and
//! drains the promise-job queue) and returns to the host with the value
//! stack unwound. The suspend point is that return.
//!
//! What the round-trip carries today: the index arenas (`HEAP`/`BLOC`),
//! the value stack (`STAC`, empty at quiescence), the program symbol names
//! (`NAME`), and the **metering state** (`METR` — accumulated computrons,
//! the check interval/threshold, and the frozen cost-table version). A
//! machine whose reachable state is confined to those atoms round-trips
//! **exactly**, and a resumed machine continues a following crank
//! identically to one that never suspended — including its computron
//! count (the row-6 bar).
//!
//! What it does **not** carry yet: the rich per-instance side tables
//! enumerated `Pending` in [`crate::sidetable`] (closures, generators,
//! promises, collections, …). A machine holding a **live generator or
//! promise across the suspend** is the honest narrower contract: those
//! tables are the enumerated remaining work, not a silent gap. The
//! meter-continuity tests therefore suspend at crank boundaries with
//! closures fully resolved, exactly where the contract holds.

use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

use crate::format::{Signature, SnapshotError};
use crate::image::{read_machine, write_machine, MachineImage, MeterImage};
use crate::sha256::{hex, Sha256};
use crate::store::{
    chunk_extent_count, combine_root, derive_page_edges, image_to_batch, leaf_hash, seal_commit,
    slot_page_count, store_to_image, validate_store, CheckpointBatch, HeapStore, SmallState,
    StoreError, StoreLeaves, StoreManifest, LEAF_EXT, LEAF_PAGE, LEAF_SMALL,
    STORE_SCHEMA_VERSION,
};
use ironhorse_vm::Interp;

/// An error from the file/CAS snapshot surface: either an I/O failure or a
/// container decode/validation failure. (Kept distinct from
/// [`SnapshotError`], which is pure decode and stays `Eq`; `io::Error` is
/// not `Eq`.)
#[derive(Debug)]
pub enum MachineSnapshotError {
    Io(io::Error),
    Snapshot(SnapshotError),
}

impl std::fmt::Display for MachineSnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MachineSnapshotError::Io(e) => write!(f, "snapshot io error: {e}"),
            MachineSnapshotError::Snapshot(e) => write!(f, "snapshot decode error: {e:?}"),
        }
    }
}

impl std::error::Error for MachineSnapshotError {}

impl From<io::Error> for MachineSnapshotError {
    fn from(e: io::Error) -> Self {
        MachineSnapshotError::Io(e)
    }
}
impl From<SnapshotError> for MachineSnapshotError {
    fn from(e: SnapshotError) -> Self {
        MachineSnapshotError::Snapshot(e)
    }
}

/// The name of the temp file `suspend_to_cas` writes before the atomic
/// rename to its content hash.
const CAS_TMP_NAME: &str = ".snapshot.tmp";

/// The xsnap-shaped machine snapshot surface, implemented for the ironhorse
/// [`Interp`] (the engine's machine). See the module docs.
pub trait MachineSnapshot {
    /// Build the plain-data [`MachineImage`] of this machine under
    /// `signature` (its host callback-table version) — the arenas, the
    /// value stack, the program symbol names, and the metering state.
    fn snapshot_image(&self, signature: &Signature) -> MachineImage;

    /// Serialize this machine to the in-memory `XS_M` container bytes.
    fn write_snapshot(&self, signature: &Signature) -> Vec<u8> {
        write_machine(&self.snapshot_image(signature))
    }

    /// Write this machine's heap snapshot to `file`, computing SHA-256 on
    /// the fly, and return the hex digest. The digest is fed the bytes as
    /// they are written, and the file is flushed and synced before return,
    /// so the caller may safely rename it into the CAS (the
    /// [`Self::suspend_to_cas`] contract).
    fn write_snapshot_to_file(
        &self,
        signature: &Signature,
        file: File,
    ) -> Result<String, MachineSnapshotError> {
        let bytes = self.write_snapshot(signature);
        let mut hasher = Sha256::new();
        let mut file = file;
        // Stream the serialized image to disk in chunks, hashing on the
        // way — the digest is never computed over a re-buffered copy.
        for chunk in bytes.chunks(64 * 1024) {
            hasher.update(chunk);
            file.write_all(chunk)?;
        }
        file.flush()?;
        file.sync_all()?;
        Ok(hex(&hasher.finalize()))
    }

    /// Write this machine's snapshot into the CAS directory `cas_dir`: to a
    /// temp file, then atomically rename it to `{cas_dir}/{sha256_hex}`.
    /// Returns the hex digest (the CAS key the supervisor records as an
    /// ephemeral GC root while the worker is suspended).
    fn suspend_to_cas(
        &self,
        signature: &Signature,
        cas_dir: &Path,
    ) -> Result<String, MachineSnapshotError> {
        std::fs::create_dir_all(cas_dir)?;
        let tmp_path = cas_dir.join(CAS_TMP_NAME);
        let file = File::create(&tmp_path)?;
        let hash = self.write_snapshot_to_file(signature, file)?;
        let final_path = cas_dir.join(&hash);
        std::fs::rename(&tmp_path, &final_path)?;
        // Durable publish: the rename is final only once the CAS
        // directory itself is synced (same discipline as the file
        // store's commit).
        File::open(cas_dir)?.sync_all()?;
        Ok(hash)
    }
}

impl MachineSnapshot for Interp {
    fn snapshot_image(&self, signature: &Signature) -> MachineImage {
        // The carried atoms (see the suspend-point contract): arenas +
        // stack + program symbol names + meter. Runtime-interned keys
        // (KEYS) and well-known symbol identities (SYMB) are among the
        // enumerated `Pending` remainder for now, so they travel empty.
        MachineImage::from_arenas(
            signature.clone(),
            &self.slots,
            &self.chunks,
            self.stack_slots(),
            self.program_symbol_names().to_vec(),
            Vec::new(),
            Vec::new(),
        )
        .with_meter(self.meter_state())
    }
}

/// Rebuild a live [`Interp`] from a decoded [`MachineImage`]: a fresh
/// boot machine with the image's serializable state reinstated (the
/// arenas, stack, program symbol names, and metering state). The
/// boot-derived intrinsics/prototypes come from the fresh boot at their
/// deterministic slot indices, matching the image's boot region. See
/// [`Interp::restore_snapshot_state`].
pub fn image_to_interp(image: MachineImage) -> Interp {
    let meter = image.meter.to_state();
    let (slots, chunks) = image.to_arenas();
    let mut interp = Interp::new();
    interp.restore_snapshot_state(slots, chunks, image.stack, image.names, meter);
    interp
}

/// Rebuild a machine from `XS_M` container bytes, enforcing the ironhorse
/// `VERS` discriminator, the callback-table `SIGN` signature, and the
/// cost-table version (all fail closed). The metering analogue of
/// `fxReadSnapshot`'s signature gate is the `METR` cost-table check.
pub fn from_snapshot_bytes(buf: &[u8], expected_sig: &Signature) -> Result<Interp, SnapshotError> {
    let image = read_machine(buf, expected_sig)?;
    Ok(image_to_interp(image))
}

/// Rebuild a machine from a snapshot file. Streams the file into memory,
/// then decodes and reinstates it (the arenas are already an in-memory
/// image; the on-the-fly discipline that matters for the CAS is on the
/// *write* path, where the digest is computed without re-buffering).
pub fn from_snapshot_file(
    mut file: File,
    expected_sig: &Signature,
) -> Result<Interp, MachineSnapshotError> {
    use std::io::Read;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    Ok(from_snapshot_bytes(&buf, expected_sig)?)
}

/// Restore a machine from a CAS-stored snapshot blob (`{cas_dir}/{sha256}`).
pub fn resume_from_cas(
    cas_dir: &Path,
    sha256: &str,
    expected_sig: &Signature,
) -> Result<Interp, MachineSnapshotError> {
    let path = cas_dir.join(sha256);
    let file = File::open(&path)?;
    from_snapshot_file(file, expected_sig)
}

// --- the store-backed checkpoint surface (store seam design, phase 2)
//
// The blob verbs above serialize the whole heap every time; these
// verbs pair a machine with a `HeapStore` so that after one full
// write, every later checkpoint commits only the pages and extents the
// machine actually dirtied since the previous one. Same suspend-point
// contract as the blob path: a checkpoint is taken at machine
// quiescence between cranks, never mid-dispatch.

/// A machine's binding to one store: the session **owns the machine**,
/// so a dirty set can only ever be committed by the session that
/// watched it accumulate — the machine/session mispairing and the
/// dirty-bit theft the adversarial review demonstrated (a second
/// session over the same machine consuming bits another store still
/// needed) are unrepresentable, not merely guarded. The session also
/// records the store's commit seal, and every checkpoint verifies the
/// stored (epoch, seal) pair before committing: an equal-epoch fork,
/// copy, or foreign store fails closed with
/// [`StoreError::BaselineMismatch`].
///
/// Obtained from [`begin_store_session`] (full first write into an
/// empty store) or [`resume_from_store`]/[`resume_from_store_lazy`]
/// (adopting a store's content). [`StoreSession::into_machine`]
/// unbinds — after which the machine's dirty bits no longer describe
/// any store baseline, and the only safe re-binding is a fresh full
/// write or a resume.
/// The live (epoch, seal) pin a lazily resumed machine's page source
/// checks on every fault. Shared between the session (which advances
/// it on its own successful checkpoints) and the [`StorePageSource`]
/// (which refuses to fault once the store no longer matches it — a
/// store advanced by anyone ELSE means torn reads, and the machine
/// must die deterministically rather than mix epochs).
struct LazyPin {
    epoch: std::cell::Cell<u64>,
    seal: std::cell::RefCell<String>,
    /// Address of the pinned store's data (the `S` inside the
    /// `Rc<RefCell<S>>` the page source reads through). The session
    /// advances the pin after a commit only when the committed store
    /// IS the pinned store — a commit into a byte-identical twin store
    /// passes succession, but advancing the pin would wedge the next
    /// fault (the PR-review finding). Compared by address rather than
    /// by re-reading the manifest because during a same-store commit
    /// the caller necessarily holds the `RefCell`'s mutable borrow to
    /// pass `&mut dyn HeapStore`, so any probe through the `RefCell`
    /// would re-enter it. The `Rc` held by the page source keeps the
    /// allocation alive for the pin's whole lifetime, so the address
    /// cannot be recycled. A caller that commits through a forwarding
    /// wrapper around the pinned store fails the comparison and the
    /// pin stays put; the next fault then fails closed (deterministic
    /// named panic) rather than reading across epochs.
    store_addr: *const (),
}

pub struct StoreSession {
    interp: Interp,
    epoch: u64,
    seal: String,
    /// Present on lazily resumed sessions: advancing it on checkpoint
    /// is what lets the machine keep faulting after its own commits
    /// (its non-dirty rows are unchanged by its own checkpoint).
    pin: Option<std::rc::Rc<LazyPin>>,
}

impl std::fmt::Debug for StoreSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreSession")
            .field("epoch", &self.epoch)
            .field("seal", &self.seal)
            .finish_non_exhaustive()
    }
}

impl StoreSession {
    /// The store epoch this session last committed or adopted.
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    /// The bound machine.
    pub fn machine(&self) -> &Interp {
        &self.interp
    }

    /// The bound machine, mutably (run cranks through this).
    pub fn machine_mut(&mut self) -> &mut Interp {
        &mut self.interp
    }

    /// Unbind, discarding the store baseline. The returned machine's
    /// dirty bits are meaningless as an incremental baseline.
    pub fn into_machine(self) -> Interp {
        self.interp
    }
}

/// The manifest of the machine's current arenas at `epoch`. The field
/// formulas are exactly [`MachineImage::from_arenas`]'s, so a store
/// checkpointed incrementally exports byte-identically to a blob
/// written by [`MachineSnapshot::write_snapshot`].
fn manifest_of(interp: &Interp, signature: &Signature, epoch: u64) -> StoreManifest {
    StoreManifest {
        version: crate::format::Version::current(),
        store_schema: STORE_SCHEMA_VERSION,
        signature: signature.clone(),
        creation: crate::image::CreationParams {
            initial_slot_count: interp.slots.capacity(),
            initial_chunk_bytes: interp.chunks.byte_size() as u32,
        },
        slot_count: interp.slots.capacity(),
        slot_live: interp.slots.live_count(),
        chunk_len: interp.chunks.byte_size() as u64,
        free_len: interp.slots.free_list().len() as u32,
        epoch,
        root: String::new(),
        seal: String::new(),
    }
}

/// The machine's small state, mirroring [`MachineSnapshot::snapshot_image`]
/// exactly (keys and well-known-symbol identities travel empty per the
/// current side-table coverage).
fn small_state_of(interp: &Interp) -> SmallState {
    SmallState {
        stack: interp.stack_slots().to_vec(),
        slot_free: interp.slots.free_list().to_vec(),
        keys: Vec::new(),
        names: interp.program_symbol_names().to_vec(),
        symbols: Vec::new(),
        meter: MeterImage::of(interp.meter_state()),
    }
}

/// Bind a machine to an **empty** store with a full epoch-1 write and
/// return the session for later incremental checkpoints. A store that
/// already holds an epoch is refused ([`StoreError::NotEmpty`]) —
/// adopting existing content is [`resume_from_store`]'s job.
pub fn begin_store_session(
    mut interp: Interp,
    signature: &Signature,
    store: &mut dyn HeapStore,
) -> Result<StoreSession, (Interp, StoreError)> {
    match store.manifest() {
        Err(StoreError::Empty) => {}
        Ok(m) => return Err((interp, StoreError::NotEmpty { epoch: m.epoch })),
        Err(e) => return Err((interp, e)),
    }
    let batch = image_to_batch(&interp.snapshot_image(signature), 1, "");
    if let Err(e) = store.commit(&batch) {
        // A failed commit hands the machine back with its dirt intact.
        return Err((interp, e));
    }
    // Only a successful commit clears the bitmaps: a failed commit
    // forgets nothing and the next attempt re-offers the same dirt.
    interp.slots.clear_dirty();
    interp.chunks.clear_dirty();
    let seal = batch.manifest.seal;
    Ok(StoreSession {
        interp,
        epoch: 1,
        seal,
        pin: None,
    })
}

/// Commit the machine's state since the session's last checkpoint:
/// the dirty slot pages and chunk extents, plus the whole (small)
/// manifest and small state. Returns the new epoch.
///
/// The session/store pairing is verified first — a store whose epoch
/// is not the session's fails closed with
/// [`StoreError::EpochMismatch`] rather than absorbing a dirty set
/// computed against some other baseline (the missed-page corruption
/// this seam must make unrepresentable).
pub fn checkpoint_to_store(
    session: &mut StoreSession,
    signature: &Signature,
    store: &mut dyn HeapStore,
) -> Result<u64, StoreError> {
    let stored = store.manifest()?;
    if stored.epoch != session.epoch {
        return Err(StoreError::EpochMismatch {
            expected: session.epoch,
            found: stored.epoch,
        });
    }
    if stored.seal != session.seal {
        // Equal height, different lineage: a fork, copy, or foreign
        // store — the case a bare epoch counter cannot see.
        return Err(StoreError::BaselineMismatch {
            expected: session.seal.clone(),
            found: stored.seal,
        });
    }
    let epoch = session.epoch.checked_add(1).ok_or(StoreError::Snapshot(
        crate::format::SnapshotError::Corrupt("store epoch exhausted"),
    ))?;
    let interp = &mut session.interp;
    let mut manifest = manifest_of(interp, signature, epoch);

    // Dirty rows only — never the whole heap. `page_records`/
    // `extent_bytes` copy one page/extent out of the arena (dirty rows
    // are resident by construction, lazy or not), and the encoding is
    // the same canonical record codec the full path uses.
    let mut page_edges: Vec<(u32, Vec<u32>)> = Vec::new();
    let slot_pages: Vec<(u32, Vec<u8>)> = interp
        .slots
        .dirty_pages()
        .into_iter()
        .map(|page| {
            let records = interp.slots.page_records(page);
            // The page-edge summary (phase 6) falls out of the records
            // already in hand — a pure function of page content.
            page_edges.push((page, derive_page_edges(page, &records)));
            let mut bytes = Vec::with_capacity(records.len() * crate::slot_codec::SLOT_RECORD_BYTES);
            for slot in &records {
                crate::slot_codec::encode_slot(slot, &mut bytes);
            }
            (page, bytes)
        })
        .collect();
    // The chunk bitmap tracks the current geometry (compaction resizes
    // it), so every dirty extent is in range by construction; the
    // guard is belt-and-braces against a future bitmap bug.
    let ext_count = chunk_extent_count(manifest.chunk_len);
    let chunk_extents: Vec<(u32, Vec<u8>)> = interp
        .chunks
        .dirty_extents()
        .into_iter()
        .filter(|&e| e < ext_count)
        .map(|e| (e, interp.chunks.extent_bytes(e)))
        .collect();

    let small = small_state_of(interp).encode();
    // Free-list segments (phase 9): diff against the stored segment
    // leaves so only CHANGED segments travel — LIFO churn touches the
    // tail segment, making per-commit free bytes O(1) in heap size.
    let free_all = crate::store::encode_all_free_segs(interp.slots.free_list());
    let prior_frees = store.free_leaf_hashes().unwrap_or_default();
    let free_segs: Vec<(u32, Vec<u8>)> = free_all
        .into_iter()
        .filter(|(i, bytes)| {
            prior_frees.get(*i as usize).copied() != Some(leaf_hash(crate::store::LEAF_FREE, *i, bytes))
        })
        .collect();
    // Row-hash tree maintenance (phase 5): prior leaves + this
    // commit's dirty leaves → the new sealed root. Metadata-scale
    // (32 bytes per row) and O(dirty) hashing of content.
    let (mut leaf_pages, mut leaf_exts) = store.leaf_hashes()?;
    let mut leaf_frees = prior_frees;
    leaf_pages.resize(slot_page_count(manifest.slot_count) as usize, [0u8; 32]);
    leaf_exts.resize(chunk_extent_count(manifest.chunk_len) as usize, [0u8; 32]);
    leaf_frees.resize(
        crate::store::free_seg_count(manifest.free_len) as usize,
        [0u8; 32],
    );
    for (i, bytes) in &slot_pages {
        leaf_pages[*i as usize] = leaf_hash(LEAF_PAGE, *i, bytes);
    }
    for (i, bytes) in &chunk_extents {
        leaf_exts[*i as usize] = leaf_hash(LEAF_EXT, *i, bytes);
    }
    for (i, bytes) in &free_segs {
        leaf_frees[*i as usize] = leaf_hash(crate::store::LEAF_FREE, *i, bytes);
    }
    manifest.root = combine_root(
        &leaf_hash(LEAF_SMALL, 0, &small),
        &leaf_pages,
        &leaf_exts,
        &leaf_frees,
    );
    manifest.seal = seal_commit(
        &session.seal,
        &manifest,
        &small,
        &slot_pages,
        &chunk_extents,
        &free_segs,
        &page_edges,
    );
    let seal = manifest.seal.clone();
    let batch = CheckpointBatch {
        prev_seal: session.seal.clone(),
        manifest,
        small,
        slot_pages,
        chunk_extents,
        free_segs,
        page_edges,
    };
    store.commit(&batch)?;
    session.interp.slots.clear_dirty();
    session.interp.chunks.clear_dirty();
    session.epoch = epoch;
    session.seal = seal.clone();
    if let Some(pin) = &session.pin {
        // Advance only if this commit landed in the PINNED store,
        // decided by address identity (borrow-free — see [`LazyPin`]);
        // a commit into an identical twin leaves the pin — and the
        // pinned store's content — exactly where the machine's faults
        // need them.
        let committed: *const dyn HeapStore = &*store;
        if committed.cast::<()>() == pin.store_addr {
            pin.epoch.set(epoch);
            *pin.seal.borrow_mut() = seal;
        }
    }
    Ok(epoch)
}

/// Rebuild a machine from a store (eager reification: every page and
/// extent is read now; [`resume_from_store_lazy`] is the on-demand
/// mode) and return it with the session bound at the store's epoch.
/// Runs the full open-time validation — gates, accounting, row
/// inventory — before touching any content, so a resumed machine can
/// only be the machine that was checkpointed.
pub fn resume_from_store(
    store: &dyn HeapStore,
    expected_sig: &Signature,
) -> Result<StoreSession, StoreError> {
    let (manifest, _small, _leaves) = validate_store(store, expected_sig)?;
    let image = store_to_image(store)?;
    // Re-check the manifest after the row reads: the reads above are
    // not one atomic snapshot on every backend, so a concurrent commit
    // could otherwise hand us a chimera of two epochs (the SQLite
    // review's torn-read finding). Same-seal after the reads proves the
    // rows all belonged to one epoch.
    let after = store.manifest()?;
    if after.epoch != manifest.epoch || after.seal != manifest.seal {
        return Err(StoreError::BaselineMismatch {
            expected: manifest.seal,
            found: after.seal,
        });
    }
    Ok(StoreSession {
        interp: image_to_interp(image),
        epoch: manifest.epoch,
        seal: manifest.seal,
        pin: None,
    })
}

/// The [`ironhorse_vm::PageSource`] adapter over a shared [`HeapStore`]
/// (store seam design, phase 3). Reads go through the `RefCell` so the
/// same store object also serves `commit` at checkpoint time (`&mut`
/// via `borrow_mut`); faults happen only mid-crank and commits only
/// between cranks, so the borrows never overlap.
///
/// The store was validated exhaustively before this adapter is
/// constructed, so a read failure here is genuine I/O trouble; per the
/// [`ironhorse_vm::PageSource`] contract it panics with a named
/// message — the deterministic crashed-crank path.
struct StorePageSource<S: HeapStore> {
    store: std::rc::Rc<std::cell::RefCell<S>>,
    /// The row-leaf hashes verified against the sealed root at open
    /// (phase 5). Every fault checks its row against these, so a
    /// length-preserving flip at rest dies as a named crashed crank,
    /// never a different machine. Attach-time leaves stay valid for
    /// every faultable row: the session's own commits touch only
    /// dirty rows, and dirty ⇒ resident means those never fault.
    leaves: StoreLeaves,
    /// The (epoch, seal) the machine's session currently stands at.
    /// Every fault re-verifies it, so a store advanced by anyone else
    /// turns torn reads into a deterministic named crashed crank
    /// instead of a chimera heap (the review's two-lazy-machines
    /// finding); the session advances the pin on its own commits.
    pin: std::rc::Rc<LazyPin>,
}

impl<S: HeapStore> StorePageSource<S> {
    fn check_pin(&self, what: &str) {
        let m = self
            .store
            .borrow()
            .manifest()
            .unwrap_or_else(|e| panic!("lazy heap fault: manifest re-read ({what}): {e:?}"));
        if m.epoch != self.pin.epoch.get() || m.seal != *self.pin.seal.borrow() {
            panic!(
                "lazy heap fault: store advanced under this machine \
                 (pinned epoch {}, store epoch {}) — torn read refused",
                self.pin.epoch.get(),
                m.epoch,
            );
        }
    }
}

impl<S: HeapStore> ironhorse_vm::PageSource for StorePageSource<S> {
    fn slot_page(&self, page: u32) -> Vec<ironhorse_vm::Slot> {
        self.check_pin("slot page");
        let bytes = self
            .store
            .borrow()
            .read_slot_page(page)
            .unwrap_or_else(|e| panic!("lazy heap fault: slot page {page}: {e:?}"));
        if self.leaves.pages.get(page as usize).copied()
            != Some(leaf_hash(LEAF_PAGE, page, &bytes))
        {
            panic!("lazy heap fault: slot page {page} fails its leaf hash (corrupt store)");
        }
        // The pin check and the row read are separate store operations,
        // so on a shared backend a foreign commit can land between them
        // and the read return a NEW-epoch row the pre-check could not
        // see. Epochs only advance, so a matching pin AFTER the read
        // proves the row belonged to the pinned commit.
        self.check_pin("slot page post-read");
        crate::slot_codec::decode_slots(&bytes)
            .unwrap_or_else(|e| panic!("lazy heap fault: slot page {page} decode: {e:?}"))
    }

    fn chunk_extent(&self, ext: u32) -> Vec<u8> {
        self.check_pin("chunk extent");
        let bytes = self
            .store
            .borrow()
            .read_chunk_extent(ext)
            .unwrap_or_else(|e| panic!("lazy heap fault: chunk extent {ext}: {e:?}"));
        if self.leaves.exts.get(ext as usize).copied() != Some(leaf_hash(LEAF_EXT, ext, &bytes))
        {
            panic!("lazy heap fault: chunk extent {ext} fails its leaf hash (corrupt store)");
        }
        // Same post-read verification as `slot_page` — see there.
        self.check_pin("chunk extent post-read");
        bytes
    }
}

/// Rebuild a machine from a store with **lazy reification** (store
/// seam design, phase 3): the same exhaustive validation and the same
/// small state up front, but the arenas are attached over a
/// [`ironhorse_vm::PageSource`] and fault slot pages / chunk extents
/// in on first touch, so wake latency is proportional to the wake
/// crank's working set, not the heap.
///
/// Residency is grow-only; content is identical to an eager resume by
/// construction (a fault installs exactly the bytes the store holds),
/// which the metamorphic determinism suite locks. The store rides in
/// an `Rc<RefCell<…>>` so the returned machine's fault path and the
/// caller's later [`checkpoint_to_store`] (`&mut *store.borrow_mut()`)
/// share it.
pub fn resume_from_store_lazy<S: HeapStore + 'static>(
    store: std::rc::Rc<std::cell::RefCell<S>>,
    expected_sig: &Signature,
) -> Result<StoreSession, StoreError> {
    let (manifest, small, leaves) = validate_store(&*store.borrow(), expected_sig)?;
    // Re-check the manifest after validation's separate reads, exactly
    // as eager resume does after its row reads: the manifest / small /
    // inventory reads are not one atomic snapshot on every backend, so
    // a concurrent commit (a second SQLite connection) could otherwise
    // seed the session and its pin from mixed epochs. Epochs only
    // advance, so same (epoch, seal) after the reads proves every read
    // saw the one pinned commit.
    {
        let after = store.borrow().manifest()?;
        if after.epoch != manifest.epoch || after.seal != manifest.seal {
            return Err(StoreError::BaselineMismatch {
                expected: manifest.seal,
                found: after.seal,
            });
        }
    }
    let pin = std::rc::Rc::new(LazyPin {
        epoch: std::cell::Cell::new(manifest.epoch),
        seal: std::cell::RefCell::new(manifest.seal.clone()),
        // `RefCell::as_ptr` addresses the `S` itself — the same address
        // a later `&mut *store.borrow_mut()` coerced to
        // `&mut dyn HeapStore` carries into [`checkpoint_to_store`].
        store_addr: store.as_ptr().cast::<()>().cast_const(),
    });
    let source = std::rc::Rc::new(StorePageSource {
        store: store.clone(),
        leaves,
        pin: pin.clone(),
    });
    let slots = ironhorse_vm::SlotArena::lazy_from_parts(
        manifest.slot_count,
        small.slot_free.clone(),
        manifest.slot_live,
        source.clone(),
    );
    let chunks = ironhorse_vm::ChunkArena::lazy_from_parts(manifest.chunk_len as usize, source);
    let mut interp = Interp::new();
    interp.restore_snapshot_state(
        slots,
        chunks,
        small.stack.clone(),
        small.names.clone(),
        small.meter.to_state(),
    );
    Ok(StoreSession {
        interp,
        epoch: manifest.epoch,
        seal: manifest.seal,
        pin: Some(pin),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_vm::COST_TABLE_VERSION;

    fn sig() -> Signature {
        Signature::new("ironhorse-worker-v1")
    }

    // The exact XS bytecode for `(function(x){return x+1})(5)` (captured
    // from the oracle in the engine's meter tests): completion "6", 30
    // computrons on a fresh machine.
    const PROG_A: [u8; 44] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
        0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
        0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
    ];
    // `(function(){return (function(){return 1})()})()`: completion "1".
    const PROG_B: [u8; 51] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x1c, 0x0b, 0x00, 0xe0, 0x38, 0x00, 0x00,
        0x2e, 0x06, 0x0b, 0x00, 0x72, 0x01, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00,
        0x72, 0x04, 0x28, 0xab, 0x00, 0xbb, 0x44, 0x58, 0x92, 0x42, 0xe0, 0x89, 0x01, 0x00, 0x72,
        0x04, 0x28, 0xab, 0x00, 0xbb, 0xa9,
    ];

    /// Round-trip the bytes: a machine that ran a program serializes and
    /// deserializes to a byte-identical container, and the restored image
    /// carries the same meter.
    #[test]
    fn machine_snapshot_bytes_round_trip() {
        let mut m = Interp::new();
        let a = m.run(&PROG_A);
        assert!(a.completed);

        let bytes = m.write_snapshot(&sig());
        let m2 = from_snapshot_bytes(&bytes, &sig()).expect("restores");
        // The restored machine carries the same metering state.
        assert_eq!(m2.meter_state(), m.meter_state());
        // Re-serializing the restored machine is byte-identical.
        assert_eq!(m2.write_snapshot(&sig()), bytes);
    }

    /// The row-6 bar: run-to-a-crank, suspend, resume, run-to-end equals
    /// the uninterrupted run in BOTH result and final computron count.
    #[test]
    fn suspend_resume_equals_uninterrupted() {
        // Uninterrupted: one machine runs crank A then crank B.
        let mut uninterrupted = Interp::new();
        let _ua = uninterrupted.run(&PROG_A);
        let ub = uninterrupted.run(&PROG_B);
        assert!(ub.completed);

        // Suspended: machine 1 runs A, snapshots; machine 2 restores and
        // runs B. The meter must continue exactly.
        let mut m1 = Interp::new();
        let a1 = m1.run(&PROG_A);
        assert!(a1.completed);
        let bytes = m1.write_snapshot(&sig());
        let mut m2 = from_snapshot_bytes(&bytes, &sig()).expect("restores");
        let b2 = m2.run(&PROG_B);

        assert_eq!(b2.result, ub.result, "result equals the uninterrupted run");
        assert_eq!(
            b2.computrons, ub.computrons,
            "final computron count equals the uninterrupted run (meter continued)"
        );
        // And the resumed computrons strictly exceed crank A's alone — the
        // meter genuinely continued rather than resetting.
        assert!(b2.computrons > a1.computrons);
    }

    /// The same bar for an armed meter: the check interval/threshold ride
    /// the snapshot, so a resumed machine keeps consulting the host on the
    /// same cadence and the accumulated index is preserved.
    #[test]
    fn armed_meter_state_survives_suspend() {
        let mut m1 = Interp::new();
        // Arm a generous window so crank A completes without aborting.
        m1.arm_meter(1_000_000, Box::new(|_| true));
        let a = m1.run(&PROG_A);
        assert!(a.completed, "generous window: A completes");
        let armed_state = m1.meter_state();
        assert!(armed_state.interval > 0, "meter is armed");

        let bytes = m1.write_snapshot(&sig());
        let m2 = from_snapshot_bytes(&bytes, &sig()).expect("restores");
        // The armed interval and the accumulated index both survive.
        assert_eq!(m2.meter_state(), armed_state);
    }

    /// A snapshot written under a different cost-table version fails closed
    /// on read — the metering analogue of the signature gate.
    #[test]
    fn cost_table_mismatch_fails_closed() {
        let mut m = Interp::new();
        m.run(&PROG_A);
        let mut image = m.snapshot_image(&sig());
        image.meter.cost_table_version = "ironhorse-meter-999".to_string();
        let bytes = write_machine(&image);
        match from_snapshot_bytes(&bytes, &sig()) {
            Err(SnapshotError::CostTableMismatch { expected, found }) => {
                assert_eq!(expected, COST_TABLE_VERSION);
                assert_eq!(found, "ironhorse-meter-999");
            }
            Err(e) => panic!("expected cost-table mismatch, got {e:?}"),
            Ok(_) => panic!("expected cost-table mismatch, got a restored machine"),
        }
    }

    /// A snapshot written under one host signature is refused by a machine
    /// on a different signature (the callback-table gate), at the machine
    /// surface.
    #[test]
    fn signature_mismatch_fails_closed_at_machine_surface() {
        let mut m = Interp::new();
        m.run(&PROG_A);
        let bytes = m.write_snapshot(&Signature::new("host-v1"));
        match from_snapshot_bytes(&bytes, &Signature::new("host-v2")) {
            Err(SnapshotError::SignatureMismatch { .. }) => {}
            Err(e) => panic!("expected signature mismatch, got {e:?}"),
            Ok(_) => panic!("expected signature mismatch, got a restored machine"),
        }
    }

    /// The CAS verbs: `suspend_to_cas` writes `{cas_dir}/{sha256}` and the
    /// digest matches the streamed content; `resume_from_cas` restores a
    /// machine whose meter continues the crank exactly (the full
    /// suspend→CAS→resume path the supervisor drives).
    #[test]
    fn suspend_to_cas_and_resume_round_trips_through_the_store() {
        // Uninterrupted reference.
        let mut uninterrupted = Interp::new();
        uninterrupted.run(&PROG_A);
        let ub = uninterrupted.run(&PROG_B);

        let dir = std::env::temp_dir().join(format!(
            "ironhorse-cas-test-{}",
            // A per-run-unique subdir without Math.random/Date: the
            // content hash of PROG_A's snapshot is itself unique enough,
            // computed below; use a fixed name scoped by process temp dir.
            "suspend-resume"
        ));
        // Clean any prior run's directory.
        let _ = std::fs::remove_dir_all(&dir);

        let mut m1 = Interp::new();
        m1.run(&PROG_A);
        let hash = m1.suspend_to_cas(&sig(), &dir).expect("writes to cas");
        // The blob is stored under its own content hash.
        let stored = dir.join(&hash);
        assert!(stored.exists(), "snapshot stored at its content hash");
        // The hash addresses the exact bytes.
        let bytes = std::fs::read(&stored).unwrap();
        assert_eq!(crate::sha256::hex_sha256(&bytes), hash);

        let mut m2 = resume_from_cas(&dir, &hash, &sig()).expect("resumes from cas");
        let b2 = m2.run(&PROG_B);
        assert_eq!(b2.result, ub.result);
        assert_eq!(b2.computrons, ub.computrons, "meter continued through the CAS round-trip");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// **Summary-driven partial collection** (store seam phase 6): free
/// every page unreachable from the machine's GC roots, deciding
/// reachability ENTIRELY from the store's persisted page-edge
/// summaries — zero row-content reads, no full-heap reification.
///
/// Page-conservative by design: garbage co-resident with live data in
/// a reachable page survives (the release-fixed full
/// [`ironhorse_vm::Interp::collect_garbage`] reclaims it, and only it
/// compacts chunk space). Deterministic: a pure function of store
/// content and machine roots.
///
/// Contract: call at a checkpoint boundary while the session has no
/// dirty rows — the summaries describe the committed state, and dirt
/// would make them stale. A dirty machine panics with a named message
/// (a caller bug, like the fault contract).
///
/// Returns the number of slots freed. Freeing never dirties (the free
/// list rides small state), so the next checkpoint carries the
/// reclamation in small state alone.
pub fn partial_collect(
    session: &mut StoreSession,
    store: &dyn HeapStore,
) -> Result<u32, StoreError> {
    let interp = session.machine();
    assert!(
        interp.slots.dirty_pages().is_empty() && interp.chunks.dirty_extents().is_empty(),
        "partial collect requires a clean checkpoint boundary (dirty rows present)"
    );
    let manifest = store.manifest()?;
    if manifest.epoch != session.epoch || manifest.seal != session.seal {
        return Err(StoreError::BaselineMismatch {
            expected: session.seal.clone(),
            found: manifest.seal,
        });
    }
    let mut root_pages: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for r in interp.gc_roots() {
        if !r.is_null() {
            root_pages.insert(r.0 / crate::store::SLOTS_PER_PAGE);
        }
    }
    let reached = crate::store::reachable_pages(store, root_pages)?;
    let total = slot_page_count(manifest.slot_count);
    let dead: Vec<u32> = (0..total).filter(|p| !reached.contains(p)).collect();
    Ok(session.machine_mut().free_pages(&dead))
}
