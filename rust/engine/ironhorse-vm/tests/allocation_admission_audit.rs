//! Source guard for W2: native builtin reservations must use admission helpers.
//! The anchors exclude bootstrap/restore and the standalone representation math.
const SOURCE: &str = concat!(
    include_str!("../src/interp.rs"),
    "\n",
    include_str!("../src/interp/dispatch.rs"),
    "\n",
    include_str!("../src/interp/boot.rs"),
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
);

fn method_in(source: &str, name: &str) -> String {
    let source = code_only(source);
    let code = tokens(&source);
    let body = token_body(&code, &format!("fn {name}("));
    let start = code[body.start].start;
    let end = code[body.end - 1].start + 1;
    source[start..end].to_owned()
}

fn method(name: &str) -> String {
    method_in(SOURCE, name)
}

#[test]
fn method_anchors_survive_visibility_and_nested_bodies() {
    for visibility in ["", "pub ", "pub(super) ", "pub(crate) "] {
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

#[test]
fn native_builtins_do_not_reserve_raw_guest_capacities() {
    let start = SOURCE.find("    fn call_native(").unwrap();
    let end = SOURCE.find("    fn concat_add(").unwrap();
    let builtins = &SOURCE[start..end];
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
        let body = &code[token_body(&code, &format!("fn {name}("))];
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
        ("json_parse_array", "admit_scratch::<Slot>"),
        ("json_parse_object", "admit_scratch::<(ReadKey, Slot)>"),
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
