//! Regression for continuous-Ironhorse-fuzz finding `d5413146a257bc30`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte input
//! (sha256 `957c39a802d5b3a9f09413832ea4c03dba2d2fed67d8b6da0553a6cb6cef0563`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a
//! `new RegExp(..., "m").source` read of an `a+`/`a{1,3}`/`\s+`/`[a-c]+`
//! alternation with an optional non-capturing group.
//!
//! At the finding SHA the observable result agreed exactly with the XS pin;
//! only the meter differed (`computrons: oracle=37 ironhorse=38`). That is the
//! advisory cost-table class of sibling RegExp-surface findings (such as
//! `89e303d17e33b117`), not an engine-semantic defect:
//! `differential_check_meter_v4` requires completion and result agreement
//! while treating XS computrons as advisory, and with that fix the target
//! runs this exact fuzz input without divergence.
//!
//! This submodule-free test preserves the exact input beside the deterministic
//! bytecode and symbols XS emitted for its generated program, then replays them
//! through `ironhorse_vm`. It deliberately does not pin a raw computron count.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-d5413146a257bc30.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-d5413146a257bc30.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-d5413146a257bc30.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-d5413146a257bc30.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 6, "the minimized input stays exact");
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "957c39a802d5b3a9f09413832ea4c03dba2d2fed67d8b6da0553a6cb6cef0563",
    );
    assert_eq!(
        EXPECTED_RESULT, r"a+a{1,3}a+|(?:a*\s+|a{1,3}a+)?\s+|a{1,3}a+|[a-c]+a{1,3}",
        "the fixture preserves the RegExp.source spelling"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the source surface must yield the byte-identical pattern text"
    );
}
