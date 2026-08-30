//! Regression for ironhorse fuzz finding `783be6e6106bad98`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 6-byte minimized input `00 00 66 69 27 44`
//! (sha256 `95c5064e49e6c191f7f9b8be24270555d12b04c226cbc72c01406e024ff39008`)
//! folds, through `ironhorse_fuzz::gen_program`, into the expression
//!
//! ```text
//! ((((true + 327155712) && (!true)) || ((~570425344) * (true + 327155712)))
//!  + (!((570425344 || true) + (327155712 * -128))))
//! ```
//!
//! which collapses under ECMAScript semantics: the `&&` yields `false`, so the
//! `||` yields its right operand `(~570425344) * (true + 327155712)`; the outer
//! `(!(...))` is `false` → coerces to `0` under `+`. The whole program is
//! therefore the single product
//!
//! ```text
//! (~570425344) * (327155712 + 1) = -570425345 * 327155713
//! ```
//!
//! (`570425344 = 68 * 2^23`, `327155712 = 39 * 2^23`; both fit int32, so `~` and
//! the `true` coercion are exact.) The real product `-186617910456745985`
//! overflows 2^53 and rounds to the nearest double, `-186617910456745984`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string (verified against the pinned XS oracle,
//! moddable 23b4d6b — oracle result `-186617910456745980`, ironhorse result
//! `-186617910456746000`):
//!
//!   * XS's `fx_dtoa` printed a non-shortest 17-significant-digit form,
//!     `-186617910456745980`.
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `-186617910456746000` (the identical spelling
//!     Node/V8 emit).
//!
//! Both spellings parse back to the same double, so the port was never wrong.
//! This is the same class as findings `d99d263fcf6ca7a7` and `5c29667cc15d6d93`:
//! the differential harness now compares numeric completions by their double
//! rather than their decimal spelling (`results_agree`), which already
//! suppresses this divergence on the standing branch. No port or harness change
//! is required for this specific input; this test pins the *reproducing value's*
//! rendering so the port can never be "corrected" to XS's non-shortest form.
//!
//! It needs neither the XS oracle nor the `c/moddable` submodule: it pins the
//! port's own `number_to_ecma_string` for the reproducing value, the portable
//! source-of-truth the oracle's non-shortest rendering must not override.

use ironhorse_vm::value::number_to_ecma_string;

/// `-186617910456745984`, the double the finding program evaluates to
/// (the rounded IEEE-754 value of the exact product `-186617910456745985`).
const FINDING_VALUE: f64 = -186617910456745984.0;

/// The spec-shortest (V8/Node-matching) rendering.
const SHORTEST: &str = "-186617910456746000";
/// XS's non-shortest rendering of the same double.
const XS_NON_SHORTEST: &str = "-186617910456745980";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in f64, so the test is
    // tied to the finding and not just to a magic literal. The `&&`/`||` chain
    // and the outer `+ (!(...))` collapse to the single product below; the
    // generator's atoms are `68 << 23` (~ → -570425345 in int32) and
    // `39 << 23` (+ `true` → 327155713).
    let x = !(68_i32 << 23); // ~570425344 = -570425345
    let y = (39_i64 << 23) + 1; // (true + 327155712) = 327155713
    let value = (x as f64) * (y as f64);
    assert_eq!(
        value.to_bits(),
        FINDING_VALUE.to_bits(),
        "program value is the rounded double of -570425345 * 327155713",
    );

    // The port renders the ECMA-262 shortest decimal, exactly as V8/Node does.
    assert_eq!(
        number_to_ecma_string(value),
        SHORTEST,
        "Number::toString must be the shortest round-tripping decimal, not XS's non-shortest form",
    );

    // Both spellings denote the identical double — that is *why* the harness
    // treats them as agreeing rather than diverging.
    assert_eq!(
        SHORTEST.parse::<f64>().unwrap().to_bits(),
        XS_NON_SHORTEST.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS-non-shortest spellings are the same IEEE-754 double",
    );
    // The port must not emit XS's non-shortest form.
    assert_ne!(number_to_ecma_string(value), XS_NON_SHORTEST);
}
