//! Source guard for W2: native builtin reservations must use admission helpers.
//! The anchors exclude bootstrap/restore and the standalone representation math.
const SOURCE: &str = include_str!("../src/interp.rs");

fn method(name: &str) -> &str {
    let start = SOURCE
        .find(&format!("    fn {name}("))
        .expect("method anchor exists");
    let body = &SOURCE[start..];
    let end = body[5..]
        .find("\n    fn ")
        .map(|n| n + 5)
        .unwrap_or(body.len());
    &body[..end]
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
