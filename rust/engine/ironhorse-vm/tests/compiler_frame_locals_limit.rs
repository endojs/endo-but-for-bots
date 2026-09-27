//! The XS 65535-locals-per-frame ceiling, exercised through the public
//! compile/run surface (companion to `compiler_symbol_limit.rs`).
//!
//! XS reserves a frame's locals with `RESERVE`, and every frame-slot operand
//! (`RESERVE`/`GET_LOCAL`/`SET_LOCAL`/`RETRIEVE`/`UNWIND`/…) is a `u16`;
//! `fxByteCodeSize` corrupts the opcode stream past 65535 (a `+= 2` bump to a
//! `_4` variant that does not exist — e.g. `RESERVE_1 + 2 == RESET_CLOSURE_1`).
//! OSS-Fuzz reached this in XS. Iron Horse ports the identical width selector,
//! so it shares the exact ceiling; the compiler rejects an over-limit frame at
//! compile time with a clean, catchable `Syntax` error rather than lowering
//! corrupt bytecode. The per-accumulation-path coverage and the exact boundary
//! live in the scoper unit tests
//! (`ironhorse-compile/src/scoper/tests.rs`, `frame_*`), where the check is
//! observable in isolation; this file pins the public-API contract and that a
//! valid frame still lowers and runs.

use ironhorse_compile::{compile, compile_atoms, ParseErrorKind};
use ironhorse_vm::run_program_with_symbols;

/// A function body of `count` repetitions of `item` (with `{i}` substituted).
fn frame_of(count: usize, pre: &str, item: &str, post: &str) -> String {
    let mut s = String::with_capacity(count * item.len() + pre.len() + post.len());
    s.push_str(pre);
    for i in 0..count {
        s.push_str(&item.replace("{i}", &i.to_string()));
    }
    s.push_str(post);
    s
}

#[test]
fn over_limit_frame_is_refused_through_compile() {
    // 65536 `let` slots need a nonexistent `RESERVE_4`. The scoper's frame
    // check fires before the coder emits anything.
    let error = compile(&frame_of(65_536, "function f(){", "let a{i};", "}")).unwrap_err();
    assert_eq!(error.kind, ParseErrorKind::Syntax);
    assert_eq!(error.message, "too many variables");

    // The atom-bearing entry rejects it identically.
    let error = compile_atoms(&frame_of(65_536, "function f(){", "let a{i};", "}")).unwrap_err();
    assert_eq!(error.kind, ParseErrorKind::Syntax);
    assert_eq!(error.message, "too many variables");
}

#[test]
fn over_limit_catch_frame_is_refused() {
    // A destructuring `catch` pattern's bindings are frame slots too, so this
    // path is refused with the same error — not only plain `let`/`var`.
    let error = compile(&frame_of(65_536, "try{}catch([", "c{i},", "]){}")).unwrap_err();
    assert_eq!(error.kind, ParseErrorKind::Syntax);
    assert_eq!(error.message, "too many variables");
}

#[test]
fn valid_multi_path_frame_compiles_and_runs() {
    // A frame that exercises every accumulation path at once — parameters,
    // `var`/`let`, array + object destructuring, a hoisted function
    // declaration, and a `catch` binding — stays well under the ceiling,
    // lowers to bytecode, and runs to the expected value. This is the
    // "a frame under the limit compiles and runs" half of the contract.
    let source = "\
        function f(p, q) {\n\
        \x20 var v = 1;\n\
        \x20 let w = 2;\n\
        \x20 let [a, b] = [3, 4];\n\
        \x20 let { m, n } = { m: 5, n: 6 };\n\
        \x20 function g() { return 7; }\n\
        \x20 try { throw 8; } catch (e) { return p + q + v + w + a + b + m + n + g() + e; }\n\
        }\n\
        f(9, 10)";
    let (code, names) = compile_atoms(source).expect("valid frame compiles");
    let out = run_program_with_symbols(&code, &names);
    assert!(out.completed, "{:?}", out.halt);
    // 9 + 10 + 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 = 55
    assert_eq!(out.result, "55");
}

#[test]
fn a_large_but_admissible_frame_lowers() {
    // A four-figure-slot frame — far larger than anything hand-written, well
    // under the 65535 ceiling — still lowers cleanly (no width-selection
    // corruption on the wide-but-valid `RESERVE_2` path) and runs.
    let mut source = String::from("function f(){let s=0;");
    for i in 0..2_000 {
        source.push_str(&format!("let a{i}={i};s+=a{i};"));
    }
    source.push_str("return s;}f()");
    let (code, names) = compile_atoms(&source).expect("large admissible frame compiles");
    let out = run_program_with_symbols(&code, &names);
    assert!(out.completed, "{:?}", out.halt);
    // sum of 0..2000
    assert_eq!(out.result, (0..2_000).sum::<i64>().to_string());
}
