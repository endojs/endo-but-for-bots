//! Side-table persistence coverage, generated from the VM field roster and
//! checked against independent field and boundary classifications.
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
//! The VM roster declares the table identities alongside their owning fields,
//! with an explicit external entry for module-graph state.
//! Its metadata-only [`ironhorse_vm::interp_tables`] macro generates
//! [`SideTable`], [`SideTable::ALL`], and [`SideTable::descriptor`] here.
//! Snapshot interprets each coverage tag as [`Coverage`]; the VM does not depend
//! on snapshot types or implement persistence through these declarations.
//! The tests retain independent checks of historical identities, field coverage,
//! and the boundary conditions that make excluded state safe to omit.
//! Generated agreement alone cannot establish that an image carries a table.
//!
//! Serialized coverage includes callable proxy, accessor, private-element and
//! Intl-bound links, as well as suspended async instances.
//! Unsupported reactions and runtime natives still refuse persistence; coverage
//! does not waive those gates (see `promise_carry`, `async_carry`, and `persist_gates`).
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
//! **Per-activation registers — inert at an admitted quiescent boundary.**
//! These describe the executing frame. A halt can retain them; persistence
//! requires `last_crank_completed` and the independent transient gates in
//! `is_quiescent`, not merely a return from `run`. The following descriptions
//! apply only to a successfully completed, admitted boundary:
//! - `args`, `this_val`, `cur_func`, `cur_target` — the active call's
//!   arguments / receiver / callee / new-target; none while no call is live.
//! - `exception` — the in-flight thrown value; none outside a `throw`/catch
//!   window, cleared before successful boundary admission.
//! - `locals`, `frame_slots`, `id_map` — the executing frame's local slots,
//!   saved-frame region, and name→local index map; all belong to a live
//!   activation and are re-established by the next crank's `BEGIN_*` prologue.
//! - `resume_status` — the generator/async resume signal, meaningful only
//!   mid-`resume`; a *suspended* generator's state is the `generators` row
//!   (tracked and serialized), not this register.
//! - `env` — the active `with`/eval environment head; live only inside a
//!   `with` body or eval frame, cleared at an admitted boundary
//!   (SUSPENDED environments live in `SavedFrame.env`, inside their row).
//! - `result`, `strict` — the completion register and top-level strictness;
//!   both cleared/reset at the crank boundary, so a
//!   resumed twin's fresh defaults match.
//! - `pending_new_target` — armed by `SUPER` for the construct about to
//!   happen; consumed by the construct frame and disarmed on unwind.
//!   Non-throw halts may retain it for inspection: it is a GC root, refuses
//!   quiescence, and is reset when the next run abandons that activation (F025).
//! - `direct_eval_hoist`, `eval_program_hoist`, `eval_direct`,
//!   `active_segment`, `top_level_code` — the eval bridge's per-crank
//!   registers, re-established at every run entry and save/restored around
//!   units. `eval_program_hoist` (the declaration-instantiation `D` argument:
//!   an eval's global `var` is configurable, a Script's is not) is set and
//!   restored around every nested eval unit, and at the top level only by
//!   `Interp::set_eval_program_framing`, which exists solely for the
//!   differential harness's oracle-framing reproduction and is never armed by
//!   a production embedding — so it is `false` at every boundary a snapshot
//!   can be taken from.
//! - `id_space_exhausted` — the property-key id-space poison latch; the
//!   dispatch loop halts on it before the next instruction and
//!   `is_quiescent` refuses a poisoned machine, so it is provably false
//!   at every boundary a snapshot can be taken from.
//! - `last_crank_completed` — the crank-lifecycle latch: dropped at
//!   `run` entry, set at exit from the engine's
//!   own halt, and the FIRST conjunct of `is_quiescent`. Provably true at
//!   every boundary a snapshot can be taken from, and a fresh machine —
//!   which every restore lands on — starts true. It exists because the
//!   table conjuncts cannot see a crank halted at a top-level meter
//!   check, the dispatch ceiling, or a decode fault: every table is
//!   empty there, yet the boundary registers were never cleared.
//!
//! The registry of ALL these classifications is now MECHANICAL:
//! `tests::ledger_classification_reconciles_with_the_interp_struct`
//! reads the field inventory emitted with `Interp` and reconciles it two-way
//! against the classified groups, so a new field cannot land
//! unclassified and a stale entry cannot linger. The quiescence
//! predicate itself is reconciled the same way by
//! `tests::empty_at_boundary_rows_match_the_quiescence_predicate`: every
//! `EmptyAtBoundary` row must be required empty, and every field the
//! predicate names — emptiness and lifecycle conjuncts alike — must be
//! classified, so a conjunct cannot be dropped silently.
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
//!   `static_str` is an always-live chunk prefix that cannot move under ordered
//!   compaction; `proto_value_data` contains only numeric constants. Boot-native
//!   function name chunks can move and their live owner/offset pairs travel in
//!   `FUNC`; absence from that table removes collected native metadata.
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
//!   Serialized — but this satellite does NOT travel with it: a LIVE
//!   entry is anchored by a `FromAsync*` reaction on a live promise,
//!   which the persist gate refuses by kind, and an unanchored entry is
//!   unreachable (the next arena compaction drops it), so a resume that
//!   rebuilds the table empty is observationally exact.
//! - `arguments_objects` — the arguments-exotic brand set, riding its
//!   primary row (`Arrays`, Serialized). Since store schema 11 the brand
//!   itself TRAVELS (the `ARGB` atom / small-state arguments section), so
//!   a suspended arguments object resumes branded — its completion-value
//!   render answers `[object Arguments]`, not the array join
//!   (`language_rows_carry.rs`).
//! - `side_refs` — the counted-accessor page projection over the three bulk
//!   rows (`Arrays`/`IndexProps`/`Collections`); a derived cache the restore path
//!   rebuilds in lockstep by routing every insert through the counted
//!   accessors. Its corruption poison latch is transient: quiescence
//!   requires it clear, so a poisoned machine can never persist and
//!   restore cannot silently erase a known integrity failure.

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
    /// (the contract-violation locks in `persist_gates.rs` enforce the gates
    /// behaviorally, and
    /// `tests::empty_at_boundary_rows_match_the_quiescence_predicate`
    /// ties this classification to the predicate's actual field list
    /// mechanically). Distinct from an excluded transient: these ARE
    /// reachable machine state mid-crank — a halted crank holds them —
    /// but a halted machine cannot pass the gates, and the managed
    /// lifecycle rewinds it whole.
    EmptyAtBoundary,
}

