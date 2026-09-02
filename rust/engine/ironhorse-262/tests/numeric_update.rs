//! Prefix and postfix updates apply ToNumeric before adding or subtracting one.

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
fn prefix_increment_coerces_primitive_and_wrapper_values() {
    assert_result_agrees("var x = false; ++x; x", "1");
    assert_result_agrees("var x = new Boolean(true); ++x; x", "2");
    assert_result_agrees("var x = '41'; ++x; x", "42");
}

#[test]
fn decrement_and_postfix_update_store_the_coerced_number() {
    assert_result_agrees("var x = '42'; var old = x--; '' + old + ':' + x", "42:41");
    assert_result_agrees(
        "var x = { valueOf: function () { return 2; } }; --x; x",
        "1",
    );
}

#[test]
fn bigint_updates_preserve_domain_and_postfix_value() {
    assert_result_agrees("var x = 1n; ++x; typeof x + ':' + x", "bigint:2");
    assert_result_agrees("var x = -1n; --x; x", "-2");
    assert_result_agrees(
        "var x = 4294967295n; var old = x++; old + ':' + x",
        "4294967295:4294967296",
    );
    assert_result_agrees(
        "var x = Object(7n); var old = x--; typeof old + ':' + old + ':' + x",
        "bigint:7:6",
    );
}
