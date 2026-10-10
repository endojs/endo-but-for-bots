//! Regression for ironhorse fuzz finding `92aeb09eace0008b`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input
//! (sha256 `663a47b2beee4e5278fc608d427be4d132251f0863a5a8af73cbeed45321adb2`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! backreference-heavy, empty-matchable pattern (dotall flag `s`) matched
//! against the subject `"a"` at start offset 0. Matching it dispatches
//! 470334 metered steps, so the raw 16.16 match meter is
//! `470334 * 65536 = 30_823_809_024`, which is **larger than `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit `txU4` field, wrapping
//! it to `30_823_809_024 mod 2^32 = 759_037_952` and manufacturing a false
//! "match meter" divergence in the `differential_regexp` arm (ironhorse
//! reported the correct 30_823_809_024, the truncating pin reported
//! 759_037_952). This is the same harness-side truncation as sibling
//! finding `5d122a6fc10babd9`; the fix that widened the oracle's meter
//! fields to 64 bit (`fix(xs-oracle): stop truncating the differential
//! regexp match meter`) subsumes this input too. The port was always
//! correct.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree
//! with, and guards the matcher against ever silently narrowing the meter
//! (and against panicking on this pathological empty-matchable pattern).

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 3 bytes. A raw string literal (the pattern has backslash escapes but no
/// double quote) reproduced here so the regression builds without the fuzz
/// crate (which pulls in the oracle).
const PATTERN: &str = r"(?:((?:[a-c0-9]{1,3}\1{1,3})(\2{1,3}\2{1,3}\2{1,3})(\2{1,3}\2{1,3}\2{1,3})){1,2}(?:(?:.{1,3}\2{1,3}\2{1,3})(\4{1,3}\4{1,3}\4{1,3})){1,2}(?:(?:.{1,3}\4{1,3}\4{1,3})(\5{1,3}\5{1,3}\5{1,3})){1,2}|(?:.{1,3}\5{1,3}\5{1,3})(\2{1,3}\2{1,3}\2{1,3})){1,2}(?:(?:(\4{1,3}\4{1,3}\4{1,3})(\8{1,3}\8{1,3}\8{1,3})(\2{1,3}\2{1,3}\2{1,3})){1,2}(?:(?:.{1,3}\2{1,3}\2{1,3})(\10{1,3}\10{1,3}\10{1,3})){1,2}|(?:.{1,3}\10{1,3}\10{1,3})(\2{1,3}\2{1,3}\2{1,3})){1,2}|(?:(\8{1,3}\8{1,3}\8{1,3})(\5{1,3}\5{1,3}\5{1,3})(\4{1,3}\4{1,3}\4{1,3})){1,2}(?:(?:.{1,3}\4{1,3}\4{1,3})(\5{1,3}\5{1,3}\5{1,3})){1,2}|(?:.{1,3}\5{1,3}\5{1,3})(\8{1,3}\8{1,3}\8{1,3})";

/// The dotall flag the generator selected for this case.
const FLAGS: &str = "s";
const SUBJECT: &str = "a";
const START: i32 = 0;

/// `470334 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 30_823_809_024;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological empty-matchable pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(outcome.matched, "the pattern matches at offset {START}");
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "full-width match meter must be pinned bit-exact (no 32-bit wrap)"
    );
    // The wrapped value the truncating oracle used to report; the port must
    // never coincidentally produce it.
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "meter must not be the 32-bit-wrapped figure (759_037_952)"
    );
}
