//! Source guard for W2: native builtin reservations must use admission helpers.
//! The anchors exclude bootstrap/restore and the standalone representation math.
const SOURCE: &str = concat!(
    include_str!("../src/interp.rs"),
    include_str!("../src/interp/metering.rs"),
    include_str!("../src/interp/native_ids.rs"),
    include_str!("../src/interp/snapshot_rows.rs"),
    include_str!("../src/interp/intl_data.rs"),
    include_str!("../src/interp/admission.rs"),
    include_str!("../src/interp/side_ledger.rs"),
    include_str!("../src/interp/apply.rs"),
    include_str!("../src/interp/code.rs"),
    include_str!("../src/interp/coerce.rs"),
    include_str!("../src/interp/enumerate.rs"),
    include_str!("../src/interp/environment.rs"),
    include_str!("../src/interp/errors.rs"),
    include_str!("../src/interp/eval.rs"),
    include_str!("../src/interp/frames.rs"),
    include_str!("../src/interp/host.rs"),
    include_str!("../src/interp/function.rs"),
    include_str!("../src/interp/invoke.rs"),
    include_str!("../src/interp/iterable.rs"),
    include_str!("../src/interp/render.rs"),
    include_str!("../src/interp/strings.rs"),
    include_str!("../src/interp/unwind.rs"),
    "\n",
    include_str!("../src/interp/dispatch.rs"),
    include_str!("../src/interp/dispatch/property_read.rs"),
    include_str!("../src/interp/dispatch/private.rs"),
    include_str!("../src/interp/dispatch/super_property.rs"),
    include_str!("../src/interp/dispatch/operators.rs"),
    include_str!("../src/interp/dispatch/environment.rs"),
    include_str!("../src/interp/dispatch/iteration.rs"),
    include_str!("../src/interp/dispatch/property_write.rs"),
    "\n",
    include_str!("../src/interp/boot.rs"),
    "\n",
    include_str!("../src/interp/state.rs"),
    "\n",
    include_str!("../src/interp/bigint.rs"),
    "\n",
    include_str!("../src/interp/temporal.rs"),
    "\n",
    include_str!("../src/interp/date.rs"),
    "\n",
    include_str!("../src/interp/locale.rs"),
    "\n",
    include_str!("../src/interp/text.rs"),
    "\n",
    include_str!("../src/interp/numeric.rs"),
    "\n",
    include_str!("../src/interp/gc.rs"),
    "\n",
    include_str!("../src/interp/suspend.rs"),
    "\n",
    include_str!("../src/interp/native_try.rs"),
    "\n",
    include_str!("../src/interp/natives/regexp.rs"),
    "\n",
    include_str!("../src/interp/natives/resource.rs"),
    "\n",
    include_str!("../src/interp/natives/reflect.rs"),
    "\n",
    include_str!("../src/interp/natives/bigint.rs"),
    "\n",
    include_str!("../src/interp/natives/number.rs"),
    "\n",
    include_str!("../src/interp/natives/string.rs"),
    "\n",
    include_str!("../src/interp/natives/collection.rs"),
    "\n",
    include_str!("../src/interp/natives/date.rs"),
    "\n",
    include_str!("../src/interp/natives/temporal.rs"),
    "\n",
    include_str!("../src/interp/natives/intl.rs"),
    "\n",
    include_str!("../src/interp/natives/promise.rs"),
    "\n",
    include_str!("../src/interp/natives/buffer.rs"),
    "\n",
    include_str!("../src/interp/natives/array.rs"),
    "\n",
    include_str!("../src/interp/natives/dispatch.rs"),
    "\n",
    include_str!("../src/interp/natives/json.rs"),
    "\n",
    include_str!("../src/interp/property.rs"),
    include_str!("../src/interp/property/descriptors.rs"),
    include_str!("../src/interp/property/indexed.rs"),
    include_str!("../src/interp/property/integrity.rs"),
    include_str!("../src/interp/property/keys.rs"),
    include_str!("../src/interp/property/object.rs"),
    include_str!("../src/interp/property/ordinary.rs"),
    include_str!("../src/interp/property/proxy.rs"),
    include_str!("../src/interp/property/read_index.rs"),
    "\n",
    include_str!("../src/interp/link.rs"),
    "\n",
    include_str!("../src/interp/persist.rs"),
);

