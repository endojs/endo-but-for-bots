//! Lossless JavaScript symbol spellings. Equality and hashing use XS CESU-8,
//! including its modified encoding of NUL, never a diagnostic Rust string.
#![forbid(unsafe_code)]

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SymbolName(Vec<u8>);

impl SymbolName {
    pub fn from_units(units: &[u16]) -> Self {
        let mut bytes = Vec::new();
        for &u in units {
            let (encoded, width) = encode_unit(u);
            bytes.extend_from_slice(encoded.get(..width).unwrap_or_default());
        }
        Self(bytes)
    }

    /// Accept only canonical XS CESU-8 (no terminator).
    pub fn from_cesu8(bytes: &[u8]) -> Option<Self> {
        let mut units = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let (u, n) = decode_unit(bytes.get(i..)?)?;
            units.push(u);
            i += n;
        }
        let name = Self::from_units(&units);
        (name.0 == bytes).then_some(name)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }

    fn units(&self) -> impl Iterator<Item = u16> + '_ {
        let mut i = 0;
        // The bytes are canonical CESU-8 by construction (every constructor
        // goes through `from_units` or is checked against it), so each
        // decode succeeds; the iterator ends at the end of the bytes.
        std::iter::from_fn(move || {
            let (u, n) = decode_unit(self.0.get(i..)?)?;
            i += n;
            Some(u)
        })
    }

    pub fn to_units(&self) -> Vec<u16> {
        self.units().collect()
    }
    /// Scalar text for operations whose domain is Unicode scalar values.
    pub fn to_text(&self) -> Option<String> {
        String::from_utf16(&self.to_units()).ok()
    }
    /// Borrow ordinary UTF-8 text when its encoding also equals CESU-8.
    pub fn as_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.0).ok()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The XS CESU-8 form of one UTF-16 code unit: its bytes (the first `width`
/// of the array) and `width`. NUL takes the modified two-byte form `C0 80`,
/// so no encoding contains a zero byte; a surrogate takes the generalised
/// three-byte form, so lone surrogates are representable.
fn encode_unit(u: u16) -> ([u8; 3], usize) {
    // Each `as u8` keeps exactly the bits the mask or shift selected.
    match u {
        0 => ([0xc0, 0x80, 0], 2),
        1..=0x7f => ([u as u8, 0, 0], 1),
        0x80..=0x7ff => ([0xc0 | (u >> 6) as u8, 0x80 | (u & 63) as u8, 0], 2),
        _ => (
            [
                0xe0 | (u >> 12) as u8,
                0x80 | ((u >> 6) & 63) as u8,
                0x80 | (u & 63) as u8,
            ],
            3,
        ),
    }
}

/// Decode the one- to three-byte unit at the front of `bytes`: the unit and
/// the bytes it used, or `None` for a byte that cannot lead (NUL, a
/// continuation byte, `F0..FF`), a missing or malformed continuation byte.
/// Shape only: an overlong form decodes here and is refused by
/// [`SymbolName::from_cesu8`]'s re-encoding comparison.
fn decode_unit(bytes: &[u8]) -> Option<(u16, usize)> {
    let b = *bytes.first()?;
    match b {
        1..=0x7f => Some((u16::from(b), 1)),
        0xc0..=0xdf => {
            let b1 = *bytes.get(1)?;
            if b1 & 0xc0 != 0x80 {
                return None;
            }
            Some(((u16::from(b & 31) << 6) | u16::from(b1 & 63), 2))
        }
        0xe0..=0xef => {
            let b1 = *bytes.get(1)?;
            let b2 = *bytes.get(2)?;
            if b1 & 0xc0 != 0x80 || b2 & 0xc0 != 0x80 {
                return None;
            }
            Some((
                (u16::from(b & 15) << 12) | (u16::from(b1 & 63) << 6) | u16::from(b2 & 63),
                3,
            ))
        }
        _ => None,
    }
}

impl From<&str> for SymbolName {
    fn from(s: &str) -> Self {
        Self::from_units(&s.encode_utf16().collect::<Vec<_>>())
    }
}
impl From<String> for SymbolName {
    fn from(s: String) -> Self {
        Self::from(s.as_str())
    }
}
impl From<&String> for SymbolName {
    fn from(s: &String) -> Self {
        Self::from(s.as_str())
    }
}
impl From<&SymbolName> for SymbolName {
    fn from(s: &SymbolName) -> Self {
        s.clone()
    }
}
impl From<Vec<u16>> for SymbolName {
    fn from(s: Vec<u16>) -> Self {
        Self::from_units(&s)
    }
}
impl PartialEq<str> for SymbolName {
    fn eq(&self, s: &str) -> bool {
        self.units().eq(s.encode_utf16())
    }
}
impl PartialEq<&str> for SymbolName {
    fn eq(&self, s: &&str) -> bool {
        self == *s
    }
}
impl std::fmt::Display for SymbolName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for c in char::decode_utf16(self.units()) {
            match c {
                Ok(c) => write!(f, "{c}")?,
                Err(e) => write!(f, "\\u{:04x}", e.unpaired_surrogate())?,
            }
        }
        Ok(())
    }
}

