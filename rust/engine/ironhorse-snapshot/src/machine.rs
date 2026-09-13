//! File/CAS snapshots and paged-store checkpoint/restore operations.
//!
//! [`MachineSnapshot`] extends `ironhorse_vm::Interp` because the VM owns the
//! interpreter while this crate owns encoding and persistence validation.
//! File writes materialize the encoded image, hash that same buffer, and write it;
//! this is not a constant-memory streaming serializer. CAS publication uses a
//! content-addressed name and the read path validates content identity.
//!
//! Persistence requires a completed, quiescent crank and admitted side-table state.
//! A halted crank can retain live registers even when tables appear empty; it must
//! rewind rather than commit. Functions, proxies, accessors, generators and promises
//! have carried representations subject to the current [`crate::sidetable`] policies.
//! A resumed guest function is callable; historical dependency-gate arguments that
//! assume it is uncallable no longer apply. Live unsupported activations still refuse.
//!
//! The outer Endo integration uses these operations directly; it is not a guarantee
//! that xsnap's supervisor API or the full daemon worker protocol is unchanged.
//! See `rust/engine/ARCHITECTURE.md` and the carry/persist-gate tests.

use crate::store::HeapStoreCommit;
use std::fs::File;
use std::io::{self, Write};
use std::path::Path;

use crate::format::{Signature, SnapshotError};
use crate::image::{
    read_validated_machine, write_machine, GatedImage, MachineImage, MeterImage, ValidatedSnapshot,
};
use crate::sha256::{hex, Sha256};
#[cfg(test)]
use crate::store::image_to_batch_unchecked as image_to_batch;
use crate::store::{
    chunk_extent_count, derive_page_edges, leaf_hash, slot_page_count, store_to_image,
    validate_store, CheckpointBatch, HeapStore, SmallState, StoreError, StoreLeaves, StoreManifest,
    LEAF_EXT, LEAF_PAGE, STORE_SCHEMA_VERSION,
};
use ironhorse_vm::{Interp, RestoreSession};

/// An error from the file/CAS snapshot surface: either an I/O failure or a
/// container decode/validation failure. (Kept distinct from
/// [`SnapshotError`], which is pure decode and stays `Eq`; `io::Error` is
/// not `Eq`.)
#[derive(Debug)]
pub enum MachineSnapshotError {
    Io(io::Error),
    Snapshot(SnapshotError),
    /// The machine is not at a quiescent crank boundary:
    /// its last crank halted. A halt may leave pending microtasks /
    /// frames / an exception that no snapshot carries; even one that
    /// leaves every table empty (a top-level meter abort, the dispatch
    /// ceiling, a decode fault) leaves the boundary registers rooted,
    /// which a resumed twin would not share. Rewind or
    /// complete a crank before persisting; see `tests/persist_gates.rs`.
    NotQuiescent,
    /// The heap holds live state that `Interp::stored_unpersistable_row`
    /// cannot carry. A resumed machine would answer wrong values,
    /// so persistence refuses with the row's name.
    PendingStateUnsupported {
        row: &'static str,
    },
}

impl std::fmt::Display for MachineSnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MachineSnapshotError::Io(e) => write!(f, "snapshot io error: {e}"),
            MachineSnapshotError::Snapshot(e) => write!(f, "snapshot decode error: {e:?}"),
            MachineSnapshotError::NotQuiescent => {
                write!(f, "machine is not at a quiescent crank boundary")
            }
            MachineSnapshotError::PendingStateUnsupported { row } => {
                write!(
                    f,
                    "heap holds live {row}: that side table does not travel yet"
                )
            }
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

