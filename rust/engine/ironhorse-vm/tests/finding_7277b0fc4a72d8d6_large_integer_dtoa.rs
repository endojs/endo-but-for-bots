//! Regression for ironhorse fuzz finding `7277b0fc4a72d8d6`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input `3f f7 de`
//! (sha256 `0792c486c29a77190658d061a90fc215ba1777bce94464d104c93a508dc0d08b`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((~((~2071986176) * (~2071986176))) * (~((~2071986176) * (~2071986176))))
//! ```
//!
//! It is `X * X` where `X = ~ToInt32((~2071986176) * (~2071986176))`. In
//! IEEE-754 doubles (ECMAScript Number semantics):
//!
//!   * `~2071986176 = -2071986177` (`2071986176 = 247 * 2^23` fits int32).
//!   * The inner product `(-2071986177)^2` is `4293126717679075328` once
//!     rounded to the nearest double (its real value `2071986177^2` is not
//!     exactly representable — the ulp near 2^62 is 1024).
//!   * `ToInt32(4293126717679075328) = -150994944`, so `X = ~(-150994944) =
//!     150994943`.
//!   * The whole program squares it: `150994943^2 = 22799472811573248`, an
//!     *exactly*-representable double.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string (the same oracle-rendering class as findings
//! `284de587e16bce32`, `d99d263fcf6ca7a7`, `5c29667cc15d6d93`,
//! `7289e31013d074ec`, and `783be6e6106bad98`):
//!
//!   * XS's `fx_dtoa` prints the double's exact integer,
//!     `22799472811573248`.
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `22799472811573250`, the identical spelling
//!     Node/V8 emit.
//!
//! Both spellings parse back to the same double, so the port was never wrong.
//! The differential harness compares numeric completions by their double
//! rather than their decimal spelling (`results_agree`), which already
//! suppresses this divergence on the standing branch. No port or harness
//! change is required for this specific input; this test pins the
//! *reproducing value's* rendering so the port can never be "corrected" to
//! XS's non-conformant exact-integer form.
//!
//! It needs neither the XS oracle nor the `c/moddable` submodule: it pins the
//! port's own `number_to_ecma_string` for the reproducing value, the portable
//! source-of-truth the oracle's non-shortest rendering must not override.

use ironhorse_vm::value::number_to_ecma_string;

/// `150994943^2`, the exactly-representable double the finding program
/// evaluates to.
const FINDING_VALUE: f64 = 22799472811573248.0;

/// The spec-shortest (V8/Node-matching) rendering.
const SHORTEST: &str = "22799472811573250";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "22799472811573248";

/// ECMAScript `ToInt32` (ECMA-262 §7.1.6) for a finite integral double whose
/// magnitude fits `i64` — enough for the intermediate `~` in this program.
fn to_int32(x: f64) -> i32 {
    (x as i64 as u32) as i32
}

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in f64, so the test is
    // tied to the finding and not just to a magic literal.
    // `~2071986176` (2071986176 fits int32, so the identity `~n = -n - 1`).
    let a = to_int32(2071986176.0);
    let not_a = !a; // -2071986177
    assert_eq!(not_a, -2071986177, "~2071986176 is -2071986177");
    // The inner product, rounded to a double, then `~ToInt32(..)`.
    let inner = f64::from(not_a) * f64::from(not_a);
    assert_eq!(inner, 4293126717679075328.0, "(-2071986177)^2 rounds to this double");
    let x = !to_int32(inner); // ~ToInt32(inner) = 150994943
    assert_eq!(x, 150994943, "~ToInt32(inner) is 150994943");
    let value = f64::from(x) * f64::from(x);
    assert_eq!(value.to_bits(), FINDING_VALUE.to_bits(), "program value is 150994943^2");

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
