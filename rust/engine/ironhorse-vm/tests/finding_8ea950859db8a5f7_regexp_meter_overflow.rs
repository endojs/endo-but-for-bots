//! Regression for ironhorse fuzz finding `8ea950859db8a5f7`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 3-byte minimized input
//! (sha256 `74718c926b43f7719a57c58fd90e170eb5e9ee1872dd4973f321e07ce3025859`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a 24-group pattern: a
//! top-level alternation of three groups of `{1,3}`-quantified
//! backreferences followed by `\n{1,3}` runs, matched with no flags
//! against `" \n\n \n"` from offset one. It matches the empty range `[1, 1)`,
//! but only after 78962 metered backtracking steps, so the raw 16.16 match
//! meter is `78962 * 65536 = 5174853632`, beyond `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field
//! (`txU4 match_meter_raw`) and wrapped it to `879886336`, manufacturing a
//! false meter divergence. The causal oracle fix from finding
//! `5d122a6fc10babd9` (c8497fd88b) widened the meter fields to 64 bits; the
//! port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-8ea950859db8a5f7.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-8ea950859db8a5f7.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-8ea950859db8a5f7.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 5_174_853_632;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (1, 1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, 1),
    (1, 1),
    (1, 1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, 1),
    (1, 1),
    (1, 1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, 1),
    (1, 1),
    (1, 1),
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
        3,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "74718c926b43f7719a57c58fd90e170eb5e9ee1872dd4973f321e07ce3025859",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(flags, "");
    assert_eq!(subject, " \n\n \n");
    assert_eq!(start, 1);

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
