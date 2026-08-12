//! Stage-7 child 3/7 behavioral gate: `Promise.prototype.finally` and the
//! promise combinators (`Promise.all`/`allSettled`/`race`/`any`) on the landed
//! 5-slot native-reaction path (design [`designs/ironhorse-engine.md`] §
//! promises; the review ledger's promise residuals).
//!
//! Each combinator builds a derived promise, resolves each (dense-Array)
//! element to a promise, and registers a native reaction whose drain behavior
//! folds the element's settlement into the shared `remainingElementsCount` /
//! results state — the same crank discipline the existing promise tests lock
//! (reactions run at the pump-loop drain, never synchronously).
//!
//! Two gates per the accuracy-over-parity doctrine:
//!   1. **Result agreement** — the program's completion value agrees with the
//!      XS oracle where the oracle accepts it (`BothComplete` +
//!      `result_agrees`); the combinator/finally programs complete `undefined`
//!      synchronously (the derived promise settles at the drain), so this
//!      certifies ironhorse reproduces the oracle's whole execution *including* the
//!      microtask drain.
//!   2. **Observable resolution** — the combinator's *resolved value* is read
//!      out of a post-drain global (`g`, rendered as ironhorse's async signal) and
//!      checked against the analytically-known value XS's combinators produce.
//! Plus a **determinism** gate: identical computrons across repeated ironhorse runs
//! (the meter is deterministic-per-release; oracle agreement is advisory).

use ironhorse_262::{dual_run, Agreement};

/// Run `source` on both engines, assert they both complete with an agreeing
/// completion value, and assert ironhorse's post-drain global `g` renders to
/// `expected` — the resolved/observed value the combinator produced at the
/// drain. Also asserts the ironhorse meter is deterministic across repeated runs.
fn assert_drains_to(source: &str, expected: &str) {
    let a = ironhorse_262::dual_run_async(source, "g").expect("the XS oracle machine must start");
    assert_eq!(
        a.run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        a.run.ironhorse_halt,
        a.run.oracle_result,
        a.run.ironhorse_result,
    );
    assert!(
        a.run.result_agrees,
        "`{source}` completion divergence: oracle={:?} ironhorse={:?}",
        a.run.oracle_result, a.run.ironhorse_result,
    );
    assert_eq!(
        a.ironhorse_signal.as_deref(),
        Some(expected),
        "`{source}` post-drain global `g`: expected {:?}",
        expected,
    );
    assert_deterministic(source);
}

/// The ironhorse meter must be deterministic across repeated runs of the same
/// program (identical computrons) — the deterministic-per-release meter gate.
fn assert_deterministic(source: &str) {
    let a = dual_run(source)
        .expect("oracle machine")
        .ironhorse_computrons;
    let b = dual_run(source)
        .expect("oracle machine")
        .ironhorse_computrons;
    assert_eq!(
        a, b,
        "`{source}` ironhorse computrons must be deterministic across runs"
    );
}

// -------------------------------------------------------------------------
// §1  `Promise.prototype.finally`.
// -------------------------------------------------------------------------

#[test]
fn finally_passes_a_fulfillment_through_after_running_on_finally() {
    // `onFinally` runs (side effect) then the original value passes through.
    assert_drains_to(
        "var order=''; var g; \
         Promise.resolve(7).finally(function(){order+='f';}).then(function(v){g=order+':'+v;}); \
         undefined",
        "f:7",
    );
}

#[test]
fn finally_passes_a_rejection_through() {
    // A rejected receiver: `onFinally` runs, then the reason passes through to
    // the `onRejected` handler (finally does not swallow the rejection).
    assert_drains_to(
        "var g; \
         Promise.reject(9).finally(function(){}).then(function(v){g='F'+v;}, function(e){g='R'+e;}); \
         undefined",
        "R9",
    );
}

#[test]
fn finally_return_value_is_ignored() {
    // `onFinally`'s (non-thenable) return value is discarded — the original
    // fulfillment value is what flows on.
    assert_drains_to(
        "var g; Promise.resolve(4).finally(function(){return 99;}).then(function(v){g=''+v;}); undefined",
        "4",
    );
}

#[test]
fn finally_with_non_callable_is_a_pass_through() {
    // A non-callable `onFinally` (`this.then(x, x)`): pure pass-through.
    assert_drains_to(
        "var g; Promise.resolve(3).finally(undefined).then(function(v){g=''+v;}); undefined",
        "3",
    );
}

// -------------------------------------------------------------------------
// §2  `Promise.all` — resolve with the ordered values, reject on the first.
// -------------------------------------------------------------------------

