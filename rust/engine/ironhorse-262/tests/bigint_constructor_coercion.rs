//! BigInt conversions at the `Number` and `String` constructor boundaries.
//!
//! These are explicit conversions: unlike ordinary `ToNumber`, `Number(1n)`
//! accepts a BigInt and rounds it to binary64, while `String(1n)` renders the
//! arbitrary-precision decimal value without the source-level `n` suffix.

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
fn number_converts_bigints_with_binary64_rounding() {
    assert_result_agrees("Number(0n)", "0");
    assert_result_agrees("Number(1n)", "1");
    assert_result_agrees("Number(-42n)", "-42");
    assert_result_agrees("Number(4294967297n)", "4294967297");
    assert_result_agrees("Number(9007199254740992n)", "9007199254740992");
    assert_result_agrees("Number(9007199254740993n)", "9007199254740992");
    assert_result_agrees("Number(9007199254740994n)", "9007199254740994");
    assert_result_agrees("Number(9007199254740995n)", "9007199254740996");
    assert_result_agrees("Number(-9007199254740995n)", "-9007199254740996");
    assert_result_agrees("Number(2n ** 1024n) === Infinity", "true");
    assert_result_agrees("Number(2n ** 1023n) !== Infinity", "true");
}

#[test]
fn number_wrapper_accepts_bigints() {
    assert_result_agrees("+(new Number(0n))", "0");
    assert_result_agrees("+(new Number(9007199254740993n))", "9007199254740992");
    assert_result_agrees(
        "Number({valueOf:function(){return 9007199254740995n}})",
        "9007199254740996",
    );
}

#[test]
fn number_rejects_symbols() {
    assert_result_agrees(
        "try { Number(Symbol('x')); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
    assert_result_agrees(
        "try { new Number(Symbol('x')); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
}

#[test]
fn string_renders_bigints_and_wraps_the_result() {
    assert_result_agrees("String(0n)", "0");
    assert_result_agrees(
        "String(-123456789012345678901234567890n)",
        "-123456789012345678901234567890",
    );
    assert_result_agrees(
        "(new String(12345678901234567890n)).valueOf()",
        "12345678901234567890",
    );
}