/// Removes an unpublished CAS temporary on every exit path.
struct CasTemporary(std::path::PathBuf);
impl Drop for CasTemporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn cas_temporary(dir: &Path) -> io::Result<(CasTemporary, File)> {
    static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    loop {
        let n = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = dir.join(format!(".snapshot-{}-{n}.tmp", std::process::id()));
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => return Ok((CasTemporary(path), file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
}

/// The xsnap-shaped machine snapshot surface, implemented for the ironhorse
/// [`Interp`] (the engine's machine). See the module docs.
pub trait MachineSnapshot {
    /// The persist preconditions: a quiescent crank
    /// boundary and no live state a resume cannot bring back. Required,
    /// not defaulted: every implementor must explicitly establish
    /// admission before handing out an image; see `tests/persist_gates.rs`.
    fn persist_gate(&self) -> Result<(), MachineSnapshotError>;

    /// Build the plain-data [`MachineImage`] of this machine under
    /// `signature` (its host callback-table version) — the arenas, the
    /// value stack, the program symbol names, the metering state, and
    /// the side-table rows — after [`Self::persist_gate`] admits it.
    ///
    /// The immutable proof prevents mutation between admission and encoding.
    /// Writers and full-batch builders consume this proof; unchecked tooling
    /// encoders are separate, explicitly named operations. Incremental
    /// checkpoints run the same live gate directly over their bound machine.
    fn snapshot_image(&self, signature: &Signature) -> Result<GatedImage, MachineSnapshotError>;

    /// Test tooling that deliberately discards the persistence proof.
    #[cfg(feature = "unchecked-tooling")]
    fn snapshot_image_for_testing(
        &self,
        signature: &Signature,
    ) -> Result<MachineImage, MachineSnapshotError> {
        self.snapshot_image(signature).map(GatedImage::into_image)
    }

    /// Serialize this machine to the in-memory `XS_M` container bytes.
    /// Refuses whatever [`Self::snapshot_image`] refuses — a machine
    /// that fails [`Self::persist_gate`], or one whose image stores a
    /// property id outside the name and symbol-key tables
    /// (`Snapshot(Corrupt(..))`) — so the blob verbs carry exactly the
    /// preconditions `begin_store_session` does.
    fn write_snapshot(&self, signature: &Signature) -> Result<Vec<u8>, MachineSnapshotError> {
        Ok(write_machine(&self.snapshot_image(signature)?)?)
    }

    /// Materialize the encoded snapshot, then hash and write that buffer in chunks
    /// to `file`.
    /// The image, atom body, and finished container can coexist during encoding
    /// (roughly three heap images at peak). Return the hex digest after the file
    /// is flushed and synced,
    /// so the caller may safely rename it into the CAS (the
    /// [`Self::suspend_to_cas`] contract).
    fn write_snapshot_to_file(
        &self,
        signature: &Signature,
        file: File,
    ) -> Result<String, MachineSnapshotError> {
        let bytes = self.write_snapshot(signature)?;
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
        let (temporary, file) = cas_temporary(cas_dir)?;
        let hash = self.write_snapshot_to_file(signature, file)?;
        let final_path = cas_dir.join(&hash);
        std::fs::rename(&temporary.0, &final_path)?;
        // Durable publish: the rename is final only once the CAS
        // directory itself is synced (same discipline as the file
        // store's commit).
        File::open(cas_dir)?.sync_all()?;
        Ok(hash)
    }
}

impl MachineSnapshot for Interp {
    fn persist_gate(&self) -> Result<(), MachineSnapshotError> {
        if !self.is_quiescent() {
            return Err(MachineSnapshotError::NotQuiescent);
        }
        if let Some(row) = self.stored_unpersistable_row() {
            return Err(MachineSnapshotError::PendingStateUnsupported { row });
        }
        Ok(())
    }

    fn snapshot_image(&self, signature: &Signature) -> Result<GatedImage, MachineSnapshotError> {
        self.persist_gate()?;
        signature.check_boot()?;
        let image = ungated_image(self, signature);
        // The id-space audit: with
        // string keys living in the NAME table and symbol keys traveling
        // in the SYMB table, a LIVE machine cannot store an id outside
        // both — ids only ever come from minting. Finding one would mean
        // this process corrupted its own tables; refuse rather than hand
        // out the contradiction. Asked of the IMAGE, so the witness is
        // what a store or blob would actually hold, and asked here so
        // the gate and the store verbs admit the same images.
        if image.stored_unregistered_key_id().is_some() {
            return Err(MachineSnapshotError::Snapshot(SnapshotError::Corrupt(
                "stored property id outside the name and symbol-key tables",
            )));
        }
        Ok(GatedImage::new(image)?)
    }
}

/// Build the plain-data image of `interp` WITHOUT consulting the persist
/// gate: the body of [`MachineSnapshot::snapshot_image`], and its only
/// caller. Private on purpose: nothing in
/// this crate hands out an image of a machine the gate has not seen.
fn ungated_image(interp: &Interp, signature: &Signature) -> MachineImage {
    // The carried atoms (see the suspend-point contract): arenas +
    // stack + the name table + meter, plus the side-table ledger's
    // serialized rows (arrays, collections, `Symbol.for` registry)
    // and the symbol-key id table (SYMB). String keys — program
    // symbols and runtime-interned names alike — travel inside the
    // NAME table since the id-space unification, so the KEYS atom
    // is retired and travels empty.
    let tables = side_tables_of(interp);
    let (next_id, pairs) = interp.symbol_key_table();
    let image = MachineImage::from_arenas(
        signature.clone(),
        interp.slots(),
        interp.chunks(),
        interp.stack_slots(),
        interp.program_symbol_names().to_vec(),
        Vec::new(),
        crate::image::SymbolKeyImage { next_id, pairs },
    )
    .with_meter(interp.meter_state());
    tables
        .attach_to(image)
        .with_name_floor(interp.installed_names_floor())
}

// Generate an expression macro rather than an owned-source function: callers
// have already moved core fields (stack/names) when transferring side tables.
macro_rules! define_side_table_transfer {
    (($d:tt); $($field:ident,)*) => {
        macro_rules! side_tables_from {
            ($d source:ident) => {
                SideTableImages { $($field: $d source.$field,)* }
            };
        }
    };
}

/// The machine's serialized side-table views (ledger rows `Arrays`/
/// `Collections`/`SymbolRegistry`/`ErrorData`/`ArrayBuffers`/
/// `TypedArrays`/`DataViews`/`Dates`), converted from the vm's tuple
/// snapshots into the image structs, in the vm's canonical
/// (ascending) order.
macro_rules! define_live_side_tables {
    ($($section:ident {
        image_field: $field:ident,
        builder: $builder:ident,
        live: [$($live_field:ident: $ty:ty => ($interp:ident, $dirty:ident) $extract:block)?],
        $($rest:tt)*
    })*) => {
        struct SideTableImages {
            $($($live_field: $ty,)?) *
        }
        impl SideTableImages {
            fn attach_to(self, mut image: MachineImage) -> MachineImage {
                $($(image.$live_field = self.$live_field;)?) *
                image
            }
        }
        define_side_table_transfer!(($); $($($live_field,)?) *);
        fn side_tables_of_selected(
            interp: &Interp,
            dirty: ironhorse_vm::SnapshotDirty,
        ) -> SideTableImages {
            SideTableImages {
                $($($live_field: {
                    let $interp = interp;
                    let $dirty = dirty;
                    $extract
                },)?) *
            }
        }
        /// The machine's small state, mirroring [`MachineSnapshot::snapshot_image`]
        /// exactly (the KEYS section is retired — string keys travel inside the
        /// NAME table since the id-space unification; the ledger rows — arrays,
        /// collections, registry since schema 7 and errors since schema 9 —
        /// travel alongside, and the symbol-key table travels in the symbols
        /// section).
        fn small_state_of(interp: &Interp, dirty: ironhorse_vm::SnapshotDirty) -> SmallState {
            let tables = side_tables_of_selected(interp, dirty);
            let (next_id, pairs) = if dirty.contains(ironhorse_vm::SnapshotSection::Symbols) {
                interp.symbol_key_table()
            } else {
                Default::default()
            };
            SmallState {
                $($($live_field: tables.$live_field,)?) *
                stack: interp.stack_slots().to_vec(),
                slot_free: Vec::new(),
                keys: Vec::new(),
                names: if dirty.contains(ironhorse_vm::SnapshotSection::Names) {
                    #[cfg(test)]
                    extraction_counts::record(ironhorse_vm::SnapshotSection::Names);
                    interp.program_symbol_names().to_vec()
                } else {
                    Vec::new()
                },
                symbols: crate::image::SymbolKeyImage { next_id, pairs },
                meter: MeterImage::of(interp.meter_state()),
                // Canonicalized like `with_name_floor`: a floor at the table
                // length is the restore default and travels as `None`.
                name_floor: {
                    let floor = interp.installed_names_floor();
                    (floor as usize != interp.program_symbol_names().len()).then_some(floor)
                },
            }
        }

    };
}
crate::snapshot_roster::snapshot_payloads!(define_live_side_tables);

fn side_tables_of(interp: &Interp) -> SideTableImages {
    side_tables_of_selected(interp, ironhorse_vm::SnapshotDirty::all())
}

/// Reinstate the ledger side tables on a restored machine from their
/// image rows — [`Interp::restore_bulk_side_tables`]'s image-typed
/// front door, shared by every resume path (container, eager store,
/// lazy store). A malformed kind code was already refused at decode,
/// so the restore cannot fail on validated input — but "cannot" is a
/// claim about the decoders, not a proof, so a `false` return is a
/// STRUCTURED refusal, never a debug-only assert: a release build must
/// refuse the row set, not continue with silently missing exotic state.
// Expand the roster's successor chain into straight-line restore calls.
// The dollar token is passed explicitly because this defines a nested macro.
macro_rules! define_restore_chain {
    (($d:tt); $($section:ident => $next:ident [$($field:ident),+] ($interp:ident) $body:block)*) => {
        #[deny(unused_variables)]
        fn restore_side_tables(
            interp: &mut RestoreSession,
            mut tables: SideTableImages,
        ) -> Result<(), crate::format::SnapshotError> {
            use crate::format::SnapshotError;
            // Prune collected boot-native metadata before runtime function
            // clusters can reuse those slots, and restore relocated names.
            let shared = tables.function_state.shared.take();
            let native_names = tables.function_state.native_names.take();
            if interp.restore_native_names(native_names.as_deref()).is_err() {
                return Err(SnapshotError::Corrupt(
                    "side-table restore: malformed native names",
                ));
            }
            interp.restore_shared_machine(shared).map_err(|_| SnapshotError::Corrupt("invalid shared machine state"))?;
            macro_rules! restore_step {
                $(( $section, $d current_interp:ident, $d current_tables:ident) => {{
                    $(let $field = $d current_tables.$field;)+
                    {
                        let $interp = &mut *$d current_interp;
                        $body
                    }
                    restore_step!($next, $d current_interp, $d current_tables);
                }};)*
                (End, $d current_interp:ident, $d current_tables:ident) => {};
            }
            restore_step!(Arrays, interp, tables);
            // RestoreSession::finish owns cross-table validation and migrations.
            Ok(())
        }
    };
}

macro_rules! define_restore_steps {
    ($($section:ident {
        image_field: $field:ident,
        builder: $builder:ident,
        live: [$($live:tt)*],
        bounds: [$($bounds:tt)*],
        gate: [$($gate:tt)*],
        restore: [$($next:ident, [$($consumed:ident),+], ($interp:ident) $body:block)?],
        $($rest:tt)*
    })*) => {
        define_restore_chain!(($); $($($section => $next [$($consumed),+] ($interp) $body)?) *);
    };
}
crate::snapshot_roster::snapshot_payloads!(define_restore_steps);

/// Rebuild a live [`Interp`] from a [`ValidatedSnapshot`]: a fresh
/// boot machine with the image's serializable state reinstated (the
/// arenas, stack, program symbol names, and metering state). The
/// boot-derived intrinsics/prototypes come from the fresh boot at their
/// deterministic slot indices, matching the image's boot region. See
/// [`RestoreSession::restore_snapshot_state`].
///
/// The proof wrapper prevents mutation between validation and restore.
/// Restoration remains fallible while the VM keeps belt-and-braces
/// revalidation for derived state; every such refusal is structured on all
/// build profiles.
pub fn image_to_interp(
    snapshot: ValidatedSnapshot,
) -> Result<Interp, crate::format::SnapshotError> {
    let image = snapshot.into_image();
    let meter = image.meter.to_state();
    let (slots, chunks) = image.to_arenas();
    let mut interp = Interp::begin_restore();
    interp
        .restore_snapshot_state(slots, chunks, image.stack, image.names, meter)
        .map_err(|_| SnapshotError::Corrupt("arena restore failed"))?;
    // The installed-names floor: adopt the live floor
    // when it traveled, so names interned during the last install pass
    // stay lazily installable exactly as they were live. Bounds were
    // validated at decode.
    if let Some(floor) = image.name_floor {
        if interp.restore_installed_names_floor(floor).is_err() {
            return Err(crate::format::SnapshotError::Corrupt(
                "installed-names floor does not restore",
            ));
        }
    }
    // The symbol-key id table (SYMB): re-bind each stored id to its
    // descriptor slot and reinstate the top-down mint counter, so a
    // symbol-keyed property reads back under the same id and a later
    // mint cannot reuse a stored number.
    if !interp
        .restore_symbol_key_table(image.symbols.next_id, &image.symbols.pairs)
        .is_ok()
    {
        return Err(crate::format::SnapshotError::Corrupt(
            "symbol-key table does not restore",
        ));
    }
    // The side-table ledger rows (arrays, collections, registry):
    // restored through the counted accessors so the side-ref page
    // counts rebuild in lockstep.
    restore_side_tables(&mut interp, side_tables_from!(image))?;
    finish_restore(interp)
}

// Keep the existing capability-refusal diagnostic on every adoption path,
// including lazy stores. Other cross-row failures use the session category.
fn finish_restore(session: RestoreSession) -> Result<Interp, SnapshotError> {
    session.finish().map_err(|error| {
        SnapshotError::Corrupt(if error.row == "promise_cluster" {
            "side-table restore: malformed promise capability"
        } else {
            "restore session did not validate"
        })
    })
}

/// Rebuild a machine from `XS_M` container bytes, enforcing the ironhorse
/// `VERS` discriminator, the callback-table `SIGN` signature, and the
/// cost-table version (all fail closed). The metering analogue of
/// `fxReadSnapshot`'s signature gate is the `METR` cost-table check.
pub fn from_snapshot_bytes(buf: &[u8], expected_sig: &Signature) -> Result<Interp, SnapshotError> {
    let snapshot = read_validated_machine(buf, expected_sig)?;
    image_to_interp(snapshot)
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
    if sha256.len() != 64
        || !sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(SnapshotError::Corrupt("CAS digest is not canonical SHA-256").into());
    }
    let bytes = std::fs::read(cas_dir.join(sha256))?;
    if crate::sha256::hex_sha256(&bytes) != sha256 {
        return Err(SnapshotError::Corrupt("CAS content digest mismatch").into());
    }
    Ok(from_snapshot_bytes(&bytes, expected_sig)?)
}

// --- the store-backed checkpoint surface
//
// The blob verbs above serialize the whole heap every time; these
// verbs pair a machine with a `HeapStore` so that after one full
// write, every later checkpoint commits only the pages and extents the
// machine actually dirtied since the previous one. Same suspend-point
// contract as the blob path: a checkpoint is taken at machine
// quiescence between cranks, never mid-dispatch.

/// A machine's binding to one store: the session **owns the machine**,
/// so a dirty set can only ever be committed by the session that
/// watched it accumulate. A second session cannot consume the same
/// machine's dirty bits while another store still needs them. The session also
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
    /// The verified row-leaf hashes every fault checks its row
    /// against. Seeded from `validate_store` at attach and REFRESHED
    /// by the session's own successful checkpoints (alongside the
    /// epoch/seal advance): a checkpoint rewrites dirty rows in the
    /// store, and eviction means a rewritten-then-clean row
    /// CAN fault again — against the committed bytes, which only the
    /// refreshed leaves match. Frozen attach-time leaves would
    /// misdiagnose that healthy re-fault as a corrupt store. See
    /// `tests/store_checkpoint.rs::evict_after_own_checkpoint_refaults_cleanly`.
    leaves: std::cell::RefCell<StoreLeaves>,
    /// Address of the pinned store's data (the `S` inside the
    /// `Rc<RefCell<S>>` the page source reads through). The session
    /// advances the pin after a commit only when the committed store
    /// IS the pinned store — a commit into a byte-identical twin store
    /// passes succession, but advancing the pin would wedge the next
    /// fault. Compared by address rather than
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
    tracking: StoreTracking,
}

struct StoreTracking {
    backing_authority: Option<ironhorse_vm::BackingCommitAuthority>,
    snapshot_baseline: ironhorse_vm::SnapshotBaseline,
    epoch: u64,
    seal: String,
    /// Present on lazily resumed sessions: advancing it on checkpoint
    /// is what lets the machine keep faulting after its own commits
    /// (its non-dirty rows are unchanged by its own checkpoint).
    pin: Option<std::rc::Rc<LazyPin>>,
    /// Slot pages dirtied (or grown) since the last collection this
    /// session ran — the generational collector's candidate set,
    /// accumulated from each checkpoint's traveling page rows and
    /// cleared when a collection consumes it. A fresh RESUME starts
    /// empty (a generational pass right after resume frees nothing —
    /// retention-only, sound).
    gen_dirty: std::collections::BTreeSet<u32>,
    /// The session's live copy of the store's root metadata:
    /// seeded from verified state at begin/resume and advanced by
    /// each successful checkpoint, so the steady-state commit reads
    /// NO stored metadata and re-hashes only the dirty leaves' root
    /// paths. `None` after a failed commit (the owner-drops-on-failure
    /// discipline [`RootLedger`] documents); the next checkpoint takes
    /// the slow path — stored-metadata read, laundering pre-verify,
    /// full recombination — and rebuilds it.
    root_ledger: Option<crate::store::RootLedger>,
    /// Total COMPLETED cranks the STORE has absorbed — the durable
    /// counter the cadence schedule is derived from (store schema 8).
    /// Seeded from the manifest at begin/resume and written back by
    /// every checkpoint, so it survives a suspend and the schedule
    /// cannot fork across one.
    ///
    /// The session does not advance this itself: it has no notion of a
    /// crank. The caller that does — `PersistentMachine` — sets it with
    /// [`StoreSession::set_cranks`] before checkpointing.
    cranks: u64,
    collect_every: u32,
    collections: u64,
}

impl std::fmt::Debug for StoreSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoreSession")
            .field("epoch", &self.tracking.epoch)
            .field("seal", &self.tracking.seal)
            .finish_non_exhaustive()
    }
}

impl StoreSession {
    /// The store epoch this session last committed or adopted.
    pub fn epoch(&self) -> u64 {
        self.tracking.epoch
    }

    /// Total COMPLETED cranks this store has absorbed — the durable
    /// counter a cadence schedule must key off if it is to survive a
    /// suspend (see [`StoreManifest::cranks`]).
    pub fn cranks(&self) -> u64 {
        self.tracking.cranks
    }

    /// Record the store's completed-crank total, to be written by the
    /// next checkpoint. The session cannot derive this — it has no
    /// notion of a crank — so the caller that does owns it.
    pub fn set_cranks(&mut self, cranks: u64) {
        self.tracking.cranks = cranks;
    }

