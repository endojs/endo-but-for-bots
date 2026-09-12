//! The stored-key diagnostic keeps its historical, narrower holder set.
use ironhorse_vm::diagnostics::RUNTIME_KEY_HOLDER_SOURCE;
use ironhorse_vm::source_scan::{code_only, token_body, tokens};

fn compact(source: &str) -> String {
    let source = code_only(source);
    tokens(&source).iter().map(|token| token.text).collect()
}

fn check_wiring(interp: &str, persistence: &str) {
    let source = code_only(interp);
    let code = tokens(&source);
    let method: String = code[token_body(&code, "pub fn stored_runtime_intern")]
        .iter()
        .map(|token| token.text)
        .collect();
    assert!(method.ends_with("self.runtime_key_tail_min(&over)}"));
    assert!(method.contains("ifself.slots.is_free_index(idx){continue;}ifletSome(id)=over(&self.slots.get(idx)){returnSome(id);}"));
    let persistence = compact(persistence);
    for required in [
        "define_runtime_key_scan!(@scan []; $(($field, $runtime_keys))*);",
        "define_runtime_key_scan!(@scan [$($selected)*]; $($rest)*);",
        "define_runtime_key_scan!(@scan [$($selected)* ($field, $policy)]; $($rest)*);",
        "std::iter::empty() $(.chain(runtime_key_iter!(persist_run, self, $field, $policy)))* .filter_map(over).min()",
        "pub const RUNTIME_KEY_HOLDER_SOURCE: &[(&str, &str)] = &[$((stringify!($field), runtime_key_iter!(persist_text, self, $field, $policy)),)*];",
        "interp_state!(define_runtime_key_scan);",
        "macro_rules! persist_run { ($($code:tt)*) => { $($code)* }; }",
        "macro_rules! persist_text { ($($code:tt)*) => { stringify!($($code)*) }; }",
    ] {
        assert!(persistence.contains(&compact(required)), "missing wiring: {required}");
    }
}

#[test]
fn runtime_key_holder_set_and_projections_are_preserved() {
    check_wiring(
        include_str!("../src/interp/persist.rs"),
        include_str!("../src/interp/persistence.rs"),
    );
    let actual: Vec<_> = RUNTIME_KEY_HOLDER_SOURCE
        .iter()
        .map(|(field, source)| (*field, compact(source)))
        .collect();
    let expected = [
        ("stack", "self.stack.iter()"),
        (
            "arrays",
            "self.arrays.values().flat_map(|a| a.items().values())",
        ),
        (
            "index_props",
            "self.index_props.values().flat_map(|a| a.items().values())",
        ),
        (
            "collections",
            "self.collections.values().flat_map(|c| c.live_entries().flat_map(|(k, v)| [k, v]))",
        ),
    ]
    .map(|(field, source)| (field, compact(source)));
    assert_eq!(actual, expected);
}

#[test]
fn disconnected_key_scans_are_rejected() {
    let interp = include_str!("../src/interp/persist.rs");
    let persistence = include_str!("../src/interp/persistence.rs");
    check_wiring(interp, persistence);
    for (before, after) in [
        (
            ".filter_map(over)\n                    .min()",
            ".filter_map(over).next()",
        ),
        ("$(($field, $runtime_keys))*", "$(($field, none))*"),
        ("[$($selected)* ($field, $policy)]", "[$($selected)*]"),
        (
            "runtime_key_iter!(persist_run, self, $field, $policy)",
            "std::iter::empty()",
        ),
        (
            "runtime_key_iter!(persist_text, self, $field, $policy)",
            "\"empty\"",
        ),
        ("interp_state!(define_runtime_key_scan);", ""),
    ] {
        let mutated = persistence.replace(before, after);
        assert_ne!(mutated, persistence, "mutation must match {before}");
        assert!(std::panic::catch_unwind(|| check_wiring(interp, &mutated)).is_err());
    }
    let mutated = interp.replace("self.runtime_key_tail_min(&over)", "None");
    assert_ne!(mutated, interp);
    assert!(std::panic::catch_unwind(|| check_wiring(&mutated, persistence)).is_err());
}
