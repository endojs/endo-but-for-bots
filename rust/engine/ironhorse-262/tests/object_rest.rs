//! Object-rest destructuring compiles named exclusions through XS_CODE_SYMBOL.
//! These are internal interned string keys, not ECMAScript Symbol primitives.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn named_property_is_excluded_from_object_rest() {
    assert_result_agrees(
        "var a, rest; ({ a: a, ...rest } = { a: 1, b: 2 }); '' + a + ',' + rest.a + ',' + rest.b + ',' + Object.keys(rest).join('|')",
        "1,undefined,2,b",
    );
}

#[test]
fn declaration_and_parameter_rest_preserve_remaining_properties() {
    assert_result_agrees(
        "var { x, ...rest } = { x: 1, y: 2, z: 3 }; '' + x + ',' + rest.y + ',' + rest.z",
        "1,2,3",
    );
    assert_result_agrees(
        "function f({ p, ...rest }) { return '' + p + ',' + rest.q; } f({ p: 4, q: 5 })",
        "4,5",
    );
}

#[test]
fn primitive_string_and_symbol_sources_are_boxed() {
    assert_result_agrees(
        "var { 0: first, ...rest } = 'abc'; '' + first + ',' + rest[0] + ',' + rest[1] + ',' + rest[2] + ',' + Object.keys(rest).join('|')",
        "a,undefined,b,c,1|2",
    );
    assert_result_agrees(
        "var { ...rest } = Symbol('value'); Object.keys(rest).length",
        "0",
    );
}
