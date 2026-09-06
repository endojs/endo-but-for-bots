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
use crate::image::{
    read_validated_machine, write_machine, MachineImage, MeterImage, ValidatedSnapshot,
};
use crate::sha256::{hex, Sha256};
use crate::store::{
    chunk_extent_count, compute_root, derive_page_edges, image_to_batch, leaf_hash, seal_commit,
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
    /// The machine is not at a quiescent crank boundary (wave-6 W6-10):
    /// its last crank halted. A halt may leave pending microtasks /
    /// frames / an exception that no snapshot carries; even one that
    /// leaves every table empty (a top-level meter abort, the dispatch
    /// ceiling, a decode fault) leaves the boundary registers rooted,
    /// which a resumed twin would not share (review F011). Rewind or
    /// complete a crank before persisting.
    NotQuiescent,
    /// The heap holds live state in a SILENT-WRONG Pending side table
    /// (wave-6 W6-9: proxies, accessors, typed arrays) - a resumed
    /// machine would answer wrong values, so persist refuses by name
    /// until the row's atom lands (error data graduated to `ERRD`).
    PendingStateUnsupported { row: &'static str },
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
                write!(f, "heap holds live {row}: that side table does not travel yet")
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

/// The name of the temp file `suspend_to_cas` writes before the atomic
/// rename to its content hash.
const CAS_TMP_NAME: &str = ".snapshot.tmp";

/// The xsnap-shaped machine snapshot surface, implemented for the ironhorse
/// [`Interp`] (the engine's machine). See the module docs.
pub trait MachineSnapshot {
    /// The persist preconditions (wave-6 W6-10/12): a quiescent crank
    /// boundary and no live state a resume cannot bring back. Required,
    /// not defaulted: a permissive default was the one way an
    /// implementor could hand out an image of a machine no gate had
    /// seen (architecture review F047).
    fn persist_gate(&self) -> Result<(), MachineSnapshotError>;

    /// Build the plain-data [`MachineImage`] of this machine under
    /// `signature` (its host callback-table version) — the arenas, the
    /// value stack, the program symbol names, the metering state, and
    /// the side-table rows — after [`Self::persist_gate`] admits it.
    ///
    /// This is the ONLY way to obtain an image of a live machine outside
    /// this crate, and it is gated by construction: the encoder
    /// ([`write_machine`]), the store batch builder
    /// (`store::image_to_batch`) and every store's `commit` are pure
    /// functions of an image, never of a machine, so the gate cannot be
    /// bypassed by reaching for the data path directly (F047: the gate
    /// used to be attached to three convenience verbs while this method
    /// handed out ungated images, and in-tree helpers already used
    /// `image_to_batch(&m.snapshot_image(..)) + commit` to persist
    /// machines no gate had seen). A crafted or mutated image is still
    /// a legitimate encoder input — that is how the refusal tests and
    /// the fuzz targets exercise the reader — but it starts from an
    /// admitted image or from arbitrary data, never from a halted
    /// machine.
    fn snapshot_image(&self, signature: &Signature) -> Result<MachineImage, MachineSnapshotError>;

    /// Serialize this machine to the in-memory `XS_M` container bytes.
    /// Refuses a machine that fails [`Self::persist_gate`] - the blob
    /// verbs carry the same preconditions as the store verbs.
    fn write_snapshot(&self, signature: &Signature) -> Result<Vec<u8>, MachineSnapshotError> {
        Ok(write_machine(&self.snapshot_image(signature)?))
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
    fn persist_gate(&self) -> Result<(), MachineSnapshotError> {
        if !self.is_quiescent() {
            return Err(MachineSnapshotError::NotQuiescent);
        }
        if let Some(row) = self.stored_unpersistable_row() {
            return Err(MachineSnapshotError::PendingStateUnsupported { row });
        }
        Ok(())
    }

    fn snapshot_image(&self, signature: &Signature) -> Result<MachineImage, MachineSnapshotError> {
        self.persist_gate()?;
        Ok(ungated_image(self, signature))
    }
}

/// Build the plain-data image of `interp` WITHOUT consulting the persist
/// gate. Crate-private on purpose (architecture review F047): the two
/// callers are the gated [`MachineSnapshot::snapshot_image`] and
/// [`begin_store_session`], which runs the same predicates itself so it
/// can hand the machine back beside a [`StoreError`]. Nothing outside
/// this crate can reach an image of a machine the gate has not seen.
pub(crate) fn ungated_image(interp: &Interp, signature: &Signature) -> MachineImage {
    // The carried atoms (see the suspend-point contract): arenas +
    // stack + the name table + meter, plus the side-table ledger's
    // serialized rows (arrays, collections, `Symbol.for` registry)
    // and the symbol-key id table (SYMB). String keys — program
    // symbols and runtime-interned names alike — travel inside the
    // NAME table since the id-space unification, so the KEYS atom
    // is retired and travels empty.
    let tables = side_tables_of(interp);
    let (next_id, pairs) = interp.symbol_key_table();
    MachineImage::from_arenas(
        signature.clone(),
        &interp.slots,
        &interp.chunks,
        interp.stack_slots(),
        interp.program_symbol_names().to_vec(),
        Vec::new(),
        crate::image::SymbolKeyImage { next_id, pairs },
    )
    .with_meter(interp.meter_state())
    .with_side_tables(
        tables.arrays,
        tables.collections,
        tables.registry,
        tables.errors,
        tables.buffers,
        tables.typed_arrays,
        tables.data_views,
    )
    .with_language_rows(
        tables.wrappers,
        tables.regexps,
        tables.arguments_brands,
        tables.temporal,
        tables.intl,
    )
    .with_iterators(tables.iterators)
    .with_dates(tables.dates)
    .with_function_state(tables.function_state)
    .with_proxy_state(tables.proxy_state)
    .with_accessors(tables.accessors)
    .with_intl_bound_functions(tables.intl_bound_functions)
    .with_private_elements(tables.private_elements)
    .with_disposable_stacks(tables.disposable_stacks)
    .with_generators(tables.generators)
    .with_promise_cluster(tables.promise_cluster)
    .with_name_floor(interp.installed_names_floor())
}

/// The machine's serialized side-table views (ledger rows `Arrays`/
/// `Collections`/`SymbolRegistry`/`ErrorData`/`ArrayBuffers`/
/// `TypedArrays`/`DataViews`/`Dates`), converted from the vm's tuple
/// snapshots into the image structs, in the vm's canonical
/// (ascending) order.
struct SideTableImages {
    arrays: Vec<crate::image::ArrayImage>,
    collections: Vec<crate::image::CollectionImage>,
    registry: Vec<crate::image::RegistryImage>,
    errors: Vec<crate::image::ErrorImage>,
    buffers: Vec<crate::image::BufferImage>,
    typed_arrays: Vec<crate::image::TypedArrayImage>,
    data_views: Vec<crate::image::DataViewImage>,
    wrappers: Vec<crate::image::WrapperImage>,
    regexps: Vec<crate::image::RegExpImage>,
    dates: Vec<crate::image::DateImage>,
    function_state: ironhorse_vm::FunctionStateSnapshot,
    proxy_state: ironhorse_vm::ProxyStateSnapshot,
    accessors: Vec<ironhorse_vm::AccessorRow>,
    intl_bound_functions: Vec<ironhorse_vm::IntlBoundFunctionRow>,
    private_elements: ironhorse_vm::PrivateElementSnapshot,
    disposable_stacks: Vec<ironhorse_vm::DisposableStackRow>,
    generators: Vec<ironhorse_vm::GeneratorRow>,
    promise_cluster: ironhorse_vm::PromiseClusterSnapshot,
    arguments_brands: Vec<u32>,
    temporal: crate::image::TemporalImage,
    intl: ironhorse_vm::IntlTables,
    iterators: Vec<ironhorse_vm::IteratorRow>,
}

fn side_tables_of(interp: &Interp) -> SideTableImages {
    let arrays = interp
        .arrays_snapshot()
        .into_iter()
        .map(|(owner, length, items)| crate::image::ArrayImage {
            owner,
            length,
            items,
        })
        .collect();
    let collections = interp
        .collections_snapshot()
        .into_iter()
        .map(
            |(owner, kind, table_length, entries)| crate::image::CollectionImage {
                owner,
                kind,
                table_length,
                entries,
            },
        )
        .collect();
    let registry = interp
        .symbol_registry_snapshot()
        .into_iter()
        .map(|(key, descriptor)| crate::image::RegistryImage { key, descriptor })
        .collect();
    let errors = interp
        .errors_snapshot()
        .into_iter()
        .map(|(owner, name, message, frames)| crate::image::ErrorImage {
            owner,
            name: name.to_string(),
            message,
            frames,
        })
        .collect();
    let buffers = interp
        .array_buffers_snapshot()
        .into_iter()

        .map(|(owner, data, length, flags)| crate::image::BufferImage {
            owner,
            data,
            length,
            flags,
        })
        .collect();
    let typed_arrays = interp
        .typed_arrays_snapshot()
        .into_iter()
        .map(|(owner, kind, buffer, offset, length)| crate::image::TypedArrayImage {
            owner,
            kind,
            buffer,
            offset,
            length,
        })
        .collect();
    let data_views = interp
        .data_views_snapshot()
        .into_iter()
        .map(|(owner, buffer, offset, size)| crate::image::DataViewImage {
            owner,
            buffer,
            offset,
            size,
        })
        .collect();
    let wrappers = interp
        .wrappers_snapshot()
        .into_iter()
        .map(|(owner, value)| crate::image::WrapperImage { owner, value })
        .collect();
    let regexps = interp
        .regexps_snapshot()
        .into_iter()
        .map(|(owner, source, flags, last_index_bits)| crate::image::RegExpImage {
            owner,
            source,
            flags,
            last_index_bits,
        })
        .collect();
    let arguments_brands = interp.arguments_brands_snapshot();
    let (instants, durations, plains, zoneds) = interp.temporal_snapshot();
    let temporal = crate::image::TemporalImage {
        instants,
        durations,
        plains,
        zoneds,
    };
    let intl = interp.intl_snapshot();
    let iterators = interp.iterators_snapshot();
    let dates = interp
        .dates_snapshot()
        .into_iter()
        .map(|(owner, value_bits)| crate::image::DateImage { owner, value_bits })
        .collect();
    let function_state = interp.function_state_snapshot();
    let proxy_state = interp.proxy_state_snapshot();
    let accessors = interp.accessors_snapshot();
    let intl_bound_functions = interp.intl_bound_functions_snapshot();
    let private_elements = interp.private_elements_snapshot();
    let disposable_stacks = interp.disposable_stacks_snapshot();
    let generators = interp.generators_snapshot();
    let promise_cluster = interp.promise_cluster_snapshot();
    SideTableImages {
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
        iterators,
        dates,
        function_state,
        proxy_state,
        accessors,
        intl_bound_functions,
        private_elements,
        disposable_stacks,
        generators,
        promise_cluster,
    }
}

/// Reinstate the ledger side tables on a restored machine from their
/// image rows — [`Interp::restore_bulk_side_tables`]'s image-typed
/// front door, shared by every resume path (container, eager store,
/// lazy store). A malformed kind code was already refused at decode,
/// so the restore cannot fail on validated input — but "cannot" is a
/// claim about the decoders, not a proof, so a `false` return is a
/// STRUCTURED refusal, never a debug-only assert: a release build must
/// refuse the row set, not continue with silently missing exotic state
/// (review finding 4).
#[allow(clippy::too_many_arguments)]
fn restore_side_tables(
    interp: &mut Interp,
    arrays: Vec<crate::image::ArrayImage>,
    collections: Vec<crate::image::CollectionImage>,
    registry: Vec<crate::image::RegistryImage>,
    errors: Vec<crate::image::ErrorImage>,
    buffers: Vec<crate::image::BufferImage>,
    typed_arrays: Vec<crate::image::TypedArrayImage>,
    data_views: Vec<crate::image::DataViewImage>,
    wrappers: Vec<crate::image::WrapperImage>,
    regexps: Vec<crate::image::RegExpImage>,
    dates: Vec<crate::image::DateImage>,
    function_state: ironhorse_vm::FunctionStateSnapshot,
    proxy_state: ironhorse_vm::ProxyStateSnapshot,
    accessors: Vec<ironhorse_vm::AccessorRow>,
    intl_bound_functions: Vec<ironhorse_vm::IntlBoundFunctionRow>,
    private_elements: ironhorse_vm::PrivateElementSnapshot,
    disposable_stacks: Vec<ironhorse_vm::DisposableStackRow>,
    generators: Vec<ironhorse_vm::GeneratorRow>,
    promise_cluster: ironhorse_vm::PromiseClusterSnapshot,
    arguments_brands: Vec<u32>,
    temporal: crate::image::TemporalImage,
    intl: ironhorse_vm::IntlTables,
    iterators: Vec<ironhorse_vm::IteratorRow>,
) -> Result<(), crate::format::SnapshotError> {
    use crate::format::SnapshotError;
    let ok = interp.restore_bulk_side_tables(
        arrays
            .into_iter()
            .map(|a| (a.owner, a.length, a.items))
            .collect(),
        collections
            .into_iter()
            .map(|c| (c.owner, c.kind, c.table_length, c.entries))
            .collect(),
        registry.into_iter().map(|r| (r.key, r.descriptor)).collect(),
    );
    if !ok {
        return Err(SnapshotError::Corrupt("side-table restore: unknown kind code"));
    }
    // The error-data rows (name validated at decode against the
    // engine's closed error-name set, so this cannot fail on a
    // validated image either).
    let ok = interp.restore_error_data(
        errors
            .into_iter()
            .map(|e| (e.owner, e.name, e.message, e.frames))
            .collect(),
    );
    if !ok {
        return Err(SnapshotError::Corrupt("side-table restore: unknown error name"));
    }
    // The typed-array family (kinds, flags, extents and view geometry
    // all validated at decode/bounds; the vm re-validates against its
    // restored arenas, so `false` is a belt-and-braces corrupt signal).
    let ok = interp.restore_typed_array_family(
        buffers
            .into_iter()
            .map(|b| (b.owner, b.data, b.length, b.flags))
            .collect(),
        typed_arrays
            .into_iter()
            .map(|t| (t.owner, t.kind, t.buffer, t.offset, t.length))
            .collect(),
        data_views
            .into_iter()
            .map(|d| (d.owner, d.buffer, d.offset, d.size))
            .collect(),
    );
    if !ok {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed typed-array family",
        ));
    }
    // The data-only language rows (schema 11). Wrapper values were
    // bounds-walked with the heap; a regexp must recompile from its persisted
    // (source, flags) and carry either the standard current lastIndex heap
    // descriptor or the legacy numeric fallback; a plain record's kind was
    // validated at decode.
    interp.restore_wrapper_data(
        wrappers.into_iter().map(|w| (w.owner, w.value)).collect(),
    );
    let ok = interp.restore_regexps(
        regexps
            .into_iter()
            .map(|r| (r.owner, r.source, r.flags, r.last_index_bits))
            .collect(),
    );
    if !ok {
        return Err(SnapshotError::Corrupt(
            "side-table restore: invalid persisted regexp state",
        ));
    }
    interp.restore_dates(
        dates
            .into_iter()
            .map(|d| (d.owner, d.value_bits))
            .collect(),
    );
    if !interp.restore_proxy_state(proxy_state) {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed proxy state",
        ));
    }
    // The Intl record rows (schema 12): pure resolved-options data;
    // segment geometry and the iterator cross-reference were validated
    // at decode/bounds, and the vm re-validates them on the way in.
    let ok = interp.restore_intl(intl);
    if !ok {
        return Err(SnapshotError::Corrupt("side-table restore: malformed intl record"));
    }
    // The Intl bound natives (schema 18) install BEFORE the retained
    // function state, not after: they are the one function-shaped
    // population that `FUNC` does not own, and a guest `.bind()` over
    // one (`nf.format.bind(null)`) emits a `FUNC` bound row whose
    // target is an `IBFN` slot. Adjudicating retained function state
    // first sees that target in neither `state.functions` nor the boot
    // machine and refuses an HONEST snapshot — permanently, on every
    // resume. `restore_intl_bound_functions` depends only on the Intl
    // data rows above, so the earlier position is otherwise inert, and
    // the two collision checks stay mutually exclusive: `IBFN` still
    // refuses a slot boot already minted, and `FUNC` still refuses one
    // an earlier verb installed.
    if !interp.restore_intl_bound_functions(intl_bound_functions) {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed Intl bound-function state",
        ));
    }
    // The promise cluster (schema 23) installs its resolving-function
    // natives BEFORE the retained function state for the same reason
    // `IBFN` does: a guest `.bind()` over a resolving function emits a
    // `FUNC` bound row whose target is a `PRMS` slot, which the
    // retained-state adjudication must find already installed. The
    // collision checks stay two-sided: this verb refuses a slot boot
    // already minted, and `FUNC` refuses one an earlier verb installed.
    if !interp.restore_promise_cluster(promise_cluster) {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed promise cluster",
        ));
    }
    if !interp.restore_function_state(function_state) {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed retained function state",
        ));
    }
    if !interp.restored_promise_capabilities_are_valid() {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed promise capability",
        ));
    }
    if !interp.restore_generators(generators) {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed generator state",
        ));
    }
    interp.restore_arguments_brands(arguments_brands);
    let ok = interp.restore_temporal_records(
        temporal.instants,
        temporal.durations,
        temporal.plains,
        temporal.zoneds,
    );
    if !ok {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed temporal record",
        ));
    }
    if !interp.restore_accessors(accessors) {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed accessor state",
        ));
    }
    if !interp.restore_private_elements(private_elements) {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed private elements",
        ));
    }
    interp.restore_disposable_stacks(disposable_stacks);
    // The iterator cursors (schema 13): validated at decode/bounds
    // (kinds, cursor ranges, the covering-collection cross-check);
    // restored AFTER the collections so the covering rows are in hand
    // for the vm's own re-validation.
    let ok = interp.restore_iterators(iterators);
    if !ok {
        return Err(SnapshotError::Corrupt(
            "side-table restore: malformed iterator cursor",
        ));
    }
    // Semantic migrations run only after the persisted name floor, symbol-key
    // map, and arguments brands have all been reinstated. They can therefore
    // distinguish a never-installed implicit intrinsic from a guest deletion,
    // and a legacy arguments layout from current guest customization.
    interp.migrate_restored_layout();
    Ok(())
}

