//! The **side-table completeness ledger** — the bug class this crate is
//! designed against (job spec item 3; the review ledger's standing
//! snapshot note).
//!
//! In ironhorse the heap is index arenas, but a machine's reachable state is
//! *not* wholly in those arenas: dozens of side tables ([`ironhorse_vm`]'s
//! `Interp` fields) hold per-instance and per-activation state keyed by
//! slot index — function closures, the caught-exception jump chain, a
//! suspended generator's saved frame, a promise's pending reactions, the
//! harden worklist. **An atom grammar that serializes the arenas but
//! misses one of these is the snapshot-shaped version of a missing GC
//! root: it round-trips fine on trivial heaps and corrupts on real ones.**
//!
//! So the set of side tables is made *explicit and exhaustive here*, one
//! [`SideTable`] variant per table, enumerated against `Interp`'s actual
//! fields. [`SideTable::descriptor`] is an exhaustive `match`: the
//! compiler forces a new variant to be described the moment it is added,
//! and [`SideTable::ALL`] (guarded by [`tests::all_is_exhaustive`]) forces
//! it into the coverage ledger. Each descriptor records its
//! [`Coverage`] — whether the writer/reader in [`crate::image`] carries it
//! yet — so the remaining work is a compile-checked list, never a silent
//! omission.
//!
//! # Excluded transients — why "enumerated against `Interp`'s actual
//! fields" does not mean *every* field
//!
//! An `Interp` field is a side table this ledger must track only if it
//! carries *reachable machine state at a quiescent suspend point* (a crank
//! boundary — no frame is mid-execution). Two field classes are deliberately
//! **not** ledger rows because at that point they hold nothing, or nothing
//! that is not re-derived; excluding them is what keeps the list to genuine
//! snapshot obligations, and this is the audit trail for each:
//!
//! **Per-activation registers — empty at a crank boundary.** These describe
//! *the frame currently executing*; between cranks the call stack is
//! unwound, so each is at its inert default and carries no cross-crank state:
//! - `args`, `this_val`, `cur_func`, `cur_target` — the active call's
//!   arguments / receiver / callee / new-target; none while no call is live.
//! - `exception` — the in-flight thrown value; none outside a `throw`/catch
//!   window, all of which close before a crank returns.
//! - `locals`, `frame_slots`, `id_map` — the executing frame's local slots,
//!   saved-frame region, and name→local index map; all belong to a live
//!   activation and are re-established by the next crank's `BEGIN_*` prologue.
//! - `resume_status` — the generator/async resume signal, meaningful only
//!   mid-`resume`; a *suspended* generator's state is the `generators` row
//!   (tracked, Pending), not this register.
//! - `callback_return_depth` — the return-depth sentinel while a property
//!   accessor or other callback is executing; no callback spans a crank.
//!
//! **Boot-derived / program-symbol caches — re-derived, never stored.** These
//! are pure functions of the boot procedure and the program's `symbol_names`,
//! so restore reconstructs them rather than carrying an atom:
//! - `intrinsics`, `*_proto` (`object_proto`/`function_proto`/`array_proto`/
//!   `generator_proto`/…), `proto_methods`, `proto_data`, `well_known_symbols`,
//!   `default_keys`, `math_object`, `static_str` — boot artifacts at
//!   *deterministic* slot indices. `restore_snapshot_state` reconstructs the
//!   machine on a fresh [`ironhorse_vm::Interp::new`] whose boot lands them at the
//!   same indices the snapshot arena's boot region uses, so they need no atom.
//! - `symbol_ids` and the name-keyed lookup-id caches
//!   (`length_id`/`name_id`/`value_id`/`done_id`/`size_id`/`byte_length_id`/
//!   `byte_offset_id`/`buffer_id`/`then_id`/`last_index_id`, plus the
//!   `regexp_getter_ids`/`regexp_result_ids` clusters) — **derived from
//!   `symbol_names`**, which *is* serialized. `restore_snapshot_state`
//!   re-derives all of them (`bind_program_symbols`) from the restored names,
//!   identically to boot; this is exactly what makes the `SymbolTables` row
//!   [`Coverage::RebuiltAtRestore`] rather than a silent omission. (The
//!   forward `symbol_names` itself is the ledger row, not a transient; the
//!   top-down `next_symbol_key_id` mint counter is NOT derived — it travels
//!   in the `SYMB` atom with the `SymbolKeyIds` row.)
//!
//! **Satellite brand/edge sets — classified with their primary row.** A few
//! small `HashSet`/`Vec` fields brand or annotate instances whose principal
//! state is another row's; each rides its primary row's coverage rather than
//! earning a variant, and this list is the audit trail (a set that stops
//! riding must graduate to a row):
//! - `detached_buffers`, `shared_buffers` — brands on `array_buffers`
//!   instances (`ArrayBuffers`, Pending).
//! - `deleted_fn_meta` — per-function deleted-`length`/-`name` marks
//!   (`Functions`, Pending).
//! - `from_async` — `Array.fromAsync` accumulation state (`Combinators`,
//!   Pending).
//! - `regexp_last_names` — the last-match named-group scratch (`RegExps`,
//!   Pending).
//! - `arguments_objects` — the arguments-exotic brand set. Its primary row
//!   (`Arrays`) is Serialized but this brand does NOT yet travel, so a
//!   suspended arguments object resumes as a plain array-exotic — an honest
//!   known gap, called out here so the `Arrays` row's `Serialized` is not
//!   read as covering it.

