//! Stable small-state section identities and incremental integrity primitives.
//!
//! The active store schema still uses its legacy whole-small-state leaf.
//! These primitives preserve payload bytes for the sectioned schema migration;
//! they do not authorize interpreting an old root with the new domains.
use crate::store::{build_class_tree, class_tree_root, leaf_hash, update_class_tree, StoreError};
use crate::SnapshotError;

pub const SMALL_SECTION_COUNT: usize = 32;
const LEAF_SECTION: u8 = b'T';
const TREE_SMALL: u8 = b'm';

/// Existing framing order. IDs are persisted identities and must not move.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum SmallSection {
    Stack = 0,
    RetiredFreeList = 1,
    Keys = 2,
    Names = 3,
    Symbols = 4,
    Meter = 5,
    Arrays = 6,
    Collections = 7,
    Registry = 8,
    Errors = 9,
    Buffers = 10,
    TypedArrays = 11,
    DataViews = 12,
    Wrappers = 13,
    Regexps = 14,
    ArgumentsBrands = 15,
    Temporal = 16,
    Intl = 17,
    NameFloor = 18,
    Iterators = 19,
    Dates = 20,
    Functions = 21,
    Proxies = 22,
    Accessors = 23,
    IntlBoundFunctions = 24,
    PrivateElements = 25,
    DisposableStacks = 26,
    Generators = 27,
    ErrorFrames = 28,
    Promises = 29,
    AsyncInstances = 30,
    IndexProperties = 31,
}
impl SmallSection {
    pub const ALL: [Self; SMALL_SECTION_COUNT] = [
        Self::Stack,
        Self::RetiredFreeList,
        Self::Keys,
        Self::Names,
        Self::Symbols,
        Self::Meter,
        Self::Arrays,
        Self::Collections,
        Self::Registry,
        Self::Errors,
        Self::Buffers,
        Self::TypedArrays,
        Self::DataViews,
        Self::Wrappers,
        Self::Regexps,
        Self::ArgumentsBrands,
        Self::Temporal,
        Self::Intl,
        Self::NameFloor,
        Self::Iterators,
        Self::Dates,
        Self::Functions,
        Self::Proxies,
        Self::Accessors,
        Self::IntlBoundFunctions,
        Self::PrivateElements,
        Self::DisposableStacks,
        Self::Generators,
        Self::ErrorFrames,
        Self::Promises,
        Self::AsyncInstances,
        Self::IndexProperties,
    ];
    pub fn from_id(id: u32) -> Result<Self, StoreError> {
        Self::ALL
            .get(id as usize)
            .copied()
            .ok_or_else(|| corrupt("small section id"))
    }
    pub const fn id(self) -> u32 {
        self as u32
    }
}
fn corrupt(message: &'static str) -> StoreError {
    StoreError::Snapshot(SnapshotError::Corrupt(message))
}

/// Borrow the exact payloads in a current, complete framed small state.
/// No payload decode/re-encode is permitted at the migration boundary.
pub fn split_small_state(bytes: &[u8]) -> Result<[&[u8]; SMALL_SECTION_COUNT], StoreError> {
    let mut sections = [&[][..]; SMALL_SECTION_COUNT];
    let mut rest = bytes;
    for section in &mut sections {
        let header: [u8; 4] = rest
            .get(..4)
            .ok_or_else(|| corrupt("small section header"))?
            .try_into()
            .expect("four-byte header");
        rest = &rest[4..];
        let length = u32::from_be_bytes(header) as usize;
        *section = rest
            .get(..length)
            .ok_or_else(|| corrupt("small section payload"))?;
        rest = &rest[length..];
    }
    if !rest.is_empty() {
        return Err(corrupt("extra small sections"));
    }
    Ok(sections)
}

/// Canonical legacy framing, also used by explicit whole-state export adapters.
pub fn frame_small_state(sections: &[&[u8]; SMALL_SECTION_COUNT]) -> Result<Vec<u8>, StoreError> {
    let mut out = Vec::new();
    for section in sections {
        let length = u32::try_from(section.len()).map_err(|_| corrupt("small section length"))?;
        out.extend_from_slice(&length.to_be_bytes());
        out.extend_from_slice(section);
    }
    Ok(out)
}

/// A sparse update: omission means unchanged; empty bytes replace the payload.
/// Whether an empty payload is valid depends on its section codec.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SectionUpdate {
    pub section: SmallSection,
    pub bytes: Vec<u8>,
}

/// Validate identity and completeness before mutating leaves or backend rows.
/// Backends must additionally admit each payload through its section codec.
pub fn validate_updates(updates: &[SectionUpdate], initial: bool) -> Result<(), StoreError> {
    let mut seen = 0u32;
    for update in updates {
        let bit = 1u32 << update.section.id();
        if seen & bit != 0 {
            return Err(corrupt("duplicate small section"));
        }
        seen |= bit;
    }
    if initial && seen != u32::MAX {
        return Err(corrupt("missing initial small sections"));
    }
    Ok(())
}

