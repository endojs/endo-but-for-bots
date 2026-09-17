//! Regression for ironhorse fuzz finding `a7755caa51aa9320`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 3-byte minimized input `2d f7 60`
//! (sha256 `8e9d2a47633db281147ece5720882a273ee253c94d522c64770a8f4e87f7cf31`)
//! folds, through `ironhorse_fuzz::gen_program`, into the arithmetic program
//!
//! ```text
//! ((~((~2071986176) * (~2071986176))) * (~((~2071986176) * (~2071986176))))
//! ```
//!
//! The `2071986176` operand is the generator's large-integer atom `247 << 23`
//! (`gen_atom` case 3, driven by the cyclic input byte `0xf7 = 247`).
//!
//! Evaluated in IEEE-754 doubles with ECMAScript semantics: `2071986176` is a
//! positive int32, so `~2071986176` is `-2071986177`. Each inner product
//! `(~2071986176) * (~2071986176)` is `(-2071986177)^2`, the double
//! `4293126717679075328`. Applying `~` runs `ToInt32` on that double, yielding
//! `150994943`. The whole program is `150994943 * 150994943`: its exact real
//! value is `22799472811573249`, which is not representable (it exceeds 2^53)
//! and rounds to the nearest-even double whose exact value is
//! `22799472811573248`.
//!
//! ironhorse and XS compute the identical double. They diverged only in how
//! they render it to a string:
//!
//!   * XS's `fx_dtoa` printed the double's exact integer,
//!     `22799472811573248` (17 significant digits).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `22799472811573250` (16 significant digits).
//!
//! Both spellings parse back to the same double, so the port was never wrong;
//! the differential harness compares numeric completions by their double
//! rather than their decimal spelling (finding `d99d263fcf6ca7a7`). This is a
//! re-discovery of that dtoa-spelling class under a new minimized input; the
//! finding reproduced only at the older project SHA
//! `38ca1d189384245dd9accfcc2f79763a3b8ec5cb`, before that harness policy
//! suppressed the spurious spelling divergence.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule: it
//! pins the port's own `number_to_ecma_string` for the reproducing value, the
//! portable source-of-truth the oracle's non-shortest rendering must not be
//! allowed to override.

use ironhorse_vm::value::number_to_ecma_string;

/// The exactly-representable double the finding program evaluates to.
const FINDING_VALUE: f64 = 22799472811573248.0;

/// The spec-shortest (V8-matching) rendering.
const SHORTEST: &str = "22799472811573250";
/// XS's non-shortest exact-integer rendering of the same double.
const XS_EXACT: &str = "22799472811573248";

#[test]
fn large_integer_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program evaluates it, in f64
    // arithmetic, so the test is tied to the finding and not just to a magic
    // literal.
    //
    // `2071986176` is the generator's `247 << 23` large-integer atom.
    let big = (247_i64 << 23) as f64; // 2071986176
    assert_eq!(big, 2071986176.0);

    // `~2071986176` is `-2071986177` (ToInt32 of a positive int32, then NOT).
    let not_big = !(big as i32) as f64;
    assert_eq!(not_big, -2071986177.0);

    // Each inner product, as an f64 multiplication.
    let inner = not_big * not_big;
    assert_eq!(inner, 4293126717679075328.0);

    // `~` of that product runs ToInt32 on the double: 4293126717679075328 mod
    // 2^32 = 4143972352, which as a signed int32 is -150994944; NOT gives
    // 150994943.
    let inner_not = !((inner as i64 as i32)) as f64;
    assert_eq!(inner_not, 150994943.0);

    // The whole program is the product of the two identical halves.
    let value = inner_not * inner_not;
    assert_eq!(
        value.to_bits(),
        FINDING_VALUE.to_bits(),
        "program value is 22799472811573248 (exact double)"
    );

    // The port renders the ECMA-262 shortest decimal, exactly as V8 does.
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