    /// Collection cadence committed at genesis (zero disables scheduling).
    pub fn collect_every(&self) -> u32 {
        self.tracking.collect_every
    }

    /// Durable collection events, including explicit collections.
    pub fn collections(&self) -> u64 {
        self.tracking.collections
    }

    /// Record a completed collection before checkpointing it atomically.
    pub fn set_collections(&mut self, collections: u64) {
        self.tracking.collections = collections;
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
fn manifest_of(interp: &Interp, signature: &Signature, epoch: u64, cranks: u64) -> StoreManifest {
    StoreManifest {
        version: crate::format::Version::current(),
        store_schema: STORE_SCHEMA_VERSION,
        signature: signature.clone(),
        creation: crate::image::CreationParams {
            initial_slot_count: interp.slots().capacity(),
            initial_chunk_bytes: interp.chunks().byte_size() as u32,
        },
        slot_count: interp.slots().capacity(),
        slot_live: interp.slots().live_count(),
        chunk_len: interp.chunks().byte_size() as u64,
        free_len: interp.slots().free_list().len() as u32,
        epoch,
        cranks,
        collect_every: 0,
        collections: 0,
        parent_seal: String::new(),
        root: String::new(),
        seal: String::new(),
    }
}

/// Bind a machine to an **empty** store with a full epoch-1 write and
/// return the session for later incremental checkpoints. A store that
/// already holds an epoch is refused ([`StoreError::NotEmpty`]) —
/// adopting existing content is [`resume_from_store`]'s job.
pub fn begin_store_session(
    interp: Interp,
    signature: &Signature,
    store: &mut dyn HeapStore,
) -> Result<StoreSession, (Interp, StoreError)> {
    begin_store_session_with_cadence(interp, signature, store, 0)
}

/// Bind a fresh store with its immutable collection cadence.
pub fn begin_store_session_with_cadence(
    mut interp: Interp,
    signature: &Signature,
    store: &mut dyn HeapStore,
    collect_every: u32,
) -> Result<StoreSession, (Interp, StoreError)> {
    match begin_store_core(&mut interp, signature, store, collect_every) {
        Ok(tracking) => Ok(StoreSession { interp, tracking }),
        Err(error) => Err((interp, error)),
    }
}

fn begin_store_core(
    interp: &mut Interp,
    signature: &Signature,
    store: &mut dyn HeapStore,
    collect_every: u32,
) -> Result<StoreTracking, StoreError> {
    match store.manifest() {
        Err(StoreError::Empty) => {}
        Ok(m) => return Err(StoreError::NotEmpty { epoch: m.epoch }),
        Err(e) => return Err(e),
    }
    // The persist gate, on the data path: the ONLY way to
    // an image of this machine is the gated `snapshot_image`, whose
    // refusals are re-phrased as `StoreError`s so the machine travels
    // back beside them. Its predicates, in order: a QUIESCENT crank
    // boundary (a halted crank may leave pending
    // microtasks, a populated call stack, live handlers, a set
    // exception and a mid-frame value stack, and even a table-empty
    // halt leaves the boundary registers rooted, hence the lifecycle
    // latch; the managed lifecycle rewinds halted cranks),
    // unsupported live state refused by row name, and
    // the stored-key-id audit of the image itself.
    let image = match interp.snapshot_image(signature) {
        Ok(image) => image,
        Err(MachineSnapshotError::NotQuiescent) => {
            return Err(StoreError::MachineNotQuiescent);
        }
        Err(MachineSnapshotError::PendingStateUnsupported { row }) => {
            return Err(StoreError::PendingStateUnsupported { row });
        }
        Err(MachineSnapshotError::Snapshot(e)) => return Err(StoreError::Snapshot(e)),
        // Unreachable for `Interp` (`snapshot_image` does no I/O); kept
        // so the match stays exhaustive if the error type grows an arm.
        Err(MachineSnapshotError::Io(e)) => return Err(StoreError::Io(e.to_string())),
    };
    let batch = crate::store::image_to_batch_with_cadence(&image, 1, "", collect_every);
    // A failed commit hands the machine back with its dirt intact.
    store.commit(&batch)?;
    // Only a successful commit clears the bitmaps: a failed commit
    // forgets nothing and the next attempt re-offers the same dirt.
    interp.acknowledge_arena_commit();
    // Seed the session's root ledger from the epoch-1 batch — it
    // carries EVERY row, so an empty ledger advanced by it is the
    // store's exact state (`root_ledger_tracks_real_batches`).
    let root_ledger = {
        let mut ledger =
            crate::store::RootLedger::build(&batch.small, Vec::new(), Vec::new(), Vec::new(), &[]);
        ledger
            .apply(
                &batch.manifest,
                &batch.small,
                &batch.slot_pages,
                &batch.chunk_extents,
                &batch.free_segs,
                &batch.page_edges,
            )
            .ok()
            .filter(|root| *root == batch.manifest.root)
            .map(|_| ledger)
    };
    debug_assert!(root_ledger.is_some(), "epoch-1 ledger seed cannot diverge");
    let seal = batch.manifest.seal;
    // The full write dirtied EVERY page: the first generational pass
    // after a begin degenerates to a full partial collect, which is
    // exactly right for a fresh store.
    let gen_dirty: std::collections::BTreeSet<u32> =
        (0..crate::store::slot_page_count(batch.manifest.slot_count)).collect();
    let snapshot_baseline = interp.acknowledge_snapshot();
    Ok(StoreTracking {
        snapshot_baseline,
        gen_dirty,
        epoch: 1,
        seal,
        pin: None,
        backing_authority: None,
        root_ledger,
        // A fresh store has absorbed no cranks; the first checkpoint
        // records however many the caller reports.
        cranks: 0,
        collect_every,
        collections: 0,
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
    checkpoint_to_store_core(&mut session.interp, &mut session.tracking, signature, store)
}

fn checkpoint_to_store_core(
    interp: &mut Interp,
    tracking: &mut StoreTracking,
    signature: &Signature,
    store: &mut dyn HeapStore,
) -> Result<u64, StoreError> {
    signature.check_boot()?;
    if let Some(authority) = &tracking.backing_authority {
        interp.check_backing_authority(authority).map_err(|_| {
            StoreError::Snapshot(SnapshotError::Corrupt(
                "commit authority does not match the machine's backing",
            ))
        })?;
    }
    // Runtime-interned property ids remain resumable: string keys live
    // in the NAME table (persisted every checkpoint via the small
    // state) and symbol keys travel in the SYMB table, so a live
    // machine's stored ids are always resumable by construction, and
    // `begin_store_session` / `resume_from_store` keep the full-image
    // audit for adopted bytes.
    //
    // The incremental path's gate. It cannot ride `snapshot_image`: a
    // checkpoint builds its batch from the DIRTY pages and the small
    // state, never from a full image, which is what keeps it O(dirty).
    // So the predicates run inline here, in the same order as the gated
    // image so a machine refuses by the same name on
    // either verb: the quiescence gate first (a halted
    // crank must be rewound, never checkpointed — see
    // begin_store_session), then the pending rows, walked over the
    // dirty pages only (the clean pages were admitted by the checkpoint
    // that committed them). The stored-key-id audit is not repeated
    // here: a live machine's stored ids come only from minting, and the
    // audit exists for adopted bytes, which begin/resume/import run it
    // on.
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    if let Some(row) = interp.stored_unpersistable_row_at_checkpoint() {
        return Err(StoreError::PendingStateUnsupported { row });
    }
    let stored = store.manifest()?;
    if stored.epoch != tracking.epoch {
        return Err(StoreError::EpochMismatch {
            expected: tracking.epoch,
            found: stored.epoch,
        });
    }
    if stored.seal != tracking.seal {
        // Equal height, different lineage: a fork, copy, or foreign
        // store — the case a bare epoch counter cannot see.
        return Err(StoreError::BaselineMismatch {
            expected: tracking.seal.clone(),
            found: stored.seal,
        });
    }
    if let Some(pin) = &tracking.pin {
        // Read through the caller's existing store borrow: the lazy source
        // owns the same RefCell and cannot be borrowed during checkpoint.
        interp.slots().validate_backing_before_checkpoint(|page| {
            let bytes = store.read_slot_page(page)?;
            if pin.leaves.borrow().pages.get(page as usize).copied()
                != Some(leaf_hash(LEAF_PAGE, page, &bytes))
            {
                return Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                    "checkpoint deferred slot page leaf mismatch",
                )));
            }
            crate::slot_codec::decode_slots(&bytes).map_err(|_| {
                StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                    "checkpoint deferred slot page decode",
                ))
            })
        })?;
    }
    let epoch = tracking.epoch.checked_add(1).ok_or(StoreError::Snapshot(
        crate::format::SnapshotError::Corrupt("store epoch exhausted"),
    ))?;
    // Root maintenance takes one of two paths. FAST: the
    // session holds a live [`RootLedger`] — verified at seed time and
    // advanced in lockstep with this session's own commits, which the
    // pairing guard above proves are the only ones — so this commit
    // reuses the retained root metadata and re-hashes only the dirty leaves'
    // root paths, O(dirty · log n). The ledger is TAKEN here: any
    // error path FROM THIS POINT ON drops it and the next checkpoint
    // rebuilds via the slow path (the drop-on-failure discipline).
    //
    // The guards ABOVE — quiescence, unsupported rows, epoch, seal,
    // deferred backing validation, epoch overflow, and a failed manifest
    // read — return before the take, so a refusal
    // there leaves the ledger in place. Those guards
    // refuse before anything is written, so the ledger still describes
    // exactly the store state it was advanced against and stays
    // coherent. What must drop the ledger is a failure that could have
    // left the store somewhere else, and every one of those is below.
    // SLOW (no
    // ledger: first checkpoint after a failure): read the stored
    // metadata and verify it recombines to the stored root before
    // building on it — a leaf edited at rest leaves the manifest
    // untouched, so the pairing guard above still passes, and without
    // this check the edit would be laundered into THIS commit's
    // validly sealed root. The fast
    // path is immune to that laundering by construction — it never
    // reads the edited bytes — and the edit stays detected by the
    // backend's own recombination, every fault's row/leaf check, and
    // the next open.
    let mut ledger = match tracking.root_ledger.take() {
        Some(ledger) => ledger,
        None => {
            let (pages, exts) = store.leaf_hashes()?;
            let frees = store.free_leaf_hashes()?;
            let edges = store.page_edges()?;
            let sections =
                crate::store_sections::SectionLeaves::from_hashes(store.small_section_hashes()?);
            let ledger =
                crate::store::RootLedger::build_from_sections(sections, pages, exts, frees, &edges);
            let root = ledger.root(&stored);
            if root != stored.root {
                return Err(StoreError::BaselineMismatch {
                    expected: root,
                    found: stored.root.clone(),
                });
            }
            ledger
        }
    };
    let mut manifest = manifest_of(interp, signature, epoch, tracking.cranks);
    manifest.parent_seal = tracking.seal.clone();
    manifest.collect_every = tracking.collect_every;
    manifest.collections = tracking.collections;

    // Dirty rows only — never the whole heap. `page_records`/
    // `extent_bytes` copy one page/extent out of the arena (dirty rows
    // are resident by construction, lazy or not), and the encoding is
    // the same canonical record codec the full path uses. The range
    // filter mirrors the chunk side's — the slot bitmap cannot exceed
    // the geometry today (slot space never shrinks), so it is the
    // same belt-and-braces, an unindexable panic traded for a row the
    // root check below would refuse.
    let page_count = slot_page_count(manifest.slot_count);
    let mut page_edges: Vec<(u32, Vec<u32>)> = Vec::new();
    let slot_pages: Vec<(u32, Vec<u8>)> = interp
        .slots()
        .dirty_pages()
        .into_iter()
        .filter(|&p| p < page_count)
        .map(|page| {
            let records = interp.slots().page_records(page);
            // The page-edge summary falls out of the records
            // already in hand — a pure function of page content.
            page_edges.push((page, derive_page_edges(page, &records)));
            let mut bytes =
                Vec::with_capacity(records.len() * crate::slot_codec::SLOT_RECORD_BYTES);
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
        .chunks()
        .dirty_extents()
        .into_iter()
        .filter(|&e| e < ext_count)
        .map(|e| (e, interp.chunks().extent_bytes(e)))
        .collect();

    // Select before extraction and encoding; hash only dirty candidates.
    let prior_sections =
        ledger
            .section_leaves()
            .ok_or(StoreError::Snapshot(SnapshotError::Corrupt(
                "checkpoint ledger lacks section inventory",
            )))?;
    let dirty = interp.snapshot_dirty_sections(&tracking.snapshot_baseline);
    let small = small_state_of(interp, dirty);
    let small_updates = crate::store_sections::SmallSection::ALL
        .into_iter()
        .filter(|section| dirty.contains(section.vm_section()))
        .filter_map(|section| {
            let bytes = small.encode_section(section);
            (crate::store_sections::section_hash(section, &bytes)
                != prior_sections.hashes()[section.id() as usize])
                .then_some(crate::store_sections::SectionUpdate { section, bytes })
        })
        .collect();
    // Free-list segments: diff against the prior segment
    // leaves so only CHANGED segments travel — LIFO churn touches the
    // tail segment, making per-commit free bytes O(1) in heap size.
    // The ledger holds prior free leaves, either retained from the last
    // successful checkpoint or rebuilt from the verified store inventory.
    let prior_frees = ledger.free_leaves();
    let free_all = crate::store::encode_all_free_segs(interp.slots().free_list());
    let free_segs: Vec<(u32, Vec<u8>)> = free_all
        .into_iter()
        .filter(|(i, bytes)| {
            prior_frees.get(*i as usize).copied()
                != Some(leaf_hash(crate::store::LEAF_FREE, *i, bytes))
        })
        .collect();
    let mut batch = CheckpointBatch {
        prev_seal: tracking.seal.clone(),
        manifest,
        small: Vec::new(),
        small_updates: Some(small_updates),
        slot_pages,
        chunk_extents,
        free_segs,
        page_edges,
    };
    batch.manifest.root = ledger.apply_checkpoint(&batch)?;
    crate::store::reseal_batch(&mut batch);
    let seal = batch.manifest.seal.clone();
    store.commit(&batch)?;
    // Failed writes drop the advanced ledger; the next attempt validates the
    // persisted inventory and reoffers every difference against that baseline.
    tracking.root_ledger = Some(ledger);
    // Accumulate the traveled slot pages into the generational
    // candidate set (dirtied ∪ grown — exactly what this commit
    // shipped); a collection consumes and clears it.
    tracking
        .gen_dirty
        .extend(batch.slot_pages.iter().map(|(p, _)| *p));
    // Did this commit land in the PINNED store — the one the machine's
    // faults read from — decided by address identity (borrow-free, see
    // [`LazyPin`])? A commit into an identical TWIN leaves the pin, and
    // the pinned store's content, exactly where the faults need them.
    //
    // Taken BEFORE the dirty bits are cleared, because the arenas need
    // the answer to decide which pages are still safe to evict: clean is
    // not the same as backed, and a twin commit makes them differ. See
    // `tests/store_checkpoint.rs::evict_after_a_twin_store_checkpoint_keeps_the_modified_body`.
    let landed_in_backing = {
        let committed: *const dyn HeapStore = &*store;
        tracking
            .pin
            .as_ref()
            .is_some_and(|pin| committed.cast::<()>() == pin.store_addr)
    };
    if !landed_in_backing {
        interp.acknowledge_arena_commit();
    }
    tracking.snapshot_baseline = interp.acknowledge_snapshot();
    tracking.epoch = epoch;
    tracking.seal = seal.clone();
    if let Some(pin) = &tracking.pin {
        if landed_in_backing {
            pin.epoch.set(epoch);
            *pin.seal.borrow_mut() = seal;
            // The pinned store's rows just changed; the leaves every
            // future fault verifies against must follow (a
            // committed-then-clean row is evictable, so it CAN fault
            // again — and must verify against the bytes this commit
            // wrote, not the attach-time ones). Patched in place from
            // the batch's own rows — O(dirty), like the root ledger.
            {
                let mut leaves = pin.leaves.borrow_mut();
                leaves.pages.resize(page_count as usize, [0u8; 32]);
                leaves.exts.resize(
                    chunk_extent_count(batch.manifest.chunk_len) as usize,
                    [0u8; 32],
                );
                leaves.frees.resize(
                    crate::store::free_seg_count(batch.manifest.free_len) as usize,
                    [0u8; 32],
                );
                for (i, bytes) in &batch.slot_pages {
                    leaves.pages[*i as usize] = leaf_hash(LEAF_PAGE, *i, bytes);
                }
                for (i, bytes) in &batch.chunk_extents {
                    leaves.exts[*i as usize] = leaf_hash(LEAF_EXT, *i, bytes);
                }
                for (i, bytes) in &batch.free_segs {
                    leaves.frees[*i as usize] = leaf_hash(crate::store::LEAF_FREE, *i, bytes);
                }
            }
            // And the arenas' lazy backing advances to the committed
            // geometry: rows appended past the attach-time range are
            // now store-backed (evictable, re-faultable), and the
            // tail row's expected fault length is the committed one.
            interp
                .acknowledge_backing_commit(
                    tracking
                        .backing_authority
                        .as_mut()
                        .expect("lazy session has backing authority"),
                )
                .map_err(|_| {
                    StoreError::Snapshot(SnapshotError::Corrupt(
                        "commit authority does not match the machine's backing",
                    ))
                })?;
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
    let (manifest, _small, leaves) = validate_store(store, expected_sig)?.into_parts();
    // Ledger seed material: validation just proved these
    // leaves recombine to the stored root; the raw summaries and
    // small bytes complete the picture. Read before the torn-read
    // re-check below so the guard covers them too.
    let edges = store.page_edges()?;
    let small_bytes = store.read_small_state()?;
    let image = store_to_image(store)?;
    // The eager resume reads every row, so it can afford the FULL
    // id-space audit and is the one resume path that does. It closes
    // the adoption hole: a store whose bytes carry a property id
    // outside both key tables (crafted, torn, or written by a
    // pre-unification build that let one through) is refused here
    // rather than laundered into this session's checkpoints.
    // `resume_from_store_lazy` deliberately reads no heap rows
    // at open — that is the whole point of lazy resume — so it cannot
    // ask this question, and does not pretend to; what protects it is
    // that every path that ADOPTS bytes audits (begin, import, eager
    // resume), and the incremental checkpoint only ever writes ids a
    // live machine minted, so no store this code produces can hold one.
    if image.stored_unregistered_key_id().is_some() {
        return Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
            "stored property id outside the name and symbol-key tables",
        )));
    }
    // Re-check the manifest after the row reads: the reads above are
    // not one atomic snapshot on every backend, so a concurrent commit
    // could otherwise hand us a chimera of two epochs. Same-seal after
    // the reads proves the rows all belonged to one epoch.
    let after = store.manifest()?;
    if after.epoch != manifest.epoch || after.seal != manifest.seal {
        return Err(StoreError::BaselineMismatch {
            expected: manifest.seal,
            found: after.seal,
        });
    }
    let root_ledger = crate::store::RootLedger::build_sectioned(
        &small_bytes,
        leaves.pages,
        leaves.exts,
        leaves.frees,
        &edges,
    )?;
    debug_assert_eq!(
        root_ledger.root(&manifest),
        manifest.root,
        "seed from validated state"
    );
    let interp = image_to_interp(ValidatedSnapshot::from_validated_image(image))
        .map_err(StoreError::Snapshot)?;
    // Restore can normalize older payloads; preserve that dirt until committed.
    let snapshot_baseline = interp.snapshot_baseline();
    Ok(StoreSession {
        interp,
        tracking: StoreTracking {
            snapshot_baseline,
            gen_dirty: std::collections::BTreeSet::new(),
            epoch: manifest.epoch,
            seal: manifest.seal,
            pin: None,
            backing_authority: None,
            root_ledger: Some(root_ledger),
            cranks: manifest.cranks,
            collect_every: manifest.collect_every,
            collections: manifest.collections,
        },
    })
}

