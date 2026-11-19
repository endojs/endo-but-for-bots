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

use crate::format::{FourCc, SnapshotError};

/// The fixed atom header size: a `u32` big-endian size followed by the
/// 4-byte FourCC tag. `size` is measured from the first byte of the
/// header to the last byte of the payload (XS `fxWriteAtom` writes the
/// total atom size, header included).
pub const ATOM_HEADER: usize = 8;

/// A buffered writer for the atom container. Atoms are appended in
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
    /// Refuses lengths that cannot fit the wire format, including the outer
    /// envelope, before changing the accumulated body.
    pub fn atom(&mut self, tag: FourCc, payload: &[u8]) -> Result<(), SnapshotError> {
        let total = appended_atom_size(self.body.len(), payload.len())?;
        self.body.extend_from_slice(&total.to_be_bytes());
        self.body.extend_from_slice(&tag.0);
        self.body.extend_from_slice(payload);
        Ok(())
    }

    /// Close the container: wrap the accumulated atoms in the outer
    /// [`crate::format::XS_M`] envelope and return the finished bytes.
    pub fn finish(self) -> Result<Vec<u8>, SnapshotError> {
        let total = atom_size(self.body.len())?;
        let mut out = Vec::with_capacity(total as usize);
        out.extend_from_slice(&total.to_be_bytes());
        out.extend_from_slice(&crate::format::XS_M.0);
        out.extend_from_slice(&self.body);
        Ok(out)
    }
}

/// Check the wire-domain bound without requiring a multi-gigabyte allocation.
pub(crate) fn atom_size(payload_len: usize) -> Result<u32, SnapshotError> {
    payload_len
        .checked_add(ATOM_HEADER)
        .and_then(|total| u32::try_from(total).ok())
        .ok_or(SnapshotError::Atom(AtomError::TooLarge))
}

/// Include both headers when admitting a new inner atom. Checking the
/// cumulative envelope prevents individually valid atoms from overflowing it.
pub(crate) fn appended_atom_size(
    body_len: usize,
    payload_len: usize,
) -> Result<u32, SnapshotError> {
    let total = atom_size(payload_len)?;
    let body_len = body_len
        .checked_add(total as usize)
        .ok_or(SnapshotError::Atom(AtomError::TooLarge))?;
    atom_size(body_len)?;
    Ok(total)
}

/// A malformed atom container.
#[derive(Debug, PartialEq, Eq)]
pub enum AtomError {
    /// A writer payload or complete envelope exceeds the u32 wire size.
    TooLarge,
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

impl std::fmt::Display for AtomError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AtomError::TooLarge => write!(f, "atom payload exceeds the u32 wire size"),
            AtomError::Truncated => write!(f, "atom header or payload runs past its container"),
            AtomError::BadLength => write!(f, "atom size is smaller than its 8-byte header"),
            AtomError::NotContainer(tag) => {
                write!(f, "envelope tag is `{}`, not `XS_M`", tag.as_str())
            }
            AtomError::TrailingBytes => write!(f, "bytes follow the declared `XS_M` envelope"),
            AtomError::DuplicateAtom(tag) => write!(f, "atom `{}` appears twice", tag.as_str()),
        }
    }
}

impl std::error::Error for AtomError {}

/// A borrowed view of one parsed atom.
pub struct Atom<'a> {
    pub tag: FourCc,
    pub payload: &'a [u8],
}

/// Split one atom off the front of `buf`: its declared total size, its tag,
/// its payload, and the bytes after it. The checks run in the order the
/// errors are documented: a short header is [`AtomError::Truncated`], a
/// size below the header [`AtomError::BadLength`], and a size past the end
/// of `buf` [`AtomError::Truncated`] again.
fn split_atom(buf: &[u8]) -> Result<(usize, FourCc, &[u8], &[u8]), AtomError> {
    let (size, after_size) = buf.split_first_chunk::<4>().ok_or(AtomError::Truncated)?;
    let (tag, _) = after_size
        .split_first_chunk::<4>()
        .ok_or(AtomError::Truncated)?;
    // Where `usize` is narrower than `u32`, a size that does not convert
    // could not fit inside `buf` either.
    let size = usize::try_from(u32::from_be_bytes(*size)).map_err(|_| AtomError::Truncated)?;
    if size < ATOM_HEADER {
        return Err(AtomError::BadLength);
    }
    let (atom, rest) = buf.split_at_checked(size).ok_or(AtomError::Truncated)?;
    // `size >= ATOM_HEADER` was checked above, so the header split succeeds.
    let (_, payload) = atom
        .split_at_checked(ATOM_HEADER)
        .ok_or(AtomError::BadLength)?;
    Ok((size, FourCc(*tag), payload, rest))
}

