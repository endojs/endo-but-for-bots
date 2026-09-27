//! Regression for continuous-Ironhorse-fuzz finding `5c9d2506e6048f4a`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 4-byte fuzz input (sha256
//! `cf677bd6b6eee5fe9ed8394911852ed267fe6057e827df87ef1ffd2abdee8302`)
//! folds through `ironhorse_fuzz::gen_stage3b_regexp_program` into a deeply
//! nested `new RegExp(<pattern>, "s").source` program. Its 1170-byte
//! completion value exceeded the XS differential oracle's former 1023-byte
//! usable capture buffer. The oracle returned a truncated prefix, so the
//! harness mistook the port's correct full result for a divergence.
//!
//! Commit `7fae4aea2f67f5b28c9ab0e371f95c0c6f25ab15` fixed the oracle by
//! enlarging its result buffer and explicitly reporting any remaining
//! overflow. This submodule-free test keeps the exact input beside the
//! deterministic bytecode and symbols that the oracle emitted, then replays
//! the program through IronHorse and checks the complete result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-5c9d2506e6048f4a.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-5c9d2506e6048f4a.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-5c9d2506e6048f4a.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-5c9d2506e6048f4a.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_source_completes_without_truncation() {
    assert_eq!(FINDING_INPUT.len(), 4, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.source program must complete, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result.len(),
        1170,
        "the result must retain every byte beyond the oracle's former capture boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "IronHorse must render the complete RegExp source"
    );
}