/// The [`ironhorse_vm::PageSource`] adapter over a shared [`HeapStore`].
/// Reads go through the `RefCell` so the
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
    /// The (epoch, seal, row leaves) the machine's session currently
    /// stands at. Every fault re-verifies the pin, so a store
    /// advanced by anyone else turns torn reads into a deterministic
    /// named crashed crank instead of a chimera heap, and checks its row
    /// against the pinned leaves, so a length-preserving flip at rest dies as a
    /// named crashed crank, never a different machine. The session
    /// advances all three on its own commits — see
    /// [`LazyPin::leaves`] for why the leaves must advance too.
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
        if self.pin.leaves.borrow().pages.get(page as usize).copied()
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
        if self.pin.leaves.borrow().exts.get(ext as usize).copied()
            != Some(leaf_hash(LEAF_EXT, ext, &bytes))
        {
            panic!("lazy heap fault: chunk extent {ext} fails its leaf hash (corrupt store)");
        }
        // Same post-read verification as `slot_page` — see there.
        self.check_pin("chunk extent post-read");
        bytes
    }
}

/// Rebuild a machine from a store with **lazy reification**: validate
/// the manifest, small state, inventory, and leaf metadata up front.
/// The arenas are attached over a
/// [`ironhorse_vm::PageSource`] and fault slot pages / chunk extents
/// in on first touch. Row reification follows the wake crank's working
/// set; total wake-up work also includes the upfront metadata validation.
///
/// Each fault verifies its row against the pinned store's leaf hashes;
/// clean backed rows can be evicted and verified again on re-fault
/// (`tests/store_checkpoint.rs`). The store rides in
/// an `Rc<RefCell<…>>` so the returned machine's fault path and the
/// caller's later [`checkpoint_to_store`] (`&mut *store.borrow_mut()`)
/// share it.
pub fn resume_from_store_lazy<S: HeapStore + 'static>(
    store: std::rc::Rc<std::cell::RefCell<S>>,
    expected_sig: &Signature,
) -> Result<StoreSession, StoreError> {
    let (manifest, small, leaves) = validate_store(&*store.borrow(), expected_sig)?.into_parts();
    // Ledger seed material, read before the torn-read re-check
    // below so the guard covers it too.
    let edges = store.borrow().page_edges()?;
    let small_bytes = store.borrow().read_small_state()?;
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
    let root_ledger = crate::store::RootLedger::build_sectioned(
        &small_bytes,
        leaves.pages.clone(),
        leaves.exts.clone(),
        leaves.frees.clone(),
        &edges,
    )?;
    debug_assert_eq!(
        root_ledger.root(&manifest),
        manifest.root,
        "seed from validated state"
    );
    let pin = std::rc::Rc::new(LazyPin {
        epoch: std::cell::Cell::new(manifest.epoch),
        seal: std::cell::RefCell::new(manifest.seal.clone()),
        leaves: std::cell::RefCell::new(leaves),
        // `RefCell::as_ptr` addresses the `S` itself — the same address
        // a later `&mut *store.borrow_mut()` coerced to
        // `&mut dyn HeapStore` carries into [`checkpoint_to_store`].
        store_addr: store.as_ptr().cast::<()>().cast_const(),
    });
    let source = std::rc::Rc::new(StorePageSource {
        store: store.clone(),
        pin: pin.clone(),
    });
    let (slots, chunks, backing_authority) = ironhorse_vm::BackingCommitAuthority::lazy_arenas(
        manifest.slot_count,
        small.slot_free.clone(),
        manifest.slot_live,
        manifest.chunk_len as usize,
        source,
    )
    .map_err(|_| StoreError::Snapshot(SnapshotError::Corrupt("invalid lazy arena metadata")))?;
    let mut interp = Interp::begin_restore();
    interp
        .restore_snapshot_state(
            slots,
            chunks,
            small.stack.clone(),
            small.names.clone(),
            small.meter.to_state(),
        )
        .map_err(|_| StoreError::Snapshot(SnapshotError::Corrupt("arena restore failed")))?;
    // The installed-names floor, exactly as the container
    // path adopts it; bounds were validated by `SmallState::decode`.
    if let Some(floor) = small.name_floor {
        if interp.restore_installed_names_floor(floor).is_err() {
            return Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "installed-names floor does not restore",
            )));
        }
    }
    // The symbol-key id table rides the small state too, restored
    // before anything can mint.
    if !interp
        .restore_symbol_key_table(small.symbols.next_id, &small.symbols.pairs)
        .is_ok()
    {
        return Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
            "symbol-key table does not restore",
        )));
    }
    // The ledger side tables ride the small state, so a LAZY resume
    // restores them eagerly like everything else small — only arena
    // rows fault on demand.
    restore_side_tables(&mut interp, side_tables_from!(small)).map_err(StoreError::Snapshot)?;
    let interp = finish_restore(interp).map_err(StoreError::Snapshot)?;
    // Restore can normalize older payloads; preserve that dirt until committed.
    let snapshot_baseline = interp.snapshot_baseline();
    Ok(StoreSession {
        interp,
        tracking: StoreTracking {
            snapshot_baseline,
            gen_dirty: std::collections::BTreeSet::new(),
            epoch: manifest.epoch,
            seal: manifest.seal,
            pin: Some(pin),
            backing_authority: Some(backing_authority),
            root_ledger: Some(root_ledger),
            cranks: manifest.cranks,
            collect_every: manifest.collect_every,
            collections: manifest.collections,
        },
    })
}

