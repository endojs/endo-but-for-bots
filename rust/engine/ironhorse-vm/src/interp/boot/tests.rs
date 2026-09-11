#![cfg(test)]
//! Independent constructor order and emitter checks for the interpreter roster.
use super::*;
use crate::source_scan::{code_only, token_body, tokens};

macro_rules! describe_boot_fields {
    (() $vis:vis struct $name:ident {
        $(#[boot_new($new:expr)]
          #[boot_template($template:expr)]
          $(#[$attr:meta])* $field_vis:vis $field:ident: $ty:ty,)*
    } boot_context { $($context:tt)* } external_tables { $($external:tt)* }) => {
        const BOOT_FIELDS: &[(&str, &str, &str)] = &[
            $((stringify!($field), stringify!($new), stringify!($template)),)*
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

// Captured from the handwritten template constructor before generation.
const TEMPLATE_ORDER: &[&str] = &[
    "snapshot_dirt",
    "snapshot_baseline_identity",
    "stack",
    "locals",
    "id_map",
    "global_obj",
    "global_props",
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
    "source_compiler",
    "intrinsic_permit",
    "code_segments",
    "active_segment",
    "top_level_code",
    "func_segments",
    "eval_direct",
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
    "unhandled_rejection",
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

// Captured independently from the handwritten fresh constructor.
const FRESH_ORDER: &[&str] = &[
    "snapshot_dirt",
    "snapshot_baseline_identity",
    "stack",
    "locals",
    "id_map",
    "global_obj",
    "global_props",
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
    "source_compiler",
    "intrinsic_permit",
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
    "unhandled_rejection",
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
fn constructor_policies_cover_every_field_and_preserve_evaluation_order() {
    let fields: Vec<_> = BOOT_FIELDS.iter().map(|(field, _, _)| *field).collect();
    assert_eq!(fields, TEMPLATE_ORDER);
    assert_eq!(
        fields,
        INTERP_FIELDS
            .iter()
            .map(|(field, _)| *field)
            .collect::<Vec<_>>()
    );
    // The old fresh constructor evaluated this boolean literal before the four
    // code-segment fields. Moving a literal has no observable evaluation effect;
    // every other expression retains its original relative order.
    assert_eq!(
        fields
            .iter()
            .filter(|name| **name != "eval_direct")
            .collect::<Vec<_>>(),
        FRESH_ORDER
            .iter()
            .filter(|name| **name != "eval_direct")
            .collect::<Vec<_>>()
    );
    let eval = BOOT_FIELDS
        .iter()
        .find(|(field, _, _)| *field == "eval_direct")
        .unwrap();
    assert_eq!(compact(eval.1), "false");
    assert_eq!(compact(eval.2), "state.eval_direct");
}

fn check_wiring(source: &str) {
    let clean = code_only(source);
    let code = tokens(&clean);
    let emitter = &code[token_body(&code, "macro_rules! define_boot_initializers")];
    let once = |haystack: &[crate::source_scan::Token<'_>], needle: &str| {
        let needle = tokens(needle);
        assert_eq!(
            haystack
                .windows(needle.len())
                .filter(|window| window.iter().zip(&needle).all(|(a, b)| a.text == b.text))
                .count(),
            1,
            "missing or duplicated wiring: {needle:?}"
        );
    };
    for needle in [
        "#[boot_new($new:expr)] #[boot_template($template:expr)]",
        "fresh($new_dirt:ident, $slots:ident, $chunks:ident, $global:ident, $static:ident);",
        "template($state:ident, $snapshot_dirt:ident, $refs:ident, $arrays:ident, $indexed:ident, $collections:ident);",
        "let $new_dirt = $d snapshot_dirt; let $slots = $d slots; let $chunks = $d chunks; let $global = $d global; let $static = $d strings; Interp { $($field: $new,)* }",
        "let $state = $d state; let $snapshot_dirt = $d snapshot_dirt; let $refs = $d refs; let $arrays = $d arrays; let $indexed = $d indexed; let $collections = $d collections; Interp { $($field: $template,)* }",
    ] { once(emitter, needle); }
    once(&code, "interp_state!(define_boot_initializers, $);");
    let fresh = &code[token_body(&code, "pub fn new() -> Interp")];
    once(fresh, "let mut interp = boot_fresh!(snapshot_dirt, slots, chunks, global_obj, static_str); interp.create_intrinsics(); interp.boot_slot_count = interp.slots.capacity(); interp");
    let template = &code[token_body(&code, "pub(crate) fn instantiate(&self) -> Interp")];
    once(
        template,
        "boot_template!(state, snapshot_dirt, side_refs, arrays, index_props, collections)",
    );
}

#[test]
fn constructor_emitter_forwards_policies_and_owned_contexts() {
    let source = include_str!("../boot.rs");
    check_wiring(source);
    for (before, after) in [
        ("$($field: $new,)*", "$($field: Default::default(),)*"),
        ("$($field: $template,)*", "$($field: $new,)*"),
        (
            "let $snapshot_dirt = $d snapshot_dirt;",
            "let $snapshot_dirt = SnapshotDirt::default();",
        ),
        ("let $refs = $d refs;", "let $refs = SideRefCounts::new();"),
        (
            "let $indexed = $d indexed;",
            "let $indexed = Default::default();",
        ),
        ("interp_state!(define_boot_initializers, $);", ""),
        (
            "boot_fresh!(snapshot_dirt, slots, chunks, global_obj, static_str)",
            "Interp::default()",
        ),
        (
            "boot_template!(\n            state,\n            snapshot_dirt,\n            side_refs,\n            arrays,\n            index_props,\n            collections\n        )",
            "Interp::new()",
        ),
    ] {
        let mutated = source.replace(before, after);
        assert_ne!(source, mutated, "mutation must match {before}");
        assert!(
            std::panic::catch_unwind(|| check_wiring(&mutated)).is_err(),
            "missed {before}"
        );
    }
}

#[test]
fn template_instances_keep_independent_trackers_and_baselines() {
    let template = BootTemplate::new(&[], None);
    let mut first = template.instantiate();
    let mut second = template.instantiate();
    assert_eq!(
        first.derive_boot_fingerprint(),
        template.inner.derive_boot_fingerprint()
    );
    assert_eq!(
        second.derive_boot_fingerprint(),
        first.derive_boot_fingerprint()
    );
    let first_baseline = first.acknowledge_snapshot();
    let second_baseline = second.acknowledge_snapshot();
    template.inner.snapshot_dirt.clear();
    first.dates.insert(first.global_obj, 123.0);
    assert!(first
        .snapshot_dirty_sections(&first_baseline)
        .contains(SnapshotSection::Dates));
    assert!(!second
        .snapshot_dirty_sections(&second_baseline)
        .contains(SnapshotSection::Dates));
    assert!(!template
        .inner
        .snapshot_dirt
        .snapshot()
        .contains(SnapshotSection::Dates));
    assert!(!second.dates.contains_key(&first.global_obj));
    assert!(!template.inner.dates.contains_key(&first.global_obj));
    // An acknowledgement from another instance cannot clear or hide changes.
    assert!(second
        .snapshot_dirty_sections(&first_baseline)
        .contains(SnapshotSection::Dates));
}