fn method_in(source: &str, name: &str) -> String {
    let source = code_only(source);
    let code = tokens(&source);
    let body = token_body(&code, &format!("fn {name}"));
    let start = code[body.start].start;
    let end = code[body.end - 1].start + 1;
    source[start..end].to_owned()
}

fn method(name: &str) -> String {
    method_in(SOURCE, name)
}

#[test]
fn method_anchors_survive_visibility_and_nested_bodies() {
    for visibility in [
        "",
        "pub ",
        "pub(super) ",
        "pub(crate) ",
        "pub(in crate::interp) ",
    ] {
        let source = format!(
            "// Unicode comment: λ {{ }}\nimpl Interp {{ {visibility}fn target() {{ if true {{ admitted(); }} }} \
             pub(super) fn neighbor() {{ raw_growth(); }} }}"
        );
        let body = method_in(&source, "target");
        assert!(body.contains("admitted()"));
        assert!(!body.contains("raw_growth"));
        assert!(body.ends_with("}"));
    }
}

fn check_builtin_capacities(moved_modules: &[&str]) {
    // Exact method enrollment from the former call_native..concat_add span.
    // Follow declarations across modules rather than relying on file order.
    // Only immutable baseline text is cached; every mutation snippet below
    // is checked afresh. This keeps the expanded source audit inexpensive.
    static ORIGINAL_METHODS: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    let original_methods = ORIGINAL_METHODS.get_or_init(|| {
        let source_code = code_only(SOURCE);
        let source_tokens = tokens(&source_code);
        [
            "call_native",
            "slot_from_number",
            "instance_put_raw",
            "is_callable_value",
            "is_constructor_value",
            "slot_is_constructor",
            "slot_is_callable",
            "array_from_try",
            "call_any",
            "call_any_catching_throw",
            "invoke_value_method",
            "to_length_value",
            "capture_error_frames",
            "build_error",
            "build_native_error",
            "install_error_cause",
            "internal_error",
            "id_name",
            "build_suppressed_error",
            "build_aggregate_error",
            "aggregate_error_elements",
            "make_bound_function",
            "box_primitive_to_instance",
            "box_primitive_wrapper",
            "box_object_primitive",
            "build_wrapper",
            "set_own_unmetered",
            "set_own_unmetered_with_flag",
            "set_own_accessor_unmetered",
            "needs_abstract_call",
            "call_dot_call_native",
            "call_dot_apply_native",
            "enter_call_dot_call",
            "enter_call_dot_apply",
            "enter_construct_bound",
            "error_to_string",
            "value_to_scalar_text",
            "call_native_method",
            "arraylike_to_vec",
            "apply_arraylike_metering",
            "iterable_to_list",
            "iterable_to_list_inner",
            "new_string_metered",
            "new_string_units",
            "to_string_units",
            "to_string_slot",
            "catchable_range_error_msg",
            "to_property_key_slot",
            "make_enumerator",
            "for_in_level_keys",
            "own_enumeration_keys",
            "enumerator_next",
            "chain_resolves_native_data_method",
            "strict_equal",
            "same_value_zero",
            "set_data_on_receiver",
            "arg_to_byte_length",
            "to_index_arg",
            "arg_to_index",
            "end_completion",
            "leave_call",
            "unwind_to_jump",
            "raise_js",
            "catchable_type_error_msg",
            "catchable_syntax_error",
            "catchable_syntax_error_with_message",
            "meter_host_escape",
            "unmeter_host_escape",
            "closure_index",
            "closure_cell",
            "sloppy_argument_cells",
            "repoint_closure",
            "write_closure_cell",
            "retrieve_closures",
            "store_closure",
            "append_environment_capture",
            "append_module_closure",
            "bind_program_this",
            "run_constructor",
            "bind_this_sloppy",
            "invoke_value",
            "construct_value",
            "run_callback_construct",
            "new_environment_instance",
            "is_scopable_slot",
            "is_environment_instance",
            "environment_property",
            "environment_get",
            "environment_set",
            "resolve_env_reference",
            "has_lexical_env_binding",
            "local_operand",
            "local_index",
            "get_local",
            "set_local",
            "resolve_frame_get",
            "resolve_set",
            "truthy",
            "binary_arith",
            "binary_bit",
            "relational",
            "equality",
            "call_primitive_method",
            "to_primitive",
            "to_primitive_default",
            "to_primitive_with_hint",
            "ordinary_to_primitive",
            "to_number_value",
            "to_numeric_integer_value",
            "to_number_f64",
            "op_add",
        ]
        .map(|name| {
            let body = token_body(&source_tokens, &format!("fn {name}"));
            let start = source_tokens[body.start].start;
            let end = source_tokens[body.end - 1].start + 1;
            &source_code[start..end]
        })
        .join("\n")
    });
    for builtins in std::iter::once(original_methods.as_str()).chain(moved_modules.iter().copied())
    {
        for (line, text) in builtins.lines().enumerate() {
            if text.contains("Vec::with_capacity") {
                assert_eq!(
                    text.trim(),
                    "let mut units = Vec::with_capacity(8);",
                    "raw builtin reservation at relative line {}",
                    line + 1
                );
            }
        }
        // Catch the other explicit capacity spelling, including multiline macros.
        for suffix in builtins.split("vec![").skip(1) {
            let expression = suffix.split(']').next().unwrap();
            assert!(
                !expression.contains(';'),
                "sized vec! bypasses admission: {expression}"
            );
        }
    }
}

