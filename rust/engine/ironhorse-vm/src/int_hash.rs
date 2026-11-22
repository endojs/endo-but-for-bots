//! A cheap seeded hasher for the interpreter's integer-keyed side tables.
//!
//! The side tables are keyed by arena handles ([`crate::value::SlotIndex`]),
//! interned property-key ids (`u16`) and pairs of them. `std`'s default
//! SipHash-1-3 spends about a hundred instructions per probe on such a key,
//! and a property read or a call probes several of these tables. This hasher
//! spends a handful: one 64x64->128-bit multiply per written integer, folded
//! by XOR of its halves (the `folded_multiply` step of foldhash and aHash's
//! fallback), keyed by a secret per-process seed; finishing XORs the high
//! half of the state into the low half.
//!
//! Why this is safe for these tables and not for strings:
//!
//! - The keys are not chosen by the guest. A guest influences which arena
//!   slots and key ids exist (by allocating, interning and collecting), but
//!   it cannot pick their values, and the seed it would need to aim
//!   collisions is drawn from the OS through `RandomState` once per process
//!   and never leaves it. The fold and the finishing shift mix every key bit
//!   into the low bits that pick the bucket, so a structured key set (an
//!   arithmetic progression of handles with a power-of-two stride, say)
//!   spreads like any other; a bare multiplicative or identity hash would put
//!   such a set in one bucket chain, and the fold alone still crowds strides
//!   of 2^18 and up into about half the buckets a uniform hash fills.
//! - Tables keyed by guest-spelled text (`SymbolName`, registry keys) keep
//!   SipHash.
//! - Iteration order stays seeded per process, exactly as with `RandomState`:
//!   no table's order is reproducible across processes before or after this
//!   change, so nothing that is deterministic today (results, meter counts,
//!   snapshot rows, which their writers sort) can come to depend on it.
//!
//! The hasher is not persisted and has no observable effect beyond speed.

use std::hash::{BuildHasher, Hasher};

/// A `HashMap` over integer-like keys with the [`IntBuildHasher`].
pub(crate) type IntMap<K, V> = std::collections::HashMap<K, V, IntBuildHasher>;
/// A `HashSet` over integer-like keys with the [`IntBuildHasher`].
pub(crate) type IntSet<K> = std::collections::HashSet<K, IntBuildHasher>;

/// An odd 64-bit multiplier with well-spread bits (2^64 / golden ratio).
const MULTIPLIER: u64 = 0x9e37_79b9_7f4a_7c15;

/// The full 128-bit product folded to 64 bits: every input bit reaches the
/// low half through the high half of the product.
#[inline(always)]
fn folded_multiply(x: u64, y: u64) -> u64 {
    // Two zero-extended 64-bit factors: the product is below 2^128.
    let product = u128::from(x).wrapping_mul(u128::from(y));
    (product as u64) ^ ((product >> 64) as u64)
}

/// The process's secret seed, drawn once from `RandomState`'s OS-seeded keys.
fn process_seed() -> u64 {
    static SEED: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *SEED.get_or_init(|| std::collections::hash_map::RandomState::new().hash_one(0x5eed_u64))
}

/// The [`BuildHasher`] of [`IntMap`] and [`IntSet`]; every instance in a
/// process carries the same seed, like `RandomState` clones of one table.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IntBuildHasher {
    seed: u64,
}

impl Default for IntBuildHasher {
    #[inline]
    fn default() -> Self {
        Self {
            seed: process_seed(),
        }
    }
}

impl BuildHasher for IntBuildHasher {
    type Hasher = IntHasher;
    #[inline(always)]
    fn build_hasher(&self) -> IntHasher {
        IntHasher { state: self.seed }
    }
}

/// See the module documentation.
#[derive(Clone, Copy, Debug)]
pub(crate) struct IntHasher {
    state: u64,
}

impl Hasher for IntHasher {
    #[inline(always)]
    fn write_u64(&mut self, x: u64) {
        self.state = folded_multiply(self.state ^ x, MULTIPLIER);
    }
    #[inline(always)]
    fn write_u8(&mut self, x: u8) {
        self.write_u64(u64::from(x));
    }
    #[inline(always)]
    fn write_u16(&mut self, x: u16) {
        self.write_u64(u64::from(x));
    }
    #[inline(always)]
    fn write_u32(&mut self, x: u32) {
        self.write_u64(u64::from(x));
    }
    #[inline(always)]
    fn write_usize(&mut self, x: usize) {
        self.write_u64(x as u64);
    }
    /// Byte input, for completeness: eight bytes per mixing step. A slice's
    /// `Hash` writes its length first, so zero padding of the last word
    /// cannot make two inputs of different lengths collide.
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.write_u64(u64::from_le_bytes(word));
        }
    }
    /// The fold leaves the low bits of its low half depending only on low
    /// key bits; XORing in the high half spreads large strides. (A second
    /// fold spreads them as well, but its extra multiply grew the frames of
    /// `exec_run` and two other call-path functions by 32 B each, and the
    /// recursion cases of the stack-height gate by 2.4%.)
    #[inline(always)]
    fn finish(&self) -> u64 {
        self.state ^ (self.state >> 32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::SlotIndex;

    #[test]
    fn instances_agree_and_equal_keys_hash_equal() {
        let (a, b) = (IntBuildHasher::default(), IntBuildHasher::default());
        for k in [0u32, 1, 2, 0x8000_0000, u32::MAX] {
            assert_eq!(a.hash_one(SlotIndex(k)), b.hash_one(SlotIndex(k)));
            assert_eq!(
                a.hash_one((SlotIndex(k), 7u16)),
                b.hash_one((SlotIndex(k), 7u16))
            );
        }
        assert_ne!(a.hash_one(SlotIndex(1)), a.hash_one(SlotIndex(2)));
        assert_ne!(
            a.hash_one((SlotIndex(1), 2u16)),
            a.hash_one((SlotIndex(2), 1u16))
        );
    }

    /// Power-of-two strides, the pattern a bare multiplicative hash would
    /// put in one bucket chain, spread over the low bits that pick a bucket.
    #[test]
    fn strided_keys_spread_over_buckets() {
        let h = IntBuildHasher::default();
        for stride in [1u32, 2, 3, 16, 1024, 1 << 16, 3 << 18, 1 << 19, 1 << 20] {
            let buckets: IntSet<u64> = (0..4096u32)
                .map(|i| h.hash_one(SlotIndex(i.wrapping_mul(stride))) & 4095)
                .collect();
            // A uniform hash fills about 63% (2590) of 4096 buckets with 4096
            // keys, give or take about 25; the fold alone fills as few as
            // 1208 at a stride of 3 * 2^18.
            assert!(buckets.len() > 2300, "stride {stride}: {}", buckets.len());
        }
    }

    #[test]
    fn maps_behave_as_maps() {
        let mut m: IntMap<SlotIndex, u32> = IntMap::default();
        for i in 0..10_000u32 {
            assert_eq!(m.insert(SlotIndex(i * 64), i), None);
        }
        for i in 0..10_000u32 {
            assert_eq!(m.get(&SlotIndex(i * 64)), Some(&i));
            assert_eq!(m.get(&SlotIndex(i * 64 + 1)), None);
        }
        let mut words = IntHasher { state: 0 };
        words.write(&[1, 2, 3]);
        let mut padded = IntHasher { state: 0 };
        padded.write(&[1, 2, 3, 0]);
        assert_eq!(words.finish(), padded.finish());
    }
}
