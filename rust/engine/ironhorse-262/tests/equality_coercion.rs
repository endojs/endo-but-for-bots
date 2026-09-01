//! Abstract Equality recursively applies primitive conversion before comparing
//! mixed String, Number, Boolean, BigInt, and Symbol operands.

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
fn strings_compare_to_numbers_and_booleans_by_numeric_value() {
    assert_result_agrees(
        "'' + ('1' == 1) + ':' + ('+1.10' == 1.1) + ':' + ('' == false) + ':' + ('no' == 0)",
        "true:true:true:false",
    );
}

#[test]
fn object_primitive_results_reenter_abstract_equality() {
    assert_result_agrees(
        "var a = { valueOf: function () { return '+1'; } }; var b = new String('-1'); '' + (a == true) + ':' + (b == -1)",
        "true:true",
    );
}

#[test]
fn bigint_boolean_and_symbol_comparisons_follow_abstract_equality() {
    assert_result_agrees(
        "'' + (1n == true) + ':' + (0n == false) + ':' + (0n == Symbol('0'))",
        "true:true:false",
    );
}

#[test]
fn abrupt_symbol_to_primitive_access_is_catchable() {
    assert_result_agrees(
        "var marker = {}; var y = Object.defineProperty({}, Symbol.toPrimitive, { get: function () { throw marker; } }); try { 0 == y; } catch (e) { e === marker; }",
        "true",
    );
}