// These coercions were inside the parent call_native..concat_add audit span.
// The representation routines that follow them in the child were outside it;
// keep that original boundary while retaining the whole child in SOURCE.
fn bigint_builtin_coercions(source: &str) -> String {
    ["to_bigint_low64", "slot_to_bigint_u64"]
        .map(|name| method_in(source, name))
        .join("\n")
}

// concat_add was outside the original audited interval. Keep its existing
// reservation exemption narrow while covering every other string helper.
fn strings_without_concat(source: &str) -> String {
    let mut source = code_only(source);
    let code = tokens(&source);
    let body = token_body(&code, "fn concat_add");
    let range = code[body.start].start..code[body.end - 1].start + 1;
    source.replace_range(range, "{}");
    source
}

#[test]
fn execution_children_keep_allocation_admission() {
    for original in [
        include_str!("../src/interp/admission.rs"),
        include_str!("../src/interp/dispatch/property_read.rs"),
        include_str!("../src/interp/dispatch/private.rs"),
        include_str!("../src/interp/dispatch/super_property.rs"),
        include_str!("../src/interp/dispatch/operators.rs"),
        include_str!("../src/interp/dispatch/environment.rs"),
        include_str!("../src/interp/dispatch/iteration.rs"),
        include_str!("../src/interp/dispatch/property_write.rs"),
        include_str!("../src/interp/apply.rs"),
        include_str!("../src/interp/code.rs"),
        include_str!("../src/interp/coerce.rs"),
        include_str!("../src/interp/enumerate.rs"),
        include_str!("../src/interp/environment.rs"),
        include_str!("../src/interp/errors.rs"),
        include_str!("../src/interp/eval.rs"),
        include_str!("../src/interp/frames.rs"),
        include_str!("../src/interp/function.rs"),
        include_str!("../src/interp/invoke.rs"),
        include_str!("../src/interp/iterable.rs"),
        include_str!("../src/interp/render.rs"),
        include_str!("../src/interp/unwind.rs"),
        &strings_without_concat(include_str!("../src/interp/strings.rs")),
    ] {
        check_builtin_capacities(&[original]);
        let anchor = "impl Interp {";
        assert!(original.contains(anchor));
        for allocation in [
            "let raw = Vec::with_capacity(guest);",
            "let raw = vec![0; guest];",
        ] {
            let injected = format!("{anchor} fn allocation_probe(guest: usize) {{ {allocation} }}");
            let mutated = original.replacen(anchor, &injected, 1);
            assert_ne!(original, mutated);
            assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
        }
    }
}

