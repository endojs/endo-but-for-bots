//! Regression for continuous-Ironhorse-fuzz finding `197b32cc30bdd4fe`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 4-byte fuzz input (sha256
//! `ede13378ef6a99084bdae3f261735d41106e04e22fa8b0b51b3daf39056a9211`)
//! folds through `ironhorse_fuzz::gen_stage3b_regexp_program` into a deeply
//! nested `new RegExp(<pattern>, "s").source` program. Its 1080-byte
//! completion value exceeded the XS differential oracle's former 1023-byte
//! usable capture buffer. The oracle returned a truncated prefix, so the
//! harness mistook the port's correct full result for a divergence.
//!
//! This is the same oracle-truncation class as finding `493390fc03979205`.
//! That finding's causal fix enlarged the oracle buffer and made the harness
//! skip honestly if a result still overflows it. This submodule-free test
//! keeps the exact input beside the deterministic bytecode and symbols that
//! the oracle emitted, then replays the program through IronHorse and checks
//! the complete result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-197b32cc30bdd4fe.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-197b32cc30bdd4fe.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-197b32cc30bdd4fe.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-197b32cc30bdd4fe.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_completes_without_truncation() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete, got halt {:?}",
        output.halt
    );
    assert!(
        output.result.len() > 1023,
        "the result must cross the oracle's former capture boundary; got {} bytes",
        output.result.len()
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "IronHorse must render the complete RegExp source"
    );
}
