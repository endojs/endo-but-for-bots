//! Regression for ironhorse fuzz finding `7637ac162a0b916a`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 6-byte minimized input
//! (sha256 `a62a861beeaae59d45ec4bad76a22ed6a371a620347a43673bc8d7114f5b1707`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a 29-group pattern of
//! `{2}`-quantified `(\N*\w*\N*)` groups over backreferences, alternated with
//! `\n{2}` backreference sequences, matched with the `i` flag against `"b"`
//! from offset zero. It fails to match, but only after 7482237 metered
//! backtracking steps, so the raw 16.16 match meter is
//! `7482237 * 65536 = 490355884032`, beyond `u32::MAX`.
//!
//! The port keeps that full value in a `u64`. At the finding SHA, the XS
//! differential oracle copied its own 64-bit meter into a 32-bit field
//! (`txU4 match_meter_raw`) and wrapped it to `729612288`
//! (`490355884032 - 114 * 2^32`), manufacturing a false meter divergence. The
//! causal oracle fix from finding `5d122a6fc10babd9` (c8497fd88b) widened the
//! meter fields to 64 bits; the port was always correct.
//!
//! This test replays the regexp case that `ironhorse_fuzz::gen_regexp`
//! generates from the exact input, pinned in
//! `fixtures/finding-7637ac162a0b916a.regexp-case.txt`, which
//! `ironhorse-fuzz/tests/vm_finding_fixtures.rs` regenerates from the input and
//! byte-compares; the test also asserts the input's cited sha256. It then runs
//! the pinned case through the pure-Rust regexp engine, so it builds without
//! the XS oracle or `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-7637ac162a0b916a.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-7637ac162a0b916a.regexp-case.txt");
const EXPECTED_PATTERN: &str = r"(((?:\1\n{2}\1)(?:\1\n{2}\1)(?:\1\n{2}\1)|\1\n{2}\1)(?:(\3*\w*\3*){2}(\1*\w*\1*){2}(\4*\w*\4*){2})((?:\3\n{2}\3)(?:\3\n{2}\3)(?:\3\n{2}\3)|\3\n{2}\3)|(\2*\w*\2*){2}(\1*\w*\1*){2}(\9*\w*\9*){2})((?:(\9*\w*\9*){2}(\9*\w*\9*){2}(\9*\w*\9*){2})((?:\9\n{2}\9)(?:\9\n{2}\9)(?:\9\n{2}\9)|\9\n{2}\9)(?:(\9*\w*\9*){2}(\9*\w*\9*){2}(\9*\w*\9*){2}))(?:((b *b)(b *b)(b *b))(?:(\9*\w*\9*){2}(\9*\w*\9*){2}(\9*\w*\9*){2})((?:\9\n{2}\9)(?:\9\n{2}\9)(?:\9\n{2}\9)|\9\n{2}\9)|(\9*\w*\9*){2}(\9*\w*\9*){2}(\9*\w*\9*){2})";
const EXPECTED_MATCH_METER_RAW: u64 = 490_355_884_032;
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (-1, -1),
    (1, 1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (1, -1),
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
];
#[test]
fn exact_fuzz_input_preserves_the_full_width_match_meter() {
    assert_eq!(
        FINDING_INPUT.len(),
        6,
        "the minimized finding remains exact"
    );
    common::fixtures::assert_input_sha256(
        FINDING_INPUT,
        "a62a861beeaae59d45ec4bad76a22ed6a371a620347a43673bc8d7114f5b1707",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(pattern, EXPECTED_PATTERN);
    assert_eq!(flags, "i");
    assert_eq!(subject, "b");
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
