//! Stage-14 (binary-data/atomics) behavioral gate: `SharedArrayBuffer` and the
//! single-agent `Atomics.*` read-modify-write surface.
//!
//! ironhorse runs one agent, so `Atomics` is a plain (non-atomic) sequence over
//! the integer TypedArray's backing store, and a `SharedArrayBuffer` is a byte
//! buffer marked shared. Each snippet is dual-run against the XS oracle; the
//! gate is **result agreement where the oracle accepts the program**
//! (`BothComplete` + `result_agrees`), per the accuracy-over-parity doctrine.

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
// §1  SharedArrayBuffer construction and views over it.
// -------------------------------------------------------------------------

#[test]
fn shared_array_buffer_basics() {
    assert_result_agrees("new SharedArrayBuffer(8).byteLength");
    assert_result_agrees("new SharedArrayBuffer(0).byteLength");
    assert_result_agrees("var s = new SharedArrayBuffer(16); new Int32Array(s).length");
    assert_result_agrees("var s = new SharedArrayBuffer(16); var a = new Int32Array(s); a[0] = 7; a[0]");
    assert_result_agrees("typeof SharedArrayBuffer");
    assert_result_agrees("new DataView(new SharedArrayBuffer(8)).byteLength");
}

// -------------------------------------------------------------------------
// §2  Single-agent Atomics on integer views (load/store and the RMW family).
// -------------------------------------------------------------------------

#[test]
fn atomics_load_store() {
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); Atomics.store(a, 0, 5)");
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); Atomics.store(a, 0, 5); Atomics.load(a, 0)");
    // store returns the coerced value, not the wrapped element.
    assert_result_agrees("var a = new Int8Array(new SharedArrayBuffer(4)); Atomics.store(a, 0, 256)");
    // the wrapped element read back.
    assert_result_agrees("var a = new Int8Array(new SharedArrayBuffer(4)); Atomics.store(a, 0, 256); a[0]");
}

#[test]
fn atomics_rmw_returns_old() {
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); a[0] = 10; Atomics.add(a, 0, 5)");
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); a[0] = 10; Atomics.add(a, 0, 5); a[0]");
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); a[0] = 10; Atomics.sub(a, 0, 3); a[0]");
    assert_result_agrees("var a = new Uint8Array(new SharedArrayBuffer(4)); a[0] = 0xF0; Atomics.and(a, 0, 0x0F); a[0]");
    assert_result_agrees("var a = new Uint8Array(new SharedArrayBuffer(4)); a[0] = 0xF0; Atomics.or(a, 0, 0x0F); a[0]");
    assert_result_agrees("var a = new Uint8Array(new SharedArrayBuffer(4)); a[0] = 0xFF; Atomics.xor(a, 0, 0x0F); a[0]");
    assert_result_agrees("var a = new Int16Array(new SharedArrayBuffer(8)); a[0] = 42; Atomics.exchange(a, 0, 99)");
    assert_result_agrees("var a = new Int16Array(new SharedArrayBuffer(8)); a[0] = 42; Atomics.exchange(a, 0, 99); a[0]");
}

#[test]
fn atomics_compare_exchange() {
    // Matching expected → replaced, returns old.
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); a[0] = 7; Atomics.compareExchange(a, 0, 7, 99); a[0]");
    // Mismatched expected → unchanged, returns old.
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); a[0] = 7; Atomics.compareExchange(a, 0, 5, 99); a[0]");
    assert_result_agrees("var a = new Int32Array(new SharedArrayBuffer(16)); a[0] = 7; Atomics.compareExchange(a, 0, 7, 99)");
}

#[test]
fn atomics_works_on_non_shared() {
    // Atomics operate on a plain (non-shared) integer TypedArray too.
    assert_result_agrees("var a = new Int32Array(4); a[0] = 3; Atomics.add(a, 0, 4); a[0]");
}

// -------------------------------------------------------------------------
// §3  BigInt Atomics.
// -------------------------------------------------------------------------

#[test]
fn atomics_bigint() {
    assert_result_agrees("var a = new BigInt64Array(new SharedArrayBuffer(16)); Atomics.store(a, 0, 5n); Atomics.load(a, 0)");
    assert_result_agrees("var a = new BigInt64Array(new SharedArrayBuffer(16)); a[0] = 10n; Atomics.add(a, 0, 5n); a[0]");
    assert_result_agrees("var a = new BigUint64Array(new SharedArrayBuffer(16)); a[0] = 0xFFn; Atomics.and(a, 0, 0x0Fn); a[0]");
    assert_result_agrees("var a = new BigInt64Array(new SharedArrayBuffer(16)); a[0] = 7n; Atomics.compareExchange(a, 0, 7n, 99n); a[0]");
    assert_result_agrees("var a = new BigInt64Array(new SharedArrayBuffer(16)); a[0] = -1n; Atomics.exchange(a, 0, 3n)");
}

// -------------------------------------------------------------------------
// §4  isLockFree.
// -------------------------------------------------------------------------

#[test]
fn atomics_is_lock_free() {
    // XS reports lock-free only for the 4-byte element.
    assert_result_agrees("Atomics.isLockFree(1)");
    assert_result_agrees("Atomics.isLockFree(2)");
    assert_result_agrees("Atomics.isLockFree(4)");
    assert_result_agrees("Atomics.isLockFree(8)");
    assert_result_agrees("Atomics.isLockFree(3)");
}
