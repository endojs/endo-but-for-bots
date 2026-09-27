//! Regression for continuous-Ironhorse-fuzz finding `e4a8e011666d0362`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 3-byte input
//! (sha256 `1c3ef6ed461f18060fd3607e8553fdddca6337002c20d38ffc83eaae980876d5`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! var m = new RegExp("(?:[abc]+?(?:[abc]+?(?:.{1,3}.+?[abc]{1,3}){1,2}…){1,2}", "").exec("b\n0"); m ? m.index : -1
//! ```
//!
//! — a `RegExp.prototype.exec` over a nested lazy-quantifier alternation
//! pattern. The subject cannot match (`.` stops at the line terminator), so
//! `exec` returns `null` and the program's completion value is `-1`.
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on
//! XS-computron equality, and this input reproduced a divergence of the same
//! class as sibling findings `1cb63ec6f8e6fc22` / `2cc2ac67ba7e9b9f`: the
//! completion value agreed **exactly** with the XS pin (`-1` on both), only the
//! meter diverged (`computrons: oracle=186 ironhorse=187`). That is a
//! cost-table difference, not a correctness defect.
//!
//! The arm no longer gates on that meter: `ironhorse_fuzz`'s
//! `differential_check_meter_v4` treats XS computrons as **advisory**, so at
//! current `llm` HEAD this exact input runs the target cleanly (verified:
//! `cargo +nightly-2026-08-15 fuzz run differential_regexp_surface <input> --
//! -runs=1` executes with no divergence).
//!
//! The invariant this test locks is that the exact reproducing input's generated
//! program runs to completion **without panic** and yields the byte-identical
//! `exec` completion value. The raw computron count is deliberately **not**
//! pinned, so ongoing cost-table recalibration does not break it.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-e4a8e011666d0362.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-e4a8e011666d0362.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-e4a8e011666d0362.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-e4a8e011666d0362.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_exec_surface_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 3, "the minimized input stays exact");
    assert_eq!(EXPECTED_RESULT, "-1", "the exec surface finds no match");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.exec surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the exec surface must yield the byte-identical completion value"
    );
}
