//! Behavioral gate: `ArrayBuffer`/`SharedArrayBuffer` constructor argument
//! coercion and error semantics (js-26 TypedArray/ArrayBuffer cluster).
//!
//! The `length` argument takes `ToIndex` (ECMA-262 7.1.22): a boolean / string
//! / object is coerced through the general `ToNumber` path (observing
//! `valueOf`/`toString`); a `Symbol`/`BigInt` argument throws a **catchable**
//! `TypeError`; a negative or over-`0x7FFFFFFF` result throws a **catchable**
//! `RangeError`; and calling the constructor without `new` throws a
//! `TypeError`. Each snippet is dual-run against the XS oracle and gated on
//! observable agreement where the oracle accepts the program (`BothComplete` +
//! `result_agrees`) — the same accuracy-over-parity bar the sibling
//! `typed_array_from_source` gate uses. Before this landed these all self-named
//! `unsupported-opcode:native-call:ArrayBuffer:*` honest skips.

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
// §1  ToIndex coercion of a non-integer length argument.
// -------------------------------------------------------------------------

#[test]
fn boolean_length_coerces_to_one() {
    // ToNumber(true) === 1, ToNumber(false) === 0.
    assert_result_agrees("new ArrayBuffer(true).byteLength");
    assert_result_agrees("new ArrayBuffer(false).byteLength");
}

#[test]
fn string_length_coerces() {
    assert_result_agrees("new ArrayBuffer('16').byteLength");
    // A blank / non-numeric string is ToNumber -> NaN -> ToIndex 0.
    assert_result_agrees("new ArrayBuffer('').byteLength");
    assert_result_agrees("new ArrayBuffer('   ').byteLength");
}

#[test]
fn object_length_runs_valueof() {
    assert_result_agrees("new ArrayBuffer({ valueOf: function () { return 8; } }).byteLength");
    // A fractional coerced length truncates toward zero (ToIntegerOrInfinity).
    assert_result_agrees("new ArrayBuffer(4.9).byteLength");
    // null / undefined -> 0.
    assert_result_agrees("new ArrayBuffer(null).byteLength");
    assert_result_agrees("new ArrayBuffer(undefined).byteLength");
}

// -------------------------------------------------------------------------
// §2  Catchable RangeError on an out-of-range length.
// -------------------------------------------------------------------------

#[test]
fn negative_length_throws_catchable_range_error() {
    assert_result_agrees(
        "try { new ArrayBuffer(-1); 'none' } catch (e) { e instanceof RangeError }",
    );
    assert_result_agrees(
        "try { new ArrayBuffer(-1.5); 'none' } catch (e) { e instanceof RangeError }",
    );
}

#[test]
fn oversized_length_throws_catchable_range_error() {
    // Above XS's 0x7FFFFFFF chunk ceiling.
    assert_result_agrees(
        "try { new ArrayBuffer(9007199254740991); 'none' } catch (e) { e instanceof RangeError }",
    );
    assert_result_agrees(
        "try { new ArrayBuffer(0x80000000); 'none' } catch (e) { e instanceof RangeError }",
    );
}

// -------------------------------------------------------------------------
// §3  Catchable TypeError on a Symbol/BigInt length or a no-`new` call.
// -------------------------------------------------------------------------

#[test]
fn symbol_length_throws_catchable_type_error() {
    assert_result_agrees(
        "try { new ArrayBuffer(Symbol()); 'none' } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn bigint_length_throws_catchable_type_error() {
    assert_result_agrees(
        "try { new ArrayBuffer(1n); 'none' } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn call_without_new_throws_type_error() {
    assert_result_agrees("try { ArrayBuffer(8); 'none' } catch (e) { e instanceof TypeError }");
    assert_result_agrees("try { ArrayBuffer(); 'none' } catch (e) { e instanceof TypeError }");
}

// -------------------------------------------------------------------------
// §4  SharedArrayBuffer shares the same coercion / error surface.
// -------------------------------------------------------------------------

#[test]
fn shared_array_buffer_ctor_coercion_and_errors() {
    assert_result_agrees("new SharedArrayBuffer('12').byteLength");
    assert_result_agrees(
        "try { new SharedArrayBuffer(-1); 'none' } catch (e) { e instanceof RangeError }",
    );
    assert_result_agrees(
        "try { SharedArrayBuffer(8); 'none' } catch (e) { e instanceof TypeError }",
    );
}
