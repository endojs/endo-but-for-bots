//! Regression for ironhorse fuzz finding `637d760bc2e0278e`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 4-byte minimized input `68 d4 80 df`
//! (sha256 `8c07999756e8cfc3a105c0a58a725b7a8d05e182fac761c61ba47452bd4e0130`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested,
//! backreference-heavy pattern over the subject `"b 00b"` at start offset
//! 0. The pattern never matches, but the port explores 458132
//! metered backtracking steps before failing, so the raw 16.16 match meter
//! is `458132 * 65536 = 30024138752`, which is **larger than `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit `txU4` field, wrapping
//! it to `30024138752 mod 2^32 = 4254334976` and manufacturing a false "match
//! meter" divergence in the `differential_regexp` arm. This is the same
//! root cause as findings `5d122a6fc10babd9` / `8275793bca439f6e` /
//! `407764ab1120ed1a`; the oracle-side fix (widening the meter fields to
//! 64 bit) was already landed on the standing branch, and the port was
//! always correct.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree
//! with, and guards the matcher against ever silently narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 4 bytes (`68 d4 80 df`). Reproduced here as a byte-exact raw-string
/// literal so the regression builds without the fuzz crate (which pulls in
/// the oracle). The literal `\N` sequences are numeric backreferences.
const PATTERN: &str = r###"(?:((?:\1{1,3}[a-c]{1,3}[a-c]{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\1*\1{1,3}))(?:([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\3*\3{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}|\1*\1{1,3})((?:\5{1,3}[a-c]{1,3}[a-c]{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\3*\3{1,3}))|([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\3*\7{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}|\5*\1{1,3})((?:([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\3*\5{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}|\4*\6{1,3})((?:\9{1,3}[a-c]{1,3}[a-c]{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\5*\1{1,3}))(?:([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\3*\7{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}|\3*\15{1,3}))(?:((?:\9{1,3}[a-c]{1,3}[a-c]{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\9*\3{1,3}))(?:([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\15*\15{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}|\4*\10{1,3})((?:\5{1,3}[a-c]{1,3}[a-c]{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\3*\21{1,3}))|([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}(?:\15*\17{1,3})([a-c0-9]*[a-c0-9]*[a-c0-9]*){1,2}|\6*\13{1,3})"###;

const SUBJECT: &str = "b 00b";
const START: i32 = 0;

/// `458132 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 30024138752;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, "").expect("pattern compiles");
    // No panic on this pathological backreference-heavy pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    // This case never matches; it is the *backtracking* that overflows u32.
    assert!(!outcome.matched, "the pattern does not match the subject");
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
