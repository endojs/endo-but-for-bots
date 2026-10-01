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
//! `reused_results_are_protected_like_xs` says otherwise.

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
