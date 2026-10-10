//! Regression for ironhorse fuzz finding `5d122a6fc10babd9`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input
//! (sha256 `79942bf96e3b9bb97a3ef0f66a352ecff1b171e26906f9839cb24e0842d7a917`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested
//! empty-matchable pattern over the subject `"00b00"` at start offset 2.
//! Matching it dispatches 243671 metered steps, so the raw 16.16 match
//! meter is `243671 * 65536 = 15_969_222_656`, which is **larger than
//! `u32::MAX`**.
//!
//! The port's [`ironhorse_regexp`] matcher meters into a `u64` and holds
//! that full value. The XS differential oracle originally copied the pin's
//! (64-bit `meterIndex`) match meter into a 32-bit `txU4` field, wrapping
//! it to `15_969_222_656 mod 2^32 = 3_084_320_768` and manufacturing a
//! false "match meter" divergence in the `differential_regexp` arm. The
//! fix widened the oracle's meter fields to 64 bit; the port was always
//! correct.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree
//! with, and guards the matcher against ever silently narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 3 bytes (`68 68 14`). Reproduced here as a literal so the regression
/// builds without the fuzz crate (which pulls in the oracle).
const PATTERN: &str = "(?:(?:(?:b*b*b*)(?:b*b*b*)(?:b*b*b*)|b*b*b*)(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})(?:(?:0*0*0*)?(?:0*0*0*)?(?:0*0*0*)?|0*0*0*)?|(?:b*b*b*)(?:b*b*b*)(?:b*b*b*)|b*b*b*)(?:(?:(?:0*0*0*)?(?:0*0*0*)?(?:0*0*0*)?|0*0*0*)?(?:(?:b*b*b*)(?:b*b*b*)(?:b*b*b*)|b*b*b*)(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})|(?:0*0*0*)?(?:0*0*0*)?(?:0*0*0*)?|0*0*0*)?(?:(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})(?:(?:0*0*0*)?(?:0*0*0*)?(?:0*0*0*)?|0*0*0*)?(?:(?:b*b*b*)(?:b*b*b*)(?:b*b*b*)|b*b*b*)|(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})|(?:(?:b*b*b*)(?:b*b*b*)(?:b*b*b*)|b*b*b*)(?:(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})(?:0{1,3}0{1,3}0{1,3})|0{1,3}0{1,3}0{1,3})(?:(?:0*0*0*)?(?:0*0*0*)?(?:0*0*0*)?|0*0*0*)?|(?:b*b*b*)(?:b*b*b*)(?:b*b*b*)|b*b*b*";

const SUBJECT: &str = "00b00";
const START: i32 = 2;

/// `243671 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 15_969_222_656;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, "").expect("pattern compiles");
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
        "meter must not be the 32-bit-wrapped figure"
    );
}