impl From<&Vec<u16>> for SymbolName {
    fn from(s: &Vec<u16>) -> Self {
        Self::from_units(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_code_unit_has_a_distinct_round_trip() {
        let mut seen = std::collections::HashSet::new();
        for unit in 0..=u16::MAX {
            let name = SymbolName::from_units(&[unit]);
            assert!(!name.as_bytes().contains(&0));
            assert_eq!(name.to_units(), [unit]);
            assert_eq!(SymbolName::from_cesu8(name.as_bytes()), Some(name.clone()));
            assert!(seen.insert(name));
        }
    }

    #[test]
    fn scalar_and_unit_construction_agree() {
        for text in ["", "ascii", "é", "😀", "\0", "a\0😀z"] {
            let name = SymbolName::from(text);
            assert_eq!(name.to_text().as_deref(), Some(text));
            assert_eq!(
                name,
                SymbolName::from_units(&text.encode_utf16().collect::<Vec<_>>())
            );
        }
        assert_eq!(
            SymbolName::from("😀").as_bytes(),
            &[0xed, 0xa0, 0xbd, 0xed, 0xb8, 0x80]
        );
    }

    /// SplitMix64, so the property tests need no dependency.
    fn splitmix(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    fn lossless(units: &[u16]) {
        let name = SymbolName::from_units(units);
        assert_eq!(name.to_units(), units);
        assert_eq!(SymbolName::from_cesu8(name.as_bytes()), Some(name.clone()));
        assert!(!name.as_bytes().contains(&0));
    }

    /// TXT-1(a) on every surrogate pair and every surrogate next to every
    /// 61st unit, and on PRNG sequences of up to 8 units biased toward
    /// surrogates, NUL and the encoding-width boundaries.
    #[test]
    fn sequences_are_lossless() {
        for hi in 0xd800..=0xdbffu16 {
            for lo in 0xdc00..=0xdfffu16 {
                lossless(&[hi, lo]);
            }
        }
        for s in 0xd800..=0xdfffu16 {
            for u in (0..=u16::MAX).step_by(61) {
                lossless(&[s, u]);
                lossless(&[u, s]);
            }
        }
        let mut state = 0x1E77_u64;
        let edges = [
            0, 1, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff,
        ];
        for _ in 0..300_000 {
            let n = (splitmix(&mut state) % 9) as usize;
            let units: Vec<u16> = (0..n)
                .map(|_| {
                    let r = splitmix(&mut state);
                    match r % 4 {
                        0 => edges[((r >> 8) % edges.len() as u64) as usize],
                        1 => 0xd800 | ((r >> 16) as u16 & 0x7ff),
                        _ => (r >> 32) as u16,
                    }
                })
                .collect();
            lossless(&units);
        }
    }

    /// TXT-1(b): whatever `from_cesu8` accepts it returns byte-identical,
    /// on PRNG byte strings of up to 12 bytes drawn from lead/continuation
    /// shapes, so overlong and truncated forms are frequent; and every
    /// accepted string is the encoding of its own units.
    #[test]
    fn accepted_bytes_are_canonical() {
        let mut state = 0xCE5u64;
        let mut accepted = 0;
        for _ in 0..500_000 {
            let n = (splitmix(&mut state) % 13) as usize;
            let bytes: Vec<u8> = (0..n)
                .map(|_| {
                    let r = splitmix(&mut state);
                    match r % 5 {
                        0 => 0x80 | (r >> 8) as u8 & 0x3f,
                        1 => 0xc0 | (r >> 8) as u8 & 0x1f,
                        2 => 0xe0 | (r >> 8) as u8 & 0x0f,
                        3 => (r >> 8) as u8 & 0x7f,
                        _ => (r >> 8) as u8,
                    }
                })
                .collect();
            if let Some(name) = SymbolName::from_cesu8(&bytes) {
                accepted += 1;
                assert_eq!(name.as_bytes(), &bytes[..]);
                assert_eq!(SymbolName::from_units(&name.to_units()), name);
            }
        }
        assert!(accepted > 10_000, "only {accepted} accepted");
    }

    /// The kernels on their whole domains: every unit encodes to a form
    /// `decode_unit` inverts, and every one- to three-byte input decodes
    /// within its length.
    #[test]
    fn unit_kernels_exhaustive() {
        for u in 0..=u16::MAX {
            let (bytes, n) = encode_unit(u);
            assert_eq!(decode_unit(&bytes[..n]), Some((u, n)));
        }
        for b0 in 0..=u8::MAX {
            for b1 in 0..=u8::MAX {
                for b2 in [0, 0x80, 0xbf, 0xc0, b1] {
                    if let Some((_, n)) = decode_unit(&[b0, b1, b2]) {
                        assert!((1..=3).contains(&n));
                    }
                    if let Some((_, n)) = decode_unit(&[b0, b1]) {
                        assert!((1..=2).contains(&n));
                    }
                }
            }
        }
    }

    #[test]
    fn noncanonical_encodings_are_rejected() {
        for bytes in [
            &[0][..],
            &[0xc0, 0x81],
            &[0xc1, 0x80],
            &[0xe0, 0x80, 0x80],
            &[0xff],
            &[0xed, 0xa0],
            &[0xf0, 0x9f, 0x98, 0x80],
        ] {
            assert!(SymbolName::from_cesu8(bytes).is_none(), "{bytes:?}");
        }
    }
}

/// Kani harnesses for guarantee TXT-1 (`verification/proofs.d/framing.toml`):
/// the allocation-free per-unit kernels. The `Vec`-building wrappers are
/// covered by the exhaustive and PRNG tests above (a one-unit `SymbolName`
/// round trip took 4.3 GB of solver memory and two units exhausted it).
#[cfg(kani)]
mod proofs {
    use super::*;

    /// TXT-1(a): every code unit's CESU-8 form decodes back to it with its
    /// exact width (1 for 1..=0x7F, 2 for NUL and 0x80..=0x7FF, else 3),
    /// and contains no zero byte.
    #[kani::proof]
    #[kani::unwind(4)]
    fn txt1_unit_round_trip() {
        let u: u16 = kani::any();
        let (bytes, n) = encode_unit(u);
        let want = match u {
            1..=0x7f => 1,
            0 | 0x80..=0x7ff => 2,
            _ => 3,
        };
        assert!(n == want);
        assert!(bytes[..n].iter().all(|&b| b != 0));
        assert!(decode_unit(&bytes[..n]) == Some((u, n)));
        kani::cover!((0xd800..=0xdfff).contains(&u), "a lone surrogate's form");
    }

    /// TXT-1(b, c): `decode_unit` does not panic on any input of up to 3
    /// bytes; `Some((u, n))` implies `1 <= n <= len`; and it accepts the
    /// first `n` bytes in their canonical form exactly when they are
    /// `encode_unit(u)`, which is what `from_cesu8`'s final comparison
    /// relies on to refuse overlong forms.
    #[kani::proof]
    #[kani::unwind(4)]
    fn txt1_decode_unit_bounded() {
        let bytes: [u8; 3] = kani::any();
        let len: usize = kani::any_where(|&l| l <= 3);
        let input = &bytes[..len];
        if let Some((u, n)) = decode_unit(input) {
            assert!((1..=len).contains(&n));
            let (canonical, m) = encode_unit(u);
            let same = m == n && canonical[..m] == input[..n];
            kani::cover!(!same, "an overlong form, refused later by from_cesu8");
            kani::cover!(same && n == 3, "a canonical three-byte form");
        }
    }
}
