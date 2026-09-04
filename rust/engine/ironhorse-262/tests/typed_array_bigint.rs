//! Stage-14 (binary-data/atomics) behavioral gate: BigInt64Array/BigUint64Array
//! integer-indexed element read/write and dense-array construction.
//!
//! A BigInt64/BigUint64 typed array stores an eight-byte two's-complement
//! element; the exotic index `[[Get]]` decodes it into a BigInt and the index
//! `[[Set]]` coerces the value with `ToBigInt` and stores the low 64 bits.
//! Each snippet is dual-run against the XS oracle; the gate is **result
//! agreement where the oracle accepts the program** (`BothComplete` +
//! `result_agrees`), per the accuracy-over-parity doctrine.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

// -------------------------------------------------------------------------
// §1  Construction from a dense BigInt array + element read.
// -------------------------------------------------------------------------

#[test]
fn bigint64_from_array_literal() {
    assert_result_agrees("new BigInt64Array([1n, 2n, 3n]).length");
    assert_result_agrees("new BigInt64Array([1n, 2n, 3n])[0]");
    assert_result_agrees("new BigInt64Array([1n, 2n, 3n])[2]");
    assert_result_agrees("new BigInt64Array([-1n, -2n])[0]");
    assert_result_agrees("new BigInt64Array([9223372036854775807n])[0]");
    assert_result_agrees("new BigInt64Array([-9223372036854775808n])[0]");
    assert_result_agrees("new BigInt64Array([]).length");
}

#[test]
fn biguint64_from_array_literal() {
    assert_result_agrees("new BigUint64Array([0n, 1n])[1]");
    assert_result_agrees("new BigUint64Array([18446744073709551615n])[0]");
    assert_result_agrees("new BigUint64Array([4294967296n])[0]");
}

// -------------------------------------------------------------------------
// §2  Indexed write then read round-trip and ToBigInt wrap.
// -------------------------------------------------------------------------

#[test]
fn indexed_write_read_roundtrip() {
    assert_result_agrees("var a = new BigInt64Array(2); a[0] = 42n; a[0]");
    assert_result_agrees("var a = new BigInt64Array(2); a[1] = -7n; a[1]");
    // ToBigInt(true) === 1n.
    assert_result_agrees("var a = new BigUint64Array(1); a[0] = true; a[0]");
    // The unwritten slot reads 0n.
    assert_result_agrees("new BigInt64Array(3)[2]");
}

#[test]
fn signed_unsigned_wraparound() {
    // -1n written to a BigUint64Array reads as 2^64-1.
    assert_result_agrees("var a = new BigUint64Array(1); a[0] = -1n; a[0]");
    // 2^63 written to a BigInt64Array reads as -2^63.
    assert_result_agrees("var a = new BigInt64Array(1); a[0] = 9223372036854775808n; a[0]");
}

// -------------------------------------------------------------------------
// §3  Out-of-bounds index — a silent no-op write, undefined read.
// -------------------------------------------------------------------------

#[test]
fn out_of_bounds() {
    assert_result_agrees("var a = new BigInt64Array(1); a[5] = 9n; a[5]");
    assert_result_agrees("new BigInt64Array(1)[5]");
}
