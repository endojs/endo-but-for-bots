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
//! - `env` — the active `with`/eval environment head; live only inside a
//!   `with` body or eval frame, all of which close before a crank returns
//!   (SUSPENDED environments live in `SavedFrame.env`, inside their row).
//! - `result`, `strict` — the completion register and top-level strictness;
//!   both cleared/reset at the crank boundary (wave-6 W6-11/W6-6), so a
//!   resumed twin's fresh defaults match.
//! - `pending_new_target` — armed by `SUPER` for the construct about to
//!   happen; consumed by the construct frame and disarmed on unwind
//!   (wave-6 W6-15).
//! - `direct_eval_hoist`, `eval_direct`, `active_segment`,
//!   `top_level_code` — the eval bridge's per-crank registers,
//!   re-established at every run entry and save/restored around units.
//! - `id_space_exhausted` — the property-key id-space poison latch; the
//!   dispatch loop halts on it before the next instruction and
//!   `is_quiescent` refuses a poisoned machine, so it is provably false
//!   at every boundary a snapshot can be taken from.
//!
//! The registry of ALL these classifications is now MECHANICAL:
//! [`tests::ledger_classification_reconciles_with_the_interp_struct`]
//! parses `Interp`'s field list from source and reconciles it two-way
//! against the classified groups, so a new field cannot land
//! unclassified and a stale entry cannot linger.
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
//!   instances (`ArrayBuffers`, Serialized): each rides its buffer's
//!   `ABUF` row as a flag bit and restores into the satellite set.
//! - `deleted_fn_meta` — per-function deleted-`length`/-`name` marks
//!   (`Functions`, Serialized in `FUNC`).
//! - `from_async` — `Array.fromAsync` accumulation state (`Combinators`,
//!   Pending).
//! - `regexp_last_names` — the last-match named-group scratch (a global
//!   `Vec<i32>`, not slot-keyed): per-crank match state consumed by the
//!   legacy result accessors within the crank; its primary row
//!   (`RegExps`) is Serialized since schema 11 (source/flags/lastIndex
//!   travel; the program recompiles), while this scratch stays honest
//!   per-crank state.
//! - `arguments_objects` — the arguments-exotic brand set, riding its
//!   primary row (`Arrays`, Serialized). Since store schema 11 the brand
//!   itself TRAVELS (the `ARGB` atom / small-state arguments section), so
//!   a suspended arguments object resumes branded — its completion-value
//!   render answers `[object Arguments]`, not the array join
//!   (`language_rows_carry.rs`).
//! - `side_refs` — the counted-accessor page projection over the two bulk
//!   rows (`Arrays`/`Collections`); a derived cache the restore path
//!   rebuilds in lockstep by routing every insert through the counted
//!   accessors.

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
    /// **Provably empty at every persistable boundary**, so no atom is
    /// ever needed: `Interp::is_quiescent` requires the table empty and
    /// EVERY persist verb — store and blob alike — gates on quiescence
    /// (wave-6 W6-10; the contract-violation locks in
    /// `persist_gates.rs` enforce the gates behaviorally, and
    /// [`tests::empty_at_boundary_rows_match_the_quiescence_predicate`]
    /// ties this classification to the predicate's actual field list
    /// mechanically). Distinct from an excluded transient: these ARE
    /// reachable machine state mid-crank — a halted crank holds them —
    /// but a halted machine cannot pass the gates, and the managed
    /// lifecycle rewinds it whole.
    EmptyAtBoundary,
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
    /// a live proxy cannot yet round-trip. Its honest carry is
    /// dependency-gated on the `functions` row: traps are guest
    /// functions, and a resumed guest function is uncallable today, so
    /// carrying the row alone would trade silent-wrong for
    /// visible-broken, not for correct.
    Proxies,
    /// `call_stack` — the suspended `CallerState` activations (scope,
    /// args, result) of the active call chain. Empty at every
    /// persistable boundary (`is_quiescent` requires it; the persist
    /// gates enforce it), so no atom is needed.
    CallStack,
    /// `jumps` — the `CatchJump` chain (`the->firstJump`): each entry
    /// snapshots the value stack, scope, and call frames to restore on a
    /// throw. A caught-and-pending exception lives here + `exception`.
    /// Empty at every persistable boundary (quiescence-gated).
    Jumps,
    /// `global_props` — the global object's materialized own-property
    /// slot index by id.
    GlobalProps,
    /// `error_data` — per-instance Error name/message, the metadata the
    /// abort-value render consults. Serialized in the `ERRD` atom /
    /// small-state errors section (store schema 9), owner-ascending,
    /// name drawn from the engine's closed error-constructor set.
    ErrorData,
    /// `accessors` — per-instance getter/setter function slots.
    /// Pending, dependency-gated on the `functions` row exactly as
    /// `Proxies` is (getters/setters are guest functions). The one
    /// boot-derived entry — the seeded `Intl.NumberFormat` `format`
    /// getter — is exempt from the persist gate and re-derived at
    /// restore from boot structure (`rebuild_boot_accessors`).
    Accessors,
    /// `wrapper_data` — per-instance primitive-wrapper boxed value.
    WrapperData,
    /// `arrays` — exotic array length + item chunk.
    Arrays,
    /// `collections` — Map/Set/WeakMap/WeakSet internal slots.
    Collections,
    /// `array_buffers` — ArrayBuffer backing-store geometry (the bytes
    /// live in the chunk arena and travel with `BLOC`). Serialized in
    /// the `ABUF` atom / small-state buffers section (store schema
    /// 10), with the `detached_buffers`/`shared_buffers` brand
    /// satellites folded into per-row flags.
    ArrayBuffers,
    /// `typed_arrays` — TypedArray view state + buffer reference.
    /// Serialized in the `TARR` atom (schema 10); element kind refused
    /// at decode past the dispatch table, view geometry refused past
    /// its buffer's length.
    TypedArrays,
    /// `data_views` — DataView view state + buffer reference.
    /// Serialized in the `DVIW` atom (schema 10), same geometry
    /// discipline as `TypedArrays`.
    DataViews,
    /// `iterators` — the built-in iterator cursors (array
    /// values/keys/entries, for-in enumerators, string iterators,
    /// Map/Set cursors). Serialized in the `ITER` atom / small-state
    /// iterators section (store schema 13), owner-ascending, with two
    /// boundary normalizations that make the row pure data: a
    /// collection cursor travels as its LIVE-ENTRY ordinal (the `COLL`
    /// row compacts tombstones, so the ordinal IS the physical index
    /// in the restored dense table) and `clear()`-staleness folds into
    /// `done` (restored collections rebuild at generation zero; only
    /// "retired" is observable). Locks: the `iterator_carry.rs` twins
    /// — a resumed cursor CONTINUES its walk, straddling a tombstone
    /// compaction and staying retired across a clear.
    Iterators,

    /// `promises` — per-instance settlement STATUS/RESULT/THENS.
    Promises,
    /// `promise_functions` — a resolve/reject function's bound home data.
    PromiseFunctions,
    /// `promise_guards` — the per-pair `[[AlreadyResolved]]` flags.
    PromiseGuards,
    /// `promise_jobs` — the queued microtasks. Empty at every
    /// persistable boundary: the crank model drains the queue before
    /// completion, `is_quiescent` requires it empty (a HALTED crank
    /// leaves jobs queued, and the gates refuse exactly that machine),
    /// so no atom is needed.
    PromiseJobs,
    /// `combinators` — the shared `Promise.all`/`allSettled`/`race`/`any`
    /// element-accumulation state a `ReactionKind::Combine` reaction indexes.
    Combinators,
    /// `generators` — per-instance suspended activation + lifecycle state.
    Generators,
    /// `gen_run_stack` — generators currently mid-`resume_generator`
    /// dispatch (the `YIELD` snapshot target stack). Empty at every
    /// persistable boundary (quiescence-gated) — a SUSPENDED
    /// generator's state is the `generators` row, not this stack.
    GenRunStack,
    /// `async_instances` — per-instance async activation + result promise.
    AsyncInstances,
    /// `async_run_stack` — async instances mid-`step_async` dispatch (the
    /// `AWAIT` snapshot target stack). Empty at every persistable
    /// boundary (quiescence-gated) — a suspended instance's state is
    /// the `async_instances` row, not this stack.
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
    /// (The `async_gen_run_stack` HALF is quiescence-empty like the
    /// other run stacks; the variant stays `Pending` for the instance
    /// table it also names.)
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
    /// The nine Intl per-instance record tables (`locales`,
    /// `collators`, `list_formats`, `plural_rules`, `number_formats`,
    /// `segmenters`, `segments`, `segment_iterators`,
    /// `date_time_formats`): resolved-options records keyed by branded
    /// instance slots — pure numeric/string data. Serialized in the
    /// `INTL` atom / small-state intl section (store schema 12),
    /// owner-ascending; a segment iterator's cross-reference must name
    /// a covering segments row, and its consuming natives are natives
    /// on rooted boot structure, so a resumed instance WORKS
    /// (`intl_carry.rs`). The bound-function LINKS split into
    /// [`SideTable::IntlBoundFunctions`] below.
    IntlRecords,
    /// `dates` — per-instance `Date` internal slots (the epoch
    /// milliseconds, one `f64` keyed by the branded instance slot;
    /// the llm mainline's Date-core landing, 2026-08-28 rebase).
    /// Pure data — the same class as the Temporal records — so its
    /// carry is a recorded follow-up, not a design blocker.
    Dates,
    /// The Intl bound-function link tables
    /// (`collator_compare_functions`, `number_format_bound_functions`)
    /// and the `NumberFormatData::bound_format` cache they mirror. A
    /// minted bound compare/format function IS a `functions`
    /// (`FuncInfo`) row — `alloc_method` creates one per mint — so the
    /// links are dependency-gated on the `functions` carry exactly as
    /// `Proxies`/`Accessors` are. Deliberately DROPPED at the
    /// boundary, not refused: both getters re-mint on a cache miss, so
    /// an instance-held collator/format answers identically after
    /// resume (first-access behavior); only a guest that held the
    /// bound function ITSELF degrades, exactly as every held guest
    /// function does today.
    IntlBoundFunctions,
    /// `code_segments` + `func_segments` — retained defining-crank and
    /// eval/dynamic-Function bytecode plus each guest function's segment
    /// index. Carried atomically with function metadata in `FUNC`.
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
    /// `installed_names_len` — the installed-names floor (wave-6
    /// W6-7): partial install passes re-consider only ids ABOVE it, so
    /// names interned DURING an install pass (Intl member keys, the
    /// `format` accessor key) stay lazily installable by a later
    /// growing relink. Real dynamic state: serialized in the `NFLR`
    /// atom / small-state name-floor section (store schema 12; emitted
    /// only when it differs from the table length, the conservative
    /// default a floor-less restore assumes). Without it a resumed
    /// machine floored at the full table and could never install such
    /// a name — the `ListFormat.prototype.format` divergence
    /// (`intl_carry.rs`).
    NameFloor,
    /// The module records/maps (`ironhorse_vm::module::ModuleGraph`): a
    /// worker that has imported modules carries linked module records and
    /// namespace objects.
    Modules,
    /// Hardened-ness (SES `lockdown`/`harden`/`petrify`, requirement
    /// 5): which intrinsics and object graphs are frozen. Kept as slot
    /// FLAGS on the objects themselves — no side table exists — so it
    /// rides the HEAP atom and a resumed hardened graph stays hardened.
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
        SideTable::Dates,
        SideTable::AsyncGenerators,
        SideTable::PrivateElements,
        SideTable::DisposableStacks,
        SideTable::IntlRecords,
        SideTable::IntlBoundFunctions,
        SideTable::Segments,
        SideTable::CtorPrototype,
        SideTable::SymbolRegistry,
        SideTable::SymbolTables,
        SideTable::SymbolKeyIds,
        SideTable::NameFloor,
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
            // Guest constructor→prototype links travel atomically with
            // retained function metadata in `FUNC`.
            SideTable::CtorPrototype => ("ctor_prototype", Serialized),
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
            // Guest and bound function metadata travel atomically with
            // retained defining-crank bytecode in `FUNC`.
            SideTable::Functions => ("functions", Serialized),
            SideTable::BoundFunctions => ("bound_functions", Serialized),
            SideTable::Proxies => ("proxies/proxy_revokers", Serialized),
            SideTable::CallStack => ("call_stack", EmptyAtBoundary),
            SideTable::Jumps => ("jumps", EmptyAtBoundary),
            SideTable::ErrorData => ("error_data", Serialized),
            // One entry class is EXEMPT from the refuse-on-hold gate and
            // re-derived at restore: an entry that IS a boot
            // `proto_accessors` seed (the `Intl.NumberFormat` `format`
            // getter) — its getter is a boot-minted native, so
            // `Interp::rebuild_boot_accessors` reinstates the pair from
            // boot structure (the `RebuiltAtRestore` pattern inside a
            // serialized row). Guest accessors and redefinitions travel
            // in `ACCS`; the exact boot seed stays omitted. An accessor
            // referencing a runtime native function from a still-Pending
            // owner row remains dependency-gated.
            SideTable::Accessors => ("accessors", Serialized),
            SideTable::WrapperData => ("wrapper_data", Serialized),
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
            SideTable::ArrayBuffers => ("array_buffers", Serialized),
            SideTable::TypedArrays => ("typed_arrays", Serialized),
            SideTable::DataViews => ("data_views", Serialized),
            SideTable::Iterators => ("iterators", Serialized),
            SideTable::Promises => ("promises", Pending),
            SideTable::PromiseFunctions => ("promise_functions", Pending),
            SideTable::PromiseGuards => ("promise_guards", Pending),
            SideTable::PromiseJobs => ("promise_jobs", EmptyAtBoundary),
            SideTable::Combinators => ("combinators", Pending),
            SideTable::Generators => ("generators", Serialized),
            SideTable::GenRunStack => ("gen_run_stack", EmptyAtBoundary),
            SideTable::AsyncInstances => ("async_instances", Pending),
            SideTable::AsyncRunStack => ("async_run_stack", EmptyAtBoundary),
            SideTable::RegExps => ("regexps", Serialized),
            SideTable::TemporalRecords => {
                ("temporal_instants/temporal_durations/temporal_plains/temporal_zoneds", Serialized)
            }
            // Date `[[DateValue]]` records travel as raw IEEE-754 bits
            // in `DATE` (schema 14). The untouched Date.prototype seed
            // is re-derived by boot; a guest-mutated seed is emitted.
            SideTable::Dates => ("dates", Serialized),
            SideTable::AsyncGenerators => ("async_generators/async_gen_run_stack", Pending),
            SideTable::PrivateElements => ("private_values/private_accessors", Serialized),
            SideTable::DisposableStacks => ("disposable_stacks", Serialized),
            // The Intl DATA record tables (`INTL`, store schema 12): nine
            // resolved-options tables, owner-ascending, restored via
            // `Interp::restore_intl` with segment geometry and the
            // iterator cross-reference validated at decode, bounds, and
            // restore. Locks: the `intl_carry.rs` twins (memory, file,
            // lazy, blob — a resumed segment iterator CONTINUES its walk).
            SideTable::IntlRecords => ("locales/collators/…/date_time_formats", Serialized),
            // Runtime compare/format functions and their owner links
            // travel in `IBFN`; restore rebuilds their native FuncInfo.
            SideTable::IntlBoundFunctions => {
                ("collator_compare_functions/number_format_bound_functions", Serialized)
            }
            // Defining-crank and eval segments travel in the same atomic
            // cluster as their function metadata.
            SideTable::Segments => ("code_segments/func_segments", Serialized),
            SideTable::Modules => ("module::ModuleGraph", Pending),
            // Wave-6 W6-25: the ledger UNDERSTATED this coverage — the
            // engine keeps hardened-ness purely as slot FLAGS
            // (`XS_DONT_MARSHALL`/`PATCH`/`DELETE`/`SET` on the slots
            // themselves, `harden_freeze_and_traverse`); there is no
            // side-table field at all, so the state rides the HEAP atom
            // structurally and a resumed hardened graph stays hardened.
            SideTable::HardenState => ("harden slot flags (no side table)", InArena),
            // The installed-names floor (`NFLR`, store schema 12): the
            // W6-7 register travels so a resumed machine's partial
            // install passes re-consider exactly the ids the live one's
            // would (`intl_carry.rs`, the lazy-install twins).
            SideTable::NameFloor => ("installed_names_len", Serialized),
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
        const VARIANT_COUNT: usize = 41;
        assert_eq!(SideTable::ALL.len(), VARIANT_COUNT);

        // No duplicates: each field name appears once.
        let mut fields: Vec<&str> = SideTable::ALL.iter().map(|t| t.descriptor().field).collect();
        fields.sort_unstable();
        let before = fields.len();
        fields.dedup();
        assert_eq!(before, fields.len(), "duplicate side table in ALL");
    }

    /// Wave-6 pattern-3 antidote: the ledger's exhaustiveness was a
    /// hand convention ("enumerated against `Interp`'s actual fields")
    /// that a thirty-field bulk merge overwhelmed. This test parses the
    /// struct's field list FROM SOURCE and reconciles it, two-way,
    /// against the classification below: a new `Interp` field fails
    /// here until it is classified (a ledger row, a documented
    /// satellite or transient, a boot artifact, host wiring, or an
    /// arena), and a renamed/removed field fails the reverse direction.
    #[test]
    fn ledger_classification_reconciles_with_the_interp_struct() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../ironhorse-vm/src/interp.rs"
        ))
        .expect("read the vm source");
        let start = src.find("pub struct Interp {").expect("struct Interp");
        let body = &src[start..];
        let end = body.find("\n}").expect("struct end");
        let body = &body[..end];
        let mut fields: Vec<&str> = Vec::new();
        for line in body.lines() {
            let l = line.strip_prefix("    ").unwrap_or("");
            let l = l.strip_prefix("pub(crate) ").unwrap_or(l);
            let l = l.strip_prefix("pub ").unwrap_or(l);
            if let Some(colon) = l.find(':') {
                let name = &l[..colon];
                if !name.is_empty()
                    && !name.contains(' ')
                    && name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                {
                    fields.push(name);
                }
            }
        }
        assert!(fields.len() > 100, "parse sanity: found {}", fields.len());

        // The classification. Every entry is accounted for by exactly
        // the mechanism named for its group; moving a field between
        // groups is a deliberate edit here, never drift.
        const LEDGER_ROWS: &[&str] = &[
            "functions", "bound_functions", "proxies", "proxy_revokers", "call_stack",
            "jumps", "global_props", "error_data", "accessors", "wrapper_data", "arrays",
            "collections", "array_buffers", "typed_arrays", "data_views", "iterators",
            "promises", "promise_functions", "promise_guards", "promise_jobs",
            "combinators", "generators", "gen_run_stack", "async_instances",
            "async_run_stack", "async_generators", "async_gen_run_stack",
            "private_values", "private_accessors", "disposable_stacks", "regexps",
            "temporal_instants", "temporal_durations", "temporal_plains",
            "temporal_zoneds", "dates", "locales", "collators", "list_formats", "plural_rules",
            "number_formats", "segmenters", "segments", "segment_iterators",
            "date_time_formats", "collator_compare_functions",
            "number_format_bound_functions", "code_segments", "func_segments",
            "ctor_prototype", "symbol_registry", "symbol_registry_keys",
            "symbol_names", "symbol_ids", "symbol_key_ids", "next_symbol_key_id",
            "installed_names_len", "meter",
        ];
        const ARENAS: &[&str] = &["slots", "chunks", "stack"];
        const SATELLITES: &[&str] = &[
            "detached_buffers", "shared_buffers", "deleted_fn_meta", "from_async",
            "regexp_last_names", "arguments_objects", "side_refs",
        ];
        const TRANSIENTS: &[&str] = &[
            "args", "this_val", "cur_func", "cur_target", "target_func",
            "pending_new_target", "exception", "frame_slots", "locals", "id_map",
            "resume_status", "callback_return_depth", "env", "direct_eval_hoist",
            "eval_direct", "active_segment", "top_level_code", "result", "strict",
            // Native dispatch recursion is bracketed by `dispatch_at`;
            // every return decrements it before control can reach a
            // persistence boundary.
            "dispatch_depth",
            // Poison latch for the property-key id-space meet: provably
            // never set at a persistable boundary — the dispatch loop
            // halts on it before the next instruction and `is_quiescent`
            // reports the poisoned machine non-quiescent, so no snapshot
            // ever needs to carry it.
            "id_space_exhausted",
        ];
        const HOST_WIRING: &[&str] = &[
            "meter_host", "source_compiler", "cost", "step_limit", "n_dispatched",
        ];
        const BOOT_DERIVED: &[&str] = &[
            "intrinsics", "global_obj", "intl_object", "temporal_object",
            "temporal_now_object", "math_object", "static_str", "default_keys",
            "boot_slot_count",
            "well_known_symbols", "proto_methods", "proto_data", "proto_accessors",
            "proto_value_data", "string_iterator_method", "async_iterator_identity",
            // The three `@@iterator` natives that used to be minted
            // during `link_intrinsics` (above `boot_slot_count`, so
            // resume re-derived neither their `FuncInfo` nor their name
            // chunk, and the heap's reference to them read back as a
            // plain object). Minting them at boot beside the two
            // siblings above is what makes them boot-derived, and a
            // fresh boot reproduces them at identical indices.
            "iterator_identity", "segments_iterator_method",
            "segment_iterator_identity",
            // `%Error.prototype%`'s `stack` host accessor pair. Both
            // function slots are minted in `create_intrinsics`, so a
            // fresh boot re-derives them at identical indices; the
            // property install is link-time and its side-table entry
            // rides `ACCS` like any other.
            "error_stack_accessor",
            "object_proto", "function_proto", "array_proto",
            "map_proto", "set_proto", "weakmap_proto", "weakset_proto",
            "arraybuffer_proto", "dataview_proto", "array_iterator_proto",
            "string_proto", "number_proto", "symbol_proto", "promise_proto",
            "generator_proto", "generator_function_proto", "async_function_proto",
            "async_generator_proto", "async_generator_function_proto", "regexp_proto",
            "iterator_proto", "map_iterator_proto", "set_iterator_proto", "date_proto",
            "locale_proto", "collator_proto", "list_format_proto",
            "plural_rules_proto", "segmenter_proto", "segments_proto",
            "segment_iterator_proto", "date_time_format_proto", "number_format_proto",
            "temporal_instant_proto", "temporal_duration_proto",
            "temporal_plain_protos", "temporal_zoned_proto", "byte_length_id",
            "byte_offset_id", "buffer_id", "size_id", "length_id", "name_id",
            "value_id", "done_id", "then_id", "constructor_id", "last_index_id",
            // The same cached-key-id class as its neighbours above:
            // derived from the symbol table at link and re-derived by
            // `bind_program_symbols` on restore.
            "prototype_key_id",
            "regexp_getter_ids", "regexp_result_ids",
        ];

        let mut accounted: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for group in [LEDGER_ROWS, ARENAS, SATELLITES, TRANSIENTS, HOST_WIRING, BOOT_DERIVED] {
            for f in group {
                assert!(accounted.insert(f), "{f} classified twice");
            }
        }
        let struct_set: std::collections::BTreeSet<&str> = fields.iter().copied().collect();
        for f in &struct_set {
            assert!(
                accounted.contains(f),
                "Interp field `{f}` is NOT classified in the snapshot ledger's \
                 reconciliation — add it to a group here (and, if it can hold \
                 cross-crank state, to the ledger itself)"
            );
        }
        for f in &accounted {
            assert!(
                struct_set.contains(f),
                "classified field `{f}` no longer exists on Interp — stale entry"
            );
        }
    }

    #[test]
    fn pending_is_derived_from_ledger() {
        let pending = SideTable::pending();
        assert_eq!(pending.len(), 7, "the design's Remaining ledger count");
        // The rich per-instance tables are still pending.
        assert!(!pending.contains(&SideTable::Functions));
        assert!(!pending.contains(&SideTable::BoundFunctions));
        assert!(!pending.contains(&SideTable::Generators));
        // `ctor_prototype` is a HashMap-only constructor→prototype link (no
        // arena property slot) and needs the `functions` table to interpret,
        // so it is honestly Pending — not the false `InArena` it once claimed.
        assert!(!pending.contains(&SideTable::CtorPrototype));
        // The language-completion sweep's tables joined the ledger Pending,
        // and the segments row names the store gates' standing refusal.
        assert!(pending.contains(&SideTable::AsyncGenerators));
        assert!(!pending.contains(&SideTable::PrivateElements));
        assert!(!pending.contains(&SideTable::DisposableStacks));
        assert!(!pending.contains(&SideTable::Segments));
        // The restore-time-rebuilt rows are not pending: their data round-trips
        // and restore re-derives the consulting index/counter.
        assert!(!pending.contains(&SideTable::GlobalProps));
        assert!(!pending.contains(&SideTable::SymbolTables));
        // The 2026-08-26 id-space unification landed the symbol-key table
        // in the SYMB atom; the old intern gap is closed, not pending.
        assert!(!pending.contains(&SideTable::SymbolKeyIds));
        // The G3 error-data carry (`ERRD`, store schema 9) graduated the
        // first of the four silent-wrong refuse-on-hold rows.
        assert!(!pending.contains(&SideTable::ErrorData));
        // The typed-array family followed (`ABUF`/`TARR`/`DVIW`,
        // schema 10). Proxy state graduates in schema 16 after the
        // function prerequisite; accessors remain the next row.
        assert!(!pending.contains(&SideTable::ArrayBuffers));
        assert!(!pending.contains(&SideTable::TypedArrays));
        assert!(!pending.contains(&SideTable::DataViews));
        assert!(!pending.contains(&SideTable::Proxies));
        assert!(!pending.contains(&SideTable::Accessors));
        // The schema-11 data-only language rows graduated: wrappers,
        // regexps (recompiled from source at restore), and the four
        // Temporal record tables.
        assert!(!pending.contains(&SideTable::WrapperData));
        assert!(!pending.contains(&SideTable::RegExps));
        assert!(!pending.contains(&SideTable::TemporalRecords));
        // The schema-12 Intl carry: the nine DATA record tables and the
        // installed-names floor graduated; the bound-fn links split
        // into their own functions-gated row.
        assert!(!pending.contains(&SideTable::IntlRecords));
        assert!(!pending.contains(&SideTable::NameFloor));
        assert!(!pending.contains(&SideTable::IntlBoundFunctions));
        // The schema-13 iterator-cursor carry: a resumed built-in
        // iterator continues its walk (ordinal-normalized collection
        // cursors included).
        assert!(!pending.contains(&SideTable::Iterators));
        // Schema 14 carries the mainline's pure-data Date table.
        assert!(!pending.contains(&SideTable::Dates));
        // The quiescence-gated run stacks, call chain, catch chain, and
        // microtask queue are EmptyAtBoundary, not pending: no atom is
        // ever needed for state the gates prove empty.
        for t in [
            SideTable::CallStack,
            SideTable::Jumps,
            SideTable::PromiseJobs,
            SideTable::GenRunStack,
            SideTable::AsyncRunStack,
        ] {
            assert!(!pending.contains(&t), "{t:?} is quiescence-gated, not pending");
            assert_eq!(t.descriptor().coverage, Coverage::EmptyAtBoundary);
        }
    }

    /// The `EmptyAtBoundary` classification is honest only while
    /// `Interp::is_quiescent` actually requires each such table empty
    /// (the persist gates all run the predicate; `persist_gates.rs`
    /// enforces THAT behaviorally). Parse the predicate's body from
    /// source and reconcile, both ways: every EmptyAtBoundary field
    /// appears in it, and every `is_empty()`-checked field in it is
    /// accounted for — an EmptyAtBoundary row, the value stack (an
    /// arena, serialized empty via `STAC`), or `async_gen_run_stack`
    /// (quiescence-empty, but riding the still-Pending
    /// `AsyncGenerators` variant for the instance table it names).
    #[test]
    fn empty_at_boundary_rows_match_the_quiescence_predicate() {
        let src = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../ironhorse-vm/src/interp.rs"
        ))
        .expect("read the vm source");
        let start = src.find("pub fn is_quiescent(&self)").expect("the predicate");
        let open = start + src[start..].find('{').expect("body");
        let mut depth = 0usize;
        let mut end = open;
        for (i, b) in src[open..].bytes().enumerate() {
            match b {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        let body = &src[open..=end];

        // Forward: every EmptyAtBoundary field is required empty.
        for t in SideTable::ALL {
            if t.descriptor().coverage != Coverage::EmptyAtBoundary {
                continue;
            }
            for field in t.descriptor().field.split('/') {
                assert!(
                    body.contains(&format!("self.{field}.is_empty()")),
                    "{field} is classified EmptyAtBoundary but is_quiescent does not require it empty"
                );
            }
        }
        // Reverse: every field the predicate requires empty is
        // accounted for by the classification.
        let empty_rows: Vec<&str> = SideTable::ALL
            .iter()
            .filter(|t| t.descriptor().coverage == Coverage::EmptyAtBoundary)
            .flat_map(|t| t.descriptor().field.split('/'))
            .collect();
        for cap in body.split("self.").skip(1) {
            let Some(field) = cap.split(".is_empty()").next() else { continue };
            if !cap[field.len()..].starts_with(".is_empty()") {
                continue;
            }
            let accounted = empty_rows.contains(&field)
                || field == "stack"
                || field == "async_gen_run_stack";
            assert!(
                accounted,
                "is_quiescent requires `{field}` empty but the ledger does not classify it EmptyAtBoundary (or document its exception)"
            );
        }
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