/// Whether a side table is carried by the current snapshot image
/// ([`crate::image`]), and if not, why it is safe to defer.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Coverage {
    /// Fully serialized and restored by the current image.
    Serialized,
    /// Resident in the slot/chunk arenas themselves (the `HEAP`/`BLOC`
    /// atoms), so it round-trips structurally with the arenas — no
    /// separate atom needed.
    InArena,
    /// Deterministically rebuilt at restore by re-running machine boot /
    /// intrinsic linking against the same program symbols, so it need not
    /// be stored (but must be re-derived, hence tracked here).
    BootDerived,
    /// **Structurally resident in the restored arena, but reached through a
    /// side-table index that is not itself arena state, so restore must
    /// re-derive that index.** The table's *data* round-trips (either inside
    /// the slot/chunk arenas or in a serialized companion atom), but a
    /// HashMap/counter the interpreter consults to reach it — a fast index,
    /// an inverse map, a monotonic counter — is not arena state and boot
    /// leaves it empty. [`ironhorse_vm::Interp::restore_snapshot_state`] rebuilds
    /// it by walking the restored arena (or re-deriving from a restored
    /// companion). Distinct from [`Coverage::InArena`] (no rebuild step) and
    /// [`Coverage::BootDerived`] (re-derived from *boot*, not from the
    /// snapshot's own restored state). A reader may trust the row **only
    /// because** that rebuild step exists and is exercised by a cross-crank
    /// regression test — the claim is false without it.
    RebuiltAtRestore,
    /// **Not yet carried.** The image must grow an atom (or extend an
    /// existing one) before a machine spanning this table can round-trip.
    /// This is the remaining-work ledger the completeness note demands.
    Pending,
}

