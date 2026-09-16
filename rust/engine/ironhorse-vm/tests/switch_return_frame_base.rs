//! A `return` that jumps out of a `switch` must not leave the discriminant on
//! the value stack.
//!
//! `code_switch` evaluates the discriminant, keeps it live across every case
//! test (each `case` DUBs it for the `STRICT_EQUAL`), and pops it only after
//! the break target — so `break` reaches that pop and `return` never does.
//! That is what XS's `fxSwitchNodeCode` emits too; XS stays correct because
//! `XS_CODE_END` resets the stack to the frame base (`mxStack = mxFrameEnd`,
//! xsRun.c:1063) before writing the result. ironhorse's port restored the
//! caller's activation but not its stack, so the abandoned discriminant
//! survived into the caller's pending expression.
//!
//! It read as two different faults depending on what the stray slot displaced:
//! a wrong value when it landed on an operand (`"MARK" + f(42)` → `"numberN"`,
//! silent), and `TypeError: call: not a function` when it landed on a pending
//! callee. Both are one bug, so both are pinned here.
//!
//! Found via `test262:ironhorse-host`, where `@endo/pass-style`'s
//! `passStyleOf` — a `switch (typeof ...)` whose cases `return` — corrupted
//! every call made from an argument list.

use ironhorse_vm::{parse_symbols, Interp};

fn check(source: &str, expected: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols(&symbols));
    let outcome = vm.run(&code);
    assert!(outcome.completed, "{source}: {:?}", outcome.halt);
    assert_eq!(outcome.result, expected, "{source}");
}

#[test]
fn a_pending_operand_survives_a_return_out_of_a_switch() {
    // The reduced form of the pass-style failure.
    check(
        "function f(x){switch(typeof x){case 'number':return 'N';default:return 'D'}} 'MARK'+f(42)",
        "MARKN",
    );
    // A literal discriminant abandons a slot just the same: it is the switch's
    // own stack cell that leaks, not anything about how it was computed.
    check(
        "function f(){switch('number'){case 'number':return 'N';default:return 'D'}} 'MARK'+f()",
        "MARKN",
    );
    // No `case` at all still evaluates and holds a discriminant.
    check(
        "function f(x){switch(x){default:return 'D'}} 'MARK'+f(99)",
        "MARKD",
    );
    // Two pending operands, so a leak that consumed both is distinguishable
    // from one that consumed either.
    check(
        "function f(x){switch(x){case 1:return 'N';default:return 'D'}} 'A'+'B'+f(1)+'C'",
        "ABNC",
    );
    // Each enclosing switch holds its own discriminant; returning from the
    // inner one abandons both.
    check(
        "function f(x){switch(x){case 1:switch(x){case 1:return 'NN'}default:return 'D'}} \
         'MARK'+f(1)",
        "MARKNN",
    );
    // `break` reaches the pop the `return` jumps over, and was always correct:
    // it is the control case that shows the fix did not simply mask the pop.
    check(
        "function f(x){var r='D';switch(x){case 1:r='N';break;default:r='D'}return r} 'MARK'+f(1)",
        "MARKN",
    );
}

#[test]
fn a_pending_callee_survives_a_return_out_of_a_switch() {
    // When the abandoned slot lands on a callee rather than an operand the
    // same bug reports as `TypeError: call: not a function`, so a plain
    // `completed` assertion is the regression check.
    check(
        "function id(v){return v} function f(x){switch(x){default:return 'D'}} id(f(1))",
        "D",
    );
    check(
        "function two(a,b){return a+b} function f(x){switch(x){default:return 'D'}} \
         two(f(1),'Z')",
        "DZ",
    );
    check(
        "function two(a,b){return a+b} function f(x){switch(x){default:return 'D'}} \
         two('Z',f(1))",
        "ZD",
    );
    // An array literal keeps its pending element slots the same way.
    check(
        "function f(x){switch(x){default:return 'D'}} [f(1),'Z'].join('-')",
        "D-Z",
    );
}

#[test]
fn a_switch_that_falls_out_normally_is_unchanged() {
    // The discriminant is popped by the switch itself here; these pin that the
    // frame-base restore did not change ordinary switch results.
    check(
        "var r='';switch(2){case 1:r='a';break;case 2:r='b';break}r",
        "b",
    );
    check("var r='';switch(9){case 1:r='a';break;default:r='z'}r", "z");
    check(
        "function f(x){var r='';switch(x){case 1:r+='1';case 2:r+='2';default:r+='d'}return r} \
         'M'+f(1)",
        "M12d",
    );
}
