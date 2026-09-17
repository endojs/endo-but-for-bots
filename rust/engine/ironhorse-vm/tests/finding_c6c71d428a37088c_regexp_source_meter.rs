//! Regression for continuous-Ironhorse-fuzz finding `c6c71d428a37088c`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 5-byte input `74 74 74 2c 40`
//! (sha256 `272379d23e2d29e2be4eb5db911281739f46a446eedbaa78c36b06dee0f66500`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into a
//! `new RegExp(<pattern>, "m").source` program whose `.source` completion
//! value is a 1043-byte unescaped string (the pattern needs no escaping: it
//! carries no `/` and no line terminator, only backslash-escape sequences such
//! as `\s`, `\n`, and `[a-c]`).
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on
//! XS-computron equality and this input reproduced a divergence of the same
//! class as sibling findings `1898f584e9bf841a` and `1a2012ae1ec44d21`: the
//! `.source` getter needs no escaping, so XS reuses the constructor's source
//! key while the pre-fix port charged a fresh string chunk — the completion
//! value agreed exactly, only the meter diverged. The causal fix
//! `fix(ironhorse-vm): reuse unescaped regexp source` (`dbdddec76`, landed on
//! `llm` after this finding's project SHA) makes the getter reuse the
//! constructor key when no escaping is required; at current `llm` this exact
//! input runs the target cleanly (verified: `cargo +nightly-2026-08-15 fuzz
//! run differential_regexp_surface <input> -- -runs=1` executes with no
//! divergence). The port was always correct on the completion value.
//!
//! The load-bearing invariant this test locks is that the exact reproducing
//! input's generated program runs to completion **without panic** and yields
//! the byte-identical `.source` value. The raw computron count is deliberately
//! **not** pinned: the `differential_regexp_surface` harness now treats
//! XS-computron equality as advisory ("XS computron equality cannot gate an
//! IronHorse cost-table recalibration", `ironhorse-fuzz` §
//! `differential_check_meter_v4`), so an exact-count assertion would be brittle
//! against ongoing cost-table recalibration rather than load-bearing.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-c6c71d428a37088c.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-c6c71d428a37088c.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-c6c71d428a37088c.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-c6c71d428a37088c.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_getter_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the source getter must yield the byte-identical unescaped pattern"
    );
}
