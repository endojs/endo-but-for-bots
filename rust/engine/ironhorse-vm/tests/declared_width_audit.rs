//! Source guard for WASM-BLOCKERS.md B7: an admission that decides whether a
//! crank halts `HeapExhausted`, or whether a RegExp compile or match hits its
//! byte budget, charges a declared, target-independent width per element and
//! never the host's `size_of`, which differs on wasm32 for any type holding a
//! `usize`, a pointer or a `Vec` header; and a guest index is never advanced
//! in the host's `usize`. The anchors are source-mutation tests of the same
//! kind as `allocation_admission_audit.rs`: each check must reject the
//! one-line change back to the target-dependent form.

use ironhorse_vm::source_scan::{
    code_only, matching_delimiter, token_body, token_positions, tokens, Token,
};

const ADMISSION: &str = include_str!("../src/interp/admission.rs");
const JSON: &str = include_str!("../src/interp/natives/json.rs");
const REGEXP: &str = include_str!("../src/interp/natives/regexp.rs");
const MATCHER: &str = include_str!("../../ironhorse-regexp/src/matcher.rs");
const COMPILE: &str = include_str!("../../ironhorse-regexp/src/compile.rs");

/// Whether the tokens at `at` spell `form`, ignoring whitespace.
fn spells(code: &[Token<'_>], at: usize, form: &str) -> bool {
    let form = tokens(form);
    code.len() >= at + form.len()
        && code[at..at + form.len()]
            .iter()
            .zip(&form)
            .all(|(a, b)| a.text == b.text)
}

/// The tokens of a declaration's signature: from `fn name` to its body.
fn signature<'c, 'a>(code: &'c [Token<'a>], name: &str) -> &'c [Token<'a>] {
    let marker = format!("fn {name}");
    let at = token_positions(code, &marker);
    assert_eq!(at.len(), 1, "declaration must be unique: {marker}");
    &code[at[0]..token_body(code, &marker).start]
}

/// `source` with its `n`th occurrence of `anchor` replaced; a mutation that
/// changes nothing proves nothing.
fn mutated(source: &str, anchor: &str, replacement: &str, n: usize) -> String {
    let (at, _) = source
        .match_indices(anchor)
        .nth(n)
        .unwrap_or_else(|| panic!("occurrence {n} of {anchor:?} is missing"));
    let mutated = format!(
        "{}{}{}",
        &source[..at],
        replacement,
        &source[at + anchor.len()..]
    );
    assert_ne!(mutated, source);
    mutated
}

fn rejects(check: impl Fn(&str) + std::panic::RefUnwindSafe, mutated: &str, what: &str) {
    assert!(
        std::panic::catch_unwind(|| check(mutated)).is_err(),
        "the check accepted {what}"
    );
}

/// Scratch admission charges `T::CHARGE`, every element-generic helper
/// requires a declared width, and `size_of` appears only inside the
/// `scratch_element!` macro, as the 64-bit layout pin the macro emits.
fn check_scratch_admission(source: &str) {
    let source = code_only(source);
    let code = tokens(&source);
    let pin = token_body(&code, "macro_rules ! scratch_element");
    for at in token_positions(&code, "size_of") {
        assert!(
            pin.contains(&at),
            "a host layout measurement outside the macro's layout pin, at token {at}"
        );
    }
    assert!(
        !token_positions(&code[pin], "size_of :: < $ t > ( ) == $ n").is_empty(),
        "scratch_element! lost its 64-bit layout pin"
    );
    for name in [
        "extend_reserved_units",
        "admit_scratch",
        "reserve_copy_scratch",
    ] {
        let body = &code[token_body(&code, &format!("fn {name}"))];
        assert!(
            !token_positions(body, "T :: CHARGE").is_empty(),
            "{name} does not charge the declared width"
        );
    }
    for name in [
        "extend_reserved_units",
        "reserve_scratch",
        "reserve_work_scratch",
        "extend_work_scratch",
        "extend_prepaid_scratch",
        "push_prepaid_scratch",
        "admit_scratch",
        "reserve_copy_scratch",
    ] {
        assert!(
            !token_positions(signature(&code, name), "ScratchElement").is_empty(),
            "{name} admits an element type without a declared width"
        );
    }
}

#[test]
fn scratch_admission_charges_declared_widths() {
    check_scratch_admission(ADMISSION);
}