/// Rebuild a live [`Interp`] from a [`ValidatedSnapshot`]: a fresh
/// boot machine with the image's serializable state reinstated (the
/// arenas, stack, program symbol names, and metering state). The
/// boot-derived intrinsics/prototypes come from the fresh boot at their
/// deterministic slot indices, matching the image's boot region. See
/// [`Interp::restore_snapshot_state`].
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
    let mut interp = Interp::new();
    interp.restore_snapshot_state(slots, chunks, image.stack, image.names, meter);
    // The installed-names floor (wave-6 W6-7): adopt the live floor
    // when it traveled, so names interned during the last install pass
    // stay lazily installable exactly as they were live. Bounds were
    // validated at decode.
    if let Some(floor) = image.name_floor {
        if !interp.restore_installed_names_floor(floor) {
            return Err(crate::format::SnapshotError::Corrupt(
                "installed-names floor does not restore",
            ));
        }
    }
    // The symbol-key id table (SYMB): re-bind each stored id to its
    // descriptor slot and reinstate the top-down mint counter, so a
    // symbol-keyed property reads back under the same id and a later
    // mint cannot reuse a stored number.
    if !interp.restore_symbol_key_table(image.symbols.next_id, &image.symbols.pairs) {
        return Err(crate::format::SnapshotError::Corrupt(
            "symbol-key table does not restore",
        ));
    }
    // The side-table ledger rows (arrays, collections, registry):
    // restored through the counted accessors so the side-ref page
    // counts rebuild in lockstep.
    restore_side_tables(
        &mut interp,
        image.arrays,
        image.collections,
        image.registry,
        image.errors,
        image.buffers,
        image.typed_arrays,
        image.data_views,
        image.wrappers,
        image.regexps,
        image.dates,
        image.function_state,
        image.proxy_state,
        image.accessors,
        image.intl_bound_functions,
        image.private_elements,
        image.disposable_stacks,
        image.generators,
        image.promise_cluster,
        image.arguments_brands,
        image.temporal,
        image.intl,
        image.iterators,
    )?;
    Ok(interp)
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
    /// The verified row-leaf hashes every fault checks its row
    /// against. Seeded from `validate_store` at attach and REFRESHED
    /// by the session's own successful checkpoints (alongside the
    /// epoch/seal advance): a checkpoint rewrites dirty rows in the
    /// store, and phase 8's eviction means a rewritten-then-clean row
    /// CAN fault again — against the committed bytes, which only the
    /// refreshed leaves match. Frozen attach-time leaves would
    /// misdiagnose that healthy re-fault as a corrupt store (the
    /// review's eviction finding).
    leaves: std::cell::RefCell<StoreLeaves>,
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
    /// Slot pages dirtied (or grown) since the last collection this
    /// session ran — the generational collector's candidate set,
    /// accumulated from each checkpoint's traveling page rows and
    /// cleared when a collection consumes it. A fresh RESUME starts
    /// empty (a generational pass right after resume frees nothing —
    /// retention-only, sound).
    gen_dirty: std::collections::BTreeSet<u32>,
    /// The session's live copy of the store's root metadata (V6-c):
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
    /// cannot fork across one (review wave 5).
    ///
    /// The session does not advance this itself: it has no notion of a
    /// crank. The caller that does — `PersistentMachine` — sets it with
    /// [`StoreSession::set_cranks`] before checkpointing.
    cranks: u64,
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

    /// Total COMPLETED cranks this store has absorbed — the durable
    /// counter a cadence schedule must key off if it is to survive a
    /// suspend (see [`StoreManifest::cranks`]).
    pub fn cranks(&self) -> u64 {
        self.cranks
    }

    /// Record the store's completed-crank total, to be written by the
    /// next checkpoint. The session cannot derive this — it has no
    /// notion of a crank — so the caller that does owns it.
    pub fn set_cranks(&mut self, cranks: u64) {
        self.cranks = cranks;
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
fn manifest_of(
    interp: &Interp,
    signature: &Signature,
    epoch: u64,
    cranks: u64,
) -> StoreManifest {
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
        cranks,
        root: String::new(),
        seal: String::new(),
    }
}

