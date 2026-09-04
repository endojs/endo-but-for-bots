//! The length-prefixed big-endian FourCC **atom container** (design
//! `designs/ironhorse-engine.md` § Snapshots, requirement 1c). This
//! is the on-disk grammar `xsSnapshot.c` writes: an `XS_M` envelope
//! wrapping a sequence of atoms, each `[u32 size BE][4-byte FourCC tag][…
//! payload]` where `size` counts the whole atom (header + payload), the
//! same shape XS's `fxWriteAtom`/`fxReadAtom` use. Ironhorse writes and reads
//! this grammar with an ironhorse `VERS` discriminator ([`crate::format`]);
//! the XS importer is out of scope (resolved question 3).
//!
//! The container is a serializer over the index arenas, not a relocator:
//! this module only frames bytes; [`crate::image`] fills the atoms.

use crate::format::FourCc;

/// The fixed atom header size: a `u32` big-endian size followed by the
/// 4-byte FourCC tag. `size` is measured from the first byte of the
/// header to the last byte of the payload (XS `fxWriteAtom` writes the
/// total atom size, header included).
pub const ATOM_HEADER: usize = 8;

/// A streaming writer for the atom container. Atoms are appended in
/// order; [`AtomWriter::finish`] wraps them in the outer `XS_M` envelope
/// whose size covers the header plus every contained atom — exactly the
/// nesting `xsSnapshot.c` produces (`XS_M` is itself an atom whose
/// payload is the atom sequence).
#[derive(Default)]
pub struct AtomWriter {
    /// The concatenated inner atoms (each already length-prefixed).
    body: Vec<u8>,
}

impl AtomWriter {
    pub fn new() -> AtomWriter {
        AtomWriter { body: Vec::new() }
    }

    /// Append one atom: `[u32 total-size BE][tag][payload]`.
    pub fn atom(&mut self, tag: FourCc, payload: &[u8]) {
        let total = ATOM_HEADER + payload.len();
        self.body.extend_from_slice(&(total as u32).to_be_bytes());
        self.body.extend_from_slice(&tag.0);
        self.body.extend_from_slice(payload);
    }

    /// Close the container: wrap the accumulated atoms in the outer
    /// [`crate::format::XS_M`] envelope and return the finished bytes.
    pub fn finish(self) -> Vec<u8> {
        let total = ATOM_HEADER + self.body.len();
        let mut out = Vec::with_capacity(total);
        out.extend_from_slice(&(total as u32).to_be_bytes());
        out.extend_from_slice(&crate::format::XS_M.0);
        out.extend_from_slice(&self.body);
        out
    }
}

/// A malformed atom container.
#[derive(Debug, PartialEq, Eq)]
pub enum AtomError {
    /// The buffer is shorter than an atom header, or an atom's declared
    /// size runs past the end of its container.
    Truncated,
    /// The declared atom size is smaller than the 8-byte header (so the
    /// payload length would be negative) — a corrupt length prefix.
    BadLength,
    /// The outer envelope's FourCC is not `XS_M`.
    NotContainer(FourCc),
    /// Bytes follow the declared `XS_M` envelope. The writer emits the
    /// envelope and nothing else, so a trailing tail can only be
    /// crafted or torn -- and accepting it would give one logical
    /// machine unboundedly many container encodings, and so unboundedly
    /// many CAS keys.
    TrailingBytes,
    /// The same tag appears twice. The grammar has at most one of each
    /// top-level atom and `find` would silently take the first, so a
    /// duplicate is both non-canonical and a way to hide a payload
    /// behind one the reader prefers.
    DuplicateAtom(FourCc),
}

/// A borrowed view of one parsed atom.
pub struct Atom<'a> {
    pub tag: FourCc,
    pub payload: &'a [u8],
}

/// Parse the atom sequence inside a raw byte slice (no outer envelope),
/// returning each `(tag, payload)` in order.
fn parse_atoms(mut buf: &[u8]) -> Result<Vec<Atom<'_>>, AtomError> {
    let mut out = Vec::new();
    while !buf.is_empty() {
        if buf.len() < ATOM_HEADER {
            return Err(AtomError::Truncated);
        }
        let size = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if size < ATOM_HEADER {
            return Err(AtomError::BadLength);
        }
        if size > buf.len() {
            return Err(AtomError::Truncated);
        }
        let tag = FourCc([buf[4], buf[5], buf[6], buf[7]]);
        out.push(Atom {
            tag,
            payload: &buf[ATOM_HEADER..size],
        });
        buf = &buf[size..];
    }
    Ok(out)
}

