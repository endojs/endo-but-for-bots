//! BigInt exponentiation semantics: arbitrary-precision results, sign and
//! zero rules, conversion ordering, and catchable type/range errors.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "{source}: ironhorse halt={:?}, oracle={:?}, ironhorse={:?}",
        run.ironhorse_halt,
        run.oracle_result,
        run.ironhorse_result,
    );
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn computes_arbitrary_precision_powers() {
    assert_result_agrees("2n ** 0n", "1");
    assert_result_agrees("0n ** 0n", "1");
    assert_result_agrees(
        "2n ** 255n",
        "57896044618658097711785492504343953926634992332820282019728792003956564819968",
    );
    assert_result_agrees("291n ** 3n", "24642171");
    assert_result_agrees("(-3n) ** 5n", "-243");
    assert_result_agrees("(-3n) ** 4n", "81");
}

#[test]
fn handles_constant_bases_with_wide_exponents() {
    assert_result_agrees("1n ** 100000n", "1");
    assert_result_agrees("(-1n) ** 100001n", "-1");
    assert_result_agrees("0n ** 100000n", "0");
}

#[test]
fn negative_exponents_throw_range_error() {
    assert_result_agrees(
        "try { 2n ** -1n; 'no' } catch (e) { e instanceof RangeError }",
        "true",
    );
    assert_result_agrees(
        "try { 0n ** -100000000000000000n; 'no' } catch (e) { e instanceof RangeError }",
        "true",
    );
}

#[test]
fn mixed_numeric_types_throw_type_error() {
    assert_result_agrees(
        "try { 2n ** 2; 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
    assert_result_agrees(
        "try { 2 ** 2n; 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
}

#[test]
fn converts_operands_left_to_right() {
    assert_result_agrees(
        "var order=0; var a={valueOf:function(){order=order*10+1;return 2n}}; var b={valueOf:function(){order=order*10+2;return 3n}}; var r=a**b; order*100+Number(r)",
        "1208",
    );
}
