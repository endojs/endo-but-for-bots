//! Regression for continuous-Ironhorse-fuzz finding `9001b34fa6dd2d80`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 5-byte input (sha256
//! `5e2b476e505da46d7a2151149cf5a8ac93173736cfd1fd136bea0152cae2318c`)
//! folds into a deeply nested `new RegExp(<pattern>, "i").source` program.
//! Its 1231-byte completion value exceeded the XS differential oracle's old
//! 1023-byte usable capture buffer. The oracle returned a truncated prefix,
//! so the harness mistook the port's correct full result for a divergence.
//! This is the same oracle-truncation class as finding `493390fc03979205`;
//! that finding's causal fix enlarged the buffer and made the harness skip
//! honestly if a result still overflows it.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols emitted for its generated program. It replays that
//! program through IronHorse and checks the complete result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-9001b34fa6dd2d80.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-9001b34fa6dd2d80.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-9001b34fa6dd2d80.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-9001b34fa6dd2d80.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_completes_without_truncation() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");
    assert_eq!(
        FINDING_INPUT.last().map(|byte| byte % 12),
        Some(4),
        "the exact input selects the RegExp.source surface"
    );

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
