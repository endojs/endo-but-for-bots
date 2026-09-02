//! Stage-7 child 3/7 behavioral gate: `Promise.prototype.finally` and the
//! promise combinators (`Promise.all`/`allSettled`/`race`/`any`) on the landed
//! 5-slot native-reaction path (design [`designs/ironhorse-engine.md`] §
//! promises; the review ledger's promise residuals).
//!
//! Each combinator builds a derived promise, consumes the input's live iterator,
//! resolves each yielded value through the constructor's observable `resolve`
//! method, and registers a native reaction whose drain behavior folds the
//! element's settlement into the shared `remainingElementsCount` / results
//! state — the same crank discipline the existing promise tests lock (reactions
//! run at the pump-loop drain, never synchronously).
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
fn native_promise_with_own_then_uses_thenable_assimilation() {
    assert_drains_to(
        "var g,p=Promise.resolve(1); p.then=function(resolve){resolve(9);}; new Promise(function(resolve){resolve(p);}).then(function(v){g=v;}); undefined",
        "9",
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

#[test]
fn static_combinator_does_not_consult_constructor_species() {
    let run = dual_run(
        "function C(executor){executor(function(){},function(){});} Object.defineProperty(C,Symbol.species,{get:function(){throw 1;}}); Promise.all.call(C,[])",
    )
    .expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete);
    assert!(
        run.result_agrees,
        "custom static capability result must agree"
    );
}

#[test]
fn combinators_accept_string_iterables_by_code_point() {
    assert_drains_to(
        r#"var g; Promise.all('a\uD83D\uDE00').then(function(v){g=v.length+':'+v[0]+v[1];}); undefined"#,
        "2:a😀",
    );
}

#[test]
fn non_iterable_combinator_input_rejects_with_type_error() {
    assert_drains_to(
        "var g; Promise.all(1).then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
    assert_drains_to(
        "var g,a=[]; a[Symbol.iterator]=null; Promise.race(a).then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
}

#[test]
fn iterator_method_returning_a_primitive_rejects_capability() {
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){return 1;}; Promise.any(o).then(undefined,function(e){g=e.name;}); undefined",
        "TypeError",
    );
}

#[test]
fn combinators_consume_custom_iterator_protocols() {
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<3?{value:++i,done:false}:{done:true}}}}; Promise.all(o).then(function(a){g=a.join(',')}); undefined",
        "1,2,3",
    );
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<2?{value:++i,done:false}:{done:true}}}}; Promise.allSettled(o).then(function(a){g=a[0].status+':'+a[1].value}); undefined",
        "fulfilled:2",
    );
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<2?{value:++i,done:false}:{done:true}}}}; Promise.race(o).then(function(v){g=''+v}); undefined",
        "1",
    );
    assert_drains_to(
        "var g,o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<2?{value:++i,done:false}:{done:true}}}}; Promise.any(o).then(function(v){g=''+v}); undefined",
        "1",
    );
}

#[test]
fn promise_resolve_is_read_once_before_iterator_acquisition() {
    assert_drains_to(
        "var g,log='',old=Promise.resolve,o={}; Object.defineProperty(Promise,'resolve',{configurable:true,get:function(){log+='r';return old}}); o[Symbol.iterator]=function(){log+='i';return {next:function(){log+='n';return {done:true}}}}; Promise.all(o).then(function(){g=log}); undefined",
        "rin",
    );
}

#[test]
fn iterator_step_failures_reject_without_closing() {
    assert_drains_to(
        "var g,closed=0,marker={},o={}; o[Symbol.iterator]=function(){return {next:function(){throw marker},return:function(){closed++;return {}}}}; Promise.all(o).then(undefined,function(e){g=(e===marker)+':'+closed}); undefined",
        "true:0",
    );
    assert_drains_to(
        "var g,closed=0,marker={},step={value:1}; Object.defineProperty(step,'done',{get:function(){throw marker}}); var o={}; o[Symbol.iterator]=function(){return {next:function(){return step},return:function(){closed++;return {}}}}; Promise.race(o).then(undefined,function(e){g=(e===marker)+':'+closed}); undefined",
        "true:0",
    );
    assert_drains_to(
        "var g,closed=0,marker={},step={done:false}; Object.defineProperty(step,'value',{get:function(){throw marker}}); var o={}; o[Symbol.iterator]=function(){return {next:function(){return step},return:function(){closed++;return {}}}}; Promise.allSettled(o).then(undefined,function(e){g=(e===marker)+':'+closed}); undefined",
        "true:0",
    );
}

#[test]
fn element_processing_failures_close_before_rejecting() {
    assert_drains_to(
        "var g,closed=0,marker={},old=Promise.resolve,o={}; Promise.resolve=function(){throw marker}; o[Symbol.iterator]=function(){return {next:function(){return {value:1,done:false}},return:function(){closed++;return {}}}}; Promise.all(o).then(undefined,function(e){g=(e===marker)+':'+closed}); Promise.resolve=old; undefined",
        "true:1",
    );
    assert_drains_to(
        "var g,closed=0,marker={},p=Promise.resolve(1),o={}; Object.defineProperty(p,'then',{get:function(){throw marker}}); var old=Promise.resolve; Promise.resolve=function(){return p}; o[Symbol.iterator]=function(){return {next:function(){return {value:1,done:false}},return:function(){closed++;return {}}}}; Promise.race(o).then(undefined,function(e){g=(e===marker)+':'+closed}); Promise.resolve=old; undefined",
        "true:1",
    );
}

#[test]
fn array_iteration_observes_growth_caused_by_promise_resolve() {
    assert_drains_to(
        "var g,a=[1],old=Promise.resolve; Promise.resolve=function(v){if(v===1)a.push(2);return old.call(Promise,v)}; Promise.all(a).then(function(v){g=v.join(',')}); Promise.resolve=old; undefined",
        "1,2",
    );
}

#[test]
fn custom_then_methods_drive_each_combinator() {
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f){f(v+1)}}}; Promise.all([1,2]).then(function(v){g=v.join(',')}); undefined",
        "2,3",
    );
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f,r){f(v);r(9)}}}; Promise.allSettled([1]).then(function(v){g=v[0].status+':'+v[0].value}); undefined",
        "fulfilled:1",
    );
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f,r){if(v===1)r(7);else f(v)}}}; Promise.race([1,2]).then(function(v){g='f'+v},function(e){g='r'+e}); undefined",
        "r7",
    );
    assert_drains_to(
        "var g; Promise.resolve=function(v){return {then:function(f,r){if(v===1)r(7);else f(v)}}}; Promise.any([1,2]).then(function(v){g='f'+v},function(e){g='r'}); undefined",
        "f2",
    );
}

#[test]
fn captured_element_callback_remains_live_after_iteration() {
    assert_drains_to(
        "var g,fulfill; Promise.resolve=function(){return {then:function(f){fulfill=f}}}; var p=Promise.all([1]); fulfill(4); fulfill(5); p.then(function(v){g=v.join(',')}); undefined",
        "4",
    );
}