/// Exact whole-machine collection at a clean, current checkpoint boundary.
///
/// Unlike partial collection this processes weak edges and reclaims chunk
/// storage. It can fault in the full heap and dirty relocated records; the
/// consumer must checkpoint the result to make the collection durable.
/// Scheduling and collection-event counters belong to the consumer.
/// Collector panics retain the VM's permanent failure latch; discard or rewind
/// that session before further execution or persistence.
pub fn full_collect(
    session: &mut StoreSession,
    store: &dyn HeapStore,
) -> Result<ironhorse_vm::gc::GcStats, StoreError> {
    full_collect_core(&mut session.interp, &mut session.tracking, store)
}

fn full_collect_core(
    interp: &mut Interp,
    tracking: &mut StoreTracking,
    store: &dyn HeapStore,
) -> Result<ironhorse_vm::gc::GcStats, StoreError> {
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    assert!(
        interp.slots().dirty_pages().is_empty() && interp.chunks().dirty_extents().is_empty(),
        "full collect requires a clean checkpoint boundary (dirty rows present)"
    );
    let manifest = store.manifest()?;
    if manifest.epoch != tracking.epoch || manifest.seal != tracking.seal {
        return Err(StoreError::BaselineMismatch {
            expected: tracking.seal.clone(),
            found: manifest.seal,
        });
    }
    let stats = interp
        .collect_garbage()
        .map_err(|_| StoreError::MachineNotQuiescent)?;
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    tracking.gen_dirty.clear();
    Ok(stats)
}

/// **Summary-driven partial collection**: free
/// every page unreachable from the machine's GC roots and side-table
/// references, deciding arena reachability ENTIRELY from the store's
/// persisted page-edge summaries — zero row-content reads, no
/// full-heap reification.
///
/// The root set is [`ironhorse_vm::Interp::gc_roots`] **plus**
/// [`ironhorse_vm::Interp::side_table_ref_slots`]: the stored
/// summaries carry only arena edges, so every side-table-held
/// reference (an Array's elements, a Map entry, a captured closure
/// record, a suspended frame) roots its page directly — the
/// page-granular equivalent of the full collector's `extra_edges`
/// hook. Without it, an object reachable only through a side table
/// would be freed while live.
///
/// Page-conservative by design, twice over: garbage co-resident with
/// live data in a reachable page survives, and a side-table entry
/// whose key is dead still roots its values' pages until the full
/// [`ironhorse_vm::Interp::collect_garbage`] reclaims exactly (only
/// it compacts chunk space). Deterministic: a pure function of store
/// content and machine state — which also means the *schedule* of
/// partial collections is part of a replica's decision sequence,
/// exactly like the full collector's (it rewrites the free list, so
/// a replica that collects and one that does not diverge in
/// subsequent allocation order).
/// Sessions using only partial collection never reclaim chunk space. They
/// must recycle the worker before its chunk ceiling is reached, or explicitly
/// run the full collector under their consumer's collection policy. Consumers
/// requiring replica-identical heaps must coordinate collection. Partial
/// collection does not introduce allocation-triggered full GC.
///
/// Contract: call at a checkpoint boundary while the session has no
/// dirty rows — the summaries describe the committed state, and dirt
/// would make them stale. A dirty machine panics with a named message
/// (a caller bug, like the fault contract).
///
/// Returns the number of slots freed. Freeing never dirties (no
/// record byte changes), so the next checkpoint carries the
/// reclamation as free-list state alone.
pub fn partial_collect(
    session: &mut StoreSession,
    store: &dyn HeapStore,
) -> Result<u32, StoreError> {
    partial_collect_core(&mut session.interp, &mut session.tracking, store)
}

fn partial_collect_core(
    interp: &mut Interp,
    tracking: &mut StoreTracking,
    store: &dyn HeapStore,
) -> Result<u32, StoreError> {
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    assert!(
        interp.slots().dirty_pages().is_empty() && interp.chunks().dirty_extents().is_empty(),
        "partial collect requires a clean checkpoint boundary (dirty rows present)"
    );
    let manifest = store.manifest()?;
    if manifest.epoch != tracking.epoch || manifest.seal != tracking.seal {
        return Err(StoreError::BaselineMismatch {
            expected: tracking.seal.clone(),
            found: manifest.seal,
        });
    }
    let total = slot_page_count(manifest.slot_count);
    // Refuse a summary count that disagrees with the geometry BEFORE
    // deciding anything from the summaries: reachability treats an
    // absent entry as "no outgoing edges", so a truncated store would
    // read as maximal garbage and free live pages. Metadata-scale via
    // the trait (the dense default counts the full read; indexed
    // backends answer with a COUNT).
    let found = store.summary_page_count()?;
    if found != total {
        return Err(StoreError::SummaryCount {
            expected: total,
            found,
        });
    }
    let mut root_pages: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for r in interp.gc_roots() {
        if !r.is_null() {
            root_pages.insert(r.0 / crate::store::SLOTS_PER_PAGE);
        }
    }
    // The side-table roots come as the page-bit projection: the same
    // single-body enumeration as `side_table_ref_slots` (parity-locked),
    // without materializing the O(live) index vector.
    for (p, hit) in interp.side_table_ref_page_bits().into_iter().enumerate() {
        if hit {
            root_pages.insert(p as u32);
        }
    }
    // The projection can discover counted-state corruption and poison
    // the machine. Refuse before querying or applying a collection.
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    // The decision query goes through the trait so an indexed backend
    // answers it with transfer proportional to the ANSWER (the SQLite
    // recursive CTE) instead of the dense whole-edge-set read.
    let roots: Vec<u32> = root_pages.into_iter().collect();
    let reached = store.reachable_page_set(&roots)?;
    let dead: Vec<u32> = (0..total).filter(|p| !reached.contains(p)).collect();
    let freed = interp
        .free_pages(&dead)
        .map_err(|_| StoreError::MachineNotQuiescent)?;
    // Pruning a dead bulk row can discover an undercount masked in
    // the bitmap by another reference to the same page.
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    // A full partial collect re-examines everything, so the
    // generational candidate set restarts empty.
    tracking.gen_dirty.clear();
    Ok(freed)
}

/// **Summary-generational collection**: the
/// steady-state variant of [`partial_collect`] whose work is bounded
/// by the MUTATED region, not the live heap. Candidates are only the
/// pages dirtied (or grown) since the last collection this session
/// ran; a candidate survives when it is
///
/// 1. a current ROOT page (arena roots or side-table refs),
/// 2. referenced from an UN-dirtied old page (whose stored edges are
///    its current edges — the reverse-index seed), or
/// 3. reachable from either seed class through summary edges WITHIN
///    the dirty region (edges leaving the region land on old pages,
///    which this pass never frees).
///
/// Old-generation garbage is deliberately retained — the periodic
/// [`partial_collect`] (or the full in-memory collector) reclaims it;
/// every page this pass frees, a full partial pass would also free
/// (retention-only divergence, locked by test). Timing stays a pure
/// function of store content and the session's own checkpoint
/// history. Returns the number of slots freed.
///
/// # Not resume-invariant — do NOT wire this to `collect_every`
///
/// The candidate set is `gen_dirty`, which a resume seeds EMPTY while a
/// continuous session keeps accumulating. Two replicas running the same
/// program under the same `CadencePolicy` therefore free DIFFERENT pages
/// if one suspends and resumes mid-window, and the free list is
/// container-visible — so the replicas' bytes diverge.
///
/// This is latent today and must stay that way: `PersistentMachine`'s
/// scheduled collection calls [`full_collect`], which traces the whole retained
/// graph independently of `gen_dirty`, and this collector is reached only from
/// tests. The `CadencePolicy` replica
/// claim ("same policy ⟹ same bytes") assumes a resume-invariant
/// collector. Anyone flipping `collect_every` to this one must first make
/// the candidate set depend on durable state rather than session
/// lifetime.
pub fn generational_collect(
    session: &mut StoreSession,
    store: &dyn HeapStore,
) -> Result<u32, StoreError> {
    generational_collect_core(&mut session.interp, &mut session.tracking, store)
}

