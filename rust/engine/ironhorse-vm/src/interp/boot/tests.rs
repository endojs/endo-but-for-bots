#![cfg(test)]
//! Independent fresh-constructor order and emitter checks.
use super::*;
use crate::source_scan::{code_only, tokens};

macro_rules! describe_boot_fields {
    (() $vis:vis struct $name:ident {
        $(#[boot_new($new:expr)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($context:tt)* } external_tables { $($external:tt)* }) => {
        const BOOT_FIELDS: &[(&str, &str)] = &[
            $((stringify!($field), stringify!($new)),)*
        ];
    };
}
interp_state!(describe_boot_fields);

fn compact(source: &str) -> String {
    tokens(&code_only(source))
        .iter()
        .map(|token| token.text)
        .collect()
}

const FRESH_ORDER: &[&str] = &[
    "snapshot_dirt",
    "snapshot_baseline_identity",
    "stack",
    "locals",
    "id_map",
    "realm",
    "environment",
    "inactive_environments",
    "identity_roots",
    "restored_leases",
    "restored_environment_leases",
    "host_callbacks",
    "shared_compartments",
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
    "eval_direct",
    "code_segments",
    "active_segment",
    "top_level_code",
    "func_segments",
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
    "symbol_ids",
    "default_keys",
    "next_symbol_key_id",
    "installed_names_len",
    "installing_intrinsics",
    "id_space_exhausted",
    "last_crank_completed",
    "gc_failed",
    "symbol_names",
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
    "byte_length_id",
    "typed_arrays",
    "byte_offset_id",
    "buffer_id",
    "data_views",
    "dataview_proto",
    "size_id",
    "length_id",
    "name_id",
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
    "value_id",
    "done_id",
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
    "pending_rejections",
    "promise_jobs",
    "combinators",
    "from_async",
    "then_id",
    "constructor_id",
    "error_stack_accessor",
    "prototype_key_id",
    "regexps",
    "regexp_proto",
    "regexp_replace_method",
    "regexp_match_method",
    "regexp_match_all_method",
    "regexp_search_method",
    "regexp_split_method",
    "last_index_id",
    "regexp_getter_ids",
    "regexp_result_ids",
    "jumps",
];

#[test]
fn fresh_constructor_policies_cover_every_field_in_order() {
    let fields: Vec<_> = BOOT_FIELDS.iter().map(|(field, _)| *field).collect();
    // eval_direct previously preceded the code-segment cluster; its literal
    // initializer has no observable ordering dependency.
    assert_eq!(
        fields
            .iter()
            .filter(|f| **f != "eval_direct")
            .collect::<Vec<_>>(),
        FRESH_ORDER
            .iter()
            .filter(|f| **f != "eval_direct")
            .collect::<Vec<_>>()
    );
    assert_eq!(
        fields,
        INTERP_FIELDS
            .iter()
            .map(|(field, _)| *field)
            .collect::<Vec<_>>()
    );
}

fn check_wiring(source: &str) {
    let source = compact(source);
    for needle in [
        "#[boot_new($new:expr)]",
        "let $new_dirt = $d snapshot_dirt;",
        "let $slots = $d slots;",
        "let $chunks = $d chunks;",
        "let $global = $d global;",
        "let $static = $d strings;",
        "Interp { $($field: $new,)* }",
        "interp_state!(define_boot_initializers, $);",
        "boot_fresh!(snapshot_dirt, slots, chunks, global_obj, static_str)",
    ] {
        assert_eq!(source.matches(&compact(needle)).count(), 1, "{needle}");
    }
    assert!(!source.contains("boot_template"));
}

#[test]
fn fresh_constructor_emitter_forwards_owned_contexts() {
    let source = include_str!("../boot.rs");
    check_wiring(source);
    for needle in [
        "$($field: $new,)*",
        "let $slots = $d slots;",
        "let $chunks = $d chunks;",
        "let $global = $d global;",
        "let $static = $d strings;",
        "interp_state!(define_boot_initializers, $);",
        "boot_fresh!(snapshot_dirt, slots, chunks, global_obj, static_str)",
    ] {
        let mutated = source.replace(needle, "");
        assert_ne!(source, mutated, "mutation must match {needle}");
        assert!(
            std::panic::catch_unwind(|| check_wiring(&mutated)).is_err(),
            "missed {needle}"
        );
    }
}
