//! A guest throw inside a promise executor rejects the promise; it does not
//! land in a `try` live around the `new Promise` (architecture review F023).
//!
//! XS runs the executor inside `fx_Promise`'s own `mxTry`, whose `setjmp`
//! sits between the executor and the caller's handler, so the throw is
//! caught natively and becomes the rejection reason. The port's boundary
//! recorded the caller's jump depth but never fenced the chain, so the
//! executor's throw unwound into the caller's live `catch`: `r` answered
//! `"caught:1"` where XS answers `0`, and `p` — never assigned — was a
//! promise that would never settle.

use ironhorse_vm::{run_program_with_symbols, Interp, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run `first` (draining its promise jobs), then `second` on the same
/// machine, returning the second crank's completion.
fn two_cranks(first: &str, second: &str) -> String {
    let (b, n) = compile(first);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "crank 1 must complete, got {:?}", o.halt);
    let (b, n) = compile(second);
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    assert!(o.completed, "crank 2 must complete, got {:?}", o.halt);
    o.result
}

#[test]
fn an_executor_throw_does_not_reach_the_callers_catch() {
    // The review's probe: XS answers `0`.
    let out = run(
        "var r=0; var p; try { p = new Promise(function(){ throw 1; }); } \
         catch(e){ r='caught:'+e; } r",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "0");
}

#[test]
fn an_executor_throw_rejects_the_promise_with_the_thrown_value() {
    let r = two_cranks(
        "var r = 0; var rej = 0; var p; \
         try { p = new Promise(function(){ throw 1; }); } catch(e) { r = 'caught:' + e; } \
         p.then(null, function(e){ rej = 'rejected:' + e; });",
        "r + '/' + rej",
    );
    assert_eq!(r, "0/rejected:1");
}

#[test]
fn a_handler_inside_the_executor_still_catches() {
    let out = run(
        "var r=0; new Promise(function(){ try { throw 1; } catch(e) { r='inner:'+e; } }); r",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "inner:1");
}

#[test]
fn an_executor_throw_through_a_called_function_still_rejects() {
    // The throw crosses a callee frame inside the fence; the callee's frames
    // are abandoned and the caller's `try` is still not entered.
    let r = two_cranks(
        "var r = 0; var rej = 0; var p; function boom() { throw 2; } \
         try { p = new Promise(function(){ boom(); }); } catch(e) { r = 'caught:' + e; } \
         p.then(null, function(e){ rej = 'rejected:' + e; });",
        "r + '/' + rej",
    );
    assert_eq!(r, "0/rejected:2");
}

#[test]
fn the_callers_handler_chain_survives_the_fence() {
    // The caller's `try` is restored after the executor returns, so a LATER
    // throw in the same block is still caught by it.
    let out = run(
        "var r=0; try { new Promise(function(){ throw 1; }); throw 3; } \
         catch(e){ r='caught:'+e; } r",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "caught:3");
}
