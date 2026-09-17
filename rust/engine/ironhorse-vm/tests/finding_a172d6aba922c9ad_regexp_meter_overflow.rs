//! Regression for ironhorse fuzz finding `a172d6aba922c9ad`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`,
//! project SHA `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`).
//!
//! The 6-byte minimized input `df 3b 14 29 df 29`
//! (sha256 `0cb7cc8be506d1789cf39c5816b730c8051641e5b01169f2a4b68382b432196f`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested,
//! **backreference-heavy** pattern (16 capture groups, backrefs `\2`..`\16`
//! bounded-quantified `{1,3}`/`{2}`) with no flags, matched against the
//! subject `"0 0 0"` at start offset `5` (the end of the string).
//!
//! The pattern begins `b+…` but the subject holds no `b`, and the match
//! starts at end-of-string, so it never matches; V8/Node agree
//! (`new RegExp(pattern).exec("0 0 0")` scanning from 5 is `null`). But the
//! nested alternation over backreferences drives the port through `119645`
//! metered backtracking steps before failing, so the raw 16.16 match meter
//! is `119645 * 65536 = 7841054720`, which is **larger than `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit `txU4` field, wrapping
//! it to `7841054720 mod 2^32 = 3546087424` and manufacturing a false
//! "match meter ironhorse=7841054720 pin=3546087424" divergence in the
//! `differential_regexp` arm. This is the same root cause as findings
//! `5d122a6fc10babd9` / `8275793bca439f6e` / `407764ab1120ed1a` /
//! `637d760bc2e0278e` / `8b8afc47fcfb223d` / `c99f800f6a36e8a6`; the
//! oracle-side fix (widening the meter fields to 64 bit, commit `c8497fd8`)
//! was already landed on the standing branch and merged to `llm`, and the
//! port was always correct. With the widened oracle the arm checks clean
//! (verified: `cargo +nightly-2026-08-15 fuzz run differential_regexp
//! <input> -- -runs=1` exits 0; the port and pin agree bit-for-bit on
//! `matched`, every capture, and the full-width meter `7841054720`).
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter and exact capture offsets for
//! the reproducing case, so it stands as the portable source-of-truth the
//! oracle must agree with, and guards the matcher against ever silently
//! narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 6 bytes. Reproduced here as a byte-exact raw-string literal so the
/// regression builds without the fuzz crate (which pulls in the oracle).
const PATTERN: &str = r###"b+(((?:\2.{1,3}\2+)b+(\3{1,3}\2+\3{1,3}){2}){2}((?:\2.{1,3}\4+)b+(\5{1,3}\4+\5{1,3}){2}){2}((?:\6.{1,3}\2+)b+(\4{1,3}\7+\4{1,3}){2}){2})|((\6\8{2}\6){2}(\2\4{2}\2){2}(\9\4{2}\9){2})(?:(\12{1,3}\8+\12{1,3}){2}(\8{1,3}\3+\8{1,3}){2}(\4{1,3}\14+\4{1,3}){2}){2}((?:\12.{1,3}\14+)b+(\12{1,3}\16+\12{1,3}){2}){2}"###;

/// The generated case carries no flags.
const FLAGS: &str = "";
const SUBJECT: &str = "0 0 0";
/// The match scan starts at end-of-string.
const START: i32 = 5;

/// `119645 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 7841054720;

/// The exact `(from, to)` capture byte-offsets the port leaves on this
/// no-match, byte-for-byte identical to the XS pin's (both engines reset
/// captures per start-attempt but do not clear the last failed attempt's
/// partial state on overall failure — a shared, observable-value-irrelevant
/// detail, since a no-match returns `null` to JS). Pinned so the port's
/// backtracking trace stays locked to the pin's.
const EXPECTED_CAPTURES: &[(i32, i32)] = &[
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (5, 5),
    (5, 5),
    (5, 5),
    (5, 5),
    (-1, -1),
    (-1, -1),
    (-1, -1),
    (5, -1),
    (-1, -1),
];

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological nested backreference pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    // This case never matches; it is the *backtracking* that overflows u32.
    assert!(!outcome.matched, "the pattern does not match the subject");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "capture offsets must stay bit-identical to the XS pin"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "full-width match meter must be pinned bit-exact (no 32-bit wrap)"
    );
    // The wrapped value the truncating oracle used to report; the port must
    // never coincidentally produce it.
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "meter must not be the 32-bit-wrapped figure"
    );
}
