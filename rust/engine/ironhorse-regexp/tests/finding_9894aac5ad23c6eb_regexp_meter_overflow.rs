//! Regression for ironhorse fuzz finding `9894aac5ad23c6eb`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input `68 73 74` ("hst",
//! sha256 `e93c085e8bda6c3bd0cc63c2ea9dc513b25573c999b9c391b26aa4cd29aba89c`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! capturing pattern full of unbounded/bounded quantifiers and numeric
//! backreferences, matched against the single-space subject `" "` (flag
//! `m`) at start offset 0. Matching it accrues a raw 16.16 match meter of
//! `29_761_142_784`, which is **larger than `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit field, wrapping it to
//! `29_761_142_784 mod 2^32 = 3_991_339_008` and manufacturing a false
//! "match meter" divergence in the `differential_regexp` arm. This finding
//! is the same class as the standing finding `5d122a6fc10babd9`; both were
//! resolved oracle-side (the meter fields were widened to 64 bit). The port
//! was always correct.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree with,
//! and guards the matcher against ever silently narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 3 bytes. Reproduced here as a literal so the regression builds without
/// the fuzz crate (which pulls in the oracle).
const PATTERN: &str = r"((?:(?:.{1,3}\1{1,3}\1{1,3})(\2{1,3}\2{1,3}\2{1,3})){2}(?:(?:.{1,3}\2{1,3}\2{1,3})(\2{1,3}\2{1,3}\2{1,3})){2}(?:(?:.{1,3}\2{1,3}\2{1,3})(\4{1,3}\4{1,3}\4{1,3})){2}|(?:.{1,3}\4{1,3}\4{1,3})(\1{1,3}\1{1,3}\1{1,3})){2}(?:(?:(\2{1,3}\2{1,3}\2{1,3})(\4{1,3}\4{1,3}\4{1,3})(\4{1,3}\4{1,3}\4{1,3})){2}(?:(?:.{1,3}\4{1,3}\4{1,3})(\8{1,3}\8{1,3}\8{1,3})){2}|(?:.{1,3}\8{1,3}\8{1,3})(\6{1,3}\6{1,3}\6{1,3})){2}(?:(?:(\6{1,3}\6{1,3}\6{1,3})(\8{1,3}\8{1,3}\8{1,3})(\12{1,3}\12{1,3}\12{1,3})){2}(?:(?:.{1,3}\12{1,3}\12{1,3})(\4{1,3}\4{1,3}\4{1,3})){2}|(?:.{1,3}\4{1,3}\4{1,3})(\11{1,3}\11{1,3}\11{1,3})){2}|(?:(\4{1,3}\4{1,3}\4{1,3})(\14{1,3}\14{1,3}\14{1,3})(\8{1,3}\8{1,3}\8{1,3})){2}(?:(?:.{1,3}\8{1,3}\8{1,3})(\2{1,3}\2{1,3}\2{1,3})){2}|(?:.{1,3}\2{1,3}\2{1,3})(\16{1,3}\16{1,3}\16{1,3})";

const FLAGS: &str = "m";
const SUBJECT: &str = " ";
const START: i32 = 0;

/// The exact full-width raw match meter, which exceeds `u32::MAX` and so
/// must never be truncated. `29_761_142_784 mod 2^32 = 3_991_339_008` was
/// the phantom value the truncating oracle reported.
const EXPECTED_MATCH_METER_RAW: u64 = 29_761_142_784;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological deeply-nested backreference pattern.
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
        "meter must not be the 32-bit-wrapped figure"
    );
}