/// The machine's small state, mirroring [`MachineSnapshot::snapshot_image`]
/// exactly (the KEYS section is retired — string keys travel inside the
/// NAME table since the id-space unification; the ledger rows — arrays,
/// collections, registry since schema 7 and errors since schema 9 —
/// travel alongside, and the symbol-key table travels in the symbols
/// section).
fn small_state_of(interp: &Interp) -> SmallState {
    let tables = side_tables_of(interp);
    let (next_id, pairs) = interp.symbol_key_table();
    SmallState {
        stack: interp.stack_slots().to_vec(),
        slot_free: interp.slots.free_list().to_vec(),
        keys: Vec::new(),
        names: interp.program_symbol_names().to_vec(),
        symbols: crate::image::SymbolKeyImage { next_id, pairs },
        meter: MeterImage::of(interp.meter_state()),
        arrays: tables.arrays,
        collections: tables.collections,
        registry: tables.registry,
        errors: tables.errors,
        buffers: tables.buffers,
        typed_arrays: tables.typed_arrays,
        data_views: tables.data_views,
        wrappers: tables.wrappers,
        regexps: tables.regexps,
        dates: tables.dates,
        function_state: tables.function_state,
        proxy_state: tables.proxy_state,
        accessors: tables.accessors,
        intl_bound_functions: tables.intl_bound_functions,
        private_elements: tables.private_elements,
        disposable_stacks: tables.disposable_stacks,
        generators: tables.generators,
        promise_cluster: tables.promise_cluster,
        arguments_brands: tables.arguments_brands,
        temporal: tables.temporal,
        intl: tables.intl,
        iterators: tables.iterators,
        // Canonicalized like `with_name_floor`: a floor at the table
        // length is the restore default and travels as `None`.
        name_floor: {
            let floor = interp.installed_names_floor();
            (floor as usize != interp.program_symbol_names().len()).then_some(floor)
        },
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
    // A persist verb requires a QUIESCENT crank boundary (wave-6
    // W6-10): a halted crank may leave pending microtasks, a populated
    // call stack, live handlers, a set exception, and a mid-frame value
    // stack — a checkpoint there serializes the mid-frame stack while
    // silently dropping the rest — and even a table-empty halt leaves
    // the boundary registers rooted, so the predicate's first conjunct
    // is the crank-lifecycle latch (review F011). The managed lifecycle
    // rewinds halted cranks; this gate covers every other caller.
    if !interp.is_quiescent() {
        return Err((interp, StoreError::MachineNotQuiescent));
    }
    // The four SILENT-WRONG Pending rows (wave-6 W6-9): a resumed heap
    // holding one answers wrong values, not visible failures. Refuse by
    // name until their atoms land (the recorded G3 lift).
    if let Some(row) = interp.stored_unpersistable_row() {
        return Err((interp, StoreError::PendingStateUnsupported { row }));
    }
    // The id-space audit (what remains of the wave-4 P1 gate): with
    // string keys living in the NAME table and symbol keys traveling in
    // the SYMB table, a LIVE machine cannot store an id outside both —
    // ids only ever come from minting. Finding one here would mean this
    // process corrupted its own tables; refuse rather than persist the
    // contradiction. Asked of the IMAGE, which this path builds in full
    // anyway, so the witness is what the store would actually hold.
    // The ungated builder is correct here: the two gate predicates ran
    // above, phrased as `StoreError`s so the machine travels back with
    // the refusal.
    let image = ungated_image(&interp, signature);
    if image.stored_unregistered_key_id().is_some() {
        return Err((
            interp,
            StoreError::Snapshot(SnapshotError::Corrupt(
                "stored property id outside the name and symbol-key tables",
            )),
        ));
    }
    let batch = image_to_batch(&image, 1, "");
    if let Err(e) = store.commit(&batch) {
        // A failed commit hands the machine back with its dirt intact.
        return Err((interp, e));
    }
    // Only a successful commit clears the bitmaps: a failed commit
    // forgets nothing and the next attempt re-offers the same dirt.
    interp.slots.clear_dirty();
    interp.chunks.clear_dirty();
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
    Ok(StoreSession {
        gen_dirty,
        interp,
        epoch: 1,
        seal,
        pin: None,
        root_ledger,
        // A fresh store has absorbed no cranks; the first checkpoint
        // records however many the caller reports.
        cranks: 0,
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
    // The wave-4 P1 intern gate stood here — an O(dirty) refusal of any
    // stored runtime-interned property id, because the id→name map did
    // not travel. The id-space unification retired it: string keys live
    // in the NAME table (persisted every checkpoint via the small
    // state) and symbol keys travel in the SYMB table, so a live
    // machine's stored ids are always resumable by construction, and
    // `begin_store_session` / `resume_from_store` keep the full-image
    // audit for adopted bytes.
    //
    if let Some(row) = session.interp.stored_unpersistable_row_at_checkpoint() {
        return Err(StoreError::PendingStateUnsupported { row });
    }
    // And the quiescence gate (wave-6 W6-10): a halted crank must be
    // rewound, never checkpointed - see begin_store_session.
    if !session.interp.is_quiescent() {
        return Err(StoreError::MachineNotQuiescent);
    }
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
    // Root maintenance takes one of two paths (V6-c). FAST: the
    // session holds a live [`RootLedger`] — verified at seed time and
    // advanced in lockstep with this session's own commits, which the
    // pairing guard above proves are the only ones — so this commit
    // reads NO stored metadata and re-hashes only the dirty leaves'
    // root paths, O(dirty · log n). The ledger is TAKEN here: any
    // error path FROM THIS POINT ON drops it and the next checkpoint
    // rebuilds via the slow path (the drop-on-failure discipline).
    //
    // The guards ABOVE — runtime-interns, epoch, seal, epoch overflow,
    // and a failed manifest read — return before the take, so a refusal
    // there leaves the ledger in place (review wave 4, P3b: the prose
    // said "any failed or refused commit drops it", which overstated
    // it). That is correct rather than an oversight: those guards
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
    // validly sealed root (the review's laundering finding). The fast
    // path is immune to that laundering by construction — it never
    // reads the edited bytes — and the edit stays detected by the
    // backend's own recombination, every fault's row/leaf check, and
    // the next open.
    enum RootPath {
        Fast(crate::store::RootLedger),
        Slow {
            leaf_pages: Vec<[u8; 32]>,
            leaf_exts: Vec<[u8; 32]>,
            prior_frees: Vec<[u8; 32]>,
            edges_all: Vec<Vec<u32>>,
        },
    }
    let mut path = match session.root_ledger.take() {
        Some(ledger) => RootPath::Fast(ledger),
        None => {
            let (leaf_pages, leaf_exts) = store.leaf_hashes()?;
            let prior_frees = store.free_leaf_hashes()?;
            let edges_all = store.page_edges()?;
            let stored_small = store.read_small_state()?;
            let recombined = compute_root(
                &leaf_hash(LEAF_SMALL, 0, &stored_small),
                &leaf_pages,
                &leaf_exts,
                &prior_frees,
                &edges_all,
            );
            if recombined != stored.root {
                return Err(StoreError::BaselineMismatch {
                    expected: recombined,
                    found: stored.root.clone(),
                });
            }
            RootPath::Slow {
                leaf_pages,
                leaf_exts,
                prior_frees,
                edges_all,
            }
        }
    };
    let interp = &mut session.interp;
    let mut manifest = manifest_of(interp, signature, epoch, session.cranks);

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
        .slots
        .dirty_pages()
        .into_iter()
        .filter(|&p| p < page_count)
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
    // Free-list segments (phase 9): diff against the prior segment
    // leaves so only CHANGED segments travel — LIFO churn touches the
    // tail segment, making per-commit free bytes O(1) in heap size.
    // Both paths hold the prior free leaves: the ledger carries them
    // live; the slow path just read them.
    let prior_frees: &[[u8; 32]] = match &path {
        RootPath::Fast(ledger) => ledger.free_leaves(),
        RootPath::Slow { prior_frees, .. } => prior_frees,
    };
    let free_all = crate::store::encode_all_free_segs(interp.slots.free_list());
    let free_segs: Vec<(u32, Vec<u8>)> = free_all
        .into_iter()
        .filter(|(i, bytes)| {
            prior_frees.get(*i as usize).copied() != Some(leaf_hash(crate::store::LEAF_FREE, *i, bytes))
        })
        .collect();
    // Root maintenance: prior state + this commit's dirty
    // leaves/summaries → the new sealed root. Fast path: the ledger
    // patches the traveling rows and recomputes only their tree
    // paths. Slow path: patch the full vectors read above and
    // recombine from scratch (also the ledger's rebuild material).
    manifest.root = match &mut path {
        RootPath::Fast(ledger) => ledger.apply(
            &manifest,
            &small,
            &slot_pages,
            &chunk_extents,
            &free_segs,
            &page_edges,
        )?,
        RootPath::Slow {
            leaf_pages,
            leaf_exts,
            prior_frees,
            edges_all,
        } => {
            let leaf_frees = prior_frees;
            leaf_pages.resize(page_count as usize, [0u8; 32]);
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
            edges_all.resize(page_count as usize, Vec::new());
            for (i, targets) in &page_edges {
                edges_all[*i as usize] = targets.clone();
            }
            compute_root(
                &leaf_hash(LEAF_SMALL, 0, &small),
                leaf_pages,
                leaf_exts,
                leaf_frees,
                edges_all,
            )
        }
    };
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
    // The commit landed: hand the advanced ledger back to the session
    // (fast path), or rebuild one from the slow path's freshly
    // verified-and-patched vectors — either way the NEXT checkpoint
    // is O(dirty · log n).
    session.root_ledger = Some(match path {
        RootPath::Fast(ledger) => ledger,
        RootPath::Slow {
            leaf_pages,
            leaf_exts,
            prior_frees,
            edges_all,
        } => crate::store::RootLedger::build(
            &batch.small,
            leaf_pages,
            leaf_exts,
            prior_frees,
            &edges_all,
        ),
    });
    // Accumulate the traveled slot pages into the generational
    // candidate set (dirtied ∪ grown — exactly what this commit
    // shipped); a collection consumes and clears it.
    session
        .gen_dirty
        .extend(batch.slot_pages.iter().map(|(p, _)| *p));
    // Did this commit land in the PINNED store — the one the machine's
    // faults read from — decided by address identity (borrow-free, see
    // [`LazyPin`])? A commit into an identical TWIN leaves the pin, and
    // the pinned store's content, exactly where the faults need them.
    //
    // Taken BEFORE the dirty bits are cleared, because the arenas need
    // the answer to decide which pages are still safe to evict: clean is
    // not the same as backed, and a twin commit makes them differ
    // (review wave 5).
    let landed_in_backing = {
        let committed: *const dyn HeapStore = &*store;
        session
            .pin
            .as_ref()
            .is_some_and(|pin| committed.cast::<()>() == pin.store_addr)
    };
    session
        .interp
        .slots
        .clear_dirty_after_commit(landed_in_backing);
    session
        .interp
        .chunks
        .clear_dirty_after_commit(landed_in_backing);
    session.epoch = epoch;
    session.seal = seal.clone();
    if let Some(pin) = &session.pin {
        if landed_in_backing {
            pin.epoch.set(epoch);
            *pin.seal.borrow_mut() = seal;
            // The pinned store's rows just changed; the leaves every
            // future fault verifies against must follow (phase 8: a
            // committed-then-clean row is evictable, so it CAN fault
            // again — and must verify against the bytes this commit
            // wrote, not the attach-time ones). Patched in place from
            // the batch's own rows — O(dirty), like the root ledger.
            {
                let mut leaves = pin.leaves.borrow_mut();
                leaves.pages.resize(page_count as usize, [0u8; 32]);
                leaves
                    .exts
                    .resize(chunk_extent_count(batch.manifest.chunk_len) as usize, [0u8; 32]);
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
            session.interp.slots.advance_backing(batch.manifest.chunk_len);
            session.interp.chunks.advance_backing();
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
    // Ledger seed material (V6-c): validation just proved these
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
    // rather than laundered into this session's checkpoints (review
    // wave 5). `resume_from_store_lazy` deliberately reads no heap rows
    // at open — that is the whole point of lazy resume — so it cannot
    // ask this question, and does not pretend to; what protects it is
    // that every WRITE path audits, so no store this code produces can
    // hold one.
    if image.stored_unregistered_key_id().is_some() {
        return Err(StoreError::Snapshot(
            crate::format::SnapshotError::Corrupt(
                "stored property id outside the name and symbol-key tables",
            ),
        ));
    }
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
    let root_ledger = crate::store::RootLedger::build(
        &small_bytes,
        leaves.pages,
        leaves.exts,
        leaves.frees,
        &edges,
    );
    debug_assert_eq!(root_ledger.root(), manifest.root, "seed from validated state");
    Ok(StoreSession {
        gen_dirty: std::collections::BTreeSet::new(),
        interp: image_to_interp(ValidatedSnapshot::from_validated_image(image))
            .map_err(StoreError::Snapshot)?,
        epoch: manifest.epoch,
        seal: manifest.seal,
        pin: None,
        root_ledger: Some(root_ledger),
        cranks: manifest.cranks,
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
    /// The (epoch, seal, row leaves) the machine's session currently
    /// stands at. Every fault re-verifies the pin, so a store
    /// advanced by anyone else turns torn reads into a deterministic
    /// named crashed crank instead of a chimera heap (the review's
    /// two-lazy-machines finding), and checks its row against the
    /// pinned leaves, so a length-preserving flip at rest dies as a
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
    let (manifest, small, leaves) =
        validate_store(&*store.borrow(), expected_sig)?.into_parts();
    // Ledger seed material (V6-c), read before the torn-read re-check
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
    let root_ledger = crate::store::RootLedger::build(
        &small_bytes,
        leaves.pages.clone(),
        leaves.exts.clone(),
        leaves.frees.clone(),
        &edges,
    );
    debug_assert_eq!(root_ledger.root(), manifest.root, "seed from validated state");
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
    let slots = ironhorse_vm::SlotArena::lazy_from_parts(
        manifest.slot_count,
        small.slot_free.clone(),
        manifest.slot_live,
        source.clone(),
        manifest.chunk_len,
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
    // The installed-names floor (wave-6 W6-7), exactly as the container
    // path adopts it; bounds were validated by `SmallState::decode`.
    if let Some(floor) = small.name_floor {
        if !interp.restore_installed_names_floor(floor) {
            return Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "installed-names floor does not restore",
            )));
        }
    }
    // The symbol-key id table rides the small state too, restored
    // before anything can mint.
    if !interp.restore_symbol_key_table(small.symbols.next_id, &small.symbols.pairs) {
        return Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
            "symbol-key table does not restore",
        )));
    }
    // The ledger side tables ride the small state, so a LAZY resume
    // restores them eagerly like everything else small — only arena
    // rows fault on demand.
    restore_side_tables(
        &mut interp,
        small.arrays,
        small.collections,
        small.registry,
        small.errors,
        small.buffers,
        small.typed_arrays,
        small.data_views,
        small.wrappers,
        small.regexps,
        small.dates,
        small.function_state,
        small.proxy_state,
        small.accessors,
        small.intl_bound_functions,
        small.private_elements,
        small.disposable_stacks,
        small.generators,
        small.promise_cluster,
        small.arguments_brands,
        small.temporal,
        small.intl,
        small.iterators,
    )
    .map_err(StoreError::Snapshot)?;
    Ok(StoreSession {
        gen_dirty: std::collections::BTreeSet::new(),
        interp,
        epoch: manifest.epoch,
        seal: manifest.seal,
        pin: Some(pin),
        root_ledger: Some(root_ledger),
        cranks: manifest.cranks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ironhorse_vm::COST_TABLE_VERSION;

    fn sig() -> Signature {
        Signature::new("ironhorse-worker-v1")
    }

    /// Wave-6 W6-14: a store whose hashes are CONSISTENT over hostile
    /// content (the tampered-at-rest / crafted-store class) must be
    /// refused at resume exactly as the container path refuses the same
    /// bytes - leaf hashes prove authentic-to-commit, not in-arena.
    #[test]
    fn a_consistently_sealed_store_with_out_of_arena_refs_refuses_eager_resume() {
        use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};
        let mut m = Interp::new();
        m.link_intrinsics(&["x".to_string()]);
        let mut image = m.snapshot_image(&sig()).expect("gated image");
        let free: std::collections::HashSet<u32> = image.slot_free.iter().copied().collect();
        let k = (0..image.slots.len())
            .find(|i| !free.contains(&(*i as u32)))
            .expect("a live slot");
        let poison = image.slots.len() as u32 + 100;
        image.slots[k] = Slot::of(Kind::Reference, Payload::Reference(SlotIndex(poison)));
        // Sanity: the CONTAINER path refuses this exact content.
        assert!(
            crate::image::read_machine(&crate::image::write_machine(&image), &sig()).is_err(),
            "the container gate refuses the poisoned image"
        );
        // Forge the store: image_to_batch computes CONSISTENT leaf
        // hashes / root / seal over the poisoned rows - the honest
        // sealing machinery run over hostile content.
        let mut store = crate::store::MemoryStore::new();
        let batch = image_to_batch(&image, 1, "");
        crate::store::HeapStore::commit(&mut store, &batch)
            .expect("the forged batch seals consistently");
        assert!(
            resume_from_store(&store, &sig()).is_err(),
            "the store path must refuse what the container path refuses"
        );
    }

    /// The lazy twin: the poisoned page dies AT THE FAULT with a named
    /// corrupt-store refusal (the path's established channel), not
    /// later inside the collector as an anonymous index panic.
    #[test]
    #[should_panic(expected = "out-of-arena")]
    fn a_lazily_resumed_poisoned_store_dies_named_at_the_fault() {
        use ironhorse_vm::{Kind, Payload, Slot, SlotIndex};
        let mut m = Interp::new();
        m.link_intrinsics(&["x".to_string()]);
        let mut image = m.snapshot_image(&sig()).expect("gated image");
        let free: std::collections::HashSet<u32> = image.slot_free.iter().copied().collect();
        let k = (0..image.slots.len())
            .find(|i| !free.contains(&(*i as u32)))
            .expect("a live slot");
        let poison = image.slots.len() as u32 + 100;
        image.slots[k] = Slot::of(Kind::Reference, Payload::Reference(SlotIndex(poison)));
        let mut store = crate::store::MemoryStore::new();
        let batch = image_to_batch(&image, 1, "");
        crate::store::HeapStore::commit(&mut store, &batch)
            .expect("the forged batch seals consistently");
        let mut resumed = resume_from_store_lazy(
            std::rc::Rc::new(std::cell::RefCell::new(store)),
            &sig(),
        )
        .expect("lazy attach");
        // Force every page resident - the poisoned one faults.
        resumed.machine_mut().collect_garbage();
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
        m.link_intrinsics(&["x".to_string()]);
        let mut image = m.snapshot_image(&sig()).expect("gated image");
        let free: std::collections::HashSet<u32> = image.slot_free.iter().copied().collect();
        let k = (0..image.slots.len())
            .find(|i| !free.contains(&(*i as u32)))
            .expect("a live slot");
        let poison = image.chunks.len() as u32 + 100;
        image.slots[k] = Slot::of(Kind::String, Payload::String(ChunkOffset(poison)));
        // Sanity: the CONTAINER path refuses this exact content.
        assert!(
            crate::image::read_machine(&crate::image::write_machine(&image), &sig()).is_err(),
            "the container gate refuses the poisoned chunk offset"
        );
        let mut store = crate::store::MemoryStore::new();
        let batch = image_to_batch(&image, 1, "");
        crate::store::HeapStore::commit(&mut store, &batch)
            .expect("the forged batch seals consistently");
        let mut resumed = resume_from_store_lazy(
            std::rc::Rc::new(std::cell::RefCell::new(store)),
            &sig(),
        )
        .expect("lazy attach");
        // Force every page resident - the poisoned one faults.
        resumed.machine_mut().collect_garbage();
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

        let bytes = m.write_snapshot(&sig()).expect("quiescent machine snapshots");
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
        assert_eq!(m2.write_snapshot(&sig()).expect("quiescent machine snapshots"), bytes);
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
        let bytes = m1.write_snapshot(&sig()).expect("quiescent machine snapshots");
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

        let bytes = m1.write_snapshot(&sig()).expect("quiescent machine snapshots");
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
        let mut image = m.snapshot_image(&sig()).expect("gated image");
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
        assert_eq!(b2.computrons, ub.computrons, "meter continued through the CAS round-trip");

    }
}

/// **Summary-driven partial collection** (store seam phase 6): free
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
/// would be freed while live (the review's unsoundness finding).
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
    // The decision query goes through the trait so an indexed backend
    // answers it with transfer proportional to the ANSWER (the SQLite
    // recursive CTE) instead of the dense whole-edge-set read.
    let roots: Vec<u32> = root_pages.into_iter().collect();
    let reached = store.reachable_page_set(&roots)?;
    let dead: Vec<u32> = (0..total).filter(|p| !reached.contains(p)).collect();
    let freed = session.machine_mut().free_pages(&dead);
    // A full partial collect re-examines everything, so the
    // generational candidate set restarts empty.
    session.gen_dirty.clear();
    Ok(freed)
}

/// **Summary-generational collection** (store seam phase 11): the
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
/// container-visible — so the replicas' bytes diverge (review wave 4,
/// DET-5).
///
/// This is latent today and must stay that way: `PersistentMachine`'s
/// scheduled collection calls [`partial_collect`], whose candidate set is
/// the whole store and which is therefore resume-invariant, and this
/// collector is reached only from tests. The `CadencePolicy` replica
/// claim ("same policy ⟹ same bytes") assumes a resume-invariant
/// collector. Anyone flipping `collect_every` to this one must first make
/// the candidate set depend on durable state rather than session
/// lifetime.
pub fn generational_collect(
    session: &mut StoreSession,
    store: &dyn HeapStore,
) -> Result<u32, StoreError> {
    let interp = session.machine();
    assert!(
        interp.slots.dirty_pages().is_empty() && interp.chunks.dirty_extents().is_empty(),
        "generational collect requires a clean checkpoint boundary (dirty rows present)"
    );
    let manifest = store.manifest()?;
    if manifest.epoch != session.epoch || manifest.seal != session.seal {
        return Err(StoreError::BaselineMismatch {
            expected: session.seal.clone(),
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
    let dirty: Vec<u32> = session
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
    let interp = session.machine();
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
    // Seed class 2: candidates referenced from outside the region.
    for t in store.externally_referenced(&dirty)? {
        seeds.insert(t);
    }
    // Expansion within the region only.
    let seed_vec: Vec<u32> = seeds.into_iter().collect();
    let kept = store.reachable_within(&seed_vec, &dirty)?;
    let dead: Vec<u32> = dirty.into_iter().filter(|p| !kept.contains(p)).collect();
    let freed = session.machine_mut().free_pages(&dead);
    session.gen_dirty.clear();
    Ok(freed)
}
