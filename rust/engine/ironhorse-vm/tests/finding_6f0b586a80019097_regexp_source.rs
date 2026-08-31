//! Regression for continuous-Ironhorse-fuzz finding `6f0b586a80019097`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`).
//!
//! The exact 5-byte fuzz input
//! (sha256 `7637ee2cbd7ed3fbb4ceb06ff0e8fc37f4e64308a503b6f8bb388e2fbf965497`)
//! folds into a deeply nested `RegExp.source` program with a 1160-byte
//! completion value. At the finding's project SHA `38ca1d18` the XS oracle
//! captured its own reference value into a fixed 1024-byte buffer and
//! `strncpy`-truncated it to 1023 bytes; the differential harness then read the
//! port's correct full value as a divergence and panicked. The port was never
//! wrong. The causal oracle-side fix (a 16 KiB capture buffer plus an honest
//! skip when the value still overflows) already landed for same-class finding
//! `493390fc03979205`, so this distinct input now compares in full and agrees.
//!
//! This submodule-free test keeps the exact input alongside the deterministic
//! bytecode and symbols emitted for its generated program. It replays that
//! program through `ironhorse_vm::run_program_with_symbols` and asserts the VM
//! completes without panicking or truncating the result.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-6f0b586a80019097.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-6f0b586a80019097.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-6f0b586a80019097.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-6f0b586a80019097.expected-result.txt");

#[test]
fn exact_fuzz_input_program_completes_without_panic_or_truncation() {
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
        "the full result must cross the oracle's former 1023-byte boundary"
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the VM must render the complete RegExp source without truncation"
    );
}
