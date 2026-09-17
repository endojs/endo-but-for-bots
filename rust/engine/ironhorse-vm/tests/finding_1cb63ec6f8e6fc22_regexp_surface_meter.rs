//! Regression for continuous-Ironhorse-fuzz finding `1cb63ec6f8e6fc22`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 2-byte input `32 eb`
//! (sha256 `bbb90f36295c5377281fad9a7bce09f4a6a6a2d0342598c4f42cfcc434247802`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! "0a0a".search(new RegExp("(((\\s{2}a?\\s{2})?(\\s{2}a?\\s{2})?(\\s{2}a?\\s{2})?)?…)?", ""))
//! ```
//!
//! — a `String.prototype.search` over a deeply nested optional-group
//! whitespace-alternation pattern. The pattern matches the empty string at
//! offset 0, so `search` returns the index `0` and the program's completion
//! value is the string `"0"`.
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on
//! XS-computron equality, and this input reproduced a divergence of the same
//! class as sibling findings `2cc2ac67ba7e9b9f` / `c6c71d428a37088c`: the
//! completion value agreed **exactly** with the XS pin (`"0"` on both), only
//! the meter diverged (`computrons: oracle=485 ironhorse=540`). That is a
//! cost-table difference, not a correctness defect — the port ran the surface,
//! coerced the `search` result, and produced the byte-identical value.
//!
//! The arm no longer gates on that meter: `ironhorse_fuzz`'s
//! `differential_check_meter_v4` / `compare_observations` treat XS computrons as
//! **advisory** ("XS computron equality cannot gate an IronHorse cost-table
//! recalibration"), so at current `llm` HEAD this exact input runs the target
//! cleanly (verified: `differential_check_meter_v4` returns `Ok(())`, i.e.
//! `cargo +nightly-2026-08-15 fuzz run differential_regexp_surface <input> --
//! -runs=1` executes with no divergence — oracle computrons `485` vs the port's
//! `540`, identical result `"0"`). The port was always correct on the
//! observable value.
//!
//! The invariant this test locks is that the exact reproducing input's generated
//! program runs to completion **without panic** and yields the byte-identical
//! `search` completion value. The raw computron count is deliberately **not**
//! pinned: the surface harness treats XS-computron equality as advisory, so an
//! exact-count assertion would be brittle against ongoing cost-table
//! recalibration rather than load-bearing.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-1cb63ec6f8e6fc22.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-1cb63ec6f8e6fc22.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-1cb63ec6f8e6fc22.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-1cb63ec6f8e6fc22.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_search_surface_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 2, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.search surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the search surface must yield the byte-identical completion value"
    );
}
