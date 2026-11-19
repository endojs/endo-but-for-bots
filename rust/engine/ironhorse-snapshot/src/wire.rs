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
