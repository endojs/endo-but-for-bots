//! Regression for continuous-Ironhorse-fuzz finding `3a6aab9d9d140c2c`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 8-byte input
//! (sha256 `a2a56dbe5d42cc9e08c57cd5951103f37c9c870e28687430b0f3910297534fdb`,
//! bytes `11 01 00 00 2c df 6d 6d`) folds, through
//! `ironhorse_fuzz::gen_stage3b_regexp_program`, into the whole-program
//!
//! ```text
//! var m = new RegExp("a*(?:a+a*|a+a*|\w+a*)(\n+a{1,3})", "s").exec("aa"); m ? m[0] : null
//! ```
//!
//! — an `exec` whose `(\n+a{1,3})` tail cannot match `"aa"` (no line feed), so
//! `.exec` returns `null` and the completion value is `null` on both engines.
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on XS-computron
//! equality, and this input reproduced a divergence of the same class as sibling
//! findings `2cc2ac67ba7e9b9f` / `c6c71d428a37088c`: the completion value agreed
//! **exactly** with the pin, only the meter diverged (`computrons: oracle=273
//! ironhorse=274`). The one-computron gap traced to `REGEXP_CTOR_FRAME_METERING`
//! over-charging every `new RegExp(...)` creation by exactly 72 raw 16.16 units
//! (180296 vs XS's true `fx_RegExp`/`fxInitializeRegExp` frame residual of
//! 180224, measured directly against `xsre.c`/`xsMemory.c`); the residual is
//! sub-computron and normally invisible, but this program's total straddled a
//! `>> 16` boundary (pin 17_956_792 < `274 << 16` = 17_956_864 <= port
//! 17_956_872), tipping one computron. This is a cost-table difference, not a
//! correctness defect — the port matched, failed the match, and coerced the
//! `null` completion bit-identically to the pin.
//!
//! The arm no longer gates on that meter: `ironhorse_fuzz`'s
//! `differential_check_meter_v4` / `compare_observations` treat XS computrons as
//! **advisory** ("XS computron equality cannot gate an IronHorse cost-table
//! recalibration"), and IronHorse pins its own cost table through the append-only
//! `ironhorse-meter` release ledger. At current `llm` HEAD this exact input runs
//! the target cleanly (verified: `cargo +nightly-2026-08-15 fuzz run
//! differential_regexp_surface <input> -- -runs=1` executes with no divergence).
//! The port was always correct on the observable value; rewriting the frame to
//! XS's 180224 would alter a pinned release digest and contradict that decision.
//!
//! The invariant this test locks is that the exact reproducing input's generated
//! program runs to completion **without panic** and yields the byte-identical
//! `null` completion. The raw computron count is deliberately **not** pinned: the
//! surface harness treats XS-computron equality as advisory, so an exact-count
//! assertion would be brittle against ongoing cost-table recalibration rather
//! than load-bearing.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-3a6aab9d9d140c2c.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-3a6aab9d9d140c2c.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-3a6aab9d9d140c2c.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-3a6aab9d9d140c2c.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_ctor_frame_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 8, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.exec surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the exec surface must yield the byte-identical `null` completion (the \
         `\\n+` tail cannot match \"aa\")"
    );
}
