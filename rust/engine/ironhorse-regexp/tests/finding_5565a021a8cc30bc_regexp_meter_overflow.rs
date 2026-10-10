//! Regression for ironhorse fuzz finding `5565a021a8cc30bc`
//! (target `differential_regexp`, toolchain `nightly-2026-08-15`).
//!
//! The 4-byte minimized input `0b df 4d 14`
//! (sha256 `473e993461f8470c9e9c930d3a4e566d92364c11ffbaef5c5998ced01088bc93`)
//! folds, through `ironhorse_fuzz::gen_regexp`, into a deeply nested,
//! **backreference-heavy** alternation (44 capture groups; forward
//! backreferences like `\12`/`\39` to groups that never participate, lazy
//! `\w*?` runs, and `{1,2}`/`{2}` repeats) matched over the subject
//! `"b 0bb"` at start offset 0 with the `s` (dotAll) flag. The pattern does
//! **not** match, but the backtracking search to prove the non-match
//! dispatches 128_348 metered steps, so the raw 16.16 match meter is
//! `128_348 * 65536 = 8_411_414_528` — nearly **2x larger than `u32::MAX`**.
//!
//! This is the *same 32-bit-meter-truncation class* as findings
//! `493390fc03979205`, `5d122a6fc10babd9`, and `8275793bca439f6e`, resolved
//! on this branch by widening the XS oracle's meter fields to 64 bit
//! (`txU8`, commit `c8497fd88`). The port's [`ironhorse_regexp`] matcher
//! always metered into a `u64` and held the full value; the pre-fix oracle
//! copied the pin's 64-bit `meterIndex` into a 32-bit `txU4` field, wrapping
//! `8_411_414_528 mod 2^32 = 4_116_447_232` and manufacturing a false "match
//! meter" divergence in the `differential_regexp` arm. Under the widened
//! oracle the port and the XS pin agree bit-exact. This finding only
//! reproduces against the base SHA
//! `38ca1d189384245dd9accfcc2f79763a3b8ec5cb` that predates that fix. It is a
//! *distinct* witness from the sibling meter cases: this one is a **non-match**
//! (the earlier witnesses all matched), so it independently guards the
//! full-width meter along the exhaustive-backtrack-to-failure path.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule:
//! it pins the port's own full-width meter for the exact reproducing case,
//! so it stands as the portable source-of-truth the oracle must agree
//! with, and guards the matcher against ever silently narrowing the meter.

/// The pattern `ironhorse_fuzz::gen_regexp` produces from the finding's
/// 4 bytes (`0b df 4d 14`). Reproduced here as a raw literal (it contains
/// `\2`/`\12`/`\w` escapes) so the regression builds without the fuzz
/// crate (which pulls in the oracle).
const PATTERN: &str = r"((?:(\2b{2}\2{1,3}){2}(\3b{2}\3{1,3}){2}(\4b{2}\2{1,3}){2}){1,2}(?:(\2b{2}\3{1,3}){2}(\6b{2}\6{1,3}){2}(\5b{2}\1{1,3}){2}){1,2}(?:(\4b{2}\6{1,3}){2}(\3b{2}\6{1,3}){2}(\2b{2}\8{1,3}){2}){1,2}|(\1b{2}\1{1,3}){2}(\12b{2}\6{1,3}){2}(\12b{2}\13{1,3}){2}){1,2}(?:((?:\8{1,3}\w*?\12){1,2}(?:\8{1,3}\w*?\12){1,2}(?:\8{1,3}\w*?\12){1,2}|\8{1,3}\w*?\12){1,2}(?:(\12b{2}\3{1,3}){2}(\12b{2}\14{1,3}){2}(\12b{2}\10{1,3}){2}){1,2}(?:(\12b{2}\6{1,3}){2}(\12b{2}\2{1,3}){2}(\12b{2}\18{1,3}){2}){1,2}|(\12b{2}\15{1,3}){2}(\12b{2}\12{1,3}){2}(\12b{2}\9{1,3}){2}){1,2}(?:((?:\6{1,3}\w*?\12){1,2}(?:\6{1,3}\w*?\12){1,2}(?:\6{1,3}\w*?\12){1,2}|\6{1,3}\w*?\12){1,2}(?:(\12b{2}\3{1,3}){2}(\12b{2}\26{1,3}){2}(\12b{2}\24{1,3}){2}){1,2}(?:(\12b{2}\22{1,3}){2}(\12b{2}\20{1,3}){2}(\12b{2}\18{1,3}){2}){1,2}|(\12b{2}\16{1,3}){2}(\12b{2}\14{1,3}){2}(\12b{2}\12{1,3}){2}){1,2}|((?:\10{1,3}\w*?\12){1,2}(?:\10{1,3}\w*?\12){1,2}(?:\10{1,3}\w*?\12){1,2}|\10{1,3}\w*?\12){1,2}(?:(\12b{2}\8{1,3}){2}(\12b{2}\6{1,3}){2}(\12b{2}\4{1,3}){2}){1,2}(?:(\12b{2}\2{1,3}){2}(\12b{2}\39{1,3}){2}(\12b{2}\38{1,3}){2}){1,2}|(\12b{2}\37{1,3}){2}(\12b{2}\36{1,3}){2}(\12b{2}\35{1,3}){2}";

const FLAGS: &str = "s";
const SUBJECT: &str = "b 0bb";
const START: i32 = 0;

/// `128_348 * XS_REGEXP_METERING (65536)` — the exact full-width raw match
/// meter, which exceeds `u32::MAX` and so must never be truncated.
const EXPECTED_MATCH_METER_RAW: u64 = 8_411_414_528;

#[test]
fn regexp_match_meter_does_not_overflow_u32() {
    // Sanity: the reproducing meter really is past the 32-bit boundary, so
    // a narrowing bug here would actually change the value.
    assert!(EXPECTED_MATCH_METER_RAW > u64::from(u32::MAX));

    let program = ironhorse_regexp::compile(PATTERN, FLAGS).expect("pattern compiles");
    // No panic on this pathological 44-group backreference-heavy pattern.
    let outcome = ironhorse_regexp::match_regexp(&program, SUBJECT.as_bytes(), START);

    assert!(
        !outcome.matched,
        "the pattern does not match {SUBJECT:?} at offset {START}"
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
        "meter must not be the 32-bit-wrapped figure (4_116_447_232)"
    );
}