/// Only changed payloads are hashed. The fixed-width tree binds each identity.
#[derive(Clone, Debug)]
pub struct SectionLeaves {
    leaves: [[u8; 32]; SMALL_SECTION_COUNT],
    levels: Vec<Vec<[u8; 32]>>,
}
impl SectionLeaves {
    pub fn from_payloads(sections: &[&[u8]; SMALL_SECTION_COUNT]) -> Self {
        let leaves = std::array::from_fn(|id| leaf_hash(LEAF_SECTION, id as u32, sections[id]));
        Self::from_hashes(leaves)
    }
    pub fn from_hashes(leaves: [[u8; 32]; SMALL_SECTION_COUNT]) -> Self {
        Self {
            levels: build_class_tree(TREE_SMALL, &leaves),
            leaves,
        }
    }
    pub fn hashes(&self) -> &[[u8; 32]; SMALL_SECTION_COUNT] {
        &self.leaves
    }
    pub fn root(&self) -> [u8; 32] {
        class_tree_root(TREE_SMALL, &self.leaves, &self.levels)
    }
    pub fn apply(&mut self, updates: &[SectionUpdate]) -> Result<(), StoreError> {
        validate_updates(updates, false)?;
        let mut dirty = Vec::with_capacity(updates.len());
        for update in updates {
            let id = update.section.id();
            self.leaves[id as usize] = leaf_hash(LEAF_SECTION, id, &update.bytes);
            dirty.push(id);
        }
        dirty.sort_unstable();
        update_class_tree(TREE_SMALL, &self.leaves, &mut self.levels, &dirty);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_payloads() -> [Vec<u8>; SMALL_SECTION_COUNT] {
        std::array::from_fn(|id| vec![id as u8; id])
    }

    #[test]
    fn framing_preserves_payload_bytes_and_rejects_incomplete_or_extra_sections() {
        let payloads = sample_payloads();
        let refs = std::array::from_fn(|id| payloads[id].as_slice());
        let bytes = frame_small_state(&refs).unwrap();
        assert_eq!(split_small_state(&bytes).unwrap(), refs);
        for length in 0..bytes.len() {
            assert!(
                split_small_state(&bytes[..length]).is_err(),
                "length {length}"
            );
        }
        let mut extra = bytes.clone();
        extra.extend_from_slice(&0u32.to_be_bytes());
        assert!(split_small_state(&extra).is_err());
        let mut oversized = bytes;
        oversized[..4].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(split_small_state(&oversized).is_err());
        for (id, section) in SmallSection::ALL.iter().enumerate() {
            assert_eq!(section.id(), id as u32);
            assert_eq!(SmallSection::from_id(id as u32).unwrap(), *section);
        }
        assert!(SmallSection::from_id(32).is_err());
        assert!(SmallSection::from_id(u32::MAX).is_err());
    }

    #[test]
    fn incremental_hashes_match_full_rebuilds_and_bind_section_identity() {
        let mut payloads = sample_payloads();
        let refs = std::array::from_fn(|id| payloads[id].as_slice());
        let mut leaves = SectionLeaves::from_payloads(&refs);
        let original = leaves.root();
        assert_ne!(
            original,
            leaf_hash(
                crate::store::LEAF_SMALL,
                0,
                &frame_small_state(&refs).unwrap()
            )
        );
        for round in 0..100 {
            let mut updates = Vec::new();
            for section in SmallSection::ALL {
                if (section.id() + round) % 7 == 0 {
                    let bytes = vec![round as u8; (round % 13) as usize];
                    payloads[section.id() as usize] = bytes.clone();
                    updates.push(SectionUpdate { section, bytes });
                }
            }
            updates.reverse(); // callers need not sort dirty sections
            leaves.apply(&updates).unwrap();
            let refs = std::array::from_fn(|id| payloads[id].as_slice());
            assert_eq!(leaves.root(), SectionLeaves::from_payloads(&refs).root());
        }
        let before = leaves.root();
        let before_hashes = *leaves.hashes();
        leaves.apply(&[]).unwrap();
        assert_eq!(before_hashes, *leaves.hashes());
        let update = SectionUpdate {
            section: SmallSection::Arrays,
            bytes: vec![],
        };
        assert!(leaves.apply(&[update.clone(), update.clone()]).is_err());
        assert_eq!(before, leaves.root(), "invalid updates must be atomic");
        assert!(validate_updates(&[update], true).is_err());
        let all: Vec<_> = SmallSection::ALL
            .into_iter()
            .map(|section| SectionUpdate {
                section,
                bytes: vec![],
            })
            .collect();
        validate_updates(&all, true).unwrap();
        leaves.apply(&all).unwrap();
        assert_ne!(
            before,
            leaves.root(),
            "explicit empty payloads change section hashes"
        );
        let mut swapped = sample_payloads();
        let refs = std::array::from_fn(|id| swapped[id].as_slice());
        let before = SectionLeaves::from_payloads(&refs).root();
        swapped.swap(
            SmallSection::Arrays.id() as usize,
            SmallSection::Collections.id() as usize,
        );
        let refs = std::array::from_fn(|id| swapped[id].as_slice());
        assert_ne!(before, SectionLeaves::from_payloads(&refs).root());
    }
}
