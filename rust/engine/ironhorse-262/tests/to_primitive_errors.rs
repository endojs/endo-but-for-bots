//! Abrupt `ToPrimitive` outcomes are JavaScript TypeErrors, not host-level
//! unsupported exits. This covers non-callable conversion hooks and callable
//! hooks that exhaust the ordinary fallback or return another object.

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
fn non_callable_symbol_to_primitive_throws_catchable_type_error() {
    assert_result_agrees(
        "var o = {}; o[Symbol.toPrimitive] = 1; try { '' + o; false } catch (e) { e instanceof TypeError }",
        "true",
    );
}

#[test]
fn symbol_to_primitive_must_return_a_primitive() {
    assert_result_agrees(
        "var o = {}; o[Symbol.toPrimitive] = function () { return {}; }; try { '' + o; false } catch (e) { e instanceof TypeError }",
        "true",
    );
}

#[test]
fn ordinary_conversion_must_eventually_return_a_primitive() {
    assert_result_agrees(
        "var o = { valueOf: function () { return {}; }, toString: function () { return {}; } }; try { o < 1; false } catch (e) { e instanceof TypeError }",
        "true",
    );
}

#[test]
fn ordinary_conversion_skips_non_callable_methods() {
    assert_result_agrees(
        "var o = { valueOf: function () { return 7; }, toString: null }; o < 8",
        "true",
    );
    assert_result_agrees(
        "var o = { valueOf: null, toString: function () { return 'ok'; } }; '' + o",
        "ok",
    );
}

#[test]
fn computed_property_key_errors_resume_outer_catch() {
    assert_result_agrees(
        "var key = {}; key[Symbol.toPrimitive] = {}; function evaluate() { return class { [key] = 1; }; } try { evaluate(); false } catch (e) { e instanceof TypeError }",
        "true",
    );
}
