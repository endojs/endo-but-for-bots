//! Deliberately bad Kani harnesses for the runner's self-test. Each one is
//! named after the verdict `scripts/verify.py` must reach on it.
#![forbid(unsafe_code)]

/// A library function with a panic branch that a caller may exclude.
pub fn checked_half(x: u8) -> u8 {
    if x % 2 == 1 {
        panic!("odd input");
    }
    x / 2
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// Passes, with a satisfied cover.
    #[kani::proof]
    fn good() {
        let x: u8 = kani::any();
        kani::assume(x % 2 == 0);
        assert!(checked_half(x) <= 127);
        kani::cover!(x == 254, "the largest even input");
    }

    /// A counterexample.
    #[kani::proof]
    fn fails() {
        let x: u8 = kani::any();
        assert!(x < 200, "x below 200");
        kani::cover!(x == 1, "small");
    }

    /// Kani reports SUCCESSFUL, but the cover cannot be satisfied.
    #[kani::proof]
    fn unsat_cover() {
        let x: u8 = kani::any();
        kani::cover!(x > 1 && x < 1, "impossible");
    }

    /// A contradictory assumption: every check is UNREACHABLE.
    #[kani::proof]
    fn vacuous_assume() {
        let x: u8 = kani::any();
        kani::assume(x > 1 && x < 1);
        assert!(x == 0, "anything at all");
        kani::cover!(x == 3, "never");
    }

    /// The panic branch of `checked_half` is excluded by the assumption.
    /// Measured: Kani 0.68 reports such an excluded library branch as
    /// SUCCESS, not UNREACHABLE, so the run is clean.
    #[kani::proof]
    fn library_branch_excluded() {
        let x: u8 = kani::any();
        kani::assume(x % 2 == 0);
        let _ = checked_half(x);
        kani::cover!(x == 2, "a reachable even input");
    }

    /// Enough symbolic heap work to exceed a deliberately tiny memory cap.
    #[kani::proof]
    #[kani::unwind(65)]
    fn exhausts_memory() {
        let mut v: [u32; 64] = kani::any();
        for i in 0..64 {
            v[i] = v[i]
                .wrapping_mul(v[(i * 7 + 3) % 64])
                .wrapping_add(v[(i + 1) % 64]);
        }
        let mut h = 0u32;
        for x in v {
            h = h.wrapping_mul(31) ^ x;
        }
        assert!(h != 0x1234_5678, "hash collision");
        kani::cover!(h == 0, "zero hash");
    }
}
