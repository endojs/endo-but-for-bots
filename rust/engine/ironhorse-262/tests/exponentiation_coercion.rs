//! Exponentiation performs `ToNumeric` on the left operand and then the right
//! operand before applying Number exponentiation or checking the numeric type.

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
fn number_exponentiation_coerces_both_operands_in_spec_order() {
    assert_result_agrees(
        "var trace=''; var a={valueOf:function(){trace+='a';return 3;}}; var b={valueOf:function(){trace+='b';return 2;}}; (a ** b) + ':' + trace",
        "9:ab",
    );
    assert_result_agrees(
        "'' + (2 ** '3') + ',' + (2 ** false) + ',' + (2 ** null) + ',' + (2 ** undefined)",
        "8,1,1,NaN",
    );
}

#[test]
fn exponentiation_conversion_errors_are_catchable() {
    assert_result_agrees(
        "var hit=false; try { Symbol('x') ** { valueOf:function(){hit=true;return 1;} }; } catch (e) { (e instanceof TypeError) + ':' + hit; }",
        "true:false",
    );
    assert_result_agrees(
        "try { 1n ** 1; } catch (e) { e instanceof TypeError; }",
        "true",
    );
}
