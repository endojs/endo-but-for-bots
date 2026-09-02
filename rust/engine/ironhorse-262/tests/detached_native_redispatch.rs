//! Detached-native `.call`/`.apply` re-dispatch, metered against the XS
//! oracle (review wave 4, DET-2/DET-3).
//!
//! `nativeF.call(t, …)` and `nativeF.apply(t, [ … ])` reach the same
//! native callee by different host routes, and the route's cost belongs
//! to the re-dispatch method, not the callee: XS's
//! `fx_Function_prototype_apply` unpacks the argument array
//! (`fxToInstance`/`fxToLength`, the `_length` read, a `mxGetIndex` per
//! element) before it tail-calls, and that unpack is callee-agnostic.
//!
//! The engine's own detached-native suite
//! (`ironhorse-snapshot/tests/detached_natives.rs`) pins RESULTS only, so
//! a meter charged with the wrong constants sails through it. These
//! snippets assert **bit-exactness** — completion, result, AND computrons
//! — which is what actually gates the constants. Adding one element to an
//! apply array must move ironhorse's count by exactly what it moves XS's.

use ironhorse_262::{dual_run, Agreement};

/// The full acceptance bar for one program: both engines complete, same
/// result, same computrons. Reports the divergence verbatim so a
/// regression names itself.
fn assert_bit_exact(source: &str) {
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
    assert!(
        dr.computrons_agree,
        "`{source}` computrons: oracle={} ironhorse={} (delta {})",
        dr.oracle_computrons,
        dr.ironhorse_computrons,
        dr.ironhorse_computrons as i64 - dr.oracle_computrons as i64,
    );
}

#[test]
fn detached_native_dot_call_is_metered_exactly() {
    // Zero, one, and two forwarded arguments: `.call` copies each, so
    // the per-argument constant is what these pin.
    assert_bit_exact("var n = 0; var o = 0; o = { a: 1 }; n = Object.keys; n.call(null, o).length");
    assert_bit_exact("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.call(a, 9); a.length");
    assert_bit_exact("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.call(a, 9, 10); a.length");
}

#[test]
fn detached_native_dot_apply_is_metered_exactly() {
    // The array path: its base and per-element constants are DIFFERENT
    // from `.call`'s per-argument constant, and charging `.call`'s
    // (the DET-2 defect) undercharges every one of these.
    assert_bit_exact("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, []); a.length");
    assert_bit_exact("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, [7]); a.length");
    assert_bit_exact("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, [7, 8]); a.length");
    assert_bit_exact(
        "var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, [7, 8, 9, 10]); a.length",
    );
    assert_bit_exact("var n = 0; var o = 0; o = { a: 1 }; n = Object.keys; n.apply(null, [o]).length");
}

#[test]
fn detached_native_dot_apply_without_an_array_matches_a_zero_arg_call() {
    // The no-array subset pays no unpack at all — its base is already
    // folded into the shared trampoline constant. Pinning it separately
    // keeps a future "just always charge the array base" from passing.
    assert_bit_exact("var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a); a.length");
    assert_bit_exact("var n = 0; var a = 0; a = [3]; n = a.pop; n.apply(a)");
}
