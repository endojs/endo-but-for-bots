//! Regression for continuous-Ironhorse-fuzz finding `b95320dfb5dd9d3d`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 5-byte input
//! (sha256 `89590ab03d5ee8aa96ba12d1543906131941b2d6571f43808ae7f9d2eaed7d07`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! var m = new RegExp("([0-9]{2}([a-c0-9]{2}[0-9]{2}(\\w{2}0+?a{2})?)){2}[0-9]{2}", "").exec("aac00aa"); m ? m.index : -1
//! ```
//!
//! — an `exec` of a nested-group digit pattern over `"aac00aa"`. The pattern
//! needs at least ten consecutive digit-class characters and the subject has
//! only two digits in a row, so `exec` returns `null` and the completion value
//! is the number `-1` (V8/Node agree).
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on
//! XS-computron equality, and this input reproduced a divergence of the same
//! class as sibling findings `6ca7a76e0bfe3435` / `c6c71d428a37088c`: the
//! completion value agreed **exactly** with the XS pin (`-1` on both), only
//! the meter diverged (`computrons: oracle=117 ironhorse=118`). That is a
//! cost-table difference, not a correctness defect.
//!
//! The arm no longer gates on that meter: `differential_check_meter_v4` /
//! `compare_observations` treat XS computrons as **advisory**, so on the
//! standing branch this exact input runs the target cleanly (verified:
//! `cargo +nightly-2026-08-15 fuzz run differential_regexp_surface <input> --
//! -runs=1` exits 0).
//!
//! This test locks that the exact reproducing input's generated program runs
//! to completion **without panic** and yields the byte-identical completion
//! value. The raw computron count is deliberately **not** pinned, since it
//! would be brittle against ongoing cost-table recalibration.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-b95320dfb5dd9d3d.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-b95320dfb5dd9d3d.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-b95320dfb5dd9d3d.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-b95320dfb5dd9d3d.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_exec_surface_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");

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
