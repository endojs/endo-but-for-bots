//! Stage-14 (binary-data/atomics) behavioral gate: `DataView.prototype`
//! `getBigInt64`/`getBigUint64`/`setBigInt64`/`setBigUint64`.
//!
//! The 64-bit BigInt accessors decode/encode an eight-byte element as a
//! BigInt (two's complement for the store, signed vs. unsigned only in the
//! getter's decode), honoring the `littleEndian` flag (default big-endian).
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
// §1  Round-trip a stored BigInt through the getter (default big-endian).
// -------------------------------------------------------------------------

#[test]
fn set_get_bigint64_roundtrip() {
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, 1n); d.getBigInt64(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, -1n); d.getBigInt64(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, 9223372036854775807n); d.getBigInt64(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, -9223372036854775808n); d.getBigInt64(0)",
    );
}

#[test]
fn set_get_biguint64_roundtrip() {
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, 0n); d.getBigUint64(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, 18446744073709551615n); d.getBigUint64(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, 4294967296n); d.getBigUint64(0)",
    );
}

// -------------------------------------------------------------------------
// §2  Signed vs. unsigned decode of the same eight bytes.
// -------------------------------------------------------------------------

#[test]
fn signed_unsigned_reinterpretation() {
    // -1n stored, read back unsigned → 2^64-1.
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, -1n); d.getBigUint64(0)",
    );
    // 2^63 stored unsigned, read signed → -2^63.
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, 9223372036854775808n); d.getBigInt64(0)",
    );
}

// -------------------------------------------------------------------------
// §3  Endianness — the same value stored/read little- vs. big-endian.
// -------------------------------------------------------------------------

#[test]
fn endianness() {
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, 258n, true); d.getBigInt64(0, true)",
    );
    // Little-endian store, big-endian read reverses the bytes.
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, 1n, true); d.getBigUint64(0, false)",
    );
    // A ToBigInt of a boolean (1n).
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, true); d.getBigUint64(0)",
    );
}

// -------------------------------------------------------------------------
// §4  Offset placement inside a larger buffer.
// -------------------------------------------------------------------------

#[test]
fn offset_placement() {
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(16)); d.setBigInt64(8, 123456789012345n); d.getBigInt64(8)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(16), 4); d.setBigUint64(0, 42n); d.getBigUint64(0)",
    );
}