#[test]
fn native_builtins_do_not_reserve_raw_guest_capacities() {
    check_builtin_capacities(&[
        include_str!("../src/interp/natives/regexp.rs"),
        include_str!("../src/interp/admission.rs"),
        include_str!("../src/interp/side_ledger.rs"),
        include_str!("../src/interp/dispatch/property_read.rs"),
        include_str!("../src/interp/dispatch/private.rs"),
        include_str!("../src/interp/dispatch/super_property.rs"),
        include_str!("../src/interp/dispatch/operators.rs"),
        include_str!("../src/interp/dispatch/environment.rs"),
        include_str!("../src/interp/dispatch/iteration.rs"),
        include_str!("../src/interp/dispatch/property_write.rs"),
        include_str!("../src/interp/apply.rs"),
        include_str!("../src/interp/code.rs"),
        include_str!("../src/interp/coerce.rs"),
        include_str!("../src/interp/enumerate.rs"),
        include_str!("../src/interp/environment.rs"),
        include_str!("../src/interp/errors.rs"),
        include_str!("../src/interp/eval.rs"),
        include_str!("../src/interp/frames.rs"),
        include_str!("../src/interp/function.rs"),
        include_str!("../src/interp/invoke.rs"),
        include_str!("../src/interp/iterable.rs"),
        include_str!("../src/interp/render.rs"),
        include_str!("../src/interp/unwind.rs"),
        &strings_without_concat(include_str!("../src/interp/strings.rs")),
        include_str!("../src/interp/natives/resource.rs"),
        include_str!("../src/interp/natives/reflect.rs"),
        &bigint_builtin_coercions(include_str!("../src/interp/natives/bigint.rs")),
        include_str!("../src/interp/natives/number.rs"),
        include_str!("../src/interp/natives/string.rs"),
        include_str!("../src/interp/natives/collection.rs"),
        include_str!("../src/interp/natives/date.rs"),
        include_str!("../src/interp/natives/temporal.rs"),
        include_str!("../src/interp/natives/intl.rs"),
        include_str!("../src/interp/natives/promise.rs"),
        include_str!("../src/interp/natives/buffer.rs"),
        include_str!("../src/interp/natives/array.rs"),
        include_str!("../src/interp/natives/dispatch.rs"),
        include_str!("../src/interp/natives/json.rs"),
        include_str!("../src/interp/property.rs"),
        include_str!("../src/interp/property/descriptors.rs"),
        include_str!("../src/interp/property/indexed.rs"),
        include_str!("../src/interp/property/integrity.rs"),
        include_str!("../src/interp/property/keys.rs"),
        include_str!("../src/interp/property/object.rs"),
        include_str!("../src/interp/property/ordinary.rs"),
        include_str!("../src/interp/property/proxy.rs"),
        include_str!("../src/interp/property/read_index.rs"),
    ]);
}

#[test]
fn moved_regexp_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/regexp.rs");
    let anchor = "self.charge_and_check(0)?;";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let mutated = original.replacen(anchor, allocation, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_resource_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/resource.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_reflect_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/reflect.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_bigint_methods_cannot_bypass_allocation_admission() {
    let original = code_only(include_str!("../src/interp/natives/bigint.rs"));
    check_builtin_capacities(&[&bigint_builtin_coercions(&original)]);
    for name in ["to_bigint_low64", "slot_to_bigint_u64"] {
        let body = method_in(&original, name);
        for allocation in [
            "let raw = Vec::with_capacity(guest);",
            "let raw = vec![0; guest];",
        ] {
            let injected = body.replacen('{', &format!("{{ {allocation}"), 1);
            let mutated = original.replacen(&body, &injected, 1);
            assert_ne!(mutated, original);
            assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[
                &bigint_builtin_coercions(&mutated)
            ]))
            .is_err());
        }
    }
}

