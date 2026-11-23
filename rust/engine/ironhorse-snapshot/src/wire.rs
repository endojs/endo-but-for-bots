//! Checked big-endian field access over attacker-shaped bytes, and the one
//! place the encoders turn an in-memory length into its `u32` wire form.
//!
//! The decoders read fixed-width fields through these helpers so a short
//! payload is a `None` the caller maps to its own named error, never an
//! out-of-bounds index: the crate's fuzz contract is that a malformed
//! snapshot fails closed and never panics a worker. The returned arrays are
//! fixed-size by type, so the big-endian conversions cannot fail.

/// The `N` bytes at `at`, or `None` if the slice ends first.
#[inline]
pub(crate) fn chunk_at<const N: usize>(p: &[u8], at: usize) -> Option<&[u8; N]> {
    p.get(at..)?.first_chunk::<N>()
}

/// The big-endian `u32` at `at`, or `None` if the slice ends first.
#[inline]
pub(crate) fn be_u32_at(p: &[u8], at: usize) -> Option<u32> {
    chunk_at(p, at).copied().map(u32::from_be_bytes)
}

/// The big-endian `u64` at `at`, or `None` if the slice ends first.
#[inline]
pub(crate) fn be_u64_at(p: &[u8], at: usize) -> Option<u64> {
    chunk_at(p, at).copied().map(u64::from_be_bytes)
}

/// The `u32` wire form of an in-memory count, byte length, position or
/// arena index, for the infallible encoders.
///
/// Every value passed here is a `u32` quantity by construction (arena
/// indices and their counts are `u32`), or counts content inside one atom
/// payload where each entry occupies at least one byte, so it exceeds
/// `u32::MAX` only alongside a payload past `u32::MAX` bytes, which
/// [`crate::atom::atom_size`] refuses as [`crate::atom::AtomError::TooLarge`]
/// before a container is produced. Saturating rather than wrapping (the `as`
/// cast it replaces) means such an impossible value reads back as a
/// truncated length or an out-of-range index that the decoders refuse,
/// never as a small valid one; every value a valid image carries converts
/// exactly, so encoded bytes are unchanged. Debug and test builds assert
/// the invariant instead, so a caller that breaks it is found rather than
/// silently saturated.
#[inline]
pub(crate) fn wire_len(len: usize) -> u32 {
    debug_assert!(
        u32::try_from(len).is_ok(),
        "wire length {len} exceeds u32::MAX"
    );
    u32::try_from(len).unwrap_or(u32::MAX)
}

/// The pre-reservation for a list of `count` entries read from a payload of
/// `payload_len` bytes where each entry takes at least `width` bytes:
/// `count`, clamped to how many entries the payload could hold. A malformed
/// `count` (up to `u32::MAX`) must not reserve gigabytes before the
/// per-entry bounds checks refuse it; guarantee SNAP-3(b) proves the result
/// is at most `payload_len / width` and at most `count`. A zero width
/// reserves nothing.
#[inline]
pub(crate) const fn reserve_hint(count: usize, payload_len: usize, width: usize) -> usize {
    match payload_len.checked_div(width) {
        Some(room) if room < count => room,
        Some(_) => count,
        None => 0,
    }
}

/// SplitMix64: a tiny deterministic generator for the crate's property
/// tests, so they need no dependency and reproduce exactly.
#[cfg(test)]
pub(crate) struct SplitMix(pub(crate) u64);

#[cfg(test)]
impl SplitMix {
    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A value in `0..n` (`n > 0`).
    pub(crate) fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }

    /// `len` random bytes, each zero with probability one half so that
    /// framing fields often hit small values.
    pub(crate) fn bytes(&mut self, len: usize) -> Vec<u8> {
        (0..len)
            .map(|_| {
                let r = self.next();
                if r & 1 == 0 {
                    0
                } else {
                    (r >> 8) as u8
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SNAP-3(b) beyond the proof's symbolic range is the same identity;
    /// pin the boundary values the proof's covers name.
    #[test]
    fn reserve_hint_is_the_clamp() {
        for (count, len, width, want) in [
            (0, 0, 4, 0),
            (5, 20, 4, 5),
            (6, 20, 4, 5),
            (usize::MAX, 7, 4, 1),
            (3, usize::MAX, 1, 3),
            (9, 100, 0, 0),
        ] {
            assert_eq!(reserve_hint(count, len, width), want);
        }
        let mut rng = SplitMix(7);
        for _ in 0..100_000 {
            let (c, l, w) = (
                rng.next() as usize >> (rng.below(64)),
                rng.next() as usize >> (rng.below(64)),
                1 + rng.below(64) as usize,
            );
            assert_eq!(reserve_hint(c, l, w), c.min(l / w));
        }
    }
}

/// Kani harnesses for guarantee SNAP-3 (`verification/proofs.d/framing.toml`).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// SNAP-3(b): the pre-reservation is `min(count, payload_len / width)`,
    /// so never more entries than the payload could hold, for every `count`
    /// and `payload_len: usize` and each width the decoders pass (0, 1, 4,
    /// 8, 20, 28; zero reserves nothing). Concrete widths: division by a
    /// symbolic 64-bit divisor did not finish in 400 s.
    #[kani::proof]
    #[kani::unwind(7)]
    fn snap3_reserve_hint_bounded_by_input() {
        let count: usize = kani::any();
        let payload_len: usize = kani::any();
        for width in [0usize, 1, 4, 8, 20, 28] {
            let hint = reserve_hint(count, payload_len, width);
            assert!(hint <= count);
            if width == 0 {
                assert!(hint == 0);
            } else {
                assert!(hint == count.min(payload_len / width));
                assert!(hint * width <= payload_len);
            }
        }
        kani::cover!(count > payload_len / 4, "a count the payload cannot hold");
        kani::cover!(count > 0 && count <= payload_len / 20, "a count that fits");
    }

    /// SNAP-3(a): the field readers return exactly the big-endian value of
    /// the bytes at `at` when they fit, and `None` otherwise, on every
    /// buffer of up to 12 bytes and every `at`.
    #[kani::proof]
    #[kani::unwind(13)]
    fn snap3_field_readers() {
        let bytes: [u8; 12] = kani::any();
        let len: usize = kani::any_where(|&l| l <= 12);
        let p = &bytes[..len];
        let at: usize = kani::any();
        let fits4 = at.checked_add(4).is_some_and(|end| end <= len);
        let fits8 = at.checked_add(8).is_some_and(|end| end <= len);
        match be_u32_at(p, at) {
            Some(v) => {
                assert!(fits4);
                assert!(v == u32::from_be_bytes([p[at], p[at + 1], p[at + 2], p[at + 3]]));
            }
            None => assert!(!fits4),
        }
        match be_u64_at(p, at) {
            Some(v) => {
                assert!(fits8);
                assert!(v >> 32 == u64::from(be_u32_at(p, at).unwrap_or(0)));
                assert!(v & 0xFFFF_FFFF == u64::from(be_u32_at(p, at + 4).unwrap_or(0)));
            }
            None => assert!(!fits8),
        }
        kani::cover!(
            fits8 && at + 8 == len,
            "an eight-byte field ending at the buffer's end"
        );
    }
}
