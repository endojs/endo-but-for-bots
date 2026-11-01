//! `Promise.prototype.finally`, promise adoption, and `Promise.any` causal
//! regressions (ECMA-262 sec-promise.prototype.finally,
//! sec-promise-resolve-functions, sec-performpromiseany). Each executes both
//! the Rust engine and the pinned XS oracle, drains the microtask queue, and
//! inspects a post-drain global. They lock the observable shape that the
//! native `finally` and adoption fast paths must preserve: subclass
//! constructions, the value thunk passed to a replaced `then`, and the
//! reasons recorded by synchronously invoked `any` reject elements.

use ironhorse_262::{dual_run_async, Agreement};

/// Run `source` (which settles the global `g` after the drain) against both
/// engines and assert ironhorse agrees with XS and produced `expected`.
fn assert_signal(source: &str, expected: &str) {
    let run = dual_run_async(source, "g").expect("XS oracle machine");
    assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
    assert_eq!(run.ironhorse_signal.as_deref(), Some(expected), "{source}");
}

const COUNTING_SUBCLASS: &str = "var g=''; var c=0; \
     class P extends Promise { constructor(e){ c++; return super(e); } } ";

#[test]
fn subclass_finally_on_fulfilled_constructs_through_species() {
    // `then(thenFinally, catchFinally)`, `PromiseResolve(C, onFinally())`,
    // `.then(valueThunk)`, and the derived promise's adoption of that result
    // each construct a `P`, alongside `P.resolve()` and the trailing `.then`.
    assert_signal(
        &format!(
            "{COUNTING_SUBCLASS} P.resolve().finally(function(){{}}).then(function(){{ g='c'+c; }}, \
               function(){{ g='ERR'; }}); undefined"
        ),
        "c6",
    );
}

#[test]
fn subclass_finally_on_rejected_constructs_through_species() {
    assert_signal(
        &format!(
            "{COUNTING_SUBCLASS} P.reject(1).finally(function(){{}}).then(function(){{ g='ERR'; }}, \
               function(r){{ g='c'+c+'r'+r; }}); undefined"
        ),
        "c6r1",
    );
}

#[test]
fn replaced_then_sees_finally_value_thunk() {
    // A `then` replaced after `finally` registered still observes the spec's
    // arguments: first the zero-length value thunk, then the derived
    // promise's length-1 resolving function adopting that result.
    assert_signal(
        "var g=''; var seen=[]; var then=Promise.prototype.then; \
         Promise.resolve(7).finally(function(){}).then(function(v){ g=seen.join(',')+':'+v; }); \
         Promise.prototype.then=function(f){ seen.push(f.length+'/'+(typeof f.prototype)); \
           if (seen.length===1) seen.push('thunk='+f()); \
           return then.call(this, f, arguments[1]); }; undefined",
        "0/undefined,thunk=7,1/undefined:7",
    );
}

#[test]
fn subclass_promise_adoption_calls_species_then() {
    // Resolving with a subclass instance queues a job that calls its `then`,
    // which constructs the derived promise through `P`.
    assert_signal(
        &format!(
            "{COUNTING_SUBCLASS} var p=P.resolve(3); c=0; \
             Promise.resolve().then(function(){{ return p; }}).then(function(v){{ g='c'+c+'v'+v; }}); undefined"
        ),
        "c1v3",
    );
}

#[test]
fn any_reports_reasons_rejected_during_iteration() {
    // Every element rejects synchronously through a custom `then`, so the
    // final decrement after iteration rejects with all recorded reasons.
    assert_signal(
        "var g=''; function C(ex){ ex(function(){ g='RESOLVED'; }, \
           function(e){ g=(e instanceof AggregateError)+':'+Array.isArray(e.errors)+':'+e.errors.join(','); }); } \
         C.resolve=function(v){ return v; }; \
         function rej(x){ return { then: function(f, r){ r(x); r('again'); } }; } \
         Promise.any.call(C, [rej('a'), rej('b')]); undefined",
        "true:true:a,b",
    );
}
