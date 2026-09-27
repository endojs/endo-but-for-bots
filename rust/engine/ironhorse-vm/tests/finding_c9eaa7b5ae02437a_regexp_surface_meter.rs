//! Regression for continuous-Ironhorse-fuzz finding `c9eaa7b5ae02437a`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 27-byte input
//! (sha256 `6a9c7d5aa3c0a3cf59823601893c61abf251d4ec1d0cc6b933f51f4863f6155d`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into an
//! `exec` of a nested quantified pattern with a lookbehind against
//! `"1aaaaaa"`. The match-array completion coerces to `"1aaaaaa,"`.
//!
//! At the finding SHA the observable result agreed exactly with the XS pin;
//! only the meter differed (`computrons: oracle=208 ironhorse=209`). That is
//! the same advisory cost-table class as sibling RegExp-surface findings, not
//! an engine-semantic defect.
//!
//! Commit `de16989204` made the causal harness correction:
//! `differential_check_meter_v4` still requires completion and result agreement
//! while treating XS computrons as advisory. The current standing branch runs
//! this exact fuzz input without divergence.
//!
//! This submodule-free test preserves the exact input beside the deterministic
//! bytecode and symbols emitted for its generated program, then replays them
//! through `ironhorse_vm`. It deliberately does not pin a raw computron count.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-c9eaa7b5ae02437a.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-c9eaa7b5ae02437a.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-c9eaa7b5ae02437a.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-c9eaa7b5ae02437a.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_exec_surface_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 27, "the minimized input stays exact");
    assert_eq!(
        EXPECTED_RESULT, "1aaaaaa,",
        "the fixture preserves the match-array coercion"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.exec surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the exec surface must yield the byte-identical match-array coercion"
    );
}
