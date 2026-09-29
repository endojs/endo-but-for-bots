//! Regression for ironhorse fuzz finding `6be90176ff07c648`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 9-byte minimized input
//! (sha256 `241b6de8342803a0d585b1a517ecfefd09d78913f0770cd44ce8ef3fbdd4aa12`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested alternation
//! of `{1,2}`/`{2}`-quantified groups over lazy `\Bb*\w*?`, `\S*\w` and
//! `\n\S*` runs, matched with flag `m` against `"\n  ab\n"` at offset zero.
//! Backtracking dispatches 152062 metered steps, so the raw 16.16 match meter
//! is `152062 * 65536 = 9965535232`, which exceeds `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field and
//! wrapped it to `1375600640` (exactly `2^33` less), manufacturing a false
//! divergence. The causal oracle fix from finding `5d122a6fc10babd9` widened
//! the meter fields to 64 bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-6be90176ff07c648.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-6be90176ff07c648.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-6be90176ff07c648.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 9_965_535_232;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (6, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
];

#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        9,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "241b6de8342803a0d585b1a517ecfefd09d78913f0770cd44ce8ef3fbdd4aa12",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(flags, "m");
    assert_eq!(subject, "\n  ab\n");
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