/// One side table of the machine's reachable state. Enumerated from the
/// live `ironhorse_vm::interp::Interp` fields (verified against the struct,
/// not this list — see the module docs).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum SideTable {
    /// `functions` — user/native function metadata, **including
    /// `closures`** (the captured frame-cell owner). The headline case:
    /// closure capture is invisible in the slot arena's shape alone.
    Functions,
    /// `bound_functions` — `Function.prototype.bind` target/`this`/args.
    BoundFunctions,
    /// `proxies` (+ `proxy_revokers`) — each `Proxy` exotic's
    /// `[[ProxyTarget]]`/`[[ProxyHandler]]` internal slots and the revoke-fn →
    /// proxy back-links. Runtime-minted per `new Proxy`/`Proxy.revocable`, not
    /// arena-recoverable and not boot-derived, so honestly `Pending` (like
    /// `BoundFunctions`) until an atom carries it — a machine suspended holding
    /// a live proxy cannot yet round-trip.
    Proxies,
    /// `call_stack` — the suspended `CallerState` activations (scope,
    /// args, result) of the active call chain.
    CallStack,
    /// `jumps` — the `CatchJump` chain (`the->firstJump`): each entry
    /// snapshots the value stack, scope, and call frames to restore on a
    /// throw. A caught-and-pending exception lives here + `exception`.
    Jumps,
    /// `global_props` — the global object's materialized own-property
    /// slot index by id.
    GlobalProps,
    /// `error_data` — per-instance Error name/message.
    ErrorData,
    /// `accessors` — per-instance getter/setter function slots.
    Accessors,
    /// `wrapper_data` — per-instance primitive-wrapper boxed value.
    WrapperData,
    /// `arrays` — exotic array length + item chunk.
    Arrays,
    /// `collections` — Map/Set/WeakMap/WeakSet internal slots.
    Collections,
    /// `array_buffers` — ArrayBuffer backing store.
    ArrayBuffers,
    /// `typed_arrays` — TypedArray view state + buffer reference.
    TypedArrays,
    /// `data_views` — DataView view state + buffer reference.
    DataViews,
    /// `iterators` — built-in iterator state (target, index/byte-offset,
    /// kind, reused result object): array, string, for-in enumerator, and
    /// Map/Set collection cursors, which additionally carry the owning
    /// collection's clear-generation. Pending — and note the live
    /// machine's collection cursors index tombstoned entry positions, so
    /// when this row lands its encoding must compose with the snapshot
    /// writer's COLL compaction (which renumbers entries by dropping
    /// tombstones) or a resumed cursor drifts.
    Iterators,
    /// `promises` — per-instance settlement STATUS/RESULT/THENS.
    Promises,
    /// `promise_functions` — a resolve/reject function's bound home data.
    PromiseFunctions,
    /// `promise_guards` — the per-pair `[[AlreadyResolved]]` flags.
    PromiseGuards,
    /// `promise_jobs` — the pending microtask (reaction-job) queue.
    PromiseJobs,
    /// `combinators` — the shared `Promise.all`/`allSettled`/`race`/`any`
    /// element-accumulation state a `ReactionKind::Combine` reaction indexes.
    Combinators,
    /// `generators` — per-instance suspended activation + lifecycle state.
    Generators,
    /// `gen_run_stack` — generators currently mid-`resume_generator`
    /// dispatch (the `YIELD` snapshot target stack).
    GenRunStack,
    /// `async_instances` — per-instance async activation + result promise.
    AsyncInstances,
    /// `async_run_stack` — async instances mid-`step_async` dispatch (the
    /// `AWAIT` snapshot target stack).
    AsyncRunStack,
    /// `regexps` — compiled RegExp program + source/flags (note:
    /// `lastIndex` is an ordinary own property, in the arena).
    RegExps,
    /// `temporal_instants` / `temporal_durations` / `temporal_plains` /
    /// `temporal_zoneds` — immutable Temporal internal-slot records keyed
    /// by their branded instance slots (the plain/zoned tables arrived
    /// with the language-completion sweep, 2026-08-26).
    TemporalRecords,
    /// `async_generators` + `async_gen_run_stack` — per-instance async
    /// generator state (suspended frame, request queue, lifecycle) and the
    /// mid-`step_async_generator` dispatch stack. The language-completion
    /// sweep's async-generator machinery; per-instance runtime state like
    /// `Generators`/`AsyncInstances`, so honestly `Pending` with them.
    AsyncGenerators,
    /// `private_values` + `private_accessors` — class private
    /// fields/methods and private accessors keyed by (instance, brand).
    /// Reachable only through these maps (no arena property slot), so a
    /// suspended instance's private state does not yet travel.
    PrivateElements,
    /// `disposable_stacks` — `DisposableStack`/`AsyncDisposableStack`
    /// recorded resources and dispose callbacks. Per-instance runtime
    /// state; a suspended stack's pending disposals do not yet travel.
    DisposableStacks,
    /// The Intl per-instance record tables (`locales`, `collators`,
    /// `list_formats`, `plural_rules`, `number_formats`, `segmenters`,
    /// `segments`, `segment_iterators`, `date_time_formats`) plus the
    /// bound-function link tables (`collator_compare_functions`,
    /// `number_format_bound_functions`). Internal-slot records keyed by
    /// branded instance slots, none arena-recoverable.
    IntlRecords,
    /// `code_segments` + `func_segments` — the dynamic-code segment buffer
    /// (the `eval`/dynamic-`Function` source bridge) and the function→
    /// segment index. No atom carries crank or segment bytecode, so a heap
    /// holding a live segment-backed function cannot round-trip; the store
    /// gates refuse it by name (`StoreError::DynamicSegmentsUnsupported`
    /// at `begin_store_session` and `checkpoint_to_store` — see
    /// `tests/dynamic_segments.rs`). The row is the ledger's name for that
    /// refusal: flipping it to a coverage means building crank-code
    /// retention, which also unlocks the cross-crank-function half of
    /// `Functions`.
    Segments,
    /// `ctor_prototype` — each constructor instance's `.prototype` object.
    /// The `.prototype` *object* is an arena slot, but the constructor→proto
    /// link is HashMap-only (never an own-property slot), so it is not
    /// arena-recoverable and stays `Pending` (with `functions`).
    CtorPrototype,
    /// `symbol_registry` (+ `symbol_registry_keys`) — the global
    /// `Symbol.for`/`keyFor` registry.
    SymbolRegistry,
    /// `symbol_names` / `symbol_ids` — the program symbol name↔id tables.
    /// Since the id-space unification (2026-08-26) a runtime-interned
    /// string key APPENDS to `symbol_names` (its id is its position), so
    /// the one table covers program and runtime names alike. Only the
    /// forward `symbol_names` is serialized (the `NAME` atom); the inverse
    /// `symbol_ids` map and the lookup-id caches are re-derived from it at
    /// restore.
    SymbolTables,
    /// `symbol_key_ids` + `next_symbol_key_id` — the symbol-value
    /// descriptor slot → property id map minted when a symbol is used as a
    /// property key (`o[sym]` / `Object.defineProperty(o, sym, …)`), and
    /// its top-down mint counter (ids descend from `u16::MAX`, so they
    /// never collide with the growing name table). Both travel in the
    /// `SYMB` atom (2026-08-26; formerly the honest-`Pending` intern gap
    /// that made intern-holding machines refuse to persist).
    SymbolKeyIds,
    /// The module records/maps (`ironhorse_vm::module::ModuleGraph`): a
    /// worker that has imported modules carries linked module records and
    /// namespace objects.
    Modules,
    /// The harden worklist / frozen-intrinsics tables (SES `lockdown`/
    /// `harden`/`petrify`, requirement 5): which intrinsics and object
    /// graphs are frozen. A resumed hardened graph must stay hardened.
    HardenState,
    /// `meter` — the machine's metering state (design row 6): accumulated
    /// computrons, the check interval/threshold, and the frozen cost-table
    /// version. **Carried by the `METR` atom** (stage-6 child 3), so a
    /// resumed machine continues its meter exactly.
    Meter,
}

