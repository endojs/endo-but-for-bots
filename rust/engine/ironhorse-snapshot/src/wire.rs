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
/// exactly, so encoded bytes are unchanged.
#[inline]
pub(crate) fn wire_len(len: usize) -> u32 {
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
