//! The realm: a per-compartment guest namespace over a shared machine.
//!
//! One [`Interp`] owns the slot/chunk arenas and the primordial intrinsic
//! graph. A `Realm` is the per-compartment namespace state — its global
//! object and property index, its program symbol table, and its host
//! configuration. Evaluating a realm swaps its namespace into the machine's
//! active fields ([`Interp::swap_realm`]) and back, so N realms share one
//! arena and therefore one `Object.prototype` while keeping distinct globals.
//!
//! Derived id caches and the eval code segments travel with the realm, so a
//! realm's second evaluation sees the same names and functions its first did.
//! Machine-wide boot state (the intrinsic name table, boot default keys, the
//! symbol-key namespace) stays on the interpreter.

use super::*;
use crate::value::SlotIndex;

/// The realm-scoped namespace of a machine.
pub struct Realm {
    /// Identity of the machine whose arenas minted this realm. Every index
    /// the realm carries (`global_obj`, `global_props`, symbol ids) is an
    /// index into that machine, so installing it anywhere else is refused.
    machine_id: u64,
    global_obj: SlotIndex,
    global_props: std::collections::HashMap<u16, SlotIndex>,
    symbol_ids: SymbolIds,
    symbol_names: Tracked<Vec<SymbolName>>,
    installed_names_len: usize,
    source_compiler: Option<std::rc::Rc<dyn SourceCompiler>>,
    intrinsic_permit: Option<Vec<String>>,
    code_segments: Tracked<Vec<std::rc::Rc<[u8]>>>,
    func_segments: Tracked<std::collections::HashMap<crate::value::SlotIndex, usize>>,
    active_segment: Option<usize>,
    top_level_code: Option<std::rc::Rc<[u8]>>,
    eval_direct: bool,
    byte_length_id: Option<u16>,
    byte_offset_id: Option<u16>,
    buffer_id: Option<u16>,
    size_id: Option<u16>,
    length_id: Option<u16>,
    name_id: Option<u16>,
    value_id: Option<u16>,
    done_id: Option<u16>,
    then_id: Option<u16>,
    constructor_id: Option<u16>,
    prototype_key_id: Option<u16>,
    last_index_id: Option<u16>,
    regexp_getter_ids: RegExpGetterIds,
    regexp_result_ids: RegExpResultIds,
}

impl Realm {
    /// Allocate a fresh realm namespace on `interp`: a new global object in
    /// the shared arena, with an empty symbol table and no host policy.
    ///
    /// The namespace's global object is **rooted from allocation** and stays
    /// rooted until [`Interp::release_realm`]: a live [`Realm`] handle must
    /// keep its namespace alive, and the interval between minting a realm
    /// and installing it is otherwise open to a collection. While the realm
    /// is the installed one the active `global_obj` field roots it; while it
    /// is parked, the machine's root set does.
    pub fn new(interp: &mut Interp) -> Realm {
        let global_obj = interp
            .slots
            .alloc(Slot::instance(crate::value::SlotIndex::NULL));
        interp.realm_roots.push(global_obj);
        let snapshot_dirt = interp.snapshot_dirt.clone();
        Realm {
            machine_id: interp.machine_id,
            global_obj,
            global_props: std::collections::HashMap::new(),
            symbol_ids: SymbolIds::default(),
            symbol_names: Tracked::new(
                Vec::new(),
                snapshot_dirt.clone(),
                SnapshotSection::Names.mask()
                    | SnapshotSection::NameFloor.mask()
                    | SnapshotSection::Accessors.mask(),
            ),
            installed_names_len: 0,
            source_compiler: None,
            intrinsic_permit: None,
            code_segments: Tracked::new(
                Vec::new(),
                snapshot_dirt.clone(),
                SnapshotSection::Functions.mask(),
            ),
            func_segments: Tracked::new(
                std::collections::HashMap::new(),
                snapshot_dirt.clone(),
                SnapshotSection::Functions.mask(),
            ),
            active_segment: None,
            top_level_code: None,
            eval_direct: false,
            byte_length_id: None,
            byte_offset_id: None,
            buffer_id: None,
            size_id: None,
            length_id: None,
            name_id: None,
            value_id: None,
            done_id: None,
            then_id: None,
            constructor_id: None,
            prototype_key_id: None,
            last_index_id: None,
            regexp_getter_ids: RegExpGetterIds::default(),
            regexp_result_ids: RegExpResultIds::default(),
        }
    }
}

impl Interp {
    /// Allocate a fresh realm namespace over this machine's shared graph.
    pub fn new_realm(&mut self) -> Realm {
        Realm::new(self)
    }

