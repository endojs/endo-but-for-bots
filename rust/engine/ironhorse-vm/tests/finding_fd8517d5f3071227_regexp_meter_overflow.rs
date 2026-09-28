//! Regression for Ironhorse fuzz finding `fd8517d5f3071227`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The exact 30-byte minimized input
//! (sha256 `69c4d5ae332ac1ddbf55119ab093eaf6d5ac592521784224b09f3e5befe82f4e`)
//! folds through the maintained regexp generator into the adjacent 395-byte
//! nested `\s*`/`\w*` quantifier pattern, flags `m`. Matching against
//! `"0000000"` at offset zero completes without a match after 74765 metered
//! steps, for a raw 16.16 meter of `4_899_799_040`, which exceeds `u32::MAX`.
//!
//! At the finding SHA, the XS differential shim copied its 64-bit meter into
//! a 32-bit field and reported the wrapped value `604_831_744`. The existing
//! causal fix in `c8497fd88` widened the oracle fields to 64 bits; the port was
//! already correct. This test asserts the input's cited sha256 and replays the
//! case `ironhorse_fuzz::gen_regexp` generates from it, pinned in
//! `fixtures/finding-fd8517d5f3071227.regexp-case.txt` (regenerated and
//! byte-compared by `ironhorse-fuzz/tests/vm_finding_fixtures.rs`). It pins
//! the port's completion and full-width meter without depending on the oracle
//! or the `c/moddable` submodule.

mod common;

const FINDING_INPUT: &[u8] = include_bytes!("fixtures/finding-fd8517d5f3071227.input.bin");
const REGEXP_CASE: &str = include_str!("fixtures/finding-fd8517d5f3071227.regexp-case.txt");
const EXPECTED_PATTERN: &str = include_str!("fixtures/finding-fd8517d5f3071227.pattern.txt");
const EXPECTED_MATCH_METER_RAW: u64 = 4_899_799_040;
const OLD_ORACLE_WRAPPED_METER: u64 = 604_831_744;
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
        "69c4d5ae332ac1ddbf55119ab093eaf6d5ac592521784224b09f3e5befe82f4e",
    );
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let (pattern, flags, subject, start) = common::fixtures::regexp_case(REGEXP_CASE);
    assert_eq!(pattern, EXPECTED_PATTERN);
    assert_eq!(flags, "m");
    assert_eq!(subject, "0000000");
    assert_eq!(start, 0);

    let program = ironhorse_regexp::compile(&pattern, &flags).expect("finding pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, subject.as_bytes(), start);

    assert!(
        !outcome.matched,
        "the exact finding must remain a non-match"
    );
    assert!(!outcome.aborted, "matching must complete without aborting");
    assert!(
        !outcome.resource_limit,
        "matching must complete without a resource refusal"
    );
    assert_eq!(outcome.captures, EXPECTED_CAPTURES);
    assert_eq!(outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW);
    assert_eq!(
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        OLD_ORACLE_WRAPPED_METER
    );
    assert_ne!(outcome.match_meter_raw, OLD_ORACLE_WRAPPED_METER);
}
