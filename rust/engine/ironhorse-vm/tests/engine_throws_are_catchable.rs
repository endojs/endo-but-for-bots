//! Every engine-raised error is a real, catchable error object, and a
//! native `mxTry` boundary receives THAT value (architecture review F004 /
//! F005).
//!
//! `Object.defineProperty(1, …)` and its siblings used to build a bare
//! `Halt::Throw("TypeError: …")` inline: uncatchable by guest `try`/`catch`
//! (the jump chain was never consulted), and invisible to a promise
//! executor's native try, which recovered the thrown value from
//! `self.exception` — a register the inline throw never set — and so
//! rejected the promise with `undefined`. XS throws a `TypeError` the
//! program can catch, and rejects with it.

use ironhorse_vm::{run_program_with_symbols, Interp, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn compile(src: &str) -> (Vec<u8>, Vec<String>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

/// Run `first`, letting its promise jobs drain, then `second` on the same
/// machine and return the second crank's completion.
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

/// The programs name `TypeError`, as any `assert.throws(TypeError, …)`
/// does: the realm links an intrinsic's prototype when the source first
/// names it, so an error built before that renders through
/// `Error.prototype`. That lazy-link seam is its own item; this test is
/// about catchability and the carried value.
fn assert_catches(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "the guest handler must catch the engine-raised TypeError (XS \
         completes this program); halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

#[test]
fn object_statics_throw_catchable_type_errors_with_xs_messages() {
    // The messages are the pinned oracle's `String(e)` for each program.
    assert_catches(
        "var r=0; try { Object.create(1) } \
         catch(e){ r=(e instanceof TypeError)+':'+e.name+': '+e.message } r",
        "true:TypeError: invalid prototype",
    );
    assert_catches(
        "var r=0; try { Object.defineProperty(1,'x',{}) } \
         catch(e){ r=(e instanceof TypeError)+':'+e.name+': '+e.message } r",
        "true:TypeError: invalid object",
    );
    assert_catches(
        "var r=0; try { Object.defineProperty({},'x',1) } \
         catch(e){ r=(e instanceof TypeError)+':'+e.name+': '+e.message } r",
        "true:TypeError: invalid descriptor",
    );
    assert_catches(
        "var r=0; try { Object.defineProperties(1,{}) } \
         catch(e){ r=(e instanceof TypeError)+':'+e.name+': '+e.message } r",
        "true:TypeError: invalid object",
    );
}

#[test]
fn an_engine_type_error_is_an_instance_of_the_realms_type_error() {
    assert_catches(
        "var r=0; try { Object.create(1) } catch(e){ r = (e instanceof TypeError) && \
         (e instanceof Error) } r",
        "true",
    );
}

#[test]
fn a_promise_executor_that_hits_an_engine_error_rejects_with_that_error() {
    let r = two_cranks(
        "var r = 0; new Promise(function(){ Object.create(1); })\
         .then(null, function(e){ r = (e instanceof TypeError)+':'+e.name+': '+e.message; });",
        "r",
    );
    assert_eq!(r, "true:TypeError: invalid prototype");
}

#[test]
fn a_reaction_handler_that_hits_an_engine_error_rejects_the_derived_promise() {
    let r = two_cranks(
        "var r = 0; Promise.resolve(1).then(function(){ Object.defineProperty(1,'x',{}); })\
         .then(null, function(e){ r = (e instanceof TypeError)+':'+e.name+': '+e.message; });",
        "r",
    );
    assert_eq!(r, "true:TypeError: invalid object");
}

#[test]
fn an_uncaught_engine_error_still_escapes_to_the_host_with_its_rendering() {
    let out = run("Object.create(1)");
    assert!(!out.completed);
    match out.halt {
        ironhorse_vm::Halt::Throw { rendered, .. } => {
            assert_eq!(rendered, "TypeError: invalid prototype")
        }
        other => panic!("expected an uncaught TypeError, got {other:?}"),
    }
}