#[test]
fn scratch_admission_cannot_return_to_size_of() {
    // Each charging helper, back to the host's layout.
    for n in 0..3 {
        rejects(
            check_scratch_admission,
            &mutated(ADMISSION, "T::CHARGE", "std::mem::size_of::<T>()", n),
            "a size_of charge",
        );
    }
    // A helper that would accept an element type with no declared width.
    rejects(
        check_scratch_admission,
        &mutated(
            ADMISSION,
            "fn reserve_scratch<T: ScratchElement>",
            "fn reserve_scratch<T>",
            0,
        ),
        "an unbounded element type",
    );
    // A width no 64-bit build checks against the layout it stands for.
    rejects(
        check_scratch_admission,
        &mutated(
            ADMISSION,
            "const _: () = assert!(std::mem::size_of::<$t>() == $n);",
            "",
            0,
        ),
        "an unpinned width",
    );
}

/// The reviver's source tree declares its widths, and `JSON.stringify`
/// admits a container's size in `u64`, before narrowing it to the host's
/// `usize`, so an oversized result is the same catchable `RangeError` on
/// every target.
fn check_json_output_sizing(source: &str) {
    let source = code_only(source);
    let code = tokens(&source);
    for entry in ["JsonSource =>", "( ReadKey , JsonSource ) =>"] {
        assert!(
            !token_positions(&code, entry).is_empty(),
            "json.rs lost the declared width of {entry}"
        );
    }
    assert!(
        !token_positions(signature(&code, "json_reserve_output"), "additional : u64").is_empty(),
        "json_reserve_output takes its addition in the host's usize"
    );
    let body = &code[token_body(&code, "fn json_container_buffer")];
    let admitted = token_positions(body, "json_reserve_output ( state , extra )");
    let narrowed = token_positions(body, "usize :: try_from ( extra )");
    assert_eq!(
        admitted.len(),
        1,
        "json_container_buffer admits its count once"
    );
    assert_eq!(
        narrowed.len(),
        1,
        "json_container_buffer narrows its count once"
    );
    assert!(
        admitted[0] < narrowed[0],
        "json_container_buffer narrows its count before admitting it"
    );
}

#[test]
fn json_output_is_sized_in_u64() {
    check_json_output_sizing(JSON);
}

#[test]
fn json_output_sizing_cannot_return_to_usize() {
    rejects(
        check_json_output_sizing,
        &mutated(JSON, "additional: u64,", "additional: usize,", 0),
        "a usize addition",
    );
    let admit = "self.json_reserve_output(state, extra)?;";
    let narrow =
        "let extra = usize::try_from(extra).map_err(|_| Step::Host(Halt::HeapExhausted))?;";
    let swapped = mutated(
        &mutated(&mutated(JSON, admit, "\u{0}", 0), narrow, admit, 0),
        "\u{0}",
        narrow,
        0,
    );
    rejects(
        check_json_output_sizing,
        &swapped,
        "narrowing before admission",
    );
    rejects(
        check_json_output_sizing,
        &mutated(JSON, "    (ReadKey, JsonSource) => 48,\n", "", 0),
        "an undeclared element width",
    );
}

/// `AdvanceStringIndex` takes a guest ToLength, up to 2**53 - 1, and never
/// adds to it in the host's `usize`, which is 32 bits on wasm32.
fn check_string_index_advance(source: &str) {
    let source = code_only(source);
    let code = tokens(&source);
    let body = &code[token_body(&code, "fn advance_string_index")];
    assert!(
        token_positions(body, "+").is_empty(),
        "advance_string_index adds in the host's usize"
    );
    assert!(
        !token_positions(body, "checked_add").is_empty(),
        "advance_string_index lost its checked pair lookup"
    );
}

#[test]
fn string_index_advances_without_host_arithmetic() {
    check_string_index_advance(REGEXP);
}

#[test]
fn string_index_advance_cannot_return_to_usize_arithmetic() {
    rejects(
        check_string_index_advance,
        &mutated(REGEXP, "i.checked_add(2)?", "i + 2", 0),
        "a usize addition",
    );
}

