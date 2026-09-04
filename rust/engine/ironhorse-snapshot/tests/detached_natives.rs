//! Detached-native calls (the deferred-work checklist's engine item):
//! callee-identity dispatch means a native stored in a variable calls
//! like the pathful form, and `.call`/`.apply` re-dispatch onto native
//! receivers with the rebound `this`. The bare wrong-receiver case
//! stays a NAMED refusal, never a wrong answer.

use ironhorse_vm::{parse_symbols, Interp};

fn run1(src: &str) -> (bool, String) {
    let (b, syms) = ironhorse_compile::compile_atoms(src).expect("fixture compiles");
    let names = parse_symbols(&syms);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let o = m.run(&b);
    (
        o.completed,
        if o.completed {
            o.result
        } else {
            format!("{:?}", o.halt)
        },
    )
}

#[test]
fn detached_statics_call_like_the_pathful_form() {
    // The ledger's original counterexample, now the lock: namespace
    // statics detach and call by identity.
    let (ok, r) = run1("var n = 0; var o = 0; o = { a: 1, b: 2 }; n = Object.keys; n(o).length");
    assert!(ok, "halt: {r}");
    assert_eq!(r, "2");
    let (ok, r) = run1("var n = 0; n = Math.max; n(1, 5)");
    assert!(ok, "halt: {r}");
    assert_eq!(r, "5");
}

#[test]
fn dot_call_rebinds_this_onto_a_native_method() {
    let (ok, r) = run1(
        "var n = 0; var a = 0; a = [1, 2]; n = a.push; n.call(a, 9); a.length",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "3", ".call on a detached native method lands with the rebound this");
    let (ok, r) = run1(
        "var n = 0; var o = 0; o = { a: 1 }; n = Object.keys; n.call(null, o).length",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "1", ".call on a detached static ignores the null this");
}

#[test]
fn dot_apply_supports_the_dense_array_and_no_array_subsets() {
    let (ok, r) = run1(
        "var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a, [7, 8]); a.length",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "4", ".apply forwards a dense argument array");
    let (ok, r) = run1(
        "var n = 0; var a = 0; a = [1, 2]; n = a.push; n.apply(a); a.length",
    );
    assert!(ok, "halt: {r}");
    assert_eq!(r, "2", ".apply with no argument array calls with zero args");
}

#[test]
fn bare_detached_method_with_wrong_receiver_stays_a_named_refusal() {
    // Calling a detached prototype method with no receiver is a
    // TypeError in full JS; here it must stay a NAMED halt (fail
    // closed), never a wrong answer or a panic.
    let (ok, r) = run1("var n = 0; var a = 0; a = [1, 2]; n = a.push; n(3)");
    assert!(!ok, "a bare detached push with this=undefined must not complete: {r}");
    assert!(
        r.contains("push") || r.contains("TypeError") || r.contains("not a function"),
        "the refusal names the site: {r}"
    );
}
