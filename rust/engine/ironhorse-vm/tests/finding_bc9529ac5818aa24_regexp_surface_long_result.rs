//! Regression for continuous-Ironhorse-fuzz finding `bc9529ac5818aa24`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 11-byte input
//! (sha256 `c4b0b8c2b5ccf49a2608eab08cc79e770fbe892697379f8a91d99f49e11b12e4`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! new RegExp("(?:(?:(?:\\s+?0*\\s*){1,2}(?:\\d+?\\s*\\s*){1,2}…|\\s+?0*\\s*", "s").toString()
//! ```
//!
//! — a large nested whitespace / digit alternation whose `toString()`
//! completion value is 1045 bytes long.
//!
//! At the finding SHA the XS shim captured the completion value into a fixed
//! `char result[1024]` and `strncpy`-truncated it to 1023 bytes, so the pin
//! reported a cut-off string while ironhorse reported the whole `/…/s` source.
//! The port was correct; the divergence was the oracle's. The shim's buffer is
//! now 16 KiB with an honest `result_truncated` flag, and on the standing
//! branch this exact input runs the target cleanly (verified:
//! `cargo +nightly-2026-08-15 fuzz run differential_regexp_surface <input> --
//! -runs=1` exits 0).
//!
//! This test locks that the exact reproducing input's generated program runs
//! to completion and yields the full, byte-identical completion value. The raw
//! computron count is deliberately **not** pinned.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-bc9529ac5818aa24.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-bc9529ac5818aa24.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-bc9529ac5818aa24.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-bc9529ac5818aa24.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_to_string_surface_completes_with_the_full_value() {
    assert_eq!(FINDING_INPUT.len(), 11, "the minimized input stays exact");
    assert_eq!(
        EXPECTED_RESULT.len(),
        1045,
        "the pinned value is the full result, longer than the old 1 KiB oracle buffer"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.toString surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the toString surface must yield the byte-identical, untruncated completion value"
    );
}
