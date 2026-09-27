//! Regression for ironhorse fuzz finding `1dc231089278c110`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input `68 68 bc`
//! (sha256 `18d835dd78d2328c010598a2e65abf126137e92a88cde2638f52e2d0bf67643a`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! non-capturing alternation of `\n*`, `0*` and `0{1,3}` runs with no
//! flags, matched against the subject `"00\n00"` at start offset `2`.
//!
//! It matches the single `"\n"` at `(2, 3)`; V8/Node agree
//! (`/…/g` with `lastIndex = 2` finds index 2, length 1). But the nested
//! empty-matchable alternation drives the port through `83775` metered
//! backtracking steps first, so the raw 16.16 match meter is
//! `83775 * 65536 = 5490278400`, which is **larger than `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle at the fuzzed base
//! (`38ca1d18`) still copied the pin's 64-bit `meterIndex` into a 32-bit
//! field, wrapping it to `5490278400 mod 2^32 = 1195311104` and
//! manufacturing a false "match meter" divergence. This is the same root
//! cause as findings `5d122a6fc10babd9` / `407764ab1120ed1a` /
//! `8275793bca439f6e` / `8b8afc47fcfb223d` / `c99f800f6a36e8a6` /
//! `a172d6aba922c9ad`; the oracle-side fix (meter fields widened to 64 bit,
//! commit `c8497fd8`) is already on the standing branch and `llm`, and the
//! port was always correct. With the widened oracle the arm checks clean
//! (verified: `cargo +nightly-2026-08-15 fuzz run differential_regexp
//! <input> -- -runs=1` exits 0; port and pin agree bit-for-bit on
//! `matched`, the capture `(2, 3)`, and the full-width meter `5490278400`).
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter and capture offsets for the
//! reproducing case, and guards the matcher against ever silently
//! narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 3 bytes, as a byte-exact raw-string literal (`\n` here is the two-char
/// regexp escape, not a newline) so the regression builds without the
/// fuzz crate (which pulls in the oracle).
const PATTERN: &str = r#"(?:(?:(?:\n*\n*\n*)(?:\n*\n*\n*)(?:\n*\n*\n*)|\n*\n*\n*)(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})(?:(?:0*0*0*)(?:0*0*0*)(?:0*0*0*)|0*0*0*)|(?:\n*\n*\n*)(?:\n*\n*\n*)(?:\n*\n*\n*)|\n*\n*\n*)(?:(?:(?:0*0*0*)(?:0*0*0*)(?:0*0*0*)|0*0*0*)(?:(?:\n*\n*\n*)(?:\n*\n*\n*)(?:\n*\n*\n*)|\n*\n*\n*)(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})|(?:0*0*0*)(?:0*0*0*)(?:0*0*0*)|0*0*0*)(?:(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})(?:(?:0*0*0*)(?:0*0*0*)(?:0*0*0*)|0*0*0*)(?:(?:\n*\n*\n*)(?:\n*\n*\n*)(?:\n*\n*\n*)|\n*\n*\n*)|(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})|(?:(?:\n*\n*\n*)(?:\n*\n*\n*)(?:\n*\n*\n*)|\n*\n*\n*)(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})(?:(?:0*0*0*)(?:0*0*0*)(?:0*0*0*)|0*0*0*)|(?:\n*\n*\n*)(?:\n*\n*\n*)(?:\n*\n*\n*)|\n*\n*\n*"#;

/// The generated case carries no flags.
const FLAGS: &str = "";
/// A real newline in the subject.
const SUBJECT: &str = "00\n00";
const START: i32 = 2;

/// `83775 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 5490278400;

/// The whole-match `(from, to)` byte offsets, identical to the XS pin's
/// and to V8's: the lone `"\n"`.
const EXPECTED_CAPTURES: &[(i32, i32)] = &[(2, 3)];

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(outcome.matched, "the pattern matches the newline");
    assert_eq!(
        outcome.captures, EXPECTED_CAPTURES,
        "capture offsets must stay bit-identical to the XS pin"
    );
    assert_eq!(
        outcome.match_meter_raw, EXPECTED_MATCH_METER_RAW,
        "full-width match meter must be pinned bit-exact (no 32-bit wrap)"
    );
    // The wrapped value the truncating oracle reported at the fuzzed base.
    assert_ne!(
        outcome.match_meter_raw,
        EXPECTED_MATCH_METER_RAW & u64::from(u32::MAX),
        "meter must not be the 32-bit-wrapped figure"
    );
}
