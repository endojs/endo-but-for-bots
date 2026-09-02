//! Regression for ironhorse fuzz finding `7289e31013d074ec`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 4-byte minimized input `d8 7f 33 ba`
//! (sha256 `6abb2fe734124222bc19e12518fa968a59f254edea3c9ed262414cb4637c736f`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((~(~(1560281088 * true))) * ((~(1560281088 * true)) << ((~true) << (true << true))))
//! ```
//!
//! The literal `1560281088` is `186 * 2^23` (the generator's "larger integer"
//! atom, `byte << 23` with `byte = 186`). Evaluated with ECMAScript Number
//! semantics:
//!
//!   * `~(~(1560281088 * true)) = 1560281088` (`true` is `1`; `~~x` is the
//!     `ToInt32` identity here, and `1560281088 < 2^31`).
//!   * `(~true) << (true << true) = (-2) << 2 = -8`, and a `<<` count is taken
//!     mod 32, so the outer shift is by `24`.
//!   * `(~(1560281088 * true)) << 24 = (-1560281089) << 24 = -16777216`
//!     (`ToInt32` wrapping).
//!   * the product is `1560281088 * -16777216 = -(186 * 2^47) = -(93 * 2^48)`,
//!     the *exactly* representable double whose real value is
//!     `-26177172834091008`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string (verified against the pinned XS oracle,
//! moddable `23b4d6b`: oracle result `-26177172834091008`, ironhorse result
//! `-26177172834091010`):
//!
//!   * XS's `fx_dtoa` printed the double's exact integer, `-26177172834091008`
//!     (17 significant digits).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `-26177172834091010` (the identical spelling
//!     Node/V8 emit).
//!
//! Both spellings parse back to the same double, so the port was never wrong.
//! This is the same class as findings `d99d263fcf6ca7a7` and
//! `5c29667cc15d6d93`: the differential harness compares numeric completions by
//! their double rather than their decimal spelling (`results_agree`), which
//! already suppresses this divergence on the standing branch. No port or
//! harness change is required for this specific input; this test pins the
//! *reproducing value's* rendering so the port can never be "corrected" to XS's
//! non-conformant exact-integer form.
//!
//! It needs neither the XS oracle nor the `c/moddable` submodule: it pins the
//! port's own `number_to_ecma_string` for the reproducing value, the portable
//! source-of-truth the oracle's non-shortest rendering must not override.

use ironhorse_vm::value::number_to_ecma_string;

/// `-(93 * 2^48)`, the exactly-representable double the finding program
/// evaluates to.
const FINDING_VALUE: f64 = -26177172834091008.0;

/// The spec-shortest (V8/Node-matching) rendering.
const SHORTEST: &str = "-26177172834091010";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "-26177172834091008";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in ToInt32 arithmetic
    // over the generator's atom (`186 << 23`), so the test is tied to the
    // finding and not just to a magic literal.
    let a: i32 = 186_i32 << 23; // 1560281088
    let left: i32 = !(!a); // ~~a == a
    let inner: i32 = (!1_i32) << (1_i32 << 1); // (~true) << (true << true) = -8
    let right: i32 = (!a).wrapping_shl(inner as u32); // (~a) << (−8 mod 32 = 24)
    let value: f64 = (left as f64) * (right as f64);
    assert_eq!(value.to_bits(), FINDING_VALUE.to_bits(), "program value is -(93*2^48)");

    // The port renders the ECMA-262 shortest decimal, exactly as V8/Node does.
    assert_eq!(
        number_to_ecma_string(value),
        SHORTEST,
        "Number::toString must be the shortest round-tripping decimal, not XS's exact integer",
    );

    // Both spellings denote the identical double — that is *why* the harness
    // treats them as agreeing rather than diverging.
    assert_eq!(
        SHORTEST.parse::<f64>().unwrap().to_bits(),
        XS_EXACT.parse::<f64>().unwrap().to_bits(),
        "the shortest and XS-exact spellings are the same IEEE-754 double",
    );
    // The port must not emit XS's non-shortest form.
    assert_ne!(number_to_ecma_string(value), XS_EXACT);
}