fn generational_collect_core(
    interp: &mut Interp,
    tracking: &mut StoreTracking,
    store: &dyn HeapStore,
) -> Result<u32, StoreError> {
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    assert!(
        interp.slots().dirty_pages().is_empty() && interp.chunks().dirty_extents().is_empty(),
        "generational collect requires a clean checkpoint boundary (dirty rows present)"
    );
    let manifest = store.manifest()?;
    if manifest.epoch != tracking.epoch || manifest.seal != tracking.seal {
        return Err(StoreError::BaselineMismatch {
            expected: tracking.seal.clone(),
            found: manifest.seal,
        });
    }
    let total = slot_page_count(manifest.slot_count);
    let found = store.summary_page_count()?;
    if found != total {
        return Err(StoreError::SummaryCount {
            expected: total,
            found,
        });
    }
    let dirty: Vec<u32> = tracking
        .gen_dirty
        .iter()
        .copied()
        .filter(|p| *p < total)
        .collect();
    if dirty.is_empty() {
        return Ok(0);
    }
    let dirty_set: std::collections::BTreeSet<u32> = dirty.iter().copied().collect();

    // Seed class 1: candidate pages that are current roots.
    let mut seeds: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
    for r in interp.gc_roots() {
        if !r.is_null() {
            let p = r.0 / crate::store::SLOTS_PER_PAGE;
            if dirty_set.contains(&p) {
                seeds.insert(p);
            }
        }
    }
    for (p, hit) in interp.side_table_ref_page_bits().into_iter().enumerate() {
        if hit && dirty_set.contains(&(p as u32)) {
            seeds.insert(p as u32);
        }
    }
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    // Seed class 2: candidates referenced from outside the region.
    for t in store.externally_referenced(&dirty)? {
        seeds.insert(t);
    }
    // Expansion within the region only.
    let seed_vec: Vec<u32> = seeds.into_iter().collect();
    let kept = store.reachable_within(&seed_vec, &dirty)?;
    let dead: Vec<u32> = dirty.into_iter().filter(|p| !kept.contains(p)).collect();
    let freed = interp
        .free_pages(&dead)
        .map_err(|_| StoreError::MachineNotQuiescent)?;
    if !interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
    tracking.gen_dirty.clear();
    Ok(freed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_vm::COST_TABLE_VERSION;

    fn sig() -> Signature {
        Signature::new("ironhorse-worker-v1")
    }

    // Exercise the structured restore boundary directly: these corrupt rows
    // are normally refused by decoding before VM adoption is attempted.
    fn restore_rows(mutate: impl FnOnce(&mut SideTableImages)) -> Result<(), SnapshotError> {
        let mut rows = SideTableImages {
            arrays: vec![],
            index_props: vec![],
            collections: vec![],
            registry: vec![],
            errors: vec![],
            buffers: vec![],
            typed_arrays: vec![],
            data_views: vec![],
            wrappers: vec![],
            regexps: vec![],
            dates: vec![],
            function_state: Default::default(),
            proxy_state: Default::default(),
            accessors: vec![],
            intl_bound_functions: vec![],
            private_elements: Default::default(),
            disposable_stacks: vec![],
            generators: vec![],
            promise_cluster: Default::default(),
            arguments_brands: vec![],
            temporal: Default::default(),
            intl: Default::default(),
            iterators: vec![],
        };
        mutate(&mut rows);
        let source = Interp::new();
        let meter = source.meter_state();
        let (next_symbol_key, symbol_keys) = source.symbol_key_table();
        let (slots, chunks) = source.into_arenas();
        let mut session = Interp::begin_restore();
        session
            .restore_snapshot_state(slots, chunks, Vec::new(), Vec::new(), meter)
            .map_err(|_| SnapshotError::Corrupt("arena restore failed"))?;
        session
            .restore_symbol_key_table(next_symbol_key, &symbol_keys)
            .map_err(|_| SnapshotError::Corrupt("symbol-key table does not restore"))?;
        restore_side_tables(&mut session, rows)?;
        finish_restore(session).map(|_| ())
    }

    #[test]
    fn restore_boundary_rejects_a_cyclic_proxy_before_exposing_the_machine() {
        let owner = Interp::new()
            .function_state_snapshot()
            .native_names
            .unwrap()[0]
            .0;
        assert_eq!(
            restore_rows(|rows| {
                rows.proxy_state
                    .proxies
                    .push(ironhorse_vm::snapshot_api::ProxyRow {
                        owner,
                        target: owner,
                        handler: owner,
                        revoked: false,
                    });
            }),
            Err(SnapshotError::Corrupt("restore session did not validate"))
        );
    }

    #[test]
    fn restore_boundary_reports_exact_side_table_failures() {
        use crate::image::{CollectionImage, ErrorImage, RegExpImage, TypedArrayImage};
        use ironhorse_vm::snapshot_api::{
            AccessorRow, GeneratorRow, PrivateAccessorRow, ProxyRevokerRow,
        };
        use ironhorse_vm::Slot;
        assert_eq!(restore_rows(|_| {}), Ok(()));
        assert_eq!(
            restore_rows(|rows| rows.collections.push(CollectionImage {
                owner: 1,
                kind: 255,
                table_length: 8,
                entries: vec![],
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: unknown kind code"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.errors.push(ErrorImage {
                owner: 1,
                name: "NotAnError".into(),
                message: None,
                frames: vec![],
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed Errors row"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.typed_arrays.push(TypedArrayImage {
                owner: 1,
                kind: 255,
                buffer: 2,
                offset: 0,
                length: 0,
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed typed-array family"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.regexps.push(RegExpImage {
                owner: 1,
                source: "[".into(),
                flags: "".into(),
                last_index_bits: 0,
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: invalid persisted regexp state"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.proxy_state.revokers.push(ProxyRevokerRow {
                owner: 1,
                proxy: 2,
                name_chunk: u32::MAX
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed proxy state"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.generators.push(GeneratorRow {
                owner: 1,
                state: 255,
                frame: None,
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed generator state"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.accessors.push(AccessorRow {
                owner: 1,
                id: 1,
                get: Some(Slot::integer(1)),
                set: None,
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed accessor state"
            ))
        );
        assert_eq!(
            restore_rows(
                |rows| rows.private_elements.accessors.push(PrivateAccessorRow {
                    receiver: 1,
                    brand: 2,
                    get: None,
                    set: Some(Slot::integer(1)),
                })
            ),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed private elements"
            ))
        );
    }

    #[test]
    fn restore_boundary_reports_vm_owned_row_validation() {
        use crate::image::{DateImage, WrapperImage};
        assert_eq!(
            restore_rows(|rows| rows.arguments_brands.push(u32::MAX)),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed ArgumentsBrands row"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.dates.push(DateImage {
                owner: u32::MAX,
                value_bits: 0,
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed Dates row"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.wrappers.push(WrapperImage {
                owner: u32::MAX,
                value: ironhorse_vm::Slot::integer(1),
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed Wrappers row"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.disposable_stacks.push(
                ironhorse_vm::snapshot_api::DisposableStackRow {
                    owner: u32::MAX,
                    disposed: false,
                    asynchronous: false,
                    records: vec![],
                }
            )),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed DisposableStacks row"
            ))
        );
    }

    #[test]
    fn restore_boundary_reports_remaining_language_failures() {
        use ironhorse_vm::snapshot_api::{
            BoundFunctionRow, IntlBoundFunctionRow, IteratorRow, PromiseReactionRow, PromiseRow,
            SegmentsData,
        };
        use ironhorse_vm::value::SlotIndex;
        use ironhorse_vm::{Kind, Payload, Slot};
        assert_eq!(restore_rows(|_| {}), Ok(()));
        assert_eq!(
            restore_rows(|rows| rows.function_state.native_names = Some(vec![(0, 4)])),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed native names"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.intl.segments.push((
                1,
                SegmentsData {
                    units: vec![],
                    segments: vec![(0, 1, false)],
                    granularity: "grapheme".into(),
                }
            ))),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed intl record"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.intl_bound_functions.push(IntlBoundFunctionRow {
                kind: 255,
                function: u32::MAX,
                owner: 1,
                name: "bad".into(),
                name_chunk: u32::MAX,
                arity: 0,
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed Intl bound-function state"
            ))
        );
        assert_eq!(
            restore_rows(
                |rows| rows.function_state.bound_functions.push(BoundFunctionRow {
                    owner: 1,
                    target: 2,
                    this_arg: Slot::undefined(),
                    args: vec![],
                })
            ),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed retained function state"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.promise_cluster.promises.push(PromiseRow {
                owner: 1,
                state: 255,
                result: Slot::undefined(),
                ever_handled: false,
                reactions: vec![],
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed promise cluster"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.promise_cluster.promises.push(PromiseRow {
                owner: 1,
                state: 0,
                result: Slot::undefined(),
                ever_handled: true,
                reactions: vec![PromiseReactionRow {
                    kind: 0,
                    a: 0,
                    b: 0,
                    on_fulfilled: Slot::undefined(),
                    on_rejected: Slot::undefined(),
                    resolve: Slot::of(Kind::Reference, Payload::Reference(SlotIndex(1))),
                    reject: Slot::of(Kind::Reference, Payload::Reference(SlotIndex(1))),
                }],
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed promise capability"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.temporal.plains.push((1, 255, 2026, [0; 8]))),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed temporal record"
            ))
        );
        assert_eq!(
            restore_rows(|rows| rows.iterators.push(IteratorRow {
                owner: 1,
                kind: 255,
                iterable: 2,
                index: 0,
                done: false,
                result: 3,
                enum_keys: vec![],
                str_bytes: vec![],
            })),
            Err(SnapshotError::Corrupt(
                "side-table restore: malformed iterator cursor"
            ))
        );
    }

    #[test]
    fn restore_boundary_reports_name_floor_and_symbol_table_failures() {
        let image = Interp::new().snapshot_image_for_testing(&sig()).unwrap();
        // Deliberately bypass admission to test restoration's own backstops.
        // No external caller can mutate a real ValidatedSnapshot this way.
        let restore =
            |image| image_to_interp(ValidatedSnapshot::from_validated_image(image)).map(|_| ());
        assert_eq!(restore(image.clone()), Ok(()));
        let mut invalid = image.clone();
        invalid.name_floor = Some(u32::MAX);
        assert_eq!(
            restore(invalid),
            Err(SnapshotError::Corrupt(
                "installed-names floor does not restore"
            ))
        );
        let mut invalid = image;
        invalid.symbols.next_id = 0;
        assert_eq!(
            restore(invalid),
            Err(SnapshotError::Corrupt("symbol-key table does not restore"))
        );
    }

    #[test]
    fn checkpoint_refuses_corrupt_deferred_pages_before_committing() {
        use crate::store::{HeapStore, HeapStoreCommit};
        use crate::store_file::FileStore;
        use ironhorse_vm::{Opcode, Slot, SLOTS_PER_PAGE};
        let mut image = Interp::new().snapshot_image_for_testing(&sig()).unwrap();
        let count = (image.slots.len() as u32).div_ceil(SLOTS_PER_PAGE) * SLOTS_PER_PAGE
            + 2 * SLOTS_PER_PAGE;
        image.slots.resize(count as usize, Slot::undefined());
        image.slot_free.clear();
        image.slot_live = count;
        let page = count / SLOTS_PER_PAGE - 1;
        for authenticated in [false, true] {
            let dir = crate::test_dir::TempDir::new("deferred-checkpoint-refusal");
            let path = dir.join("heap.ihstore");
            let mut store = FileStore::open(&path).unwrap();
            store.commit(&image_to_batch(&image, 1, "")).unwrap();
            let shared = std::rc::Rc::new(std::cell::RefCell::new(store));
            let mut session = resume_from_store_lazy(shared.clone(), &sig()).unwrap();
            assert!(!session.machine().slots().is_fully_resident());
            assert!(
                session
                    .machine_mut()
                    .run(&[
                        Opcode::XS_CODE_OBJECT as u8,
                        Opcode::XS_CODE_POP as u8,
                        Opcode::XS_CODE_RETURN as u8,
                    ])
                    .completed
            );
            assert!(session.machine().slots().capacity() > count);
            let original = std::fs::read(&path).unwrap();
            let read_len =
                |at: usize| u32::from_be_bytes(original[at..at + 4].try_into().unwrap()) as usize;
            let small_header = 12 + read_len(8);
            let directory = small_header + 4 + read_len(small_header) + 8;
            let entry = directory + page as usize * 12;
            let offset =
                u64::from_be_bytes(original[entry..entry + 8].try_into().unwrap()) as usize;
            let mut corrupt = original.clone();
            corrupt[offset] = 255; // invalid Kind in an otherwise complete page
            std::fs::write(&path, &corrupt).unwrap();
            if authenticated {
                // Isolate the codec backstop by supplying the expected leaf
                // for malformed bytes through the private test-visible pin.
                // This is not a claim that valid admission can forge its pin.
                let bytes = shared.borrow().read_slot_page(page).unwrap();
                session
                    .tracking
                    .pin
                    .as_ref()
                    .unwrap()
                    .leaves
                    .borrow_mut()
                    .pages[page as usize] = leaf_hash(LEAF_PAGE, page, &bytes);
            }
            let result = checkpoint_to_store(&mut session, &sig(), &mut *shared.borrow_mut());
            if authenticated {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "checkpoint deferred slot page decode"
                    )))
                );
            } else {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "checkpoint deferred slot page leaf mismatch"
                    )))
                );
            }
            assert_eq!(shared.borrow().manifest().unwrap().epoch, 1);
            assert_eq!(std::fs::read(&path).unwrap(), corrupt);
            std::fs::write(&path, &original).unwrap();
            let bytes = shared.borrow().read_slot_page(page).unwrap();
            session
                .tracking
                .pin
                .as_ref()
                .unwrap()
                .leaves
                .borrow_mut()
                .pages[page as usize] = leaf_hash(LEAF_PAGE, page, &bytes);
            checkpoint_to_store(&mut session, &sig(), &mut *shared.borrow_mut()).unwrap();
            assert_eq!(shared.borrow().manifest().unwrap().epoch, 2);
        }
    }

    #[test]
    fn checkpoint_refuses_a_legacy_ledger_then_rebuilds_without_losing_state() {
        use crate::store::{HeapStore, MemoryStore, RootLedger};
        let (code, symbols) = ironhorse_compile::compile_atoms("1").unwrap();
        let mut machine = Interp::new();
        machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
        assert!(machine.run(&code).completed);
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(machine, &sig(), &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        let prior = store.manifest().unwrap();
        let (pages, extents) = store.leaf_hashes().unwrap();
        session.tracking.root_ledger = Some(RootLedger::build(
            &store.read_small_state().unwrap(),
            pages,
            extents,
            store.free_leaf_hashes().unwrap(),
            &store.page_edges().unwrap(),
        ));
        assert!(matches!(
            checkpoint_to_store(&mut session, &sig(), &mut store),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "checkpoint ledger lacks section inventory"
            )))
        ));
        assert_eq!(store.manifest().unwrap(), prior);
        assert!(session.tracking.root_ledger.is_none());
        checkpoint_to_store(&mut session, &sig(), &mut store).unwrap();
        assert_eq!(store.manifest().unwrap().epoch, prior.epoch + 1);
    }

    #[test]
    fn checkpoint_batch_must_use_the_current_schema() {
        use crate::store::{HeapStore, HeapStoreCommit, MemoryStore};
        let (code, symbols) = ironhorse_compile::compile_atoms("1").unwrap();
        let mut machine = Interp::new();
        machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
        assert!(machine.run(&code).completed);
        let image = machine.snapshot_image(&sig()).unwrap();
        let mut batch = image_to_batch(&image, 1, "");
        batch.manifest.store_schema = STORE_SCHEMA_VERSION - 1;
        let mut store = MemoryStore::new();
        assert!(matches!(
            store.commit(&batch),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "checkpoint requires current store schema"
            )))
        ));
        assert!(matches!(store.manifest(), Err(StoreError::Empty)));
    }

    /// A store whose hashes are CONSISTENT over hostile
    /// content (the tampered-at-rest / crafted-store class) must be
    /// refused at resume exactly as the container path refuses the same
    /// bytes - leaf hashes prove authentic-to-commit, not in-arena.
    #[test]
    fn a_consistently_sealed_store_with_out_of_arena_refs_refuses_eager_resume() {
        use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};
        let mut m = Interp::new();
        m.link_intrinsics(&["x".into()]);
        let mut image = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let free: std::collections::HashSet<u32> = image.slot_free.iter().copied().collect();
        let k = (0..image.slots.len())
            .find(|i| !free.contains(&(*i as u32)))
            .expect("a live slot");
        let poison = image.slots.len() as u32 + 100;
        image.slots[k] = Slot::of(Kind::Reference, Payload::Reference(SlotIndex(poison)));
        // Sanity: the CONTAINER path refuses this exact content.
        assert!(
            crate::image::read_machine(&crate::image::write_machine_unchecked(&image), &sig())
                .is_err(),
            "the container gate refuses the poisoned image"
        );
        // Forge the store: image_to_batch computes CONSISTENT leaf
        // hashes / root / seal over the poisoned rows - the honest
        // sealing machinery run over hostile content.
        let mut store = crate::store::MemoryStore::new();
        let batch = image_to_batch(&image, 1, "");
        crate::store::HeapStoreCommit::commit(&mut store, &batch)
            .expect("the forged batch seals consistently");
        assert!(
            resume_from_store(&store, &sig()).is_err(),
            "the store path must refuse what the container path refuses"
        );
    }

    #[test]
    fn live_to_free_to_poison_is_refused_by_container_and_store_paths() {
        use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};
        let mut m = Interp::new();
        m.link_intrinsics(&["x".into()]);
        let mut image = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let page = ironhorse_vm::value::SLOTS_PER_PAGE;
        let edge = (image.slots.len() as u32).div_ceil(page) * page;
        let free = edge + page;
        image.slots.resize(free as usize, Slot::undefined());
        image.slots[edge as usize] = Slot::of(Kind::Reference, Payload::Reference(SlotIndex(free)));
        image.slots.push(Slot::of(
            Kind::Reference,
            Payload::Reference(SlotIndex(free + 900_000)),
        ));
        image.slot_free.push(free);
        image.slot_live = image.slots.len() as u32 - image.slot_free.len() as u32;
        assert!(
            crate::image::read_machine(&crate::image::write_machine_unchecked(&image), &sig())
                .is_err()
        );
        for checkpoint in [false, true] {
            let mut store = crate::store::MemoryStore::new();
            let batch = image_to_batch(&image, 1, "");
            crate::store::HeapStoreCommit::commit(&mut store, &batch)
                .expect("consistently sealed hostile store");
            assert!(resume_from_store(&store, &sig()).is_err());
            let shared = std::rc::Rc::new(std::cell::RefCell::new(store));
            let mut resumed = resume_from_store_lazy(shared.clone(), &sig()).expect("lazy attach");
            let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if checkpoint {
                    assert!(
                        resumed
                            .machine_mut()
                            .run(&[
                                ironhorse_vm::Opcode::XS_CODE_OBJECT as u8,
                                ironhorse_vm::Opcode::XS_CODE_POP as u8,
                                ironhorse_vm::Opcode::XS_CODE_RETURN as u8,
                            ])
                            .completed
                    );
                    assert!(!resumed.machine().slots().is_free_index(SlotIndex(free)));
                    checkpoint_to_store(&mut resumed, &sig(), &mut *shared.borrow_mut()).unwrap();
                } else {
                    resumed.machine().slots().ensure_all_resident();
                }
            }))
            .expect_err("the live-to-free edge must fail before fault or commit can follow poison");
            let message = panic.downcast_ref::<String>().expect("named fault");
            assert!(message.contains("references a free slot"), "{message}");
            assert_eq!(
                crate::store::HeapStore::manifest(&*shared.borrow())
                    .unwrap()
                    .epoch,
                1,
                "refusal must precede the durable commit"
            );
        }
    }

    /// The lazy twin: the poisoned page dies AT THE FAULT with a named
    /// corrupt-store refusal (the path's established channel), not
    /// later inside the collector as an anonymous index panic.
    #[test]
    #[should_panic(expected = "out-of-arena")]
    fn a_lazily_resumed_poisoned_store_dies_named_at_the_fault() {
        use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};
        let mut m = Interp::new();
        m.link_intrinsics(&["x".into()]);
        let mut image = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let free: std::collections::HashSet<u32> = image.slot_free.iter().copied().collect();
        let k = (0..image.slots.len())
            .find(|i| !free.contains(&(*i as u32)))
            .expect("a live slot");
        let poison = image.slots.len() as u32 + 100;
        image.slots[k] = Slot::of(Kind::Reference, Payload::Reference(SlotIndex(poison)));
        let mut store = crate::store::MemoryStore::new();
        let batch = image_to_batch(&image, 1, "");
        crate::store::HeapStoreCommit::commit(&mut store, &batch)
            .expect("the forged batch seals consistently");
        let mut resumed =
            resume_from_store_lazy(std::rc::Rc::new(std::cell::RefCell::new(store)), &sig())
                .expect("lazy attach");
        // Force every page resident - the poisoned one faults.
        resumed.machine_mut().collect_garbage().unwrap();
    }

    /// The chunk-offset half of the same class (the recorded lazy
    /// remainder, now closed): a faulted slot whose String payload
    /// names an offset outside the chunk arena must die AT THE FAULT
    /// with the named corrupt-store refusal — not later, anonymously,
    /// inside a chunk read or the compactor's asserts.
    #[test]
    #[should_panic(expected = "out-of-arena chunk offset")]
    fn a_lazily_resumed_store_with_a_poisoned_chunk_offset_dies_named_at_the_fault() {
        use ironhorse_vm::{ChunkOffset, Kind, Payload, Slot};
        let mut m = Interp::new();
        m.link_intrinsics(&["x".into()]);
        let mut image = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let free: std::collections::HashSet<u32> = image.slot_free.iter().copied().collect();
        let k = (0..image.slots.len())
            .find(|i| !free.contains(&(*i as u32)))
            .expect("a live slot");
        let poison = image.chunks.len() as u32 + 100;
        image.slots[k] = Slot::of(Kind::String, Payload::String(ChunkOffset(poison)));
        // Sanity: the CONTAINER path refuses this exact content.
        assert!(
            crate::image::read_machine(&crate::image::write_machine_unchecked(&image), &sig())
                .is_err(),
            "the container gate refuses the poisoned chunk offset"
        );
        let mut store = crate::store::MemoryStore::new();
        let batch = image_to_batch(&image, 1, "");
        crate::store::HeapStoreCommit::commit(&mut store, &batch)
            .expect("the forged batch seals consistently");
        let mut resumed =
            resume_from_store_lazy(std::rc::Rc::new(std::cell::RefCell::new(store)), &sig())
                .expect("lazy attach");
        // Force every page resident - the poisoned one faults.
        resumed.machine_mut().collect_garbage().unwrap();
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

        let bytes = m
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots");
        let snapshot = read_validated_machine(&bytes, &sig()).expect("validates");
        assert_eq!(
            snapshot.image().meter.to_state(),
            m.meter_state(),
            "the proof wrapper exposes only an immutable validated image",
        );
        let m2 = image_to_interp(snapshot).expect("restores validated state");
        // The restored machine carries the same metering state.
        assert_eq!(m2.meter_state(), m.meter_state());
        // Re-serializing the restored machine is byte-identical.
        assert_eq!(
            m2.write_snapshot(&sig())
                .expect("quiescent machine snapshots"),
            bytes
        );
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
        let bytes = m1
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots");
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

        let bytes = m1
            .write_snapshot(&sig())
            .expect("quiescent machine snapshots");
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
        let mut image = m.snapshot_image_for_testing(&sig()).expect("gated image");
        image.meter.cost_table_version = "ironhorse-meter-999".to_string();
        let bytes = crate::image::write_machine_unchecked(&image);
        match from_snapshot_bytes(&bytes, &sig()) {
            Err(SnapshotError::CostTableMismatch { expected, found }) => {
                assert_eq!(expected, COST_TABLE_VERSION);
                assert_eq!(found, "ironhorse-meter-999");
            }
            Err(e) => panic!("expected cost-table mismatch, got {e:?}"),
            Ok(_) => panic!("expected cost-table mismatch, got a restored machine"),
        }
    }

    #[test]
    fn matching_version_with_different_weights_fails_closed() {
        let mut m = Interp::new();
        m.run(&PROG_A);
        let mut image = m.snapshot_image_for_testing(&sig()).unwrap();
        image.meter.cost_table_digest[0] ^= 1;
        assert!(matches!(
            from_snapshot_bytes(&crate::image::write_machine_unchecked(&image), &sig()),
            Err(SnapshotError::CostTableMismatch { .. })
        ));
    }

    /// A snapshot written under one host signature is refused by a machine
    /// on a different signature (the callback-table gate), at the machine
    /// surface.
    #[test]
    fn signature_mismatch_fails_closed_at_machine_surface() {
        let mut m = Interp::new();
        m.run(&PROG_A);
        let bytes = m.write_snapshot(&Signature::new("host-v1"));
        let bytes = bytes.expect("quiescent machine snapshots");
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

        // A fixed name scoped by the process temp dir; the guard
        // pre-cleans any prior run's leftover and removes the
        // directory on drop, success or panic.
        let dir = crate::test_dir::TempDir::new("ironhorse-cas-test-suspend-resume");

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
        assert_eq!(
            b2.computrons, ub.computrons,
            "meter continued through the CAS round-trip"
        );
    }
}

