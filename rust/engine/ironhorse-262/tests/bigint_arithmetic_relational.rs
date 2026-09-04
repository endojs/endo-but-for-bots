//! BigInt division/remainder, mixed numeric errors, and exact abstract
//! relational comparison against Number, Boolean, String, and wrappers.

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
fn bigint_division_truncates_toward_zero() {
    assert_result_agrees(
        "''+(13n/5n)+','+(-13n/5n)+','+(13n/-5n)+','+(-13n/-5n)",
        "2,-2,-2,2",
    );
    assert_result_agrees(
        "var n=123456789012345678901234567890n; var d=9876543210987654321n; var q=n/d; var r=n%d; q*d+r===n && r>=0n && r<d",
        "true",
    );
}

#[test]
fn bigint_remainder_has_the_dividend_sign() {
    assert_result_agrees(
        "''+(13n%5n)+','+(-13n%5n)+','+(13n%-5n)+','+(-13n%-5n)",
        "3,-3,3,-3",
    );
}

#[test]
fn division_by_zero_throws_range_error() {
    assert_result_agrees(
        "var r=''; try { 1n/0n } catch(e) { r += e instanceof RangeError } try { 1n%0n } catch(e) { r += ','+(e instanceof RangeError) } r",
        "true,true",
    );
}

#[test]
fn mixed_arithmetic_throws_type_error_after_left_to_right_coercion() {
    assert_result_agrees(
        "var r=''; for (var i=0;i<5;i++) { try { if(i===0)1n+1; if(i===1)1n-1; if(i===2)1n*1; if(i===3)1n/1; if(i===4)1n%1 } catch(e) { r += e instanceof TypeError } } r",
        "truetruetruetruetrue",
    );
    assert_result_agrees(
        "var log=''; var a={valueOf:function(){log+='a';return 7n}}; var b={valueOf:function(){log+='b';return 2}}; try { a/b } catch(e) { log += e instanceof TypeError } log",
        "abtrue",
    );
}

#[test]
fn relational_comparison_is_exact_across_bigint_and_number() {
    assert_result_agrees(
        "''+(9007199254740993n>9007199254740992)+','+(9007199254740993n<9007199254740994)+','+(-9007199254740993n < -9007199254740992)",
        "true,true,true",
    );
    assert_result_agrees(
        "''+(1n<1.5)+','+(1n>0.5)+','+(-1n>-1.5)+','+(-1n<-0.5)",
        "true,true,true,true",
    );
    assert_result_agrees(
        "''+(1n<Infinity)+','+(1n>-Infinity)+','+(1n<NaN)+','+(1n>=NaN)",
        "true,true,false,false",
    );
}

#[test]
fn relational_comparison_handles_strings_booleans_and_wrappers() {
    assert_result_agrees(
        "''+(10n<'11')+','+(10n>='10')+','+(10n<'x')+','+('0x10'<17n)+','+(1n>true)+','+(0n>=false)",
        "true,true,false,true,false,true",
    );
    assert_result_agrees(
        "var log=''; var a={valueOf:function(){log+='a';return 2n}}; var b={valueOf:function(){log+='b';return 2.5}}; var r=a<b; log+','+r+','+(Object(3n)>2)",
        "ab,true,true",
    );
}

#[test]
fn relational_symbol_conversion_throws_type_error() {
    assert_result_agrees(
        "try { 1n < Symbol('x'); false } catch(e) { e instanceof TypeError }",
        "true",
    );
}
