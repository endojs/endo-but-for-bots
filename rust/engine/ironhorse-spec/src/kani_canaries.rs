//! Canaries for the verifier itself (VERIFICATION.md, soundness rule 2).
//!
//! This is the one module in the proof tree that may use float `%`,
//! `rem_euclid`, `powi` and `powf`, and it uses them only to pin down that
//! Kani 0.68 / CBMC 6.11 computes them **wrongly, without a warning**. Each
//! float canary asserts the wrong answer Kani currently produces, so it
//! passes today; the comment gives the true IEEE 754 value. When a Kani or
//! CBMC upgrade fixes an encoding, its canary fails and forces a deliberate
//! review: the rule "no proof may depend on these operations" can then be
//! relaxed for that operation, in VERIFICATION.md, by a human.
//!
//! `pins` makes an `f64` symbolic and then pins it to one value, so rustc
//! cannot fold the operation at compile time: the result comes from Kani's
//! encoding, which is what is under test.
//!
//! `float_casts_round_correctly` is the opposite kind of canary: it asserts
//! the *true* results of `f64 as f32` and `f32 as f64` at their rounding,
//! subnormal and overflow boundaries, so it passes only while Kani encodes
//! these casts as rustc computes them. It was written to measure the casts
//! before NUM-8's Float32 proof relied on them, and it stays as that
//! proof's tripwire.
//!
//! The last canary is a deliberately false assertion, run with
//! `expect = "fail"`: it proves the runner notices a failed check.

/// A symbolic `f64` constrained to the bit pattern of `value`.
fn pins(value: f64) -> f64 {
    let x: f64 = kani::any();
    kani::assume(x.to_bits() == value.to_bits());
    x
}

/// `3.0 % 2.0` is `1.0` (IEEE 754 remainder toward zero, `fmod`); Kani
/// lowers `%` on floats to CBMC's `floatbv_mod`, which yields `0.0`.
#[kani::proof]
fn float_rem_is_miscomputed() {
    let r = pins(3.0) % pins(2.0);
    kani::cover!(r == 0.0, "Kani computes 3 % 2 as 0");
    assert!(
        r == 0.0,
        "true value 1.0: Kani's f64 % may be fixed; review"
    );
}

/// `(-3.0).rem_euclid(2.0)` is `1.0`; built on `%`, Kani yields `0.0`.
#[kani::proof]
fn float_rem_euclid_is_miscomputed() {
    let r = pins(-3.0).rem_euclid(pins(2.0));
    kani::cover!(r == 0.0, "Kani computes rem_euclid(-3, 2) as 0");
    assert!(
        r == 0.0,
        "true value 1.0: Kani's f64 rem_euclid may be fixed; review"
    );
}

/// `3.0.powi(2)` is `9.0`; Kani yields some other value.
#[kani::proof]
fn float_powi_is_miscomputed() {
    let r = pins(3.0).powi(2);
    kani::cover!(
        r != 9.0,
        "Kani computes powi(3, 2) as something other than 9"
    );
    assert!(
        r != 9.0,
        "true value 9.0: Kani's f64 powi may be fixed; review"
    );
}

/// `3.0.powf(2.0)` is `9.0`; Kani yields some other value.
#[kani::proof]
fn float_powf_is_miscomputed() {
    let r = pins(3.0).powf(pins(2.0));
    kani::cover!(
        r != 9.0,
        "Kani computes powf(3, 2) as something other than 9"
    );
    assert!(
        r != 9.0,
        "true value 9.0: Kani's f64 powf may be fixed; review"
    );
}

/// The bits of `pins(value) as f32`.
fn narrowed(value: f64) -> u32 {
    (pins(value) as f32).to_bits()
}

/// `f64 as f32` rounds to nearest with ties to even, flushes below half the
/// smallest subnormal to zero, overflows to infinity, and keeps a NaN a
/// NaN; `f32 as f64` is exact. Each expected value is rustc's.
#[kani::proof]
fn float_casts_round_correctly() {
    // 1 + 2^-24 ties between 1 and 1 + 2^-23: to even.
    assert_eq!(narrowed(f64::from_bits(0x3FF0_0000_1000_0000)), 0x3F80_0000);
    // 1 + 3 × 2^-24 ties between 1 + 2^-23 (odd) and 1 + 2^-22: up.
    assert_eq!(narrowed(f64::from_bits(0x3FF0_0000_3000_0000)), 0x3F80_0002);
    // Just above the first tie rounds up.
    assert_eq!(narrowed(f64::from_bits(0x3FF0_0000_1000_0001)), 0x3F80_0001);
    // 2^-150 ties between 0 and 2^-149: to even, +0; 3 × 2^-150 rounds up.
    assert_eq!(narrowed(f64::from_bits(0x3690_0000_0000_0000)), 0x0000_0000);
    assert_eq!(narrowed(f64::from_bits(0x36A8_0000_0000_0000)), 0x0000_0002);
    // A binary64 subnormal narrows to -0 with its sign.
    assert_eq!(narrowed(f64::from_bits(0x8000_0000_0000_0001)), 0x8000_0000);
    // The overflow threshold (2 - 2^-24) × 2^127 ties to infinity; just
    // below it is the largest finite binary32.
    assert_eq!(narrowed(f64::from_bits(0x47EF_FFFF_F000_0000)), 0x7F80_0000);
    assert_eq!(narrowed(f64::from_bits(0x47EF_FFFF_EFFF_FFFF)), 0x7F7F_FFFF);
    assert_eq!(narrowed(f64::from_bits(0xC7F0_0000_0000_0000)), 0xFF80_0000);
    assert!((pins(f64::NAN) as f32).is_nan());
    // Widening is exact: the smallest binary32 subnormal is 2^-149.
    let tiny: f32 = kani::any();
    kani::assume(tiny.to_bits() == 1);
    let wide = f64::from(tiny).to_bits();
    kani::cover!(wide == 0x36A0_0000_0000_0000, "2^-149 widens exactly");
    assert_eq!(wide, 0x36A0_0000_0000_0000);
}

/// A false assertion. The manifest expects this harness to FAIL; if the
/// runner ever reports it as passing, failure detection is broken.
#[kani::proof]
fn false_assertion_is_reported() {
    let x: u8 = kani::any();
    kani::cover!(x == 7, "the refuting input is reachable");
    assert!(x != 7, "deliberately false: x = 7 refutes it");
}
