//! Detached-native call/apply redispatch retains XS completion and result
//! agreement. Version 2 adds admitted argument/key copies; frozen raw totals
//! separately pin zero-, one-, and multi-argument forwarding costs.

mod w2_meter_support;

use ironhorse_262::{dual_run, Agreement};

/// Both engines complete with the same result and the frozen version-4 cost.
fn assert_version_four(source: &str) {
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
        "`{source}` result: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
    w2_meter_support::assert_raw(source, dr.ironhorse_meter_raw);
}

#[test]
fn detached_native_dot_call_has_version_four_costs() {
    // Zero, one, and two forwarded arguments: `.call` copies each, so
    // the per-argument constant is what these pin.
    assert_version_four(
        "var n = 0; var o = 0; o = { a: 1 }; n = Object.keys; n.call(null, o).length",
    );
    assert_version_four("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.call(a, 9); a.length");
    assert_version_four("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.call(a, 9, 10); a.length");
}

#[test]
fn detached_native_dot_apply_has_version_four_costs() {
    // The array path: its base and per-element constants are DIFFERENT
    // from `.call`'s per-argument constant, and charging `.call`'s
    // (the DET-2 defect) undercharges every one of these.
    assert_version_four("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, []); a.length");
    assert_version_four("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, [7]); a.length");
    assert_version_four(
        "var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, [7, 8]); a.length",
    );
    assert_version_four(
        "var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, [7, 8, 9, 10]); a.length",
    );
    assert_version_four(
        "var n = 0; var o = 0; o = { a: 1 }; n = Object.keys; n.apply(null, [o]).length",
    );
}

#[test]
fn detached_native_dot_apply_without_an_array_matches_a_zero_arg_call() {
    // The no-array subset pays no unpack at all — its base is already
    // folded into the shared trampoline constant. Pinning it separately
    // keeps a future "just always charge the array base" from passing.
    assert_version_four("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a); a.length");
    assert_version_four("var n = 0; var a = 0; a = [3]; n = a.pop; n.apply(a)");
}