#[cfg(test)]
pub(crate) mod extraction_counts {
    use std::cell::Cell;
    thread_local! {
        static EXTRACT: Cell<[usize; 32]> = const { Cell::new([0; 32]) };
        static ENCODE: Cell<[usize; 32]> = const { Cell::new([0; 32]) };
    }
    pub(super) fn record(section: ironhorse_vm::SnapshotSection) {
        EXTRACT.with(|counts| {
            let mut n = counts.get();
            n[section as usize] += 1;
            counts.set(n);
        });
    }
    pub(crate) fn encode(section: crate::store_sections::SmallSection) {
        ENCODE.with(|counts| {
            let mut n = counts.get();
            n[section.id() as usize] += 1;
            counts.set(n);
        });
    }
    fn reset() {
        EXTRACT.set([0; 32]);
        ENCODE.set([0; 32]);
    }

    #[test]
    fn unchanged_bulk_sections_are_neither_extracted_nor_encoded() {
        use super::*;
        use crate::store::MemoryStore;
        use crate::store_sections::SmallSection;
        let signature = Signature::new("ironhorse-worker-v1");
        let mut source =
            String::from("var a=[]; var m=new Map(); for(var i=0;i<1000;i++){a[i]=i;m.set(i,i);}");
        for i in 0..1000 {
            source.push_str(&format!("var retained_name_{i}={i};"));
        }
        source.push_str("0");
        let (code, names) = ironhorse_compile::compile_atoms(&source).unwrap();
        let mut interp = Interp::new();
        interp.link_intrinsics(&ironhorse_vm::parse_symbols(&names));
        assert!(interp.run(&code).completed);
        let mut store = MemoryStore::new();
        let mut session = begin_store_session(interp, &signature, &mut store)
            .map_err(|(_, error)| error)
            .unwrap();
        let (hot, _) = ironhorse_compile::compile_atoms("1 + 1").unwrap();
        for resumed in [false, true] {
            if resumed {
                session = resume_from_store(&store, &signature).unwrap();
                checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
            }
            reset();
            assert!(session.machine_mut().run(&hot).completed);
            checkpoint_to_store(&mut session, &signature, &mut store).unwrap();
            for section in [
                SmallSection::Arrays,
                SmallSection::Collections,
                SmallSection::Names,
            ] {
                assert_eq!(
                    EXTRACT.get()[section.id() as usize],
                    0,
                    "{section:?} extraction"
                );
                assert_eq!(
                    ENCODE.get()[section.id() as usize],
                    0,
                    "{section:?} encoding"
                );
            }
            let restored = resume_from_store(&store, &signature).unwrap();
            assert_eq!(
                restored.machine().snapshot_image(&signature).unwrap(),
                session.machine().snapshot_image(&signature).unwrap()
            );
        }
        let store = std::rc::Rc::new(std::cell::RefCell::new(store));
        let mut lazy = resume_from_store_lazy(store.clone(), &signature).unwrap();
        checkpoint_to_store(&mut lazy, &signature, &mut *store.borrow_mut()).unwrap();
        reset();
        assert!(lazy.machine_mut().run(&hot).completed);
        checkpoint_to_store(&mut lazy, &signature, &mut *store.borrow_mut()).unwrap();
        for section in [
            SmallSection::Arrays,
            SmallSection::Collections,
            SmallSection::Names,
        ] {
            assert_eq!(
                EXTRACT.get()[section.id() as usize],
                0,
                "lazy {section:?} extraction"
            );
            assert_eq!(
                ENCODE.get()[section.id() as usize],
                0,
                "lazy {section:?} encoding"
            );
        }
        let restored = resume_from_store(&*store.borrow(), &signature).unwrap();
        assert_eq!(
            restored.machine().snapshot_image(&signature).unwrap(),
            lazy.machine().snapshot_image(&signature).unwrap()
        );
        // Positive control: the counters observe real full materialization.
        reset();
        small_state_of(lazy.machine(), ironhorse_vm::SnapshotDirty::all()).encode_sections();
        for section in [
            SmallSection::Arrays,
            SmallSection::Collections,
            SmallSection::Names,
        ] {
            assert_eq!(EXTRACT.get()[section.id() as usize], 1);
            assert_eq!(ENCODE.get()[section.id() as usize], 1);
        }
    }
}

