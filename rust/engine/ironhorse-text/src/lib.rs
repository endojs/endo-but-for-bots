//! Lossless JavaScript symbol spellings. Equality and hashing use XS CESU-8,
//! including its modified encoding of NUL, never a diagnostic Rust string.
#![forbid(unsafe_code)]

#[derive(Clone, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SymbolName(Vec<u8>);

impl SymbolName {
    pub fn from_units(units: &[u16]) -> Self {
        let mut bytes = Vec::new();
        for &u in units {
            match u {
                0 => bytes.extend_from_slice(&[0xc0, 0x80]),
                1..=0x7f => bytes.push(u as u8),
                0x80..=0x7ff => {
                    bytes.extend_from_slice(&[0xc0 | (u >> 6) as u8, 0x80 | (u & 63) as u8])
                }
                _ => bytes.extend_from_slice(&[
                    0xe0 | (u >> 12) as u8,
                    0x80 | ((u >> 6) & 63) as u8,
                    0x80 | (u & 63) as u8,
                ]),
            }
        }
        Self(bytes)
    }

    /// Accept only canonical XS CESU-8 (no terminator).
    pub fn from_cesu8(bytes: &[u8]) -> Option<Self> {
        let mut units = Vec::new();
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            let (u, n) = match b {
                1..=0x7f => (u16::from(b), 1),
                0xc0..=0xdf => {
                    let b1 = *bytes.get(i + 1)?;
                    if b1 & 0xc0 != 0x80 {
                        return None;
                    }
                    ((u16::from(b & 31) << 6) | u16::from(b1 & 63), 2)
                }
                0xe0..=0xef => {
                    let b1 = *bytes.get(i + 1)?;
                    let b2 = *bytes.get(i + 2)?;
                    if b1 & 0xc0 != 0x80 || b2 & 0xc0 != 0x80 {
                        return None;
                    }
                    (
                        (u16::from(b & 15) << 12) | (u16::from(b1 & 63) << 6) | u16::from(b2 & 63),
                        3,
                    )
                }
                _ => return None,
            };
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
        std::iter::from_fn(move || {
            let b = *self.0.get(i)?;
            let (u, n) = if b < 0x80 {
                (u16::from(b), 1)
            } else if b < 0xe0 {
                ((u16::from(b & 31) << 6) | u16::from(self.0[i + 1] & 63), 2)
            } else {
                (
                    (u16::from(b & 15) << 12)
                        | (u16::from(self.0[i + 1] & 63) << 6)
                        | u16::from(self.0[i + 2] & 63),
                    3,
                )
            };
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
