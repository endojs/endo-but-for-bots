//! Regression for ironhorse fuzz finding `79f0475dd0440b2d`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 3-byte minimized input
//! (sha256 `df0ec7eb405a4384678271e613dac0a54682116e7684738d817cb2c201609b67`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a 20-group pattern of
//! nested `{2}`-quantified alternations whose atoms are `{1,3}`-quantified
//! backreferences and `.{1,3}` runs, matched with flag `m` against
//! `" \n\n \n"` from offset one. It matches (`[3, 4)`), but only after
//! 464407076 metered backtracking steps, so the raw 16.16 match meter is
//! `464407076 * 65536 = 30435382132736`, far beyond `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field
//! (`txU4 match_meter_raw`) and wrapped it to `1243873280`, manufacturing a
//! false meter divergence. The causal oracle fix from finding
//! `5d122a6fc10babd9` (c8497fd88b) widened the meter fields to 64 bits; the
//! port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-79f0475dd0440b2d.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-79f0475dd0440b2d.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-79f0475dd0440b2d.regexp-case.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 30_435_382_132_736;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (3, 4),
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
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (3, 3),
    (3, 3),
    (3, 3),
    (4, 4),
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
        "df0ec7eb405a4384678271e613dac0a54682116e7684738d817cb2c201609b67",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(flags, "m");
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
