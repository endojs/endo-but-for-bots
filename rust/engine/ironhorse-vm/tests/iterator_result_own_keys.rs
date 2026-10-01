//! An intrinsic iterator's `{value, done}` result carries both own properties
//! whether or not the program ever spells either name.
//!
//! The Array, String and collection iterators write the fields under the
//! cached `value_id` / `done_id`, which `bind_program_symbols` fills only when
//! the program names `value` or `done`. A program that never did got an empty
//! result object: `JSON.stringify([1].values().next())` was `{}` and
//! `Object.keys` of a String Iterator result was empty, until some read such
//! as `r.value` happened to intern the name. Generator and RegExp String
//! Iterator results, whose builders looked the names up or interned them,
//! were already right; every one of these builders now shares
//! `Interp::iterator_result_ids`, and the tests below cover them all.
//!
//! The programs in the first three tests never spell `value` or `done` outside
//! a string, which is why the keys are read reflectively; a generator's must
//! not `yield` either, since `yield` compiles both names. Every expected value
//! was measured on the XS oracle; Node agrees except where
//! `reused_results_are_protected_like_xs` says otherwise. The one value XS
//! does not give is an async generator result's field attributes, where
//! Ironhorse follows the specification and Node, as
//! `an_async_generator_result_has_value_and_done` explains.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_result(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "must complete; halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

#[test]
fn an_array_iterator_result_has_value_and_done() {
    assert_result(
        "JSON.stringify([1].values().next())",
        r#"{"value":1,"done":false}"#,
    );
    assert_result(
        "JSON.stringify([7].keys().next()) + JSON.stringify([7].entries().next())",
        r#"{"value":0,"done":false}{"value":[0,7],"done":false}"#,
    );
    assert_result(
        "var it = [1][Symbol.iterator](); it.next(); JSON.stringify(it.next())",
        r#"{"done":true}"#,
    );
    assert_result(
        "Object.getOwnPropertyNames([1][Symbol.iterator]().next()).join('|')",
        "value|done",
    );
    // An arguments object iterates with the Array iterator, sloppy or strict.
    assert_result(
        "JSON.stringify((function () { return arguments[Symbol.iterator]().next(); })(4))",
        r#"{"value":4,"done":false}"#,
    );
    assert_result(
        "Object.keys((function () { 'use strict'; \
             return arguments[Symbol.iterator]().next(); })(4)).join('|')",
        "value|done",
    );
}

#[test]
fn a_string_iterator_result_has_value_and_done() {
    assert_result(
        "Object.keys('ab'[Symbol.iterator]().next()).join('|')",
        "value|done",
    );
    assert_result(
        "JSON.stringify('x'[Symbol.iterator]().next())",
        r#"{"value":"x","done":false}"#,
    );
    assert_result(
        "JSON.stringify(''[Symbol.iterator]().next())",
        r#"{"done":true}"#,
    );
}

#[test]
fn collection_regexp_and_generator_results_have_value_and_done() {
    assert_result(
        "Object.keys(new Map([[1, 2]]).entries().next()).join('|')",
        "value|done",
    );
    assert_result(
        "JSON.stringify(new Set([3]).values().next()) + JSON.stringify(new Map([[1, 2]]).keys().next())",
        r#"{"value":3,"done":false}{"value":1,"done":false}"#,
    );
    assert_result(
        "Object.keys('ab'.matchAll(/a/g).next()).join('|')",
        "value|done",
    );
    assert_result(
        "function* g() {} Object.keys(g().return(5)).join('|') + JSON.stringify(g().next())",
        r#"value|done{"done":true}"#,
    );
    // Every Map and Set iterator kind, by name and by `@@iterator`.
    assert_result(
        "JSON.stringify(new Set([3]).entries().next()) \
         + JSON.stringify(new Map([[1, 2]])[Symbol.iterator]().next()) \
         + JSON.stringify(new Set([3]).keys().next())",
        r#"{"value":[3,3],"done":false}{"value":[1,2],"done":false}{"value":3,"done":false}"#,
    );
    assert_result(
        "JSON.stringify(new Map([[1, 2]]).values().next()) \
         + JSON.stringify(new Set([3])[Symbol.iterator]().next())",
        r#"{"value":2,"done":false}{"value":3,"done":false}"#,
    );
}

/// XS reuses one result object per Array, String and collection iterator
/// and protects its fields (`fxNewIteratorInstance`), so a later step
/// rewrites the object an earlier step returned. CreateIterResultObject makes
/// a fresh, writable object each time, as V8 does; Ironhorse follows XS here,
/// and follows the specification for the RegExp String Iterator and
/// generators, where XS reuses only the former.
#[test]
fn reused_results_are_protected_like_xs() {
    assert_result(
        "var it = [1, 2].values(); var a = it.next(); var b = it.next(); \
         var d = Object.getOwnPropertyDescriptor(a, 'value'); \
         [a === b, d.writable, d.enumerable, d.configurable].join()",
        "true,false,true,false",
    );
    assert_result(
        "var s = 'xy'[Symbol.iterator](); var m = new Map([[1, 2]]).values(); \
         [s.next() === s.next(), m.next() === m.next()].join()",
        "true,true",
    );
    assert_result(
        "var it = [1].values(); var r = it.next(); r.value = 9; \
         [delete r.done, r.value].join()",
        "false,1",
    );
    assert_result(
        "var x = 'ab'.matchAll(/./g); function* g() { yield 1; } var gi = g(); \
         var d = Object.getOwnPropertyDescriptor(g().next(), 'value'); \
         [x.next() === x.next(), gi.next() === gi.next(), d.writable, d.configurable].join()",
        "false,false,true,true",
    );
}

