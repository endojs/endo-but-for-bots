//! Regression for continuous-Ironhorse-fuzz finding `6ca7a76e0bfe3435`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte input
//! (sha256 `9123812342a612c521af0e2cb2c8677c90de5e5dd605d4163d3c49e93f78a55b`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! var m = new RegExp("(?:\\b.{1,3}(?:[a-c0-9]{1,3}(?:\\B\\s*?\\B){2}...|\\B\\s*?\\B", "m").exec("b"); m ? m.length : 0
//! ```
//!
//! — an `exec` of a word-boundary / lazy-whitespace alternation over the
//! one-character subject `"b"`. Every alternative needs a `\B` at a position
//! that is a word boundary (both offsets of `"b"` are), so `exec` returns
//! `null` and the completion value is the string `"0"` (V8/Node agree).
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on
//! XS-computron equality, and this input reproduced a divergence of the same
//! class as sibling findings `1cb63ec6f8e6fc22` / `c6c71d428a37088c`: the
//! completion value agreed **exactly** with the XS pin (`"0"` on both), only
//! the meter diverged (`computrons: oracle=179 ironhorse=180`). That is a
//! cost-table difference, not a correctness defect.
//!
//! The arm no longer gates on that meter: `differential_check_meter_v4` /
//! `compare_observations` treat XS computrons as **advisory**, so with
//! that fix this exact input runs the target cleanly (verified:
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

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-6ca7a76e0bfe3435.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-6ca7a76e0bfe3435.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-6ca7a76e0bfe3435.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-6ca7a76e0bfe3435.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_exec_surface_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "9123812342a612c521af0e2cb2c8677c90de5e5dd605d4163d3c49e93f78a55b",
    );

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
