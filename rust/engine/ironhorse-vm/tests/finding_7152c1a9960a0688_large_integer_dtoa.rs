//! Regression for ironhorse fuzz finding `7152c1a9960a0688`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 8-byte minimized input `27 79 00 00 00 57 2d 08`
//! (sha256 `f8b5e31e69a227500b3733aebdfffee49512debf2bb863c825991a4435652bc1`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((((1015021568 / true) * (377487360 + -89)) + (-(true + 377487360)))
//!  || 1015021568)
//! ```
//!
//! In IEEE-754 doubles (ECMAScript Number semantics) the left operand of `||`
//! is `1015021568 * 377487271 - 377487361`, a nonzero (truthy) value, so it is
//! the whole program's completion. Its rounded double is the exactly-
//! representable value `383157721332973568` (bits `0x439544ffab840000`).
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string (the same oracle-rendering class as findings
//! `d99d263fcf6ca7a7`, `5c29667cc15d6d93`, `7289e31013d074ec`,
//! `783be6e6106bad98`, and `284de587e16bce32`):
//!
//!   * XS's `fx_dtoa` prints a non-shortest 18-digit form,
//!     `383157721332973570`.
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `383157721332973600` — the identical spelling
//!     Node/V8 emit.
//!
//! Both spellings parse back to the same double, so the port was never wrong.
//! The differential harness compares numeric completions by their double
//! rather than their decimal spelling (`results_agree`), which already
//! suppresses this divergence on the standing branch. No port or harness
//! change is required for this specific input; this test pins the
//! *reproducing value's* rendering so the port can never be "corrected" to
//! XS's non-shortest exact-integer form.
//!
//! It needs neither the XS oracle nor the `c/moddable` submodule: it pins the
//! port's own `number_to_ecma_string` for the reproducing value, the portable
//! source-of-truth the oracle's non-shortest rendering must not override.

use ironhorse_vm::value::number_to_ecma_string;

/// The double the finding program evaluates to (bits `0x439544ffab840000`).
const FINDING_VALUE: f64 = 383157721332973568.0;

/// The spec-shortest (V8/Node-matching) rendering.
const SHORTEST: &str = "383157721332973600";
/// XS's non-shortest rendering of the same double.
const XS_NON_SHORTEST: &str = "383157721332973570";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in f64, so the test is
    // tied to the finding and not just to a magic literal:
    //   (1015021568 / true) * (377487360 + -89) + (-(true + 377487360))
    let product = (1015021568.0_f64 / 1.0) * (377487360.0 + -89.0);
    let value = product + (-(1.0_f64 + 377487360.0));
    assert_eq!(
        value.to_bits(),
        FINDING_VALUE.to_bits(),
        "program value is the finding's exactly-representable double",
    );
    // The `|| 1015021568` right operand is dead: the left value is nonzero.
    assert_ne!(value, 0.0, "left operand of || is truthy, so it is the result");

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
        "the shortest and XS spellings are the same IEEE-754 double",
    );
    // The port must not emit XS's non-shortest form.
    assert_ne!(number_to_ecma_string(value), XS_NON_SHORTEST);
}