/// An async generator builds its result in a promise job, from the reaction
/// that settles a `yield` or a `return` (`AsyncGeneratorYield` and
/// `AsyncGeneratorReturn`), so these programs read `log` after the job queue
/// drains. The first never spells either name and never yields: its results
/// come from a body that completes and from `return(5)` on a generator that
/// never started.
///
/// Each field is a writable, enumerable, configurable data property of a
/// fresh object, as CreateIterResultObject defines it and V8 answers. XS
/// departs here: its `fxNewGeneratorResult` defines both fields
/// `XS_DONT_DELETE_FLAG | XS_DONT_SET_FLAG`, so it answers `false,true,false`
/// for each.
#[test]
fn an_async_generator_result_has_value_and_done() {
    assert_result(
        "var log = []; async function* g() {} \
         function show(r) { log.push(JSON.stringify(r) + ' ' + Object.keys(r).join('|')); } \
         g().next().then(show); g().return(5).then(show); log",
        r#"{"done":true} value|done,{"value":5,"done":true} value|done"#,
    );
    assert_result(
        "var log = []; \
         function attrs(r) { return Reflect.ownKeys(r).map(function (k) { \
             var d = Object.getOwnPropertyDescriptor(r, k); \
             return k + ':' + [d.writable, d.enumerable, d.configurable].join(); \
         }).join(' '); } \
         async function* g() { yield 1; return 2; } \
         async function drain() { var it = g(); \
             var a = await it.next(); var b = await it.next(); \
             log.push(JSON.stringify(a), attrs(a), JSON.stringify(b), attrs(b), \
                 Object.getPrototypeOf(a) === Object.prototype, a !== b); } \
         drain(); log",
        "{\"value\":1,\"done\":false},value:true,true,true done:true,true,true,\
         {\"value\":2,\"done\":true},value:true,true,true done:true,true,true,true,true",
    );
}

/// A TypedArray iterates with the Array iterator's builder, for each of its
/// three kinds and `@@iterator`, and an exhausted one still answers both
/// keys. No program here spells either name.
#[test]
fn a_typed_array_iterator_result_has_value_and_done() {
    assert_result(
        "JSON.stringify(new Uint8Array([5]).values().next()) \
         + JSON.stringify(new Uint8Array([5]).keys().next()) \
         + JSON.stringify(new Uint8Array([5]).entries().next())",
        r#"{"value":5,"done":false}{"value":0,"done":false}{"value":[0,5],"done":false}"#,
    );
    assert_result(
        "JSON.stringify(new Float64Array([1.5])[Symbol.iterator]().next()) \
         + Object.keys(new Int16Array(0).values().next()).join('|')",
        r#"{"value":1.5,"done":false}value|done"#,
    );
}

/// Every Iterator helper builds its own result, and so do `take(0)`, a
/// `return()` before the first step and a helper past its end; `Iterator.from`
/// hands back the Array and String iterators. No program here spells either
/// name.
#[test]
fn an_iterator_helper_result_has_value_and_done() {
    assert_result(
        "JSON.stringify([1, 2].values().map(function (x) { return x * 2; }).next())",
        r#"{"value":2,"done":false}"#,
    );
    assert_result(
        "JSON.stringify([1, 2].values().filter(function (x) { return x === 1; }).next()) \
         + JSON.stringify([1, 2].values().take(1).next()) \
         + JSON.stringify([1, 2].values().drop(1).next()) \
         + JSON.stringify([1, 2].values().flatMap(function (x) { return [x]; }).next())",
        concat!(
            r#"{"value":1,"done":false}{"value":1,"done":false}"#,
            r#"{"value":2,"done":false}{"value":1,"done":false}"#,
        ),
    );
    assert_result(
        "JSON.stringify([[1, 2]].values().flatMap(function (x) { return x; }).drop(1).next())",
        r#"{"value":2,"done":false}"#,
    );
    assert_result(
        "JSON.stringify([1].values().take(0).next()) \
         + JSON.stringify([1].values().map(function (x) { return x; }).return())",
        r#"{"done":true}{"done":true}"#,
    );
    assert_result(
        "Object.keys([1].values().take(0).next()).join('|') + ' ' \
         + Object.keys([1].values().map(function (x) { return x; }).return()).join('|') + ' ' \
         + Object.keys([].values().filter(function () { return true; }).next()).join('|')",
        "value|done value|done value|done",
    );
    assert_result(
        "var it = [1].values().map(function (x) { return x; }); it.next(); \
         JSON.stringify(it.next())",
        r#"{"done":true}"#,
    );
    assert_result(
        "JSON.stringify(Iterator.from([1]).next()) + JSON.stringify(Iterator.from('ab').next())",
        r#"{"value":1,"done":false}{"value":"a","done":false}"#,
    );
}

/// A generator that delegates with `yield*` answers both keys from a step
/// and from a `throw()` the delegation catches, and a generator a `throw()`
/// closed before it started answers from its next step. `yield*` compiles
/// both names, so these pin the result's shape on those paths rather than
/// the interning.
#[test]
fn a_delegating_generator_result_has_value_and_done() {
    assert_result(
        "function* g() { yield* [7]; } JSON.stringify(g().next())",
        r#"{"value":7,"done":false}"#,
    );
    assert_result(
        "function* g() { try { yield* [1]; } catch (e) {} } var it = g(); it.next(); \
         var r = it.throw(5); JSON.stringify(r) + ' ' + Object.keys(r).join('|')",
        r#"{"done":true} value|done"#,
    );
    assert_result(
        "function* g() {} var it = g(); var r; try { it.throw(5); } catch (e) { r = e; } \
         String(r) + JSON.stringify(it.next())",
        r#"5{"done":true}"#,
    );
}
