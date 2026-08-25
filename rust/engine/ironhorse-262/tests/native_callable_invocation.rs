//! Behavioral gate for invoking **native / bound** callables through
//! `Function.prototype.{call,apply,bind}` — the `native-callables` milestone of
//! the Ironhorse JS completion arc (garden `ironhorse-js26-milestone-native-callables`).
//! Prior to this milestone a native receiver/callback (or a non-callable bind
//! target) self-named an honest skip; these cases route the native receiver
//! through the existing `call_native` / `call_native_method` machinery and
//! produce the correct observable result.
//!
//! Each snippet is dual-run against the XS differential oracle; the gate is
//! **result agreement where the oracle accepts the program** (`BothComplete` +
//! `result_agrees`) per the accuracy-over-parity doctrine — computron agreement
//! is advisory for these re-entrant native invocations.

use ironhorse_262::{dual_run, Agreement};

/// Assert a program completes on BOTH engines with the SAME completion value.
fn agrees(source: &str) {
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
// §1  Function.prototype.apply over a native receiver (dense-array forwarding).
// -------------------------------------------------------------------------

#[test]
fn native_apply_forwards_dense_array() {
    // A native constructor/value function receiver spreads a dense array.
    agrees("Math.max.apply(null, [3, 1, 4, 1, 5, 9, 2, 6])");
    agrees("Math.min.apply(null, [3, 1, 4, 1, 5, 9, 2, 6])");
    // Empty / absent argument arrays are the zero-argument subset.
    agrees("Math.max.apply(null, [])");
    agrees("Math.max.apply(null)");
    agrees("Math.max.apply(null, undefined)");
    agrees("Math.max.apply(null, null)");
}

#[test]
fn native_method_apply_over_receiver() {
    // A native *method* receiver (`String.prototype.concat`) applied with a
    // string `this` and a forwarded argument array.
    agrees("String.prototype.concat.apply('a', ['b', 'c', 'd'])");
    // `Array.prototype.join` applied to a real array receiver.
    agrees("Array.prototype.join.apply([1, 2, 3], ['-'])");
}

// -------------------------------------------------------------------------
// §2  Function.prototype.call over a native receiver.
// -------------------------------------------------------------------------

#[test]
fn native_call_over_receiver() {
    agrees("Math.max.call(null, 3, 1, 4, 1, 5)");
    agrees("String.prototype.concat.call('a', 'b', 'c')");
}

// -------------------------------------------------------------------------
// §3  Function.prototype.bind step 2 — non-callable target throws TypeError.
// -------------------------------------------------------------------------

#[test]
fn bind_non_callable_target_throws_type_error() {
    agrees(
        "var ok; try { Function.prototype.bind.call({}); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok; try { Function.prototype.bind.call(undefined, {}); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok; try { Function.prototype.bind.call(null, {}); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    // A plain object with an inherited `.bind` is still a non-callable target.
    agrees(
        "function Foo() {} var f = new Foo(); f.bind = Function.prototype.bind; \
         var ok; try { f.bind(); ok = false; } catch (e) { ok = e instanceof TypeError; } ok",
    );
}

// -------------------------------------------------------------------------
// §4  `new` on `Function.prototype.{call,apply}` — not a constructor.
// -------------------------------------------------------------------------

#[test]
fn new_on_call_apply_throws_type_error() {
    agrees(
        "var ok; try { new Function.prototype.call(); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
    agrees(
        "var ok; try { new Function.prototype.apply(); ok = false; } \
         catch (e) { ok = e instanceof TypeError; } ok",
    );
}
