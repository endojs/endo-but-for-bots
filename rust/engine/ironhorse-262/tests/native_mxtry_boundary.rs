//! A native-validation raise that becomes catchable (`Halt::Resume`) must NOT
//! cross the native `mxTry` boundary `run_callback_catching_throw` models —
//! a promise executor's (or thenable/finally/dispose handler's) TypeError has
//! to be captured at that boundary (the promise rejects), never unwind into a
//! guest `try` live around the native call.
//!
//! Regression: the round-2 ratchet converted native validation sites
//! (`defineProperty target`, `copy target`, `Object.create prototype`, the
//! not-callable callee, …) from a bare `Halt::Throw` into a `raise_js` that
//! resolves to `Halt::Resume` the moment a handler is visible on the jump
//! chain. `run_callback_catching_throw` left the caller's chain unfenced, so a
//! raise inside the executor consumed the OUTER handler and leaked the
//! `Resume` past the boundary: `new Promise(function(){ throw }) ` inside an
//! outer `try` landed in that outer `catch` (and the promise never settled),
//! where XS rejects the promise and the outer `try` sees nothing. Fixed by
//! fencing `self.jumps` for the callback's duration, mirroring the
//! async-generator body fence at `resume_async_generator`.

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
fn executor_native_type_error_rejects_not_outer_catch() {
    // The load-bearing case: a native-validation TypeError inside the promise
    // executor must reject the promise (returning `'no'`), never resume the
    // OUTER `catch` (which would return `'caught'`).
    assert_result_agrees(
        "function f(){ \
           try { new Promise(function(){ Object.defineProperty(true, 'x', {}); }); } \
           catch (e) { return 'caught'; } \
           return 'no'; \
         } f();",
    );
}

#[test]
fn executor_not_callable_type_error_rejects_not_outer_catch() {
    // Same boundary via the not-callable callee raise site.
    assert_result_agrees(
        "function f(){ \
           try { new Promise(function(){ Math(); }); } \
           catch (e) { return 'caught'; } \
           return 'no'; \
         } f();",
    );
}

#[test]
fn executor_own_try_still_catches() {
    // Fencing must not break a `try` established INSIDE the executor: its own
    // handler still catches the native-validation raise.
    assert_result_agrees(
        "var seen = 'none'; \
         new Promise(function(){ \
           try { Object.defineProperty(true, 'x', {}); } catch (e) { seen = e instanceof TypeError; } \
         }); \
         seen;",
    );
}

#[test]
fn thenable_then_native_type_error_does_not_escape() {
    // The thenable-adoption `then` job runs through the same native `mxTry`
    // helper; a native raise inside `then` must not unwind into an outer try.
    assert_result_agrees(
        "var out = 'no'; \
         try { \
           Promise.resolve({ then: function(){ Object.defineProperty(true, 'x', {}); } }); \
         } catch (e) { out = 'caught'; } \
         out;",
    );
}