/// A paged-store session bound to the same shared Machine used by its live
/// compartments and rooted host values. Checkpoints never replace that core.
pub struct SharedStoreSession {
    machine: ironhorse_vm::Machine,
    tracking: StoreTracking,
}

fn shared_access_error(halt: ironhorse_vm::Halt) -> StoreError {
    match halt {
        ironhorse_vm::Halt::MachineBusy => StoreError::MachineNotQuiescent,
        ironhorse_vm::Halt::Refused(row) => StoreError::PendingStateUnsupported { row },
        other => StoreError::MachineOperation(format!("{other:?}")),
    }
}

impl SharedStoreSession {
    pub fn machine(&self) -> &ironhorse_vm::Machine {
        &self.machine
    }
    pub fn epoch(&self) -> u64 {
        self.tracking.epoch
    }
    pub fn cranks(&self) -> u64 {
        self.tracking.cranks
    }
    pub fn set_cranks(&mut self, cranks: u64) {
        self.tracking.cranks = cranks;
    }
    pub fn collect_every(&self) -> u32 {
        self.tracking.collect_every
    }
    pub fn collections(&self) -> u64 {
        self.tracking.collections
    }
    pub fn set_collections(&mut self, collections: u64) {
        self.tracking.collections = collections;
    }

    pub fn checkpoint(
        &mut self,
        signature: &Signature,
        store: &mut dyn HeapStore,
    ) -> Result<u64, StoreError> {
        self.machine
            .with_persistence(|interp| {
                checkpoint_to_store_core(interp, &mut self.tracking, signature, store)
            })
            .map_err(shared_access_error)?
    }
    pub fn full_collect(
        &mut self,
        store: &dyn HeapStore,
    ) -> Result<ironhorse_vm::gc::GcStats, StoreError> {
        self.machine
            .with_collection(|interp| full_collect_core(interp, &mut self.tracking, store))
            .map_err(shared_access_error)?
    }
    pub fn partial_collect(&mut self, store: &dyn HeapStore) -> Result<u32, StoreError> {
        self.machine
            .with_collection(|interp| partial_collect_core(interp, &mut self.tracking, store))
            .map_err(shared_access_error)?
    }
    pub fn generational_collect(&mut self, store: &dyn HeapStore) -> Result<u32, StoreError> {
        self.machine
            .with_collection(|interp| generational_collect_core(interp, &mut self.tracking, store))
            .map_err(shared_access_error)?
    }
}

pub fn begin_shared_store_session(
    machine: ironhorse_vm::Machine,
    signature: &Signature,
    store: &mut dyn HeapStore,
    collect_every: u32,
) -> Result<SharedStoreSession, (ironhorse_vm::Machine, StoreError)> {
    let result = machine
        .with_persistence(|interp| begin_store_core(interp, signature, store, collect_every))
        .map_err(shared_access_error)
        .and_then(|r| r);
    match result {
        Ok(tracking) => Ok(SharedStoreSession { machine, tracking }),
        Err(error) => Err((machine, error)),
    }
}

/// Eagerly restore a shared heap and reattach its exhaustive host policy.
pub fn resume_shared_from_store(
    store: &dyn HeapStore,
    signature: &Signature,
    policy: ironhorse_vm::MachineRestorePolicy,
) -> Result<SharedStoreSession, StoreError> {
    adopt_shared_session(resume_from_store(store, signature)?, policy)
}

/// Restore shared environments over the same authenticated lazy page source used
/// by standalone sessions, with identical commit-authority and pin advancement.
pub fn resume_shared_from_store_lazy<S: HeapStore + 'static>(
    store: std::rc::Rc<std::cell::RefCell<S>>,
    signature: &Signature,
    policy: ironhorse_vm::MachineRestorePolicy,
) -> Result<SharedStoreSession, StoreError> {
    adopt_shared_session(resume_from_store_lazy(store, signature)?, policy)
}

pub fn adopt_shared_session(
    session: StoreSession,
    policy: ironhorse_vm::MachineRestorePolicy,
) -> Result<SharedStoreSession, StoreError> {
    let machine = ironhorse_vm::Machine::from_restored_interpreter(session.interp, policy)
        .map_err(shared_access_error)?;
    Ok(SharedStoreSession {
        machine,
        tracking: session.tracking,
    })
}

impl MachineSnapshot for ironhorse_vm::Machine {
    fn persist_gate(&self) -> Result<(), MachineSnapshotError> {
        self.with_persistence(|interp| interp.persist_gate())
            .map_err(|_| MachineSnapshotError::NotQuiescent)?
    }
    fn snapshot_image(&self, signature: &Signature) -> Result<GatedImage, MachineSnapshotError> {
        self.with_persistence(|interp| interp.snapshot_image(signature))
            .map_err(|_| MachineSnapshotError::NotQuiescent)?
    }
}

pub fn shared_from_snapshot_bytes(
    bytes: &[u8],
    signature: &Signature,
    policy: ironhorse_vm::MachineRestorePolicy,
) -> Result<ironhorse_vm::Machine, StoreError> {
    ironhorse_vm::Machine::from_restored_interpreter(from_snapshot_bytes(bytes, signature)?, policy)
        .map_err(shared_access_error)
}

/// Inspect an inert lazy restore before supplying host policy. This entry point
/// never exposes the interpreter; the supplied policy must cover every environment.
pub fn resume_shared_from_store_lazy_with<S: HeapStore + 'static>(
    store: std::rc::Rc<std::cell::RefCell<S>>,
    signature: &Signature,
    policy: impl FnOnce(
        &[ironhorse_vm::EnvironmentId],
        ironhorse_vm::MeterState,
    ) -> Result<ironhorse_vm::MachineRestorePolicy, StoreError>,
) -> Result<SharedStoreSession, StoreError> {
    let session = resume_from_store_lazy(store, signature)?;
    let ids: Vec<_> = session
        .interp
        .shared_environment_ids()
        .into_iter()
        .map(ironhorse_vm::EnvironmentId)
        .collect();
    let policy = policy(&ids, session.interp.meter_state())?;
    adopt_shared_session(session, policy)
}