impl SideTable {
    /// Every side table. **Adding a `SideTable` variant without adding it
    /// here fails [`tests::all_is_exhaustive`]**; every entry's coverage
    /// is asserted, so a new table cannot slip in as a silent snapshot
    /// gap.
    pub const ALL: &'static [SideTable] = &[
        SideTable::Functions,
        SideTable::BoundFunctions,
        SideTable::Proxies,
        SideTable::CallStack,
        SideTable::Jumps,
        SideTable::GlobalProps,
        SideTable::ErrorData,
        SideTable::Accessors,
        SideTable::WrapperData,
        SideTable::Arrays,
        SideTable::Collections,
        SideTable::ArrayBuffers,
        SideTable::TypedArrays,
        SideTable::DataViews,
        SideTable::Iterators,
        SideTable::Promises,
        SideTable::PromiseFunctions,
        SideTable::PromiseGuards,
        SideTable::PromiseJobs,
        SideTable::Combinators,
        SideTable::Generators,
        SideTable::GenRunStack,
        SideTable::AsyncInstances,
        SideTable::AsyncRunStack,
        SideTable::RegExps,
        SideTable::TemporalRecords,
        SideTable::AsyncGenerators,
        SideTable::PrivateElements,
        SideTable::DisposableStacks,
        SideTable::IntlRecords,
        SideTable::Segments,
        SideTable::CtorPrototype,
        SideTable::SymbolRegistry,
        SideTable::SymbolTables,
        SideTable::SymbolKeyIds,
        SideTable::Modules,
        SideTable::HardenState,
        SideTable::Meter,
    ];

    /// The table's `Interp` field name and its current snapshot coverage.
    /// An **exhaustive** match: the compiler forces every new variant to
    /// declare a descriptor, which is what makes this a completeness
    /// ledger rather than a stale comment.
    pub fn descriptor(self) -> Descriptor {
        use Coverage::*;
        let (field, coverage): (&'static str, Coverage) = match self {
            // The global object's own-property *slots* round-trip inside the
            // slot arena (linked into `global_obj`'s property chain by
            // `create_global_property`), but the `global_props` id→slot fast
            // index that `resolve_get`/`resolve_set` consult is a HashMap, not
            // arena state, and boot leaves it empty. `restore_snapshot_state`
            // rebuilds it by walking the restored chain (`rebuild_global_props`),
            // so a runtime-materialized global (`var x = 5`, or a
            // `globalThis.x = 1` create, in an earlier crank) resolves after
            // resume. Regression: `restore_side_tables.rs`
            // (`runtime_global_survives_suspend_resume`).
            SideTable::GlobalProps => ("global_props", RebuiltAtRestore),
            // `ctor_prototype` is a HashMap-only link (a constructor's default
            // `.prototype` is NOT installed as an arena property slot — see
            // `new_function`), and reaching it *also* needs the `functions`
            // table (below, Pending) to know a slot is a constructor at all.
            // Neither is arena-recoverable, so this stays honestly Pending
            // until an atom carries it. A truthful cross-crank `new f()` test
            // is unreachable today regardless of restore (the uninterrupted
            // machine already aborts cross-crank construction), which is the
            // deciding evidence the row cannot be claimed covered.
            SideTable::CtorPrototype => ("ctor_prototype", Pending),
            // Only the forward `symbol_names` is serialized (the `NAME`
            // atom); the inverse `symbol_ids` map is *derived* from it and
            // never persisted (`link_intrinsics` computes it at boot).
            // `restore_snapshot_state` re-derives it via
            // `bind_program_symbols` from the restored names, so an
            // earlier-crank global reads back by name — and because a
            // runtime-interned string key IS a `symbol_names` append, the
            // same restore covers it. Regression: `restore_side_tables.rs`
            // (`symbol_tables_rebuilt_at_restore`).
            SideTable::SymbolTables => {
                ("symbol_names(NAME-serialized)+symbol_ids(derived)", RebuiltAtRestore)
            }
            // Ledger G1 (2026-08-24): the `Symbol.for` registry travels in
            // the `REGY` atom / small-state registry section (key bytes →
            // descriptor slot, key-ascending), and restore repopulates the
            // forward and reverse maps pairwise — `Symbol.for('k')` minted
            // before a suspend IS the same symbol after a resume
            // (`resumed_symbol_registry_keeps_symbol_for_identity`).
            SideTable::SymbolRegistry => ("symbol_registry/symbol_registry_keys", Serialized),
            // The symbol-key desc→id map (ledger SYMB, 2026-08-26): the
            // wave-4 P1 id-space hazard, lifted in two halves. String keys
            // no longer occupy a runtime range at all — a runtime-interned
            // NAME appends to `symbol_names` and travels with the NAME
            // row. Symbol keys mint DOWNWARD from `u16::MAX` (no collision
            // with the growing table) and travel in the SYMB atom /
            // small-state symbols section: the top-down counter plus every
            // (id, descriptor slot) pair, id-ascending, restored via
            // `Interp::restore_symbol_key_table` — so a symbol-keyed
            // property reads back under the same id after a resume
            // (`interned_property_keys_round_trip_through_the_store`).
            // What the persist/adopt paths still refuse — as Corrupt, via
            // `MachineImage::stored_unregistered_key_id` — is a stored id
            // outside BOTH tables, which maps to nothing and can only be
            // crafted or torn bytes.
            SideTable::SymbolKeyIds => ("symbol_key_ids/next_symbol_key_id", Serialized),
            // The rich per-instance/per-activation tables still to be wired
            // into dedicated atoms (child-3-adjacent; the honest remainder).
            SideTable::Functions => ("functions", Pending),
            SideTable::BoundFunctions => ("bound_functions", Pending),
            SideTable::Proxies => ("proxies/proxy_revokers", Pending),
            SideTable::CallStack => ("call_stack", Pending),
            SideTable::Jumps => ("jumps", Pending),
            SideTable::ErrorData => ("error_data", Pending),
            SideTable::Accessors => ("accessors", Pending),
            SideTable::WrapperData => ("wrapper_data", Pending),
            // Ledger G1 (2026-08-24): the two BULK tables travel in the
            // `ARRY`/`COLL` atoms and the schema-7 small-state sections
            // (owner-ascending, items/entries in table order; values are
            // ordinary slot records, chunk-remapped with the live table).
            // Restore routes every insert through the counted accessors,
            // so the side-ref page counts rebuild in lockstep — the
            // uninterrupted-vs-resumed twins in
            // `tests/side_table_ledger.rs` (incl. lazy resume + full
            // collect under the debug parity net) are the locks.
            SideTable::Arrays => ("arrays", Serialized),
            SideTable::Collections => ("collections", Serialized),
            SideTable::ArrayBuffers => ("array_buffers", Pending),
            SideTable::TypedArrays => ("typed_arrays", Pending),
            SideTable::DataViews => ("data_views", Pending),
            SideTable::Iterators => ("iterators", Pending),
            SideTable::Promises => ("promises", Pending),
            SideTable::PromiseFunctions => ("promise_functions", Pending),
            SideTable::PromiseGuards => ("promise_guards", Pending),
            SideTable::PromiseJobs => ("promise_jobs", Pending),
            SideTable::Combinators => ("combinators", Pending),
            SideTable::Generators => ("generators", Pending),
            SideTable::GenRunStack => ("gen_run_stack", Pending),
            SideTable::AsyncInstances => ("async_instances", Pending),
            SideTable::AsyncRunStack => ("async_run_stack", Pending),
            SideTable::RegExps => ("regexps", Pending),
            SideTable::TemporalRecords => {
                ("temporal_instants/temporal_durations/temporal_plains/temporal_zoneds", Pending)
            }
            SideTable::AsyncGenerators => ("async_generators/async_gen_run_stack", Pending),
            SideTable::PrivateElements => ("private_values/private_accessors", Pending),
            SideTable::DisposableStacks => ("disposable_stacks", Pending),
            SideTable::IntlRecords => ("locales/collators/…/date_time_formats + bound-fn links", Pending),
            // Pending here is load-bearing beyond the missing atom: the
            // store gates REFUSE a heap holding a live segment-backed
            // function (`DynamicSegmentsUnsupported`), fail-closed instead
            // of resuming a callable whose body is gone.
            SideTable::Segments => ("code_segments/func_segments", Pending),
            SideTable::Modules => ("module::ModuleGraph", Pending),
            SideTable::HardenState => ("lockdown/harden state", Pending),
            // The metering state — carried by the METR atom (child 3).
            SideTable::Meter => ("meter", Serialized),
        };
        Descriptor {
            table: self,
            field,
            coverage,
        }
    }

    /// The tables not yet carried by the snapshot image — the remaining
    /// work, computed from the ledger so it can never drift from the code.
    pub fn pending() -> Vec<SideTable> {
        Self::ALL
            .iter()
            .copied()
            .filter(|t| t.descriptor().coverage == Coverage::Pending)
            .collect()
    }
}

