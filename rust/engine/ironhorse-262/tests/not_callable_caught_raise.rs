//! A **caught** not-callable `TypeError` must resume at the handler as a
//! plain raise, dual-run against the pinned XS oracle.
//!
//! Regression: `enter_call`'s not-callable arm returned `raise_js`'s
//! `Ok(handler_pc)` directly, so every caller interpreted the catch-handler
//! pc as a callee `body_start`. In-loop RUN dispatch happened to work, but
//! `call_cross_segment` (the route a non-function callee takes once any
//! function definition has retained a code segment, since it has no
//! `func_segments` entry) dispatched the handler as a nested function body
//! in the wrong frame: the eventual `end` returned to the *inner* call's
//! continuation, corrupting locals and completing with a stale or empty
//! value. Observed in the full sweep as 14 `Fail` divergences (test262
//! `built-ins/{JSON,Math,Reflect,Atomics}/prop-desc.js`,
//! `built-ins/JSON/15.12-0-{2,3}.js`, `built-ins/global/S15.1_A1_T{1,2}.js`
//! and `S15.1_A2_T1.js`, `built-ins/Object/prototype/S15.2.4_A{3,4}.js`,
//! `built-ins/Function/prototype/S15.3.4_A5.js`,
//! `language/types/object/S8.6.2_A7.js`,
//! `language/expressions/new/ctorExpr-isCtor-after-args-eval.js`) plus an
//! `ironhorse-aborted` skip class for the same shape inside function bodies.

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

#[test]
fn caught_namespace_call_in_function_returns_catch_value() {
    assert_result_agrees(
        "function f(){ try { JSON(); } catch (e) { return e instanceof TypeError; } } f();",
    );
}

#[test]
fn caught_namespace_construct_in_function_resumes_after_catch() {
    assert_result_agrees(
        "function f(){ try { new JSON(); } catch (e) {} return true; } f();",
    );
}

#[test]
fn caught_local_variable_callee_raises_in_frame() {
    assert_result_agrees(
        "function f(){ var m = Math; try { m(); } catch (e) { return e instanceof TypeError; } } f();",
    );
}

#[test]
fn caught_member_callee_raises_in_frame() {
    assert_result_agrees(
        "var o = { m: Math }; \
         function f(){ try { o.m(); } catch (e) { return e instanceof TypeError; } } f();",
    );
}

#[test]
fn toplevel_continuation_survives_caught_raise_in_callee() {
    assert_result_agrees(
        "function f(){ try { new JSON(); } catch (e) {} } f(); 42;",
    );
}

#[test]
fn toplevel_try_statement_completion_is_undefined() {
    // The whole-program completion after a caught raise must be the try
    // statement's `undefined`, not a stale earlier completion value (the
    // `formatSimpleValue` leak shape from the harness prelude).
    assert_result_agrees("9; try { new JSON(); } catch (e) {}");
}

#[test]
fn caught_raise_inside_native_driven_callback() {
    assert_result_agrees(
        "var r = [1].map(function(x){ try { JSON(); } catch (e) { return e instanceof TypeError; } }); r[0];",
    );
}

#[test]
fn uncaught_not_callable_still_aborts_on_both() {
    let dr = dual_run("function f(){ Math(); } f();").expect("oracle must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothAbort,
        "an uncaught not-callable TypeError must abort on both engines",
    );
}