// The VM exports only selected metadata tokens. Coverage interpretation and
// descriptor behavior remain here; independent tests below verify the contract.
macro_rules! define_side_tables {
    ($($variant:ident, $id:literal, $order:literal, $coverage:ident, $primary:expr, $display:literal;)*) => {
        /// One logical side table, generated from the VM field inventory.
        #[derive(Copy, Clone, Debug, PartialEq, Eq)]
        pub enum SideTable {
            $(#[doc = $display] $variant = $id,)*
        }
        impl SideTable {
            /// Every table in the existing public enumeration order.
            pub const ALL: &'static [Self] = &{
                let mut tables = [$(Self::$variant,)*];
                assert!(tables.len() == ironhorse_vm::SIDE_TABLES.len());
                let mut i = 0;
                while i < tables.len() {
                    tables[i] = match ironhorse_vm::SIDE_TABLES[i].discriminant {
                        $($id => Self::$variant,)*
                        _ => panic!("unknown table discriminant"),
                    };
                    i += 1;
                }
                tables
            };
            /// Current snapshot coverage, interpreted from the VM metadata tags.
            pub fn descriptor(self) -> Descriptor {
                let (field, coverage) = match self {
                    $(Self::$variant => ($display, Coverage::$coverage),)*
                };
                Descriptor { table: self, field, coverage }
            }
            /// Tables not yet carried by the snapshot image.
            pub fn pending() -> Vec<Self> {
                Self::ALL.iter().copied()
                    .filter(|table| table.descriptor().coverage == Coverage::Pending)
                    .collect()
            }
        }
    };
}
ironhorse_vm::interp_tables!(define_side_tables);

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

    #[test]
    fn historical_table_ids_order_and_descriptors_are_preserved() {
        // Intentional independent contract: enum order and ALL order differed.
        const EXPECTED: &[(usize, &str, &str, Coverage, Option<&str>)] = &[
            (
                0,
                "Functions",
                "functions",
                Coverage::Serialized,
                Some("functions"),
            ),
            (
                1,
                "BoundFunctions",
                "bound_functions",
                Coverage::Serialized,
                Some("bound_functions"),
            ),
            (
                2,
                "Proxies",
                "proxies/proxy_revokers",
                Coverage::Serialized,
                Some("proxies"),
            ),
            (
                3,
                "CallStack",
                "call_stack",
                Coverage::EmptyAtBoundary,
                Some("call_stack"),
            ),
            (
                4,
                "Jumps",
                "jumps",
                Coverage::EmptyAtBoundary,
                Some("jumps"),
            ),
            (
                5,
                "GlobalProps",
                "global_props",
                Coverage::RebuiltAtRestore,
                Some("global_props"),
            ),
            (
                6,
                "ErrorData",
                "error_data",
                Coverage::Serialized,
                Some("error_data"),
            ),
            (
                7,
                "Accessors",
                "accessors",
                Coverage::Serialized,
                Some("accessors"),
            ),
            (
                8,
                "WrapperData",
                "wrapper_data",
                Coverage::Serialized,
                Some("wrapper_data"),
            ),
            (9, "Arrays", "arrays", Coverage::Serialized, Some("arrays")),
            (
                10,
                "IndexProps",
                "index_props",
                Coverage::Serialized,
                Some("index_props"),
            ),
            (
                11,
                "Collections",
                "collections",
                Coverage::Serialized,
                Some("collections"),
            ),
            (
                12,
                "ArrayBuffers",
                "array_buffers",
                Coverage::Serialized,
                Some("array_buffers"),
            ),
            (
                13,
                "TypedArrays",
                "typed_arrays",
                Coverage::Serialized,
                Some("typed_arrays"),
            ),
            (
                14,
                "DataViews",
                "data_views",
                Coverage::Serialized,
                Some("data_views"),
            ),
            (
                15,
                "Iterators",
                "iterators",
                Coverage::Serialized,
                Some("iterators"),
            ),
            (
                16,
                "Promises",
                "promises",
                Coverage::Serialized,
                Some("promises"),
            ),
            (
                17,
                "PromiseFunctions",
                "promise_functions",
                Coverage::Serialized,
                Some("promise_functions"),
            ),
            (
                18,
                "PromiseGuards",
                "promise_guards",
                Coverage::Serialized,
                Some("promise_guards"),
            ),
            (
                19,
                "PromiseJobs",
                "promise_jobs",
                Coverage::EmptyAtBoundary,
                Some("promise_jobs"),
            ),
            (
                20,
                "Combinators",
                "combinators",
                Coverage::Serialized,
                Some("combinators"),
            ),
            (
                21,
                "Generators",
                "generators",
                Coverage::Serialized,
                Some("generators"),
            ),
            (
                22,
                "GenRunStack",
                "gen_run_stack",
                Coverage::EmptyAtBoundary,
                Some("gen_run_stack"),
            ),
            (
                23,
                "AsyncInstances",
                "async_instances",
                Coverage::Serialized,
                Some("async_instances"),
            ),
            (
                24,
                "AsyncRunStack",
                "async_run_stack",
                Coverage::EmptyAtBoundary,
                Some("async_run_stack"),
            ),
            (
                25,
                "RegExps",
                "regexps",
                Coverage::Serialized,
                Some("regexps"),
            ),
            (
                26,
                "TemporalRecords",
                "temporal_instants/temporal_durations/temporal_plains/temporal_zoneds",
                Coverage::Serialized,
                Some("temporal_instants"),
            ),
            (31, "Dates", "dates", Coverage::Serialized, Some("dates")),
            (
                27,
                "AsyncGenerators",
                "async_generators/async_gen_run_stack",
                Coverage::Pending,
                Some("async_generators"),
            ),
            (
                28,
                "PrivateElements",
                "private_values/private_accessors",
                Coverage::Serialized,
                Some("private_values"),
            ),
            (
                29,
                "DisposableStacks",
                "disposable_stacks",
                Coverage::Serialized,
                Some("disposable_stacks"),
            ),
            (
                30,
                "IntlRecords",
                "locales/collators/…/date_time_formats",
                Coverage::Serialized,
                Some("locales"),
            ),
            (
                32,
                "IntlBoundFunctions",
                "collator_compare_functions/number_format_bound_functions",
                Coverage::Serialized,
                Some("collator_compare_functions"),
            ),
            (
                33,
                "Segments",
                "code_segments/func_segments",
                Coverage::Serialized,
                Some("code_segments"),
            ),
            (
                34,
                "CtorPrototype",
                "ctor_prototype",
                Coverage::Serialized,
                Some("ctor_prototype"),
            ),
            (
                35,
                "SymbolRegistry",
                "symbol_registry/symbol_registry_keys",
                Coverage::Serialized,
                Some("symbol_registry"),
            ),
            (
                36,
                "SymbolTables",
                "symbol_names(NAME-serialized)+symbol_ids(derived)",
                Coverage::RebuiltAtRestore,
                Some("symbol_names"),
            ),
            (
                37,
                "SymbolKeyIds",
                "symbol_key_ids/next_symbol_key_id",
                Coverage::Serialized,
                Some("symbol_key_ids"),
            ),
            (
                38,
                "NameFloor",
                "installed_names_len",
                Coverage::Serialized,
                Some("installed_names_len"),
            ),
            (
                39,
                "Modules",
                "module::ModuleGraph",
                Coverage::Pending,
                None,
            ),
            (
                40,
                "HardenState",
                "harden slot flags (no side table)",
                Coverage::InArena,
                Some("slots"),
            ),
            (41, "Meter", "meter", Coverage::Serialized, Some("meter")),
        ];
        assert_eq!(SideTable::ALL.len(), EXPECTED.len());
        assert_eq!(ironhorse_vm::SIDE_TABLES.len(), EXPECTED.len());
        for (ordinal, ((table, raw), expected)) in SideTable::ALL
            .iter()
            .zip(ironhorse_vm::SIDE_TABLES)
            .zip(EXPECTED)
            .enumerate()
        {
            let descriptor = table.descriptor();
            assert_eq!(*table as usize, expected.0);
            assert_eq!(format!("{table:?}"), expected.1);
            assert_eq!(descriptor.field, expected.2);
            assert_eq!(descriptor.coverage, expected.3);
            assert_eq!(descriptor.table, *table);
            assert_eq!(raw.variant, expected.1);
            assert_eq!(raw.discriminant, expected.0);
            assert_eq!(raw.ordinal, ordinal);
            assert_eq!(raw.field, expected.2);
            assert_eq!(raw.coverage, format!("{:?}", expected.3));
            assert_eq!(raw.primary_field, expected.4);
            if let Some(field) = raw.primary_field {
                assert!(ironhorse_vm::interp::INTERP_FIELDS
                    .iter()
                    .any(|(name, _)| *name == field));
            }
        }
        assert!(!ironhorse_vm::interp::INTERP_FIELDS
            .iter()
            .any(|(name, _)| *name == "Modules"));
    }

    /// Independent cardinality and uniqueness checks on the generated ledger.
    /// Field/satellite classification below remains separate from its metadata.
    #[test]
    fn all_is_exhaustive() {
        // Independent historical count. A deliberate new table must update
        // this contract and the identity/descriptor fixture above.
        const VARIANT_COUNT: usize = 42;
        assert_eq!(SideTable::ALL.len(), VARIANT_COUNT);

        // No duplicates: each field name appears once.
        let mut fields: Vec<&str> = SideTable::ALL
            .iter()
            .map(|t| t.descriptor().field)
            .collect();
        fields.sort_unstable();
        let before = fields.len();
        fields.dedup();
        assert_eq!(before, fields.len(), "duplicate side table in ALL");
    }

    /// Read the field list emitted with `Interp` and reconcile it, two-way,
    /// against the classification below: a new `Interp` field fails
    /// here until it is classified (a ledger row, a documented
    /// satellite or transient, a boot artifact, host wiring, or an
    /// arena), and a renamed/removed field fails the reverse direction.
    #[test]
    fn ledger_classification_reconciles_with_the_interp_struct() {
        let src = include_str!("../../ironhorse-vm/src/interp/boot.rs");
        let fields: Vec<&str> = ironhorse_vm::interp::INTERP_FIELDS
            .iter()
            .map(|(name, _)| *name)
            .collect();
        assert!(
            fields.len() > 100,
            "field inventory sanity: found {}",
            fields.len()
        );

        // The classification. Every entry is accounted for by exactly
        // the mechanism named for its group; moving a field between
        // groups is a deliberate edit here, never drift.
        const LEDGER_ROWS: &[&str] = &[
            "functions",
            "bound_functions",
            "proxies",
            "proxy_revokers",
            "call_stack",
            "jumps",
            "global_props",
            "error_data",
            "accessors",
            "wrapper_data",
            "arrays",
            "index_props",
            "collections",
            "array_buffers",
            "typed_arrays",
            "data_views",
            "iterators",
            "promises",
            "promise_functions",
            "promise_guards",
            "promise_jobs",
            "combinators",
            "generators",
            "gen_run_stack",
            "async_instances",
            "async_run_stack",
            "async_generators",
            "async_gen_run_stack",
            "private_values",
            "private_accessors",
            "disposable_stacks",
            "regexps",
            "temporal_instants",
            "temporal_durations",
            "temporal_plains",
            "temporal_zoneds",
            "dates",
            "locales",
            "collators",
            "list_formats",
            "plural_rules",
            "number_formats",
            "segmenters",
            "segments",
            "segment_iterators",
            "date_time_formats",
            "collator_compare_functions",
            "number_format_bound_functions",
            "code_segments",
            "func_segments",
            "ctor_prototype",
            "symbol_registry",
            "symbol_registry_keys",
            "symbol_names",
            "symbol_ids",
            "symbol_key_ids",
            "next_symbol_key_id",
            "installed_names_len",
            "meter",
        ];
        const ARENAS: &[&str] = &["slots", "chunks", "stack"];
        const SATELLITES: &[&str] = &[
            "detached_buffers",
            "shared_buffers",
            "deleted_fn_meta",
            "from_async",
            "arguments_objects",
            "side_refs",
            // Derived membership/refinement bits rebuilt by ClassMap inserts
            // when the authoritative side-table rows are restored.
            "classes",
            "snapshot_baseline_identity",
        ];
        const TRANSIENTS: &[&str] = &[
            // Intrinsic linking is synchronous and restores this guard before
            // control can reach a persistence boundary.
            "installing_intrinsics",
            "args",
            "this_val",
            "this_captures",
            "cur_func",
            "cur_target",
            "target_func",
            "pending_new_target",
            "exception",
            "frame_slots",
            "locals",
            "id_map",
            "resume_status",
            "env",
            "direct_eval_hoist",
            "eval_direct",
            "active_segment",
            "top_level_code",
            "result",
            "strict",
            // The native-recursion budget consumed by the activations in
            // flight; every guarded entry releases its charge on return,
            // so it is `0` before control can reach a persistence boundary.
            "native_depth",
            // Array Iterator Proxy-Get context is installed only around one
            // synchronous trap call and restored on both success and throw.
            // `is_quiescent` additionally refuses a leaked context.
            "array_iterator_proxy_get_context",
            // Poison latch for the property-key id-space meet: provably
            // never set at a persistable boundary — the dispatch loop
            // halts on it before the next instruction and `is_quiescent`
            // reports the poisoned machine non-quiescent, so no snapshot
            // ever needs to carry it.
            "id_space_exhausted",
            // The crank-lifecycle latch: dropped at `run`
            // entry, set at exit from the engine's own halt, and the
            // lifecycle conjunct of `is_quiescent`. Provably TRUE at every
            // persistable boundary; a restore lands on a fresh machine,
            // which starts true.
            "last_crank_completed",
        ];
        const HOST_WIRING: &[&str] = &[
            // Embedding policy configured outside each activation.
            "eval_program_hoist",
            "meter_host",
            "source_compiler",
            "cost",
            "step_limit",
            "n_dispatched",
        ];
        const BOOT_DERIVED: &[&str] = &[
            "intrinsics",
            "global_obj",
            "intl_object",
            "temporal_object",
            "temporal_now_object",
            "math_object",
            "static_str",
            "default_keys",
            "boot_slot_count",
            "well_known_symbols",
            "proto_methods",
            "proto_data",
            "proto_accessors",
            "proto_value_data",
            "string_iterator_method",
            "async_iterator_identity",
            // Boot-minted identities for well-known-symbol properties whose
            // property ids remain lazy. They are explicit roots until first
            // materialization and are re-derived at identical slots on resume.
            "function_has_instance_method",
            "symbol_to_primitive_method",
            "date_to_primitive_method",
            // The three `@@iterator` natives that used to be minted
            // during `link_intrinsics` (above `boot_slot_count`, so
            // resume re-derived neither their `FuncInfo` nor their name
            // chunk, and the heap's reference to them read back as a
            // plain object). Minting them at boot beside the two
            // siblings above is what makes them boot-derived, and a
            // fresh boot reproduces them at identical indices.
            "iterator_identity",
            "segments_iterator_method",
            "segment_iterator_identity",
            // `%Error.prototype%`'s `stack` host accessor pair. Both
            // function slots are minted in `create_intrinsics`, so a
            // fresh boot re-derives them at identical indices; the
            // property install is link-time and its side-table entry
            // rides `ACCS` like any other.
            "error_stack_accessor",
            // The registry head is reproduced at the same boot index; its
            // generated-site properties and template-array references travel
            // in the ordinary slot arena rooted through that head.
            "template_cache",
            "object_proto",
            "function_proto",
            "array_proto",
            "map_proto",
            "set_proto",
            "weakmap_proto",
            "weakset_proto",
            "arraybuffer_proto",
            "dataview_proto",
            "array_iterator_proto",
            "string_proto",
            "number_proto",
            "boolean_proto",
            "symbol_proto",
            "bigint_proto",
            "promise_proto",
            "generator_proto",
            "generator_function_proto",
            "async_function_proto",
            "async_generator_proto",
            "async_generator_function_proto",
            "regexp_proto",
            "regexp_replace_method",
            "regexp_match_method",
            "regexp_match_all_method",
            "regexp_search_method",
            "regexp_split_method",
            "iterator_proto",
            "iterator_wrapper_proto",
            "map_iterator_proto",
            "set_iterator_proto",
            "regexp_string_iterator_proto",
            "date_proto",
            "locale_proto",
            "collator_proto",
            "list_format_proto",
            "plural_rules_proto",
            "segmenter_proto",
            "segments_proto",
            "segment_iterator_proto",
            "date_time_format_proto",
            "number_format_proto",
            "temporal_instant_proto",
            "temporal_duration_proto",
            "temporal_plain_protos",
            "temporal_zoned_proto",
            "byte_length_id",
            "byte_offset_id",
            "buffer_id",
            "size_id",
            "length_id",
            "name_id",
            "value_id",
            "done_id",
            "then_id",
            "constructor_id",
            "last_index_id",
            // The same cached-key-id class as its neighbours above:
            // derived from the symbol table at link and re-derived by
            // `bind_program_symbols` on restore.
            "prototype_key_id",
            "regexp_getter_ids",
            "regexp_result_ids",
        ];

        // A retained boot-derived field must contribute to the mechanical
        // compatibility identity. Comments cannot satisfy this source check.
        let fingerprint = src
            .split("fn derive_boot_fingerprint(&self)")
            .nth(1)
            .expect("boot fingerprint exists")
            .split("hash.finalize()")
            .next()
            .unwrap();
        let fingerprint = fingerprint
            .lines()
            .map(|line| line.split("//").next().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        for field in BOOT_DERIVED {
            assert!(
                fingerprint.split("self.").skip(1).any(|tail| {
                    tail.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                        .next()
                        == Some(*field)
                }),
                "boot-derived field {field} is absent from the boot fingerprint"
            );
        }

        // Every activation transient has an independent persistence gate.
        // Retained embedding policy belongs in HOST_WIRING, not this set.
        let quiescence = checked_quiescence_source();
        for field in TRANSIENTS {
            assert!(
                quiescence.split("self.").skip(1).any(|tail| {
                    tail.split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
                        .next()
                        == Some(*field)
                }),
                "transient {field} has no independent quiescence gate"
            );
        }

        let mut accounted: std::collections::BTreeSet<&str> = std::collections::BTreeSet::new();
        for group in [
            LEDGER_ROWS,
            ARENAS,
            SATELLITES,
            TRANSIENTS,
            HOST_WIRING,
            BOOT_DERIVED,
        ] {
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
        assert_eq!(pending.len(), 2, "the design's Remaining ledger count");
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
        // The schema-23 promise-cluster carry (`PRMS`): the four
        // cross-referencing rows graduated together; what remains
        // pending is the async machinery their gate refuses by
        // reaction kind.
        assert!(!pending.contains(&SideTable::Promises));
        assert!(!pending.contains(&SideTable::PromiseFunctions));
        assert!(!pending.contains(&SideTable::PromiseGuards));
        assert!(!pending.contains(&SideTable::Combinators));
        assert!(!pending.contains(&SideTable::AsyncInstances));
        assert!(pending.contains(&SideTable::Modules));
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
            assert!(
                !pending.contains(&t),
                "{t:?} is quiescence-gated, not pending"
            );
            assert_eq!(t.descriptor().coverage, Coverage::EmptyAtBoundary);
        }
    }

    fn check_quiescence_wiring(interp: &str, boundary: &str) {
        let compact = |source: &str| {
            source
                .lines()
                .map(|line| line.split("//").next().unwrap())
                .collect::<String>()
                .split_whitespace()
                .collect::<String>()
        };
        let interp = compact(interp);
        let boundary = compact(boundary);
        assert!(
            interp.contains("pubfnis_quiescent(&self)->bool{self.fields_are_quiescent()}"),
            "public gate must invoke the generated field predicates"
        );
        assert!(boundary.contains("pub(super)fnfields_are_quiescent(&self)->bool{true$(&&boundary_predicate!(boundary_run,self,$field,$boundary))*}"),
            "every field predicate must contribute conjunctively");
        assert!(
            boundary.contains("macro_rules!boundary_run{($($code:tt)*)=>{$($code)*};}"),
            "runtime emitter must forward the exact predicate tokens"
        );
        assert!(
            boundary
                .contains("macro_rules!boundary_text{($($code:tt)*)=>{stringify!($($code)*)};}"),
            "source emitter must stringify the exact predicate tokens"
        );
        assert!(boundary.contains("pubconstQUIESCENCE_SOURCE:&str=concat!($(boundary_predicate!(boundary_text,self,$field,$boundary),\"\\n\",)*);"),
            "source evidence must cover every generated predicate");
        assert!(
            boundary.contains("interp_state!(define_boundary);"),
            "field policies must come from the state roster"
        );
    }

    fn checked_quiescence_source() -> String {
        check_quiescence_wiring(
            include_str!("../../ironhorse-vm/src/interp/persist.rs"),
            include_str!("../../ironhorse-vm/src/interp/boundary.rs"),
        );
        ironhorse_vm::interp::boundary::QUIESCENCE_SOURCE
            .lines()
            .map(|line| line.split_whitespace().collect::<String>())
            .collect::<Vec<_>>()
            .join(" && ")
    }

    #[test]
    fn quiescence_source_lock_rejects_disconnected_emitters() {
        let interp = include_str!("../../ironhorse-vm/src/interp/persist.rs");
        let boundary = include_str!("../../ironhorse-vm/src/interp/boundary.rs");
        check_quiescence_wiring(interp, boundary);
        for (before, after) in [
            (
                "true $(&& boundary_predicate!",
                "true $(|| boundary_predicate!",
            ),
            ("=> { $($code)* }", "=> { true }"),
            ("stringify!($($code)*)", "\"self.last_crank_completed\""),
            ("interp_state!(define_boundary);", ""),
            (
                "boundary_predicate!(boundary_text, self, $field, $boundary)",
                "\"true\"",
            ),
        ] {
            let mutated = boundary.replace(before, after);
            assert_ne!(mutated, boundary, "mutation must match: {before}");
            assert!(
                std::panic::catch_unwind(|| check_quiescence_wiring(interp, &mutated)).is_err(),
                "disconnected evidence accepted: {before}"
            );
        }
        let mutated = interp.replace("self.fields_are_quiescent()", "true");
        assert!(std::panic::catch_unwind(|| check_quiescence_wiring(&mutated, boundary)).is_err());
    }

    /// The `EmptyAtBoundary` classification is honest only while
    /// `Interp::is_quiescent` actually requires each such table empty
    /// (the persist gates all run the predicate; `persist_gates.rs`
    /// enforces that behaviorally). Verify the generated predicate is invoked,
    /// then reconcile its exact emitted tokens in both directions: every EmptyAtBoundary field
    /// appears in it, and every field the predicate names is accounted
    /// for — an EmptyAtBoundary row, the value stack (an arena,
    /// serialized empty via `STAC`), `async_gen_run_stack`
    /// (quiescence-empty, but riding the still-Pending
    /// `AsyncGenerators` variant for the instance table it names), or
    /// one of the NON-emptiness conjuncts listed below, each a
    /// documented transient. The reverse direction reads every
    /// `self.<field>` mention, not only the `is_empty()` ones, and the
    /// forward direction requires each listed non-emptiness conjunct
    /// to be present, so a lifecycle conjunct cannot be dropped
    /// silently: table emptiness alone does not establish crank completion.
    #[test]
    fn empty_at_boundary_rows_match_the_quiescence_predicate() {
        /// The conjuncts of `is_quiescent` that are not `is_empty()`
        /// tests on a ledger row: each is a transient the module docs
        /// classify, and each must stay in the predicate.
        const EMPTY_TRANSIENTS: &[&str] = &["args", "this_captures", "locals", "id_map"];
        const NON_EMPTINESS_CONJUNCTS: &[&str] = &[
            "this_val",
            "env",
            "result",
            "cur_func",
            "target_func",
            "cur_target",
            "frame_slots",
            "strict",
            "top_level_code",
            "active_segment",
            "installing_intrinsics",
            // Counted references need not be empty, but a poisoned
            // projection must never be checkpointed.
            "side_refs",
            // The crank-lifecycle latch.
            "last_crank_completed",
            // The Proxy-trap context, refused if leaked.
            "array_iterator_proxy_get_context",
            // Hidden control latches may survive a halted activation (F025).
            "pending_new_target",
            "resume_status",
            "eval_direct",
            "direct_eval_hoist",
            // The in-flight thrown value.
            "exception",
            // The native-recursion budget in flight: every guarded entry
            // releases its charge on return, so it is `0` at a boundary.
            "native_depth",
            // The property-key id-space poison latch.
            "id_space_exhausted",
        ];
        let body = checked_quiescence_source();
        let body = body.as_str();

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
        for field in EMPTY_TRANSIENTS {
            assert!(
                body.contains(&format!("self.{field}.is_empty()")),
                "transient {field} must be empty"
            );
        }
        // Forward, the lifecycle half: every documented non-emptiness
        // conjunct is still in the predicate. The latch in particular
        // is what keeps a table-empty halt out of the persist verbs.
        for field in NON_EMPTINESS_CONJUNCTS {
            assert!(
                body.contains(&format!("self.{field}")),
                "is_quiescent no longer tests `{field}`; a documented conjunct was dropped"
            );
        }
        // Polarity: the latch is asserted TRUE, never negated. A
        // `!self.last_crank_completed` would satisfy the presence check
        // above while admitting exactly the halted class; the
        // behavioral persist-gate locks catch it, and so does this.
        assert!(
            !body.contains("!self.last_crank_completed"),
            "is_quiescent negates the lifecycle latch"
        );
        // Reverse: every field the predicate names — an emptiness test
        // or otherwise — is accounted for by the classification.
        let empty_rows: Vec<&str> = SideTable::ALL
            .iter()
            .filter(|t| t.descriptor().coverage == Coverage::EmptyAtBoundary)
            .flat_map(|t| t.descriptor().field.split('/'))
            .collect();
        let mut named = 0usize;
        for cap in body.split("self.").skip(1) {
            let field: &str = cap
                .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'))
                .next()
                .unwrap_or("");
            if field.is_empty() {
                continue;
            }
            named += 1;
            let is_emptiness = cap[field.len()..].starts_with(".is_empty()");
            let accounted = if is_emptiness {
                empty_rows.contains(&field)
                    || EMPTY_TRANSIENTS.contains(&field)
                    || field == "stack"
                    || field == "async_gen_run_stack"
            } else {
                NON_EMPTINESS_CONJUNCTS.contains(&field)
            };
            assert!(
                accounted,
                "is_quiescent tests `{field}` but the ledger does not classify it \
                 (EmptyAtBoundary for an emptiness conjunct, NON_EMPTINESS_CONJUNCTS otherwise)"
            );
        }
        assert!(
            named >= empty_rows.len() + NON_EMPTINESS_CONJUNCTS.len(),
            "parse sanity: the predicate names {named} fields"
        );
    }

    /// The restore-time rebuild rows are classified [`Coverage::RebuiltAtRestore`],
    /// because each round-trips its data but reaches it through a side index
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
        assert_ne!(
            SideTable::GlobalProps.descriptor().coverage,
            Coverage::InArena
        );
        assert_ne!(
            SideTable::CtorPrototype.descriptor().coverage,
            Coverage::InArena
        );
    }
}