    /// Swap this machine's active namespace with `realm`'s. Call before a run
    /// to install a realm and after it to park the realm again; the machine's
    /// arena and primordial graph never move.
    ///
    /// `realm.global_obj` is rooted from allocation. The swap keeps exactly
    /// the NON-active realm globals rooted: the incoming global becomes
    /// active (`global_obj`, rooted by the field whether or not it is also in
    /// the root set) and is removed from `realm_roots`; the outgoing global
    /// is parked and added.
    pub fn swap_realm(&mut self, realm: &mut Realm) {
        assert_eq!(
            realm.machine_id, self.machine_id,
            "a realm may only be installed into the machine that minted it: \
             its slot and symbol indices belong to that machine's arenas"
        );
        std::mem::swap(&mut self.global_obj, &mut realm.global_obj);
        self.realm_roots.retain(|root| *root != self.global_obj);
        if !self.realm_roots.contains(&realm.global_obj) {
            self.realm_roots.push(realm.global_obj);
        }
        std::mem::swap(&mut self.global_props, &mut realm.global_props);
        std::mem::swap(&mut self.symbol_ids, &mut realm.symbol_ids);
        std::mem::swap(&mut self.symbol_names, &mut realm.symbol_names);
        std::mem::swap(
            &mut self.installed_names_len,
            &mut realm.installed_names_len,
        );
        std::mem::swap(&mut self.source_compiler, &mut realm.source_compiler);
        std::mem::swap(&mut self.intrinsic_permit, &mut realm.intrinsic_permit);
        std::mem::swap(&mut self.code_segments, &mut realm.code_segments);
        std::mem::swap(&mut self.func_segments, &mut realm.func_segments);
        std::mem::swap(&mut self.active_segment, &mut realm.active_segment);
        std::mem::swap(&mut self.top_level_code, &mut realm.top_level_code);
        std::mem::swap(&mut self.eval_direct, &mut realm.eval_direct);
        std::mem::swap(&mut self.byte_length_id, &mut realm.byte_length_id);
        std::mem::swap(&mut self.byte_offset_id, &mut realm.byte_offset_id);
        std::mem::swap(&mut self.buffer_id, &mut realm.buffer_id);
        std::mem::swap(&mut self.size_id, &mut realm.size_id);
        std::mem::swap(&mut self.length_id, &mut realm.length_id);
        std::mem::swap(&mut self.name_id, &mut realm.name_id);
        std::mem::swap(&mut self.value_id, &mut realm.value_id);
        std::mem::swap(&mut self.done_id, &mut realm.done_id);
        std::mem::swap(&mut self.then_id, &mut realm.then_id);
        std::mem::swap(&mut self.constructor_id, &mut realm.constructor_id);
        std::mem::swap(&mut self.prototype_key_id, &mut realm.prototype_key_id);
        std::mem::swap(&mut self.last_index_id, &mut realm.last_index_id);
        std::mem::swap(&mut self.regexp_getter_ids, &mut realm.regexp_getter_ids);
        std::mem::swap(&mut self.regexp_result_ids, &mut realm.regexp_result_ids);
    }

    /// Drop `realm` from this machine's root set. The realm must not be used
    /// afterwards; its namespace becomes unreachable and the next collection
    /// may reclaim it. Releasing twice is harmless. A realm handle always
    /// holds the namespace it parked, so releasing the currently installed
    /// realm unroots that parked namespace (for the first install, the
    /// machine's boot default), not the active one — the active global is
    /// rooted through `global_obj`.
    pub fn release_realm(&mut self, realm: &Realm) {
        assert_eq!(
            realm.machine_id, self.machine_id,
            "a realm may only be released on the machine that minted it: \
             its slot and symbol indices belong to that machine's arenas"
        );
        self.realm_roots.retain(|root| *root != realm.global_obj);
    }

    /// The number of realm namespaces this machine keeps rooted while they
    /// are not the active one — every minted realm until
    /// [`Interp::release_realm`], plus a parked default global. Bounded by the
    /// number of live realm handles.
    pub fn rooted_realm_count(&self) -> usize {
        self.realm_roots.len()
    }
}

#[cfg(test)]
mod tests {
    use crate::INTERP_FIELDS;

    /// The fields `Interp::swap_realm` moves in and out of the machine when a
    /// realm is installed or parked.
    /// Kept in lockstep with the swap body by the test below.
    const REALM_SCOPED: &[&str] = &[
        "global_obj",
        "global_props",
        "symbol_ids",
        "symbol_names",
        "installed_names_len",
        "source_compiler",
        "intrinsic_permit",
        "code_segments",
        "func_segments",
        "active_segment",
        "top_level_code",
        "eval_direct",
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
        "prototype_key_id",
        "last_index_id",
        "regexp_getter_ids",
        "regexp_result_ids",
    ];

