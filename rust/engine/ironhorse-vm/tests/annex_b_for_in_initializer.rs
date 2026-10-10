//! Annex B.3.5 `for-in` head initializer: the SEMANTICS, not just the grammar.
//!
//! Admitting the syntax without these would be worse than refusing it. The
//! first attempt did exactly that: the parser accepted the shape and the coder
//! dropped the initializer, so `for (var x = 'init' in {}) ; x` evaluated to
//! `undefined` and a side-effecting initializer never ran at all.
//!
//! The cause is worth recording. `code_for_in_of` fed the whole `Binding` node
//! to its own `code_assign`, whose `Binding` arm is the DESTRUCTURING-DEFAULT
//! rule — take the supplied value unless it is `undefined`, otherwise evaluate
//! the initializer. A for-in key is never `undefined`, so the initializer was
//! emitted inside the loop and was dead code. The initializer is now emitted
//! once, before the head expression, and the loop targets the inner node.
//!
//! Every expectation below was checked against Node, and the four `NONSTRICT`
//! cases are the four blocks of
//! `annexB/language/statements/for-in/nonstrict-initializer.js` reduced to the
//! values they assert.

use ironhorse_compile::compile_atoms;
use ironhorse_vm::{parse_symbols_checked, Interp};

fn run(source: &str) -> String {
    let (bytecode, symbols) = compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let out = vm.run(&bytecode);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}

/// The four blocks of test262's `nonstrict-initializer.js`.
#[test]
fn the_test262_nonstrict_initializer_assertions_hold() {
    // "Initializer should only be executed once", with an empty object so the
    // body never runs.
    assert_eq!(
        run("(function(){ var effects=0; for (var a = ++effects in {}); return effects; })()"),
        "1"
    );
    // "Initialized value should be available to RHS" — the head expression is
    // evaluated AFTER the initializer has been assigned.
    assert_eq!(
        run("(function(){ var stored; for (var a = 0 in stored = a, {}); return stored; })()"),
        "0"
    );
    // The binding keeps the initialized value when the loop body never runs.
    assert_eq!(
        run("(function(){ for (var a = 0 in {}); return a; })()"),
        "0"
    );
    // All three at once, with a body that does run.
    assert_eq!(
        run("(function(){ var effects=0,iterations=0,stored; \
             for (var a = (++effects,-1) in stored = a, {a:0,b:1,c:2}) { ++iterations; } \
             return stored+','+effects+','+iterations; })()"),
        "-1,1,3"
    );
}

/// Ordering and arity, stated separately from the corpus case so a change in
/// either is named rather than folded into one string.
#[test]
fn the_initializer_runs_once_and_before_the_head_expression() {
    // Once, regardless of how many keys the loop then visits.
    assert_eq!(
        run("var n=0; for (var x = (n++, 0) in {a:1,b:2,c:3}) ; n"),
        "1"
    );
    // Before the head expression.
    assert_eq!(
        run("var t=[]; for (var x = (t.push('init'),0) in (t.push('expr'),{a:1})) ; t.join(',')"),
        "init,expr"
    );
    // The loop then overwrites the binding with each key, so the initialized
    // value does not survive a non-empty enumeration.
    assert_eq!(run("for (var x = 'init' in {a:1,b:2}) ; x"), "b");
    // …and the keys themselves are unaffected.
    assert_eq!(
        run("var seen=[]; for (var k = 0 in {a:1,b:2}) seen.push(k); seen.join(',')"),
        "a,b"
    );
}

/// A `for-in` head WITHOUT an initializer must not have acquired any of this.
#[test]
fn an_ordinary_for_in_head_is_unchanged() {
    assert_eq!(
        run("var seen=[]; for (var k in {a:1,b:2}) seen.push(k); seen.join(',')"),
        "a,b"
    );
    assert_eq!(run("var last; for (var k in {a:1}) last=k; last"), "a");
    // The key `"ab"` destructures to a='a', b='b', so `a+b` is `"ab"`.
    // Checked against Node.
    assert_eq!(
        run("var seen=[]; for (var [a,b] in {ab:1}) seen.push(a+b); seen.join(',')"),
        "ab"
    );
}