/// A parsed atom container: the `XS_M` envelope unwrapped into its atom
/// sequence. Atoms are exposed in file order; [`AtomReader::find`] fetches
/// the first atom with a given tag (the grammar has at most one of each
/// top-level atom).
pub struct AtomReader<'a> {
    atoms: Vec<Atom<'a>>,
}

impl<'a> AtomReader<'a> {
    /// Parse a whole container, verifying the outer `XS_M` envelope.
    pub fn parse(buf: &'a [u8]) -> Result<AtomReader<'a>, AtomError> {
        if buf.len() < ATOM_HEADER {
            return Err(AtomError::Truncated);
        }
        let size = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if size < ATOM_HEADER {
            return Err(AtomError::BadLength);
        }
        if size > buf.len() {
            return Err(AtomError::Truncated);
        }
        let tag = FourCc([buf[4], buf[5], buf[6], buf[7]]);
        if tag != crate::format::XS_M {
            return Err(AtomError::NotContainer(tag));
        }
        // EXACT consumption: the envelope is the whole container.
        if size != buf.len() {
            return Err(AtomError::TrailingBytes);
        }
        let atoms = parse_atoms(&buf[ATOM_HEADER..size])?;
        // At most one of each tag, so `find`'s first-match is also the
        // only match and the encoding is canonical.
        for (i, a) in atoms.iter().enumerate() {
            if atoms[..i].iter().any(|b| b.tag == a.tag) {
                return Err(AtomError::DuplicateAtom(a.tag));
            }
        }
        Ok(AtomReader { atoms })
    }

    /// The first atom carrying `tag`, or `None`.
    pub fn find(&self, tag: FourCc) -> Option<&Atom<'a>> {
        self.atoms.iter().find(|a| a.tag == tag)
    }

    /// Every atom, in file order.
    pub fn atoms(&self) -> &[Atom<'a>] {
        &self.atoms
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::FourCc;

    #[test]
    fn empty_container_round_trips() {
        let bytes = AtomWriter::new().finish();
        let r = AtomReader::parse(&bytes).unwrap();
        assert!(r.atoms().is_empty());
    }

    #[test]
    fn atoms_round_trip_in_order() {
        let a = FourCc(*b"AAAA");
        let b = FourCc(*b"BBBB");
        let mut w = AtomWriter::new();
        w.atom(a, b"hello");
        w.atom(b, &[1, 2, 3, 4, 5]);
        let bytes = w.finish();

        let r = AtomReader::parse(&bytes).unwrap();
        assert_eq!(r.atoms().len(), 2);
        assert_eq!(r.atoms()[0].tag, a);
        assert_eq!(r.atoms()[0].payload, b"hello");
        assert_eq!(r.find(b).unwrap().payload, &[1, 2, 3, 4, 5]);
        assert!(r.find(FourCc(*b"ZZZZ")).is_none());
    }

    #[test]
    fn empty_payload_atom() {
        let t = FourCc(*b"MTPT");
        let mut w = AtomWriter::new();
        w.atom(t, &[]);
        let bytes = w.finish();
        let r = AtomReader::parse(&bytes).unwrap();
        assert_eq!(r.find(t).unwrap().payload, b"");
    }

    #[test]
    fn rejects_non_container_envelope() {
        // A single atom that is not XS_M at the outermost position.
        let mut inner = Vec::new();
        inner.extend_from_slice(&8u32.to_be_bytes());
        inner.extend_from_slice(b"NOPE");
        assert_eq!(
            AtomReader::parse(&inner).err(),
            Some(AtomError::NotContainer(FourCc(*b"NOPE")))
        );
    }

    #[test]
    fn rejects_truncated() {
        assert_eq!(AtomReader::parse(&[0, 0, 0]).err(), Some(AtomError::Truncated));
        // Envelope claims 100 bytes but only 8 present.
        let mut buf = Vec::new();
        buf.extend_from_slice(&100u32.to_be_bytes());
        buf.extend_from_slice(&XS_M_TAG);
        assert_eq!(AtomReader::parse(&buf).err(), Some(AtomError::Truncated));
    }

    #[test]
    fn rejects_bad_length() {
        // Size prefix smaller than the 8-byte header.
        let mut buf = Vec::new();
        buf.extend_from_slice(&4u32.to_be_bytes());
        buf.extend_from_slice(&XS_M_TAG);
        assert_eq!(AtomReader::parse(&buf).err(), Some(AtomError::BadLength));
    }

    const XS_M_TAG: [u8; 4] = *b"XS_M";
}
