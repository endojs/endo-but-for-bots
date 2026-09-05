//! Unary numeric operators apply the appropriate abstract conversion to
//! primitive and wrapper operands, including catchable Symbol/BigInt errors.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

#[test]
fn unary_number_operators_coerce_strings_and_wrappers() {
    assert_result_agrees(
        "'' + (+\"1\") + ',' + (+new Number(-1)) + ',' + (-\"-2\") + ',' + (-new String('-3'))",
        "1,-1,2,3",
    );
    assert_result_agrees(
        "'' + (~\"1\") + ',' + (~new String('0')) + ',' + (~\"x\")",
        "-2,-1,-1",
    );
}

#[test]
fn unary_numeric_type_errors_are_catchable() {
    assert_result_agrees("try { +1n; } catch (e) { e instanceof TypeError; }", "true");
    assert_result_agrees(
        "try { -Symbol('x'); } catch (e) { e instanceof TypeError; }",
        "true",
    );
}
