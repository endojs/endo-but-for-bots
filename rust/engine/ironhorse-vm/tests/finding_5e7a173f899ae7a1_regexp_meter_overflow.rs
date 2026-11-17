//! Regression for ironhorse fuzz finding `5e7a173f899ae7a1`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 3-byte minimized input
//! (sha256 `a2e071e91af4adb713327ad655155d762060283b46b82487c9c6f429324c6dbe`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! non-capturing alternation of `\n*`, `0*` and `0{1,3}` runs, matched with the
//! `m` flag against `"00\n00"` at offset two. It matches `(2, 3)`, as V8
//! does. Matching dispatches 215842 metered steps, so the raw 16.16 match
//! meter is `215842 * 65536 = 14145421312`, which exceeds `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field and
//! wrapped it to `1260519424` (exactly `3 * 2^32` less), manufacturing a false
//! divergence. The causal oracle fix from finding `5d122a6fc10babd9` widened
//! the meter fields to 64 bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-5e7a173f899ae7a1.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-5e7a173f899ae7a1.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-5e7a173f899ae7a1.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 14_145_421_312;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[(2, 3)];

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        3,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "a2e071e91af4adb713327ad655155d762060283b46b82487c9c6f429324c6dbe",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(flags, "m");
    assert_eq!(subject, "00\n00");
    assert_eq!(start, 2);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(outcome.matched, "the exact finding pattern must match");
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