    /// Every other `Interp` field is machine-scoped: shared by all realms.
    /// A new field must be classified here (or in `REALM_SCOPED`) deliberately.
    const MACHINE_SCOPED: &[&str] = &[
        "snapshot_dirt",
        "snapshot_baseline_identity",
        "machine_id",
        "stack",
        "locals",
        "id_map",
        "realm_roots",
        "direct_eval_hoist",
        "eval_program_hoist",
        "result",
        "strict",
        "meter",
        "cost",
        "meter_host",
        "step_limit",
        "slots",
        "chunks",
        "static_str",
        "n_dispatched",
        "boot_slot_count",
        "native_depth",
        "functions",
        "bound_functions",
        "proxies",
        "array_iterator_proxy_get_context",
        "proxy_revokers",
        "call_stack",
        "args",
        "this_val",
        "this_captures",
        "env",
        "cur_func",
        "cur_target",
        "target_func",
        "pending_new_target",
        "exception",
        "frame_slots",
        "intrinsics",
        "intl_object",
        "locale_proto",
        "collator_proto",
        "list_format_proto",
        "plural_rules_proto",
        "segmenter_proto",
        "segments_proto",
        "segment_iterator_proto",
        "segments_iterator_method",
        "segment_iterator_identity",
        "date_time_format_proto",
        "number_format_proto",
        "locales",
        "collators",
        "list_formats",
        "plural_rules",
        "number_formats",
        "segmenters",
        "segments",
        "segment_iterators",
        "date_time_formats",
        "temporal_object",
        "temporal_instant_proto",
        "temporal_duration_proto",
        "temporal_plain_protos",
        "temporal_zoned_proto",
        "temporal_now_object",
        "temporal_instants",
        "temporal_durations",
        "temporal_plains",
        "temporal_zoneds",
        "collator_compare_functions",
        "number_format_bound_functions",
        "deleted_fn_meta",
        "object_proto",
        "function_proto",
        "function_has_instance_method",
        "template_cache",
        "ctor_prototype",
        "private_values",
        "private_accessors",
        "proto_methods",
        "proto_data",
        "proto_accessors",
        "well_known_symbols",
        "default_keys",
        "next_symbol_key_id",
        "installing_intrinsics",
        "id_space_exhausted",
        "last_crank_completed",
        "gc_failed",
        "error_data",
        "wrapper_data",
        "array_proto",
        "arrays",
        "index_props",
        "arguments_objects",
        "disposable_stacks",
        "collections",
        "side_refs",
        "map_proto",
        "set_proto",
        "weakmap_proto",
        "weakset_proto",
        "array_buffers",
        "detached_buffers",
        "shared_buffers",
        "arraybuffer_proto",
        "typed_arrays",
        "data_views",
        "dataview_proto",
        "array_iterator_proto",
        "iterator_proto",
        "iterator_wrapper_proto",
        "map_iterator_proto",
        "set_iterator_proto",
        "regexp_string_iterator_proto",
        "math_object",
        "string_proto",
        "string_iterator_method",
        "number_proto",
        "boolean_proto",
        "date_proto",
        "date_to_primitive_method",
        "dates",
        "symbol_proto",
        "symbol_to_primitive_method",
        "bigint_proto",
        "symbol_registry",
        "symbol_registry_keys",
        "symbol_key_ids",
        "accessors",
        "proto_value_data",
        "iterators",
        "promises",
        "promise_proto",
        "generators",
        "generator_proto",
        "generator_function_proto",
        "gen_run_stack",
        "async_instances",
        "async_function_proto",
        "async_run_stack",
        "async_generators",
        "async_generator_proto",
        "async_generator_function_proto",
        "async_iterator_identity",
        "iterator_identity",
        "async_gen_run_stack",
        "resume_status",
        "promise_functions",
        "promise_guards",
        "unhandled_rejection",
        "pending_rejections",
        "promise_jobs",
        "combinators",
        "from_async",
        "error_stack_accessor",
        "regexps",
        "regexp_proto",
        "regexp_replace_method",
        "regexp_match_method",
        "regexp_match_all_method",
        "regexp_search_method",
        "regexp_split_method",
        "jumps",
    ];

    #[test]
    fn every_interp_field_is_classified_realm_or_machine() {
        let declared: std::collections::BTreeSet<&str> =
            INTERP_FIELDS.iter().map(|(name, _)| *name).collect();
        let realm: std::collections::BTreeSet<&str> = REALM_SCOPED.iter().copied().collect();
        let machine: std::collections::BTreeSet<&str> = MACHINE_SCOPED.iter().copied().collect();
        assert!(realm.is_disjoint(&machine), "a field cannot be both scoped");
        let classified: std::collections::BTreeSet<&str> = realm.union(&machine).copied().collect();
        let unclassified: Vec<_> = declared.difference(&classified).collect();
        let stale: Vec<_> = classified.difference(&declared).collect();
        assert!(
            unclassified.is_empty(),
            "Interp fields with no realm/machine classification: {unclassified:?}"
        );
        assert!(
            stale.is_empty(),
            "classification names an Interp field that no longer exists: {stale:?}"
        );

        // The declared realmscoped set must be exactly what the swap body
        // moves, and no machine-scoped field may be swapped. Whitespace is
        // stripped so a rustfmt-wrapped `swap` call still matches.
        let source: String = include_str!("realm.rs").split_whitespace().collect();
        for name in REALM_SCOPED {
            let needle = format!("std::mem::swap(&mutself.{name},");
            assert!(
                source.contains(&needle),
                "REALM_SCOPED `{name}` is not moved by swap_realm"
            );
        }
        for name in MACHINE_SCOPED {
            let needle = format!("std::mem::swap(&mutself.{name},");
            assert!(
                !source.contains(&needle),
                "MACHINE_SCOPED `{name}` is moved by swap_realm"
            );
        }
    }
}