#[test]
fn all_resolves_with_the_ordered_values() {
    assert_drains_to(
        "var g; Promise.all([1,2,3]).then(function(a){g=''+a[0]+a[1]+a[2];}); undefined",
        "123",
    );
}

#[test]
fn all_places_values_by_index_not_settle_order() {
    // A later index resolved synchronously and an earlier one through a
    // promise: the result Array is still index-ordered.
    assert_drains_to(
        "var g; Promise.all([Promise.resolve(10), 20]).then(function(a){g=''+(a[0]+a[1]);}); undefined",
        "30",
    );
}

#[test]
fn all_rejects_on_the_first_rejection() {
    assert_drains_to(
        "var g; Promise.all([1, Promise.reject(5), 3]).then(function(a){g='F';}, function(e){g='R'+e;}); undefined",
        "R5",
    );
}

#[test]
fn all_of_empty_resolves_with_an_empty_array() {
    assert_drains_to(
        "var g; Promise.all([]).then(function(a){g='len'+a.length;}); undefined",
        "len0",
    );
}

// -------------------------------------------------------------------------
// §3  `Promise.allSettled` — a status record per element, never rejects.
// -------------------------------------------------------------------------

#[test]
fn all_settled_records_fulfilled_and_rejected() {
    assert_drains_to(
        "var g; Promise.allSettled([1, Promise.reject(2)]).then(function(a){\
         g=a[0].status+','+a[0].value+','+a[1].status+','+a[1].reason;}); undefined",
        "fulfilled,1,rejected,2",
    );
}

#[test]
fn all_settled_of_empty_resolves_empty() {
    assert_drains_to(
        "var g; Promise.allSettled([]).then(function(a){g='n'+a.length;}); undefined",
        "n0",
    );
}

// -------------------------------------------------------------------------
// §4  `Promise.race` — the first element to settle wins.
// -------------------------------------------------------------------------

#[test]
fn race_settles_with_the_first_fulfillment() {
    assert_drains_to(
        "var g; Promise.race([1,2]).then(function(v){g='v'+v;}, function(e){g='e'+e;}); undefined",
        "v1",
    );
}

#[test]
fn race_settles_with_the_first_rejection() {
    assert_drains_to(
        "var g; Promise.race([Promise.reject(8), 2]).then(function(v){g='v'+v;}, function(e){g='e'+e;}); undefined",
        "e8",
    );
}

// -------------------------------------------------------------------------
// §5  `Promise.any` — the first fulfillment wins; else an AggregateError.
// -------------------------------------------------------------------------

#[test]
fn any_settles_with_the_first_fulfillment() {
    assert_drains_to(
        "var g; Promise.any([1,2]).then(function(v){g='v'+v;}, function(e){g='e';}); undefined",
        "v1",
    );
}

#[test]
fn any_rejects_with_an_aggregate_error_when_all_reject() {
    assert_drains_to(
        "var g; Promise.any([Promise.reject(1), Promise.reject(2)]).then(\
         function(v){g='v'+v;}, function(e){g=e.name+':'+e.errors.length+':'+e.errors[0]+e.errors[1];}); undefined",
        "AggregateError:2:12",
    );
}

#[test]
fn any_of_empty_rejects_with_an_empty_aggregate_error() {
    assert_drains_to(
        "var g; Promise.any([]).then(function(v){g='v';}, function(e){g=e.name+e.errors.length;}); undefined",
        "AggregateError0",
    );
}

// -------------------------------------------------------------------------
// §6  Rejection propagation and async resume boundaries.
// -------------------------------------------------------------------------

#[test]
fn thrown_reaction_rejects_the_derived_promise() {
    assert_drains_to(
        "var g; Promise.resolve(1).then(function(){throw 7;}).then(undefined,function(e){g='e'+e;}); undefined",
        "e7",
    );
}

#[test]
fn throwing_thenable_rejects_the_adopting_promise() {
    assert_drains_to(
        "var g; Promise.resolve({then:function(){throw 8;}}).then(undefined,function(e){g='e'+e;}); undefined",
        "e8",
    );
}

#[test]
fn native_promise_resolution_is_adopted_asynchronously() {
    assert_drains_to(
        "var g; Promise.resolve(Promise.resolve(9)).then(function(v){g='v'+v;}); undefined",
        "v9",
    );
}

#[test]
fn await_preserves_try_catch_across_suspension() {
    assert_drains_to(
        "var g; (async function(){try{await Promise.reject(10);}catch(e){g='e'+e;}})(); undefined",
        "e10",
    );
}

#[test]
fn resolving_a_promise_with_itself_rejects_with_type_error() {
    assert_drains_to(
        "var g,r,p=new Promise(function(resolve){r=resolve;}); r(p); p.then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
}
