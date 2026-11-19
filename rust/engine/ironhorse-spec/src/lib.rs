//! Reference models of ECMA-262 abstract operations, written as exact
//! integer arithmetic over the IEEE 754 bit decomposition of a Number.
//!
//! These models are the trusted base of the Ironhorse proofs
//! (`rust/engine/VERIFICATION.md`). A proof states "the engine agrees with
//! the model", so a model must be short enough to check against the
//! specification text by eye. The rules that keep it so:
//!
//! - **No floating-point arithmetic.** A model takes the bit pattern of a
//!   Number (`f64::to_bits`) and returns an integer or a bit pattern. The
//!   only float operations are `f64::from_bits`/`f64::to_bits` at the edges,
//!   in the convenience wrappers. Kani's float model is incomplete (it
//!   silently miscomputes `%`, `rem_euclid`, `powi` and `powf`; the
//!   `kani_canaries` module, built only under `cfg(kani)`, pins that down),
//!   and an integer model does not depend on it.
//! - **Each function cites its clause** of ECMA-262 (16th edition, 2025) by
//!   number and name and quotes the algorithm steps it implements. The
//!   models take a Number, so the "Let number be ? ToNumber(argument)" step
//!   is the caller's: ToNumber of a Number is the identity.
//! - **No dependency on any engine crate**, ever: a model that imports the
//!   code it judges proves nothing.
//!
//! Mathematical values ("ℝ(number)", "truncate", "modulo") are computed
//! exactly in `u64`/`u128`; every finite Number is an integer multiple of
//! `2^-1074`, so the decomposition `significand × 2^exponent` below is exact.
#![forbid(unsafe_code)]

pub mod float16;
pub mod number;
pub mod relative_index;
pub mod to_integer;

#[cfg(kani)]
mod kani_canaries;

pub use float16::{binary16_to_binary64, binary64_to_binary16, f16_bits_to_f64, f64_to_f16_bits};
pub use number::{decompose, Decomposed};
pub use relative_index::{integer_or_infinity_saturated, relative_index};
pub use to_integer::{
    to_int16, to_int32, to_int8, to_uint16, to_uint32, to_uint8, to_uint8_clamp,
    truncate_to_integer_mod_2n,
};

/// A deterministic test-input generator (SplitMix64, Steele, Lea and
/// Flood 2014), so the differential tests need no dependency and replay
/// identically everywhere.
#[cfg(test)]
pub(crate) mod tests_support {
    pub(crate) struct SplitMix64(pub(crate) u64);

    impl SplitMix64 {
        pub(crate) fn next(&mut self) -> u64 {
            self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = self.0;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        }

        /// A Number whose biased exponent is concentrated where the
        /// conversions change behaviour: around 1, 2^8 … 2^64 and the
        /// binary16 range, with any sign and trailing significand.
        pub(crate) fn interesting_f64(&mut self) -> f64 {
            let r = self.next();
            let sign = r >> 63;
            let biased = 1023 - 30 + (r >> 52) % 100;
            let trailing = self.next() & ((1 << 52) - 1);
            // Sometimes keep only a few significand bits, so integers and
            // halfway points are common.
            let trailing = if r & 1 == 0 {
                trailing & !((1 << ((r >> 1) % 52)) - 1)
            } else {
                trailing
            };
            f64::from_bits(sign << 63 | biased << 52 | trailing)
        }
    }
}
