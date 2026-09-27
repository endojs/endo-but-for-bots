//! Regression for continuous-Ironhorse-fuzz finding `6ba52f2bdc534545`
//! (target `differential_regexp_surface`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 5-byte input
//! (sha256 `bac79026fdb2ec1e1f65bd20757c6ac470891bc63821af6f9f0b4c56716c7fc1`)
//! folds, through `ironhorse_fuzz::gen_stage3b_regexp_program`, into the
//! whole-program
//!
//! ```text
//! new RegExp("(?:(?:(?:[abc]{1,3}[a-c]+?[a-c]{1,3}){1,2}|…|[^a-c]{1,3}[abc]{1,3}[a-c]+?", "s").toString()
//! ```
//!
//! — a deeply nested disjunction whose `toString()` is a 1963-byte string.
//!
//! At the finding SHA the target reported a **result** divergence, but the
//! port was correct: the XS oracle copied its completion value into a fixed
//! ~1 KiB capture buffer, so `oracle.result` was a truncated prefix while
//! `ironhorse.result` was the full, correct `/…/s` string. The defect lay in
//! the differential harness, not the engine (same class as findings
//! `493390fc03979205` / `197b32cc30bdd4fe`). Causal fixes, already in `llm`:
//! `fix(xs-oracle): stop truncating the differential completion value`
//! (7fae4aea2f) and `fix(xs-oracle): carry result_truncated through the
//! multi-crank copy-out` (8fdef95f3c). On the standing branch the oracle now
//! returns the full string, byte-identical to the port, and the target exits
//! 0 on this input.
//!
//! This submodule-free test keeps the exact input beside the deterministic
//! bytecode and symbols the oracle emits for its generated program and replays
//! them through `ironhorse_vm`, pinning the full (untruncated) completion
//! value the XS pin now reports. The raw computron count is deliberately not
//! pinned (XS computrons are advisory in this arm).

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-6ba52f2bdc534545.input.bin");
const BYTECODE: &[u8] = include_bytes!("fixtures/finding-6ba52f2bdc534545.bytecode.bin");
const SYMBOLS: &[u8] = include_bytes!("fixtures/finding-6ba52f2bdc534545.symbols.bin");
const EXPECTED_RESULT: &str = include_str!("fixtures/finding-6ba52f2bdc534545.expected-result.txt");

#[test]
fn exact_fuzz_input_regexp_tostring_completes_with_the_full_value() {
    assert_eq!(FINDING_INPUT.len(), 5, "the minimized input stays exact");
    assert!(
        EXPECTED_RESULT.len() > 1024
            && EXPECTED_RESULT.starts_with("/(?:")
            && EXPECTED_RESULT.ends_with("/s"),
        "the pinned value must be the full, untruncated regexp string"
    );

    let output = ironhorse_vm::run_program_with_symbols(BYTECODE, SYMBOLS);
    assert!(
        output.completed,
        "the RegExp.toString surface program must complete without panic, got halt {:?}",
        output.halt
    );
    assert_eq!(
        output.result, EXPECTED_RESULT,
        "RegExp.prototype.toString must yield the byte-identical completion value"
    );
}
