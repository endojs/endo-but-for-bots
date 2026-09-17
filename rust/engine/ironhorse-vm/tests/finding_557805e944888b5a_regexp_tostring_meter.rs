//! Regression for continuous-Ironhorse-fuzz finding `557805e944888b5a`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 11-byte input `14 14 14 a0 24 a0 c6 a0 24 a0 c6`
//! (sha256 `6ec8c34eaf1d04f2f67d9964a024e7294d836121f0b836a75209061206ae8af6`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! program
//!
//! ```js
//! new RegExp("(?:\\d* {1,3}\\d{1,3}|\\d* {1,3}\\d{1,3}|a*[a-c]*[a-c]{1,3})? +?\\d*", "").toString()
//! ```
//!
//! whose completion value is the 65-byte string
//! `/(?:\d* {1,3}\d{1,3}|\d* {1,3}\d{1,3}|a*[a-c]*[a-c]{1,3})? +?\d*/`.
//!
//! At the finding SHA the `differential_regexp_surface` arm gated on
//! XS-computron equality and this input reproduced a divergence of the same
//! class as sibling findings `1898f584e9bf841a`, `1a2012ae1ec44d21`, and
//! `c6c71d428a37088c`: the port and the XS pin agree **bit-for-bit on the
//! completion value**, only the computron count differs (XS charged 49, the
//! port 71 — `RegExp.prototype.toString` builds `/`+source+`/`+flags, which the
//! port meters on its own cost table). The `differential_regexp_surface`
//! harness now treats XS-computron equality as advisory ("XS computron equality
//! cannot gate an IronHorse cost-table recalibration", `ironhorse-fuzz` §
//! `differential_check_meter_v4`), so at current `llm` this exact input runs the
//! target cleanly (verified: the harness's own `differential_check_meter_v4`
//! returns `Ok` for the generated source). The port was always correct on the
//! completion value.
//!
//! The load-bearing invariant this test locks is that the exact reproducing
//! input's generated program runs to completion **without panic** and yields the
//! byte-identical `RegExp.prototype.toString()` value. The raw computron count is
//! deliberately **not** pinned: an exact-count assertion would be brittle against
//! ongoing cost-table recalibration rather than load-bearing, exactly as the
//! sibling `regexp_source_meter` regressions record.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the differential oracle emitted for its generated
//! program and replays them through `ironhorse_vm::run_program_with_symbols`.

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-557805e944888b5a.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-557805e944888b5a.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-557805e944888b5a.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-557805e944888b5a.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_tostring_completes_with_the_pinned_value() {
    assert_eq!(FINDING_INPUT.len(), 11, "the minimized input stays exact");

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.toString() program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "the toString() must yield the byte-identical /source/flags rendering"
    );
}