/// Token ranges of every `const _: () = assert!(...)` item, the 64-bit layout
/// pins: the one place a declared width may be compared with `size_of`.
fn layout_pins(code: &[Token<'_>]) -> Vec<std::ops::Range<usize>> {
    let marker = "const _ : ( ) = assert ! (";
    token_positions(code, marker)
        .into_iter()
        .map(|at| {
            let open = at + tokens(marker).len() - 1;
            at..matching_delimiter(code, open) + 1
        })
        .collect()
}

/// The widths no target changes: the only ones `size_of` may still measure
/// in a RegExp byte budget.
const PORTABLE_SIZE_OF: &[&str] = &[
    "size_of :: < i32 > ( )",
    "size_of :: < u32 > ( )",
    "size_of :: < ( i32 , i32 ) > ( )",
];
const PORTABLE_SIZE_OF_VAL: &[&str] = &[
    "size_of_val ( captures )",
    "size_of_val ( chars . as_slice ( ) )",
    "size_of_val ( s . as_slice ( ) )",
];

/// A RegExp byte budget charges declared constants for its records, each
/// pinned to its 64-bit layout, and measures only fixed-width scalars.
fn check_regexp_charges(source: &str, charges: &[(&str, &str)], pins: &[&str]) {
    let source = code_only(source);
    let code = tokens(&source);
    let pinned = layout_pins(&code);
    for pin in pins {
        assert!(
            pinned
                .iter()
                .any(|range| !token_positions(&code[range.clone()], pin).is_empty()),
            "lost the 64-bit layout pin {pin}"
        );
    }
    for at in token_positions(&code, "size_of") {
        if pinned.iter().any(|range| range.contains(&at)) {
            continue;
        }
        assert!(
            PORTABLE_SIZE_OF.iter().any(|form| spells(&code, at, form)),
            "a host layout charge at byte {}",
            code[at].start
        );
    }
    for at in token_positions(&code, "size_of_val") {
        assert!(
            PORTABLE_SIZE_OF_VAL
                .iter()
                .any(|form| spells(&code, at, form)),
            "a host layout measurement at byte {}",
            code[at].start
        );
    }
    for (name, charge) in charges {
        let body = &code[token_body(&code, &format!("fn {name}"))];
        assert!(
            !token_positions(body, charge).is_empty(),
            "{name} lost {charge}"
        );
    }
}

const MATCHER_CHARGES: &[(&str, &str)] = &[
    ("save_captures", "STATE_CHARGE"),
    ("match_regexp_budgeted", "ASSERTION_CHARGE"),
    ("match_regexp_budgeted", "QUANTIFIER_CHARGE"),
];
const MATCHER_PINS: &[&str] = &[
    "size_of :: < State > ( ) == STATE_CHARGE",
    "size_of :: < AssertionData > ( ) == ASSERTION_CHARGE",
    "size_of :: < QuantifierData > ( ) == QUANTIFIER_CHARGE",
];

fn check_matcher_charges(source: &str) {
    check_regexp_charges(source, MATCHER_CHARGES, MATCHER_PINS);
}

#[test]
fn matcher_charges_declared_widths() {
    check_matcher_charges(MATCHER);
}

#[test]
fn matcher_charges_cannot_return_to_size_of() {
    for (anchor, replacement) in [
        (
            "STATE_CHARGE.checked_add(",
            "std::mem::size_of::<State>().checked_add(",
        ),
        (
            "(program.assertion_count, ASSERTION_CHARGE)",
            "(program.assertion_count, std::mem::size_of::<AssertionData>())",
        ),
        (
            "(program.quantifier_count, QUANTIFIER_CHARGE)",
            "(program.quantifier_count, std::mem::size_of::<QuantifierData>())",
        ),
        ("std::mem::size_of::<State>() == STATE_CHARGE", "true"),
    ] {
        rejects(
            check_matcher_charges,
            &mutated(MATCHER, anchor, replacement, 0),
            anchor,
        );
    }
}

const COMPILE_CHARGES: &[(&str, &str)] = &[
    ("add_node", "NODE_CHARGE"),
    ("add_node", "STRING_HEADER_CHARGE"),
    ("charset_parts", "STRING_HEADER_CHARGE"),
    ("charset_strings", "STRING_HEADER_CHARGE"),
];
const COMPILE_PINS: &[&str] = &[
    "size_of :: < Node > ( ) == NODE_CHARGE",
    "size_of :: < Vec < u32 > > ( ) == STRING_HEADER_CHARGE",
];

fn check_compile_charges(source: &str) {
    check_regexp_charges(source, COMPILE_CHARGES, COMPILE_PINS);
}

#[test]
fn compiler_charges_declared_widths() {
    check_compile_charges(COMPILE);
}

#[test]
fn compiler_charges_cannot_return_to_size_of() {
    for (anchor, replacement) in [
        (
            "self.work.allocate(NODE_CHARGE);",
            "self.work.allocate(std::mem::size_of::<Node>());",
        ),
        (
            "self.work.allocate(STRING_HEADER_CHARGE);",
            "self.work.allocate(std::mem::size_of::<Vec<u32>>());",
        ),
        (
            "STRING_HEADER_CHARGE + std::mem::size_of_val(s.as_slice())",
            "std::mem::size_of::<Vec<u32>>() + std::mem::size_of_val(s.as_slice())",
        ),
        (
            "std::mem::size_of_val(chars.as_slice())",
            "std::mem::size_of_val(&kind)",
        ),
        ("std::mem::size_of::<Node>() == NODE_CHARGE", "true"),
    ] {
        rejects(
            check_compile_charges,
            &mutated(COMPILE, anchor, replacement, 0),
            anchor,
        );
    }
}
