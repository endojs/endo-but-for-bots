//! Regression for ironhorse fuzz finding `5eeb0aadb2004075`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 30-byte minimized input
//! (sha256 `34f722ff054be45a770489eb6ce00ec348bd4eaa33f26529dbdde2801096c673`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! non-capturing alternation of `.*.*.*` runs, `\D+` runs and `(?!\D+)` /
//! `(?=...)` lookarounds, matched with no flags against `"11111111"` at offset
//! zero. Every path needs a non-digit, so it does not match, as V8 agrees.
//! Backtracking dispatches 181602 metered steps, so the raw 16.16 match meter
//! is `181602 * 65536 = 11901468672`, which exceeds `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field and
//! wrapped it to `3311534080` (exactly `2 * 2^32` less), manufacturing a false
//! divergence. The causal oracle fix from finding `5d122a6fc10babd9` widened
//! the meter fields to 64 bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-5eeb0aadb2004075.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-5eeb0aadb2004075.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-5eeb0aadb2004075.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 11_901_468_672;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[(-1, -1)];

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        30,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "34f722ff054be45a770489eb6ce00ec348bd4eaa33f26529dbdde2801096c673",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(flags, "");
    assert_eq!(subject, "11111111");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(!outcome.matched, "the exact finding pattern must not match");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "the exact finding must retain its capture offsets"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "the exact finding must retain its full-width meter"
    );
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "the meter must not wrap to the old oracle's 32-bit value"
    );
}
