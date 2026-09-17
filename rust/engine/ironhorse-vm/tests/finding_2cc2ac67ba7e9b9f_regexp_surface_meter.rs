//! Regression for continuous-Ironhorse-fuzz finding `2cc2ac67ba7e9b9f`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 26-byte input
//! (sha256 `aeadab4b457f5d6f444bdc51c1ec6d9a362318f1f45282b21a5e10308b002f6f`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! new RegExp("((a*|\\2\\2+[abc]?)?[a-c]*|(\\1*a*)(\\4\\n?)?)?[a-c]*|((a*)? )([abc]?[abc]*|\\7{2})|a*", "i").exec("    \n\n\n\n")
//! ```
//!
//! — an `exec` of a deeply nested, case-insensitive alternation-and-backreference
//! pattern against a whitespace subject. The `exec` result is the match array
//! `["", "", "", "", "", "", "", ""]`, whose default string coercion is the
//! seven-comma `",,,,,,,"`.
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on XS-computron
//! equality, and this input reproduced a divergence of the same class as sibling
//! finding `c6c71d428a37088c`: the completion value agreed **exactly** with the
//! pin, only the meter diverged (`computrons: oracle=72 ironhorse=73`). This is
//! a cost-table difference, not a correctness defect — the port matched, shaped
//! the `exec` array, and coerced it bit-identically to the pin.
//!
//! The arm no longer gates on that meter: `ironhorse_fuzz`'s
//! `differential_check_meter_v4` / `compare_observations` treat XS computrons as
//! **advisory** ("XS computron equality cannot gate an IronHorse cost-table
//! recalibration"), so at current `llm` HEAD this exact input runs the target
//! cleanly (verified: `cargo +nightly-2026-08-15 fuzz run
//! differential_regexp_surface <input> -- -runs=1` executes with no divergence,
//! oracle computrons `72` vs the port's recalibrated `82`, identical result).
//! The port was always correct on the observable value.
//!
//! The invariant this test locks is that the exact reproducing input's generated
//! program runs to completion **without panic** and yields the byte-identical
//! `exec` completion value. The raw computron count is deliberately **not**
//! pinned: the surface harness treats XS-computron equality as advisory, so an
//! exact-count assertion would be brittle against ongoing cost-table
//! recalibration rather than load-bearing.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-2cc2ac67ba7e9b9f.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-2cc2ac67ba7e9b9f.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-2cc2ac67ba7e9b9f.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-2cc2ac67ba7e9b9f.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_exec_surface_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 26, "the minimized input stays exact");

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
