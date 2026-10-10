//! An ENGINE-raised error inside a nested dispatch lands in the right
//! handler (architecture review F001).
//!
//! `throw` always did: the `THROW` opcode's arm tests whether the handler
//! `unwind_to_jump` found lies below this loop's `return_depth` and, if
//! so, propagates `Halt::Resume` out to the dispatch that owns it. The
//! hand-expanded `raise_js` arms did not, so a `ReferenceError` raised
//! by `GET_VARIABLE` inside a `forEach` callback, a getter, a `toString`,
//! a proxy trap or a generator body resumed the OUTER frame's handler
//! inside the INNER loop and answered `Unsupported("end:frame-underflow")`
//! — invisible to the acceptance bar, which scores `Unsupported` as a
//! coverage skip. XS completes every one of these with `caught`.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_caught(source: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "the outer handler must catch the engine-raised error (XS completes \
         this program); halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, "caught", "{source}");
}

#[test]
fn a_reference_error_in_a_foreach_callback_reaches_the_callers_catch() {
    assert_caught(
        "function f(){ var r=0; try { [1].forEach(function(){ nosuchvar; }) } \
         catch(e) { r='caught' } return r } f()",
    );
    assert_caught(
        "function f(){ var r=0; try { [3,1,2].map(function(){ nosuchvar; }) } \
         catch(e) { r='caught' } return r } f()",
    );
}

#[test]
fn a_reference_error_in_a_getter_reaches_the_callers_catch() {
    assert_caught(
        "function f(){ var r=0; var o={get x(){ nosuchvar; }}; try { o.x } \
         catch(e) { r='caught' } return r } f()",
    );
}

#[test]
fn a_reference_error_in_a_tostring_reaches_the_callers_catch() {
    assert_caught(
        "function f(){ var r=0; var o={toString(){ nosuchvar; }}; try { ''+o } \
         catch(e) { r='caught' } return r } f()",
    );
}

#[test]
fn a_reference_error_in_a_proxy_trap_reaches_the_callers_catch() {
    assert_caught(
        "function f(){ var r=0; var p=new Proxy({}, {get(){ nosuchvar; }}); \
         try { p.x } catch(e) { r='caught' } return r } f()",
    );
}

#[test]
fn a_reference_error_in_a_generator_body_reaches_the_drivers_catch() {
    assert_caught(
        "function f(){ var r=0; function* g(){ nosuchvar; } try { g().next() } \
         catch(e) { r='caught' } return r } f()",
    );
}

#[test]
fn a_handler_inside_the_nested_frame_still_catches_first() {
    // The same raise with a handler in the callback's OWN frame: that
    // handler sits at or above the nested loop's depth and is consumed
    // there; the outer handler must not see it.
    let out = run(
        "function f(){ var r=0; try { [1].forEach(function(){ try { nosuchvar; } \
         catch(e) { r='inner' } }) } catch(e) { r='outer' } return r } f()",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "inner");
}
