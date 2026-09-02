//! Regression for ironhorse fuzz finding `314f811064b8febb`
//! (target `differential_source`, toolchain `nightly-2026-08-15`).
//!
//! The 5-byte minimized input `75 6c 74 7b 2d` (`"ult{-"`,
//! sha256 `4f6dc01326c7629a715a037a135e47010efe913a121ae02b43846601c850a1a5`)
//! folds, through `ironhorse_fuzz::gen_program`, into the division chain
//!
//! ```text
//! (377487360 / (377487360 / (377487360 / (-5 / 981467136))))
//! ```
//!
//! Evaluated in IEEE-754 doubles (ECMAScript Number semantics) this is the
//! exactly-representable double whose bit pattern is `0xc370740000000000`,
//! real value `-74098287619080192`.
//!
//! ironhorse and XS compute the identical double. They diverge only in how
//! they render it to a string:
//!
//!   * XS's `fx_dtoa` renders the double as the 17-digit
//!     `-74098287619080190` (its non-shortest form — the true exact integer of
//!     this double is `-74098287619080192`; XS prints neither the shortest nor
//!     the exact integer, but a longer non-round-tripping-minimal spelling that
//!     still parses back to the same double).
//!   * ironhorse — like V8/SpiderMonkey and ECMA-262 §6.1.6.1.20's Number
//!     `toString` ("let `k` be as small as possible") — prints the *shortest*
//!     decimal that round-trips, `-74098287619080200`.
//!
//! Both spellings parse back to the same double, so the port was never wrong;
//! the differential harness compares numeric completions by their double
//! rather than their decimal spelling (the `results_agree` helper landed for
//! sibling finding `d99d263fcf6ca7a7`). This is the same dtoa-spelling class
//! as `d99d263fcf6ca7a7` / `5c29667cc15d6d93` / `67a52af412f03a7b`, reached by
//! a *division* chain rather than a product.
//!
//! This test needs neither the XS oracle nor the `c/moddable` submodule: it
//! pins the port's own `number_to_ecma_string` for the reproducing value, the
//! portable source-of-truth the oracle's non-shortest rendering must not be
//! allowed to override. It is the regression the crate CI actually runs
//! (`cargo test -p ironhorse-vm`).

use ironhorse_vm::value::number_to_ecma_string;

/// The exactly-representable double the finding program evaluates to,
/// pinned by bit pattern so the test is tied to the finding, not a literal.
const FINDING_BITS: u64 = 0xc370740000000000;

/// The spec-shortest (V8-matching) rendering.
const SHORTEST: &str = "-74098287619080200";
/// XS's `fx_dtoa` non-shortest rendering of the same double (observed oracle
/// output for this finding).
const XS_EXACT: &str = "-74098287619080190";

#[test]
fn division_chain_result_renders_shortest_round_tripping_decimal() {
    // Reconstruct the value the way the program does, in f64, so the test is
    // tied to the finding and not just to a magic literal.
    let a: f64 = 377487360.0;
    let inner = -5.0_f64 / 981467136.0;
    let value = a / (a / (a / inner));
    assert_eq!(
        value.to_bits(),
        FINDING_BITS,
        "division-chain program value is the finding double 0xc370740000000000",
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
