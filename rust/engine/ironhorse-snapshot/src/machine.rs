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
    chunk_extent_count, image_to_batch, store_to_image, validate_store, CheckpointBatch,
    HeapStore, SmallState, StoreError, StoreManifest, STORE_SCHEMA_VERSION,
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

/// A machine's binding to one store: the proof that the store's
/// current epoch is this machine's previous checkpoint, which is what
/// makes committing *only* the dirty rows sound. Obtained from
/// [`begin_store_session`] (full first write) or [`resume_from_store`]
/// (adopting a store's content); consumed by [`checkpoint_to_store`].
#[derive(Debug, PartialEq, Eq)]
pub struct StoreSession {
    epoch: u64,
}

impl StoreSession {
    /// The store epoch this session last committed or adopted.
    pub fn epoch(&self) -> u64 {
        self.epoch
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
        epoch,
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
    interp: &mut Interp,
    signature: &Signature,
    store: &mut dyn HeapStore,
) -> Result<StoreSession, StoreError> {
    match store.manifest() {
        Err(StoreError::Empty) => {}
        Ok(m) => return Err(StoreError::NotEmpty { epoch: m.epoch }),
        Err(e) => return Err(e),
    }
    let batch = image_to_batch(&interp.snapshot_image(signature), 1);
    store.commit(&batch)?;
    // Only a successful commit clears the bitmaps: a failed commit
    // forgets nothing and the next attempt re-offers the same dirt.
    interp.slots.clear_dirty();
    interp.chunks.clear_dirty();
    Ok(StoreSession { epoch: 1 })
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
    interp: &mut Interp,
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
    let epoch = session.epoch + 1;
    let manifest = manifest_of(interp, signature, epoch);

    // Dirty rows only — never the whole heap. `page_records`/
    // `extent_bytes` copy one page/extent out of the arena (dirty rows
    // are resident by construction, lazy or not), and the encoding is
    // the same canonical record codec the full path uses.
    let slot_pages: Vec<(u32, Vec<u8>)> = interp
        .slots
        .dirty_pages()
        .into_iter()
        .map(|page| {
            let records = interp.slots.page_records(page);
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

    let batch = CheckpointBatch {
        manifest,
        small: small_state_of(interp).encode(),
        slot_pages,
        chunk_extents,
    };
    store.commit(&batch)?;
    interp.slots.clear_dirty();
    interp.chunks.clear_dirty();
    session.epoch = epoch;
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
) -> Result<(Interp, StoreSession), StoreError> {
    let (manifest, _small) = validate_store(store, expected_sig)?;
    let image = store_to_image(store)?;
    Ok((
        image_to_interp(image),
        StoreSession {
            epoch: manifest.epoch,
        },
    ))
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
}

impl<S: HeapStore> ironhorse_vm::PageSource for StorePageSource<S> {
    fn slot_page(&self, page: u32) -> Vec<ironhorse_vm::Slot> {
        let bytes = self
            .store
            .borrow()
            .read_slot_page(page)
            .unwrap_or_else(|e| panic!("lazy heap fault: slot page {page}: {e:?}"));
        crate::slot_codec::decode_slots(&bytes)
            .unwrap_or_else(|e| panic!("lazy heap fault: slot page {page} decode: {e:?}"))
    }

    fn chunk_extent(&self, ext: u32) -> Vec<u8> {
        self.store
            .borrow()
            .read_chunk_extent(ext)
            .unwrap_or_else(|e| panic!("lazy heap fault: chunk extent {ext}: {e:?}"))
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
) -> Result<(Interp, StoreSession), StoreError> {
    let (manifest, small) = validate_store(&*store.borrow(), expected_sig)?;
    let source = std::rc::Rc::new(StorePageSource {
        store: store.clone(),
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
    Ok((
        interp,
        StoreSession {
            epoch: manifest.epoch,
        },
    ))
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