/// Parse the atom sequence inside a raw byte slice (no outer envelope),
/// returning each `(tag, payload)` in order.
fn parse_atoms(mut buf: &[u8]) -> Result<Vec<Atom<'_>>, AtomError> {
    let mut out = Vec::new();
    while !buf.is_empty() {
        let (_, tag, payload, rest) = split_atom(buf)?;
        out.push(Atom { tag, payload });
        buf = rest;
    }
    Ok(out)
}

/// Above this many atoms the duplicate-tag check switches from a pairwise
/// scan to a set. The canonical grammar has a few dozen top-level atoms,
/// so every container a writer produces takes the allocation-free scan;
/// the set bounds a crafted container of many tiny atoms (8 bytes each) to
/// `O(n log n)` instead of the scan's `O(n^2)`, which at a few megabytes
/// of input is minutes of CPU before any other gate runs.
const PAIRWISE_DUPLICATE_SCAN_MAX: usize = 64;

/// The first atom (in file order) whose tag an earlier atom already used.
///
/// Under Kani only the pairwise shape is compiled: `BTreeSet`'s node code
/// is beyond the solver (three symbolic tags did not finish symbolic
/// execution in 300 s). That loses nothing for the SNAP-1 proofs, whose
/// inputs of at most 48 bytes hold at most five atoms, so the threshold
/// below selects the pairwise shape for every one of them (each harness
/// asserts its bound against [`PAIRWISE_DUPLICATE_SCAN_MAX`]). The set
/// shape and the two shapes' agreement are covered by ordinary tests.
fn first_duplicate(atoms: &[Atom<'_>]) -> Option<FourCc> {
    #[cfg(kani)]
    {
        first_duplicate_pairwise(atoms)
    }
    #[cfg(not(kani))]
    {
        first_duplicate_with(atoms, PAIRWISE_DUPLICATE_SCAN_MAX)
    }
}

/// [`first_duplicate`] with the shape threshold as a parameter, so tests
/// can run both shapes on the same input and check they agree.
#[cfg(not(kani))]
fn first_duplicate_with(atoms: &[Atom<'_>], pairwise_max: usize) -> Option<FourCc> {
    if atoms.len() <= pairwise_max {
        first_duplicate_pairwise(atoms)
    } else {
        first_duplicate_set(atoms)
    }
}

/// The allocation-free `O(n^2)` shape.
fn first_duplicate_pairwise(atoms: &[Atom<'_>]) -> Option<FourCc> {
    atoms.iter().enumerate().find_map(|(i, a)| {
        let earlier = atoms.get(..i)?;
        earlier.iter().any(|b| b.tag == a.tag).then_some(a.tag)
    })
}

/// The `O(n log n)` shape for many atoms.
#[cfg(not(kani))]
fn first_duplicate_set(atoms: &[Atom<'_>]) -> Option<FourCc> {
    let mut seen = std::collections::BTreeSet::new();
    atoms.iter().find(|a| !seen.insert(a.tag.0)).map(|a| a.tag)
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
        let (size, tag, payload, _) = split_atom(buf)?;
        if tag != crate::format::XS_M {
            return Err(AtomError::NotContainer(tag));
        }
        // EXACT consumption: the envelope is the whole container.
        if size != buf.len() {
            return Err(AtomError::TrailingBytes);
        }
        let atoms = parse_atoms(payload)?;
        // At most one of each tag, so `find`'s first-match is also the
        // only match and the encoding is canonical.
        if let Some(tag) = first_duplicate(&atoms) {
            return Err(AtomError::DuplicateAtom(tag));
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
        let bytes = AtomWriter::new().finish().unwrap();
        let r = AtomReader::parse(&bytes).unwrap();
        assert!(r.atoms().is_empty());
    }

    #[test]
    fn atoms_round_trip_in_order() {
        let a = FourCc(*b"AAAA");
        let b = FourCc(*b"BBBB");
        let mut w = AtomWriter::new();
        w.atom(a, b"hello").unwrap();
        w.atom(b, &[1, 2, 3, 4, 5]).unwrap();
        let bytes = w.finish().unwrap();

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
        w.atom(t, &[]).unwrap();
        let bytes = w.finish().unwrap();
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
        assert_eq!(
            AtomReader::parse(&[0, 0, 0]).err(),
            Some(AtomError::Truncated)
        );
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

    #[test]
    fn atom_size_checks_header_and_wire_bound_without_allocating() {
        assert_eq!(atom_size(0), Ok(8));
        assert_eq!(atom_size(u32::MAX as usize - ATOM_HEADER), Ok(u32::MAX));
        assert_eq!(
            atom_size(u32::MAX as usize - ATOM_HEADER + 1),
            Err(SnapshotError::Atom(AtomError::TooLarge))
        );
        assert_eq!(
            atom_size(usize::MAX),
            Err(SnapshotError::Atom(AtomError::TooLarge))
        );
    }

    #[test]
    fn cumulative_size_includes_both_headers() {
        let max = u32::MAX as usize;
        assert_eq!(appended_atom_size(max - 2 * ATOM_HEADER, 0), Ok(8));
        assert_eq!(
            appended_atom_size(max - 2 * ATOM_HEADER + 1, 0),
            Err(SnapshotError::Atom(AtomError::TooLarge))
        );
        assert_eq!(
            appended_atom_size(0, max - 2 * ATOM_HEADER),
            Ok(u32::MAX - ATOM_HEADER as u32)
        );
        assert_eq!(
            appended_atom_size(0, max - 2 * ATOM_HEADER + 1),
            Err(SnapshotError::Atom(AtomError::TooLarge))
        );
        assert_eq!(
            appended_atom_size(usize::MAX, 0),
            Err(SnapshotError::Atom(AtomError::TooLarge))
        );
    }

    /// Regression: the duplicate-tag check was a pairwise scan, so a
    /// crafted container of many 8-byte empty atoms with distinct tags cost
    /// `n^2 / 2` tag compares before any other gate ran (here `2^18` atoms,
    /// 2 MiB of input, about `3.4e10` compares: minutes, a hang under the
    /// fuzz contract). The set-based check answers in well under a second;
    /// the bound is generous so only the quadratic shape can trip it.
    #[test]
    fn many_tiny_atoms_check_duplicates_in_bounded_time() {
        let n: u32 = 1 << 18;
        let mut w = AtomWriter::new();
        for i in 0..n {
            w.atom(FourCc(i.to_be_bytes()), &[]).unwrap();
        }
        // The same sequence plus a final atom repeating the first tag.
        let mut dup = AtomWriter::new();
        for i in 0..n {
            dup.atom(FourCc(i.to_be_bytes()), &[]).unwrap();
        }
        dup.atom(FourCc(0u32.to_be_bytes()), b"x").unwrap();
        let (distinct, dup) = (w.finish().unwrap(), dup.finish().unwrap());

        let start = std::time::Instant::now();
        assert_eq!(AtomReader::parse(&distinct).unwrap().atoms().len(), 1 << 18);
        assert_eq!(
            AtomReader::parse(&dup).err(),
            Some(AtomError::DuplicateAtom(FourCc([0; 4])))
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(20));
    }

    /// Both duplicate-check shapes report the FIRST repeating atom in file
    /// order, so the error does not depend on which shape ran.
    #[test]
    fn duplicate_check_reports_the_first_repeat_in_either_shape() {
        for filler in [0u32, 100] {
            let mut w = AtomWriter::new();
            w.atom(FourCc(*b"AAAA"), &[]).unwrap();
            w.atom(FourCc(*b"BBBB"), &[]).unwrap();
            for i in 0..filler {
                w.atom(FourCc((0x1000_0000 + i).to_be_bytes()), &[])
                    .unwrap();
            }
            w.atom(FourCc(*b"BBBB"), &[]).unwrap();
            w.atom(FourCc(*b"AAAA"), &[]).unwrap();
            let bytes = w.finish().unwrap();
            assert_eq!(
                AtomReader::parse(&bytes).err(),
                Some(AtomError::DuplicateAtom(FourCc(*b"BBBB")))
            );
        }
    }

    /// The reference meaning of the duplicate check: the first atom whose
    /// tag an earlier atom already used.
    fn naive_first_duplicate(tags: &[[u8; 4]]) -> Option<FourCc> {
        (0..tags.len())
            .find(|&k| tags[..k].contains(&tags[k]))
            .map(|k| FourCc(tags[k]))
    }

    /// SNAP-1: both duplicate-check shapes agree with the reference on
    /// PRNG-driven tag lists of up to 300 atoms over alphabets small enough
    /// to repeat and large enough not to, and the threshold picks the set
    /// shape above 64 atoms (the shape Kani does not reach).
    #[test]
    fn duplicate_shapes_agree_with_the_reference() {
        let mut rng = crate::wire::SplitMix(0xD0B1);
        for _ in 0..3_000 {
            let n = rng.below(301) as usize;
            let alphabet = 1 + rng.below(1_000) as u32;
            let tags: Vec<[u8; 4]> = (0..n)
                .map(|_| (rng.below(u64::from(alphabet)) as u32).to_be_bytes())
                .collect();
            let atoms: Vec<Atom<'_>> = tags
                .iter()
                .map(|&t| Atom {
                    tag: FourCc(t),
                    payload: &[],
                })
                .collect();
            let want = naive_first_duplicate(&tags);
            assert_eq!(first_duplicate_pairwise(&atoms), want);
            assert_eq!(first_duplicate_set(&atoms), want);
            assert_eq!(first_duplicate(&atoms), want);
        }
    }

    /// SNAP-1(a, b, c, d) beyond the Kani bounds: written containers of up
    /// to 12 atoms round-trip, and PRNG mutations of them (byte changes,
    /// truncation, extension) either refuse or parse to atoms that tile the
    /// input and rewrite to exactly it.
    #[test]
    fn containers_round_trip_and_accepted_bytes_are_canonical() {
        let mut rng = crate::wire::SplitMix(0xA70A);
        let mut accepted_mutants = 0;
        for _ in 0..20_000 {
            let k = rng.below(13) as usize;
            let mut w = AtomWriter::new();
            let mut list = Vec::new();
            for _ in 0..k {
                let tag = (rng.below(16) as u32).to_be_bytes();
                let len = rng.below(20) as usize;
                let payload = rng.bytes(len);
                w.atom(FourCc(tag), &payload).unwrap();
                list.push((tag, payload));
            }
            let bytes = w.finish().unwrap();
            let tags: Vec<[u8; 4]> = list.iter().map(|(t, _)| *t).collect();
            match AtomReader::parse(&bytes) {
                Ok(r) => {
                    assert_eq!(naive_first_duplicate(&tags), None);
                    let got: Vec<([u8; 4], Vec<u8>)> = r
                        .atoms()
                        .iter()
                        .map(|a| (a.tag.0, a.payload.to_vec()))
                        .collect();
                    assert_eq!(got, list);
                }
                Err(e) => assert_eq!(
                    Some(e),
                    naive_first_duplicate(&tags).map(AtomError::DuplicateAtom)
                ),
            }
            let mut mutant = bytes.clone();
            match rng.below(3) {
                0 if !mutant.is_empty() => {
                    let at = rng.below(mutant.len() as u64) as usize;
                    mutant[at] = rng.next() as u8;
                }
                1 => mutant.truncate(rng.below(mutant.len() as u64 + 1) as usize),
                _ => {
                    let extra = 1 + rng.below(9) as usize;
                    mutant.extend(rng.bytes(extra));
                }
            }
            if let Ok(r) = AtomReader::parse(&mutant) {
                accepted_mutants += 1;
                let mut at = ATOM_HEADER;
                let mut w = AtomWriter::new();
                for a in r.atoms() {
                    assert_eq!(
                        a.payload.as_ptr() as usize - mutant.as_ptr() as usize,
                        at + ATOM_HEADER
                    );
                    at += ATOM_HEADER + a.payload.len();
                    w.atom(a.tag, a.payload).unwrap();
                }
                assert_eq!(at, mutant.len());
                assert_eq!(w.finish().unwrap(), mutant);
            }
        }
        assert!(
            accepted_mutants > 1_000,
            "only {accepted_mutants} mutants accepted"
        );
    }

    const XS_M_TAG: [u8; 4] = *b"XS_M";
}
