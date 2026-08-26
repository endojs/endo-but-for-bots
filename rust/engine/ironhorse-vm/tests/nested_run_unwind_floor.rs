//! A throw escaping a NESTED run lands in the right handler, with the
//! right frame state installed.
//!
//! Historically `unwind_to_jump` popped whatever sat on top of the jump
//! chain. A resumed generator runs its body in a nested `dispatch_at`,
//! so an uncaught throw there found the DRIVER's handler — the `catch`
//! around `it.next()` — and ran it inside the generator's dispatch,
//! with the generator's locals and stack still installed. The results
//! were fabricated: `function* g() { throw 1; }` under
//! `try { g().next() } catch (e) { r = e }` answered
//! `Throw("get: not initialized yet")`, and the nested-generator form
//! ended in `Unsupported("yield:stack-underflow")`. Neither is the
//! program's exception; both are artifacts of running one frame's
//! handler against another frame's state (review wave 5; the defect
//! predated the store seam).
//!
//! The interim fix floored the unwind at the nested run's `jumps_base`
//! and escaped to the host with the correct thrown value — honest, but
//! still divergent from XS, which COMPLETES these programs. The llm
//! rebase superseded the floor: every engine throw now routes through
//! `raise_js` (so `self.exception` is populated at the raise), the
//! unwind restores the establishing frame's activation (`leave_call`
//! per crossed frame, stack/locals/env cuts), and `Halt::Resume`
//! propagates the handler's resume point out through the Rust-level
//! dispatch nesting to the loop that owns the handler's frame. These
//! locks now pin full XS agreement: the driver's catch catches, and
//! the program completes with the thrown value.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

#[test]
fn an_uncaught_generator_throw_reaches_the_drivers_catch() {
    let out = run(
        "function* g() { throw 1; } var it = g(); var r = 0; \
         try { it.next(); } catch (e) { r = e; } r",
    );
    assert!(
        out.completed,
        "the driver's catch must catch the generator's throw (XS \
         completes this program); halt: {:?}",
        out.halt
    );
    assert_eq!(
        out.result, "1",
        "the caught value must be the program's own exception, not an \
         artifact of running the handler against the generator's frame"
    );
}

#[test]
fn a_nested_generator_throw_reaches_the_drivers_catch() {
    // The same root cause one level deeper, where it used to surface as
    // a stack underflow rather than a wrong exception.
    let out = run(
        "function* inner() { throw 1; } \
         function* outer() { var i = inner(); i.next(); yield 0; } \
         var o = outer(); var r = 0; try { o.next(); } catch (e) { r = e; } r",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "1");
}

#[test]
fn a_generators_own_handler_still_catches() {
    // The handlers the resume rebases onto the live chain sit above the
    // run's `jumps_base`, so the body's own `try` catches first — an
    // unwind that skipped them would break this. Agrees with XS.
    let out = run(
        "function* g() { try { throw 1; } catch (e) { yield e; } } \
         var it = g(); it.next().value",
    );
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "1");
}

#[test]
fn an_ordinary_throw_still_reaches_its_handler() {
    // The program's own dispatch, and a throw crossing a called
    // function within one dispatch loop; neither involves nesting.
    let out = run("var r = 0; try { throw 1; } catch (e) { r = e; } r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "1");
    let out = run("function f() { throw 1; } var r = 0; try { f(); } catch (e) { r = e; } r");
    assert!(out.completed, "halt: {:?}", out.halt);
    assert_eq!(out.result, "1");
}