#[test]
fn moved_number_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/number.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_string_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/string.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_collection_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/collection.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_date_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/date.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_temporal_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/temporal.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_intl_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/intl.rs");
    let anchor = "impl Interp {";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let injected = format!(
            "{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}"
        );
        let mutated = original.replacen(anchor, &injected, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_promise_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/promise.rs");
    let anchor = "self.meter.tick_builtin();";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let mutated = original.replacen(anchor, allocation, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_buffer_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/buffer.rs");
    let anchor = "let mut bytes = Self::reserved_vec(byte_length as usize)?;";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let mutated = original.replacen(anchor, allocation, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_array_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/array.rs");
    let anchor = "self.meter.tick_builtin();";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let mutated = original.replacen(anchor, allocation, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_native_dispatch_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/dispatch.rs");
    let anchor = "self.cost.on_builtin(m);";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let mutated = original.replacen(anchor, allocation, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_json_methods_cannot_bypass_allocation_admission() {
    let original = include_str!("../src/interp/natives/json.rs");
    let anchor = "self.json_reserve_output(state, size as u64)?;";
    assert!(original.contains(anchor));
    for allocation in [
        "let raw = Vec::with_capacity(guest);",
        "let raw = vec![0; guest];",
    ] {
        let mutated = original.replacen(anchor, allocation, 1);
        assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
    }
}

#[test]
fn moved_property_methods_cannot_bypass_allocation_admission() {
    for original in [
        include_str!("../src/interp/property/descriptors.rs"),
        include_str!("../src/interp/property/indexed.rs"),
        include_str!("../src/interp/property/integrity.rs"),
        include_str!("../src/interp/property/keys.rs"),
        include_str!("../src/interp/property/object.rs"),
        include_str!("../src/interp/property/ordinary.rs"),
        include_str!("../src/interp/property/proxy.rs"),
        include_str!("../src/interp/property/read_index.rs"),
    ] {
        let anchor = "impl Interp {";
        assert!(original.contains(anchor));
        check_builtin_capacities(&[original]);
        for allocation in [
            "let raw = Vec::with_capacity(guest);",
            "let raw = vec![0; guest];",
        ] {
            let injected = format!("{anchor} fn allocation_probe(guest: usize) {{ {allocation} let _: Vec<u8> = raw; }}");
            let mutated = original.replacen(anchor, &injected, 1);
            assert_ne!(original, mutated);
            assert!(std::panic::catch_unwind(|| check_builtin_capacities(&[&mutated])).is_err());
        }
    }
}

#[test]
fn replacement_output_growth_uses_admission() {
    for name in [
        "string_plain_substitution",
        "string_replace_plain",
        "string_replace_all_plain",
        "string_replace",
        "regexp_replace_generic",
        "regexp_generic_substitution",
        "regexp_get_substitution",
    ] {
        let body = method(name);
        assert!(
            body.contains("extend_work_scratch"),
            "{name} lost growth admission"
        );
        for output in ["out", "assembled", "results", "positions"] {
            for operation in ["push", "extend", "resize", "reserve"] {
                assert!(
                    !body.contains(&format!("{output}.{operation}")),
                    "{name} grows {output} without admission"
                );
            }
        }
    }
}

#[test]
fn named_allocation_paths_keep_the_shared_admission_seam() {
    for (name, seam) in [
        ("alloc_array_buffer", "charge_and_check"),
        ("array_sort", "reserve_scratch"),
        ("typed_array_sort", "reserve_work_scratch"),
        ("json_reserve_output", "reserve_units_growth"),
    ] {
        assert!(method(name).contains(seam), "{name} lost {seam}");
    }
}

use ironhorse_vm::source_scan::{
    code_only, matching_delimiter, token_body, token_positions, tokens, Token,
};

fn raw_variable_charges(code: &[Token<'_>]) -> usize {
    token_positions(code, "tick_builtin_some(")
        .into_iter()
        .filter(|&at| {
            let open = at + 1;
            let close = matching_delimiter(code, open);
            close != open + 2 || code[open + 1].text.parse::<u64>().is_err()
        })
        .count()
}

#[test]
fn guest_quantity_charges_cannot_bypass_admission() {
    let source = code_only(SOURCE);
    let code = tokens(&source);
    assert_eq!(raw_variable_charges(&code), 0);
    for sample in [
        "self.meter.tick_builtin_some(n);",
        "self . meter /* c */ . tick_builtin_some (n as u64);",
        "self.meter.tick_builtin_some(length * 10);",
    ] {
        assert_eq!(raw_variable_charges(&tokens(&code_only(sample))), 1);
    }
}

#[test]
fn conversion_helpers_keep_output_admission() {
    let source = code_only(SOURCE);
    let code = tokens(&source);
    for (name, seam) in [
        ("unicode_case_convert_utf16", "reserve_units("),
        ("unicode_normalize_utf16", "extend_reserved_units("),
        ("unicode_locale_case_convert_utf16", "reserve_scratch("),
    ] {
        let body = &code[token_body(&code, &format!("fn {name}"))];
        assert!(
            !token_positions(body, seam).is_empty(),
            "{name} lost admission"
        );
        assert!(
            token_positions(body, "with_capacity(").is_empty(),
            "{name} added raw scratch"
        );
    }
    let native = &code[token_body(&code, "fn call_string(")];
    let concat = &native[token_body(native, "StringConcat =>")];
    assert!(!token_positions(concat, "extend_reserved_units(").is_empty());
    assert!(token_positions(concat, "content.clone(").is_empty());
    assert!(token_positions(concat, "out.extend_from_slice(").is_empty());
}

#[test]
fn parser_and_collection_paths_keep_incremental_admission() {
    for (name, seam) in [
        ("arraylike_to_vec", "reserve_work_scratch"),
        ("iterable_to_list_inner", "push_prepaid_scratch"),
        ("json_parse_array_element", "admit_scratch::<Slot>"),
        (
            "json_parse_object_member",
            "admit_scratch::<(ReadKey, Slot)>",
        ),
        ("json_parse_string_units", "push_prepaid_scratch"),
        ("mop_own_keys_inner", "push_prepaid_scratch"),
    ] {
        assert!(method(name).contains(seam), "{name} lost {seam}");
    }
    assert!(
        !method("json_parse_string_units").contains("&input[i..]"),
        "decoding each scalar must not revalidate the entire remaining string"
    );
}

/// A Proxy `apply` trap's argument list is reserved fallibly
/// (`invoke_proxy_turn`). A bytecode trap receives it through
/// `run_user_callback`, which must push it onto the stack, and `enter_call`,
/// which must reserve the callee's copy fallibly: an allocation whose
/// failure aborts the host on either step would undo the first.
#[test]
fn every_call_path_copies_a_frames_arguments_fallibly() {
    // The bound call, the Proxy call and construct, the bound native
    // construct and the host call each copy the frame's arguments before
    // re-dispatching. Each goes through one fallible copy, and the argument
    // list a Proxy call's `apply` trap receives is reserved fallibly too.
    assert!(method("frame_arguments").contains("reserved_vec("));
    assert!(method("proxy_run_step").contains("reserved_vec("));
    assert!(!method("proxy_run_step").contains(".to_vec()"));
    for name in [
        "exec_run",
        "bound_call",
        "proxy_run_call",
        "construct_bound_native",
        "call_host",
    ] {
        let body = method(name);
        assert!(
            body.contains("frame_arguments("),
            "{name} no longer copies through frame_arguments"
        );
        assert!(
            !body.contains(".to_vec()"),
            "{name} copies a list with .to_vec()"
        );
    }
}

#[test]
fn a_callback_frame_is_pushed_without_an_infallible_copy() {
    assert!(method("invoke_proxy_turn").contains("reserved_vec("));
    assert!(method("enter_call").contains("reserved_vec("));
    for name in ["run_user_callback", "enter_call"] {
        let body = method(name);
        for copy in [".to_vec()", ".collect", "Vec::with_capacity", "vec!["] {
            assert!(
                !body.contains(copy),
                "{name} copies its arguments with {copy}"
            );
        }
    }
}

// B7/B8: retained side storage (array items, index properties, collection
// entries, `%Segments%` objects) is charged against the chunk ceiling as it
// grows and released as it shrinks, and the guest-amplified host copies
// (`join` and `toLocaleString` results, a `ListFormat` result, a `Function`
// source) are bounded by it before they grow. Each row names a function and
// the seam its body must call; `side_storage_seams_cannot_be_removed` shows
// the check fails when any one of them is taken out.
const BULK: &str = include_str!("../src/bulk.rs");
const VALUE: &str = include_str!("../src/value.rs");
const GC: &str = include_str!("../src/interp/gc.rs");
const PERSIST: &str = include_str!("../src/interp/persist.rs");
const NATIVE_DISPATCH: &str = include_str!("../src/interp/natives/dispatch.rs");

const SIDE_STORAGE_SEAMS: &[(&str, &str, &str)] = &[
    ("bulk", "fn insert_item", "reserve_side("),
    ("bulk", "fn remove_item", "release_side("),
    ("bulk", "fn clear_items", "release_side("),
    ("bulk", "fn replace_items", "reserve_side("),
    ("bulk", "fn replace_items", "release_side("),
    ("bulk", "fn push_entry", "reserve_side("),
    ("bulk", "fn push_entry", "grow_for_push("),
    ("bulk", "fn remove_entry", "release_side("),
    ("bulk", "fn remove_entry", "compact("),
    ("bulk", "fn clear_entries", "release_side("),
    ("value", "fn can_allocate", "footprint_fits("),
    ("value", "fn footprint_fits", "side_reserved"),
    ("gc", "fn collect_garbage", "rederive_side_reserved("),
    ("gc", "fn free_pages", "rederive_side_reserved("),
    (
        "persist",
        "fn restore_snapshot_state",
        "rederive_side_reserved(",
    ),
    (
        "persist",
        "fn restore_bulk_side_tables",
        "rederive_side_reserved(",
    ),
    ("persist", "fn restore_intl", "rederive_side_reserved("),
    ("interp", "fn admitted_segments", "try_reserve_side("),
    ("interp", "fn typed_array_join", "extend_admitted_copy("),
    (
        "interp",
        "fn typed_array_to_locale_string",
        "extend_admitted_copy(",
    ),
    (
        "interp",
        "fn array_to_locale_string",
        "extend_admitted_copy(",
    ),
    (
        "interp",
        "fn create_dynamic_function",
        "extend_admitted_copy(",
    ),
    ("interp", "fn index_prop_store", "&mut self.chunks"),
    ("interp", "fn typed_array_map_filter", "admit_transient("),
    ("interp", "fn call_set_method", "admit_transient("),
    ("interp", "fn call_group_by", "admit_transient("),
    (
        "dispatch",
        "NativeMethod::ListFormatFormat | NativeMethod::ListFormatFormatToParts =>",
        "admit_copy_units(",
    ),
    (
        "dispatch",
        "NativeMethod::SegmenterSegment =>",
        "admitted_segments(",
    ),
];

/// The outputs these functions build may only grow through an admitted
/// extend; a raw `push`/`extend` on them would bypass the ceiling.
const ADMITTED_OUTPUTS: &[(&str, &str)] = &[
    ("fn typed_array_join", "out"),
    ("fn typed_array_to_locale_string", "out"),
    ("fn array_to_locale_string", "out"),
    ("fn create_dynamic_function", "source"),
];

/// The bodies the side-storage checks read, keyed by source and marker.
type SideStorageBodies = std::collections::BTreeMap<(&'static str, &'static str), String>;

const SIDE_STORAGE_SOURCES: [(&str, &str); 6] = [
    ("interp", SOURCE),
    ("bulk", BULK),
    ("value", VALUE),
    ("gc", GC),
    ("persist", PERSIST),
    ("dispatch", NATIVE_DISPATCH),
];

/// Tokenizes each source once and cuts out every body the checks read.
/// `SOURCE` is the whole interpreter; tokenizing it again for each seam and
/// each mutation took minutes in a debug build.
fn side_storage_bodies() -> SideStorageBodies {
    let mut bodies = SideStorageBodies::new();
    for (label, source) in SIDE_STORAGE_SOURCES {
        let mut markers: Vec<&'static str> = SIDE_STORAGE_SEAMS
            .iter()
            .filter(|&&(name, _, _)| name == label)
            .map(|&(_, marker, _)| marker)
            .collect();
        if label == "interp" {
            markers.extend(ADMITTED_OUTPUTS.iter().map(|&(marker, _)| marker));
            markers.push("fn list_element_string");
        }
        let source = code_only(source);
        let code = tokens(&source);
        for marker in markers {
            let body = token_body(&code, marker);
            let start = code[body.start].start;
            let end = code[body.end - 1].start + 1;
            bodies.insert((label, marker), source[start..end].to_owned());
        }
    }
    bodies
}

/// `bulk` is `bulk.rs` with comments and literals removed.
fn check_side_storage_seams(bodies: &SideStorageBodies, bulk: &str) {
    for &(label, marker, seam) in SIDE_STORAGE_SEAMS {
        assert!(
            bodies[&(label, marker)].contains(seam),
            "{marker} lost {seam}"
        );
    }
    for &(marker, output) in ADMITTED_OUTPUTS {
        let body = &bodies[&("interp", marker)];
        for operation in ["push", "extend", "extend_from_slice", "resize", "reserve"] {
            assert!(
                !body.contains(&format!("{output}.{operation}(")),
                "{marker} grows {output} without admission"
            );
        }
    }
    // A `ListFormat` element is kept by reference, never copied while the
    // list is still being collected.
    let element = &bodies[&("interp", "fn list_element_string")];
    assert!(!element.contains("str_units("), "list elements are copied");
    // The tables stay private, so every mutation goes through the counted
    // methods above.
    for field in [
        "items: std::collections::BTreeMap",
        "entries: Vec<CollEntry>",
    ] {
        assert!(bulk.contains(&format!("    {field}")), "{field} moved");
        assert!(
            !bulk.contains(&format!("pub(crate) {field}")),
            "{field} became visible outside bulk.rs"
        );
    }
}

#[test]
fn side_storage_growth_keeps_its_admission() {
    check_side_storage_seams(&side_storage_bodies(), &code_only(BULK));
}

/// Each mutation edits the extracted body, which is what extracting it from
/// the edited source would return.
#[test]
fn side_storage_seams_cannot_be_removed() {
    let bodies = side_storage_bodies();
    let bulk = code_only(BULK);
    for &(label, marker, seam) in SIDE_STORAGE_SEAMS {
        let mut mutated = bodies.clone();
        let body = mutated.get_mut(&(label, marker)).unwrap();
        // Keep the delimiters balanced, so only the missing seam can fail.
        let raw = if seam.ends_with('(') {
            "raw_growth("
        } else {
            "raw_growth"
        };
        let removed = body.replace(seam, raw);
        assert_ne!(*body, removed, "{marker}: {seam}");
        *body = removed;
        assert!(
            std::panic::catch_unwind(|| check_side_storage_seams(&mutated, &bulk)).is_err(),
            "removing {seam} from {marker} went unnoticed"
        );
    }
    for &(marker, output) in ADMITTED_OUTPUTS {
        let mut mutated = bodies.clone();
        let body = mutated.get_mut(&("interp", marker)).unwrap();
        let grown = body.replacen('{', &format!("{{ {output}.push(guest);"), 1);
        assert_ne!(*body, grown);
        *body = grown;
        assert!(
            std::panic::catch_unwind(|| check_side_storage_seams(&mutated, &bulk)).is_err(),
            "a raw {output}.push in {marker} went unnoticed"
        );
    }
    for field in [
        "items: std::collections::BTreeMap",
        "entries: Vec<CollEntry>",
    ] {
        let exposed = bulk.replacen(
            &format!("    {field}"),
            &format!("    pub(crate) {field}"),
            1,
        );
        assert_ne!(bulk, exposed);
        assert!(
            std::panic::catch_unwind(|| check_side_storage_seams(&bodies, &exposed)).is_err(),
            "exposing {field} went unnoticed"
        );
    }
}