/// A side table's completeness descriptor.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub struct Descriptor {
    pub table: SideTable,
    /// The `Interp` field(s) backing this table.
    pub field: &'static str,
    pub coverage: Coverage,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ALL` must list every variant exactly once. This is the guard that
    /// turns "add a field to `Interp`" into "add it to the snapshot
    /// ledger": a new `SideTable` variant that is not in `ALL` (or is
    /// duplicated) fails here, and one with no `descriptor` arm fails to
    /// compile.
    #[test]
    fn all_is_exhaustive() {
        // Count of variants, kept beside the enum. Bump when a variant is
        // added — the assertion below then forces the ALL entry too.
        const VARIANT_COUNT: usize = 38;
        assert_eq!(SideTable::ALL.len(), VARIANT_COUNT);

        // No duplicates: each field name appears once.
        let mut fields: Vec<&str> = SideTable::ALL.iter().map(|t| t.descriptor().field).collect();
        fields.sort_unstable();
        let before = fields.len();
        fields.dedup();
        assert_eq!(before, fields.len(), "duplicate side table in ALL");
    }

    #[test]
    fn pending_is_derived_from_ledger() {
        let pending = SideTable::pending();
        // The rich per-instance tables are still pending.
        assert!(pending.contains(&SideTable::Functions));
        assert!(pending.contains(&SideTable::Generators));
        // `ctor_prototype` is a HashMap-only constructor→prototype link (no
        // arena property slot) and needs the `functions` table to interpret,
        // so it is honestly Pending — not the false `InArena` it once claimed.
        assert!(pending.contains(&SideTable::CtorPrototype));
        // The language-completion sweep's tables joined the ledger Pending,
        // and the segments row names the store gates' standing refusal.
        assert!(pending.contains(&SideTable::AsyncGenerators));
        assert!(pending.contains(&SideTable::Segments));
        // The restore-time-rebuilt rows are not pending: their data round-trips
        // and restore re-derives the consulting index/counter.
        assert!(!pending.contains(&SideTable::GlobalProps));
        assert!(!pending.contains(&SideTable::SymbolTables));
        // The 2026-08-26 id-space unification landed the symbol-key table
        // in the SYMB atom; the old intern gap is closed, not pending.
        assert!(!pending.contains(&SideTable::SymbolKeyIds));
    }

    /// The restore-time rebuild rows are classified [`Coverage::RebuiltAtRestore`],
    /// not the `InArena`/`Serialized` overstatement the supervisor review
    /// flagged: each round-trips its data but reaches it through a side index
    /// (`global_props` map / `symbol_ids` inverse map) that
    /// `ironhorse_vm::Interp::restore_snapshot_state` re-derives. The cross-crank
    /// regression that the rebuild actually runs lives in
    /// `tests/restore_side_tables.rs`.
    #[test]
    fn rebuilt_at_restore_rows_are_classified_honestly() {
        for t in [SideTable::GlobalProps, SideTable::SymbolTables] {
            assert_eq!(
                t.descriptor().coverage,
                Coverage::RebuiltAtRestore,
                "{t:?} must declare its restore-time rebuild, not overstate coverage",
            );
        }
        // And the overstatement is gone: no row still claims a bare `InArena`
        // for state that a HashMap index (not the arena) actually gates.
        assert_ne!(SideTable::GlobalProps.descriptor().coverage, Coverage::InArena);
        assert_ne!(SideTable::CtorPrototype.descriptor().coverage, Coverage::InArena);
    }
}
