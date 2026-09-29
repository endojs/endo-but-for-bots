//! Regression for continuous-Ironhorse-fuzz finding `1cd4ddc72d5801c4`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 10-byte input
//! (sha256 `b847cc7498bb5806fe98bbe606eb2cd7c4fae4d8edfb208e991b56d5fb7bd031`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! new RegExp("((?:\\1+?\\1*?)(?:\\1+?\\1*?)(?:\\1+?\\1*?)|\\1+?\\1*?)(?:\\1+?\\1*?)|\\1+?\\1*?", "").toString()
//! ```
//!
//! — `RegExp.prototype.toString` over a pattern built from lazy quantified
//! backreferences, including forward references to group 1 from inside
//! group 1 itself.
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on
//! XS-computron equality and reported `computrons: oracle=49 ironhorse=50`.
//! The completion value agreed **exactly** with the XS pin; only the meter
//! differed, by one computron. That is a cost-table difference, not a
//! correctness defect, and the same advisory class as sibling findings
//! `1cb63ec6f8e6fc22` / `3a6aab9d9d140c2c`.
//!
//! The arm no longer gates on that meter: `differential_check_meter_v4` /
//! `compare_observations` treat XS computrons as advisory, so at the current
//! branch head this exact input runs the target cleanly (verified:
//! `cargo +nightly-2026-08-15 fuzz run differential_regexp_surface <input> --
//! -runs=1` executes with no divergence). No port change is warranted.
//!
//! This test locks the observable contract that remains: the program completes
//! and renders the byte-identical source string. The raw computron count is
//! deliberately **not** pinned, since IronHorse's cost table is its own under
//! meter-v4. It is submodule-free: it keeps the exact input beside the
//! deterministic bytecode and symbols the oracle emits for the generated
//! program and replays them through `ironhorse_vm`.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-1cd4ddc72d5801c4.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-1cd4ddc72d5801c4.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-1cd4ddc72d5801c4.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-1cd4ddc72d5801c4.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_backreference_to_string_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 10, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "b847cc7498bb5806fe98bbe606eb2cd7c4fae4d8edfb208e991b56d5fb7bd031",
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.toString surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the toString surface must yield the byte-identical completion value"
    );
}
