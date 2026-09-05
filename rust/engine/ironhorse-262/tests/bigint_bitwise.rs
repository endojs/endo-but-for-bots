//! BigInt bitwise logic, signed shifts, complement, coercion ordering, and
//! catchable mixed-domain/unsigned-shift errors.

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
fn logical_operations_use_infinite_twos_complement() {
    assert_result_agrees(
        "[5n&3n,5n|2n,5n^3n,-5n&3n,-5n|2n,-5n^3n].join(',')",
        "1,7,6,3,-5,-8",
    );
    assert_result_agrees(
        "var a=0x123456789abcdef0123456789abcdefn; var b=-0xfedcba9876543210fedcba987654321n; ((a&b)|(a^b))===(a|b)",
        "true",
    );
}

#[test]
fn shifts_accept_bigint_counts_and_preserve_sign() {
    assert_result_agrees(
        "[1n<<65n,9n>>2n,-9n>>2n,-1n>>1000n,1n>>1000n].join(',')",
        "36893488147419103232,2,-3,-1,0",
    );
    assert_result_agrees(
        "[8n<<-2n,8n>>-2n,-9n<<-2n,-9n>>-2n].join(',')",
        "2,32,-3,-36",
    );
}

#[test]
fn complement_matches_minus_one_identity() {
    assert_result_agrees("[~0n,~-1n,~5n,~-5n].join(',')", "-1,0,-6,4");
    assert_result_agrees(
        "var x=123456789012345678901234567890n; ~~x===x && (~x===-x-1n)",
        "true",
    );
}

#[test]
fn mixed_numeric_domains_throw_after_left_to_right_conversion() {
    assert_result_agrees(
        "var log=''; var a={valueOf:function(){log+='a';return 7n}}; var b={valueOf:function(){log+='b';return 2}}; try { a&b } catch(e) { log += e instanceof TypeError } log",
        "abtrue",
    );
    assert_result_agrees(
        "var r=''; try { 1n|1 } catch(e) { r+=e instanceof TypeError } try { 1^1n } catch(e) { r+=','+(e instanceof TypeError) } try { 1n<<1 } catch(e) { r+=','+(e instanceof TypeError) } r",
        "true,true,true",
    );
}

#[test]
fn unsigned_right_shift_rejects_bigints() {
    assert_result_agrees(
        "var r=''; try { 1n>>>1n } catch(e) { r+=e instanceof TypeError } try { 1n>>>1 } catch(e) { r+=','+(e instanceof TypeError) } r",
        "true,true",
    );
}

#[test]
fn wrappers_and_toprimitive_participate_in_bigint_operations() {
    assert_result_agrees(
        "var a=Object(13n); var b={valueOf:function(){return 3n}}; [a&b,a>>1n,~a].join(',')",
        "1,6,-14",
    );
}
