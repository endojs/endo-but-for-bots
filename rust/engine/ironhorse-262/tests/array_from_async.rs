//! `Array.fromAsync` causal regressions (ECMA-262 sec-array.fromasync). Each
//! executes both the Rust engine and the pinned XS oracle, drains the microtask
//! queue, and inspects a post-drain global the `.then`/`.catch` chain writes.
//! `fromAsync` is a native async state machine, so these lock the observable
//! async behavior across its four input shapes (async-iterable, sync-iterable,
//! array-like, and the `CreateAsyncFromSyncIterator` sync path) plus `mapfn`,
//! `thisArg`, the this-constructor behavior, and the error/close semantics.

use ironhorse_262::{dual_run_async, Agreement};

/// Run `source` (which settles the global `g` after the drain) against both
/// engines and assert ironhorse agrees with XS and produced `expected`.
fn assert_signal(source: &str, expected: &str) {
    let run = dual_run_async(source, "g").expect("XS oracle machine");
    assert_eq!(run.run.agreement, Agreement::BothComplete, "{:?}", run.run);
    assert_eq!(run.ironhorse_signal.as_deref(), Some(expected), "{source}");
}

#[test]
fn async_iterable_input() {
    assert_signal(
        "var g=''; async function* f(){ yield 1; yield 2; yield 3; } \
         Array.fromAsync(f()).then(function(r){ g='['+r.join(',')+']'; }, \
           function(e){ g='ERR'; }); undefined",
        "[1,2,3]",
    );
}

#[test]
fn sync_iterable_values_iterator() {
    assert_signal(
        "var g=''; Array.fromAsync([0,1,2].values()).then(function(r){ g='['+r.join(',')+']'; }, \
           function(e){ g='ERR'; }); undefined",
        "[0,1,2]",
    );
}

#[test]
fn raw_array_iterates_live() {
    // The sync array iterator is live: an element pushed after the synchronous
    // first `next()` is still transferred (proposal note; asyncitems-array-add).
    assert_signal(
        "var g=''; var items=[1,2,3]; var p=Array.fromAsync(items); items.push(4); \
         p.then(function(r){ g='['+r.join(',')+']'; }, function(e){ g='ERR'; }); undefined",
        "[1,2,3,4]",
    );
}

#[test]
fn array_like_input() {
    assert_signal(
        "var g=''; Array.fromAsync({length:3,0:0,1:1,2:2,3:9}).then(function(r){ g='['+r.join(',')+']'; }, \
           function(e){ g='ERR'; }); undefined",
        "[0,1,2]",
    );
}

#[test]
fn array_like_with_thenable_awaited() {
    // Every array-like element is Await'd (unwrapping a thenable) once.
    assert_signal(
        "var g=''; var c=0; var t={then:function(res){ c++; res(42); }}; \
         Array.fromAsync({length:1,0:t}).then(function(r){ g='v'+r[0]+'c'+c; }, function(e){ g='ERR'; }); undefined",
        "v42c1",
    );
}

#[test]
fn sync_iterable_with_thenable_awaited_once() {
    assert_signal(
        "var g=''; var c=0; var t={then:function(res){ c++; res({}); }}; \
         Array.fromAsync([t].values()).then(function(){ g='c'+c; }, function(e){ g='ERR'; }); undefined",
        "c1",
    );
}

#[test]
fn mapfn_applied_and_awaited() {
    assert_signal(
        "var g=''; Array.fromAsync([1,2,3], function(x,i){ return x*10+i; }).then(\
           function(r){ g='['+r.join(',')+']'; }, function(e){ g='ERR'; }); undefined",
        "[10,21,32]",
    );
}

#[test]
fn mapfn_this_arg() {
    assert_signal(
        "var g=''; var ta={m:7}; Array.fromAsync([1], function(){ return this.m; }, ta).then(\
           function(r){ g='v'+r[0]; }, function(e){ g='ERR'; }); undefined",
        "v7",
    );
}

#[test]
fn mapfn_not_callable_rejects() {
    assert_signal(
        "var g=''; Array.fromAsync([1,2], 42).then(function(){ g='OK'; }, \
           function(e){ g='REJ:'+(e instanceof TypeError); }); undefined",
        "REJ:true",
    );
}

#[test]
fn null_input_rejects_typeerror() {
    assert_signal(
        "var g=''; Array.fromAsync(null).then(function(){ g='OK'; }, \
           function(e){ g='REJ:'+(e instanceof TypeError); }); undefined",
        "REJ:true",
    );
}

#[test]
fn mapfn_throw_rejects_and_closes_iterator() {
    // A throwing mapfn rejects the result promise AND closes the (sync) iterator
    // via its `return` method (IteratorClose on the abrupt completion).
    assert_signal(
        "var g=''; var closed=false; \
         function* gen(){ try { yield 1; yield 2; } finally { closed=true; } } \
         Array.fromAsync(gen(), function(){ throw {tag:9}; }).then(function(){ g='OK'; }, \
           function(e){ g='rej'+e.tag+'closed'+closed; }); undefined",
        "rej9closedtrue",
    );
}

#[test]
fn mapfn_throw_preserves_rejection_object_identity() {
    assert_signal(
        "var g=''; var marker={tag:9}; Array.fromAsync([1], function(){ throw marker; }).then(\
         function(){ g='OK'; }, function(e){ g=(e===marker)+':'+e.tag; }); undefined",
        "true:9",
    );
}

#[test]
fn iteration_error_rejects() {
    assert_signal(
        "var g=''; async function* f(){ throw {tag:5}; } \
         Array.fromAsync(f()).then(function(){ g='OK'; }, function(e){ g='rej'+e.tag; }); undefined",
        "rej5",
    );
}

#[test]
fn this_constructor_used_once_for_iterable() {
    assert_signal(
        "var g=''; var calls=0; function MyArray(){ calls++; } \
         Array.fromAsync.call(MyArray, [1,2]).then(function(r){ \
           g=(r instanceof MyArray)+':'+r.length+':'+r[0]+':'+r[1]+':'+calls; }, \
           function(e){ g='ERR'; }); undefined",
        "true:2:1:2:1",
    );
}

#[test]
fn non_constructor_this_makes_array() {
    assert_signal(
        "var g=''; Array.fromAsync.call({}, [1,2]).then(function(r){ \
           g=Array.isArray(r)+':['+r.join(',')+']'; }, function(e){ g='ERR'; }); undefined",
        "true:[1,2]",
    );
}

#[test]
fn string_input_iterates_code_points() {
    assert_signal(
        "var g=''; Array.fromAsync('abc').then(function(r){ g='['+r.join(',')+']'; }, \
           function(e){ g='ERR'; }); undefined",
        "[a,b,c]",
    );
}

#[test]
fn returns_a_promise() {
    assert_signal(
        "var g=''; var p=Array.fromAsync([1]); \
         g=(p instanceof Promise)+':'+(Object.getPrototypeOf(p)===Promise.prototype); \
         p.then(function(){}, function(){}); undefined",
        "true:true",
    );
}
