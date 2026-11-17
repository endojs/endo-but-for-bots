//! Regression for ironhorse fuzz finding `ac8a8e3d9d3d7f96`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 11-byte minimized input
//! (sha256 `806a67c0ca38cf31cd382ad906047d3c68c50b276920705b370f9d18c1f38093`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a 15-group pattern: a
//! `{1,2}`-quantified group of `{2}`-quantified backreference groups followed
//! by lookbehinds over further backreferences, matched with the `m` flag
//! against `" ccc"` from offset zero. It fails to match, but only after
//! 596085 metered backtracking steps, so the raw 16.16 match meter is
//! `596085 * 65536 = 39065026560`, beyond `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field
//! (`txU4 match_meter_raw`) and wrapped it to `410320896`
//! (`39065026560 - 9 * 2^32`), manufacturing a false meter divergence. The
//! causal oracle fix from finding `5d122a6fc10babd9` (c8497fd88b) widened the
//! meter fields to 64 bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-ac8a8e3d9d3d7f96.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-ac8a8e3d9d3d7f96.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-ac8a8e3d9d3d7f96.regexp-case.txt");
const EXPECTED_PATTERN: &str = r"(((\2?\2{2}){2}(\4{2}\3?)){2}((\2?\2{2}){2}(\7{2}\7?)){2}((\5?\5{2}){2}(\10{2}\5?)){2}){1,2}(((?<!\8{2}\8{2})(\10{2}\w))((?<!\12{2}c{2})(?<!\14{2}\8{2})))";
const EXPECTED_MATCH_METER_RAW: u64 = 39_065_026_560;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
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
    (4, -1),
    (4, -1),
    (-1, -1),
    (-1, -1),
];
#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        11,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "806a67c0ca38cf31cd382ad906047d3c68c50b276920705b370f9d18c1f38093",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(pattern, EXPECTED_PATTERN);
    assert_eq!(flags, "m");
    assert_eq!(subject, " ccc");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(!outcome.matched, "the exact finding pattern must not match");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "the exact finding must retain its capture vector"
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
