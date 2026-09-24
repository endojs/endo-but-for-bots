//! Stable small-state section identities, framing, and the per-section
//! digests a checkpoint compares to send only the sections that changed.
//!
//! Schema 28 stores the 32 payloads independently. An older store keeps its
//! small state framed whole until migration splits it. The digests are
//! change detection: nothing takes one as evidence about its payload (the
//! store-seam design's trust model).
use crate::store::StoreError;
use crate::SnapshotError;

/// The digest domain tag, unchanged since schema 28: the digests a store
/// holds agree with the ones a session computes, whichever build stored
/// them, so a first checkpoint after an upgrade skips unchanged sections.
const SECTION_DIGEST_TAG: u8 = b'T';

macro_rules! define_small_sections {
    ($($name:ident = $id:literal,)*) => {
        pub const SMALL_SECTION_COUNT: usize = [$(stringify!($name)),*].len();

        /// Existing framing order. IDs are persisted identities and must not move.
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        #[repr(u8)]
        pub enum SmallSection {
            $($name = $id,)*
        }
        impl SmallSection {
            pub const fn vm_section(self) -> ironhorse_vm::SnapshotSection {
                match self {
                    $(Self::$name => ironhorse_vm::SnapshotSection::$name,)*
                }
            }
            pub const ALL: [Self; SMALL_SECTION_COUNT] = [$(Self::$name,)*];
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
    };
}
ironhorse_vm::snapshot_sections!(define_small_sections);

fn corrupt(message: &'static str) -> StoreError {
    StoreError::Snapshot(SnapshotError::Corrupt(message))
}

fn checked_section_length(length: usize) -> Result<u32, StoreError> {
    u32::try_from(length).map_err(|_| corrupt("small section length"))
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

/// A section's digest: SHA-256 over the domain tag, the big-endian section
/// id, and the payload bytes.
pub fn section_hash(section: SmallSection, bytes: &[u8]) -> [u8; 32] {
    section_digest(section.id(), bytes)
}

fn section_digest(id: u32, bytes: &[u8]) -> [u8; 32] {
    let mut h = crate::sha256::Sha256::new();
    h.update(&[SECTION_DIGEST_TAG]);
    h.update(&id.to_be_bytes());
    h.update(bytes);
    h.finalize()
}

/// Canonical legacy framing, also used by explicit whole-state export adapters.
pub fn frame_small_state(sections: &[&[u8]; SMALL_SECTION_COUNT]) -> Result<Vec<u8>, StoreError> {
    let mut out = Vec::new();
    for section in sections {
        let length = checked_section_length(section.len())?;
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

pub fn validate_batch(
    batch: &crate::store::CheckpointBatch,
    initial: bool,
) -> Result<(), StoreError> {
    if let Some(updates) = &batch.small_updates {
        if !batch.small.is_empty() {
            return Err(corrupt("conflicting small-state representations"));
        }
        validate_updates(updates, initial)?;
        for update in updates {
            checked_section_length(update.bytes.len())?;
            validate_payload(update.section, &update.bytes)?;
        }
    } else {
        crate::store::SmallState::decode(&batch.small)?;
    }
    Ok(())
}

/// Decode only supplied payloads, not retained sections. Cross-section reference
/// admission remains the complete-image validator's responsibility.
fn validate_payload(section: SmallSection, bytes: &[u8]) -> Result<(), StoreError> {
    let decoded = crate::snapshot_roster::canonical_payload(section, bytes);
    if decoded.map_err(StoreError::Snapshot)? != bytes {
        return Err(corrupt("noncanonical small section payload"));
    }
    Ok(())
}

pub fn batch_updates(
    batch: &crate::store::CheckpointBatch,
) -> Result<Vec<SectionUpdate>, StoreError> {
    if let Some(updates) = &batch.small_updates {
        return Ok(updates.clone());
    }
    let sections = split_small_state(&batch.small)?;
    Ok(SmallSection::ALL
        .iter()
        .map(|&section| SectionUpdate {
            section,
            bytes: sections[section.id() as usize].to_vec(),
        })
        .collect())
}

/// The section digests after `batch`. The batch is not validated again:
/// the commit gate's `check_succession` validates each batch's section
/// payloads once, and the checkpoint producer builds its batches from the
/// machine's own state.
pub fn updated_leaves(
    prior: Option<&SectionLeaves>,
    batch: &crate::store::CheckpointBatch,
) -> Result<SectionLeaves, StoreError> {
    if let Some(updates) = &batch.small_updates {
        let mut leaves = prior
            .cloned()
            .unwrap_or_else(|| SectionLeaves::from_hashes([[0; 32]; SMALL_SECTION_COUNT]));
        leaves.apply(updates)?;
        Ok(leaves)
    } else {
        Ok(SectionLeaves::from_payloads(&split_small_state(
            &batch.small,
        )?))
    }
}

/// Merge only for whole-state adapters such as the reference FileStore,
/// over a batch the commit gate has already validated.
pub fn merge_framed(
    prior: Option<&[u8]>,
    batch: &crate::store::CheckpointBatch,
) -> Result<Vec<u8>, StoreError> {
    if let Some(updates) = &batch.small_updates {
        let mut sections = match prior {
            Some(bytes) => split_small_state(bytes)?,
            None => [&[][..]; SMALL_SECTION_COUNT],
        };
        for update in updates {
            sections[update.section.id() as usize] = &update.bytes;
        }
        frame_small_state(&sections)
    } else {
        Ok(batch.small.clone())
    }
}

/// The 32 section digests. Only changed payloads are hashed again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SectionLeaves {
    leaves: [[u8; 32]; SMALL_SECTION_COUNT],
}
impl SectionLeaves {
    pub fn from_payloads(sections: &[&[u8]; SMALL_SECTION_COUNT]) -> Self {
        Self::from_hashes(std::array::from_fn(|id| {
            section_digest(id as u32, sections[id])
        }))
    }
    pub fn from_hashes(leaves: [[u8; 32]; SMALL_SECTION_COUNT]) -> Self {
        Self { leaves }
    }
    pub fn hashes(&self) -> &[[u8; 32]; SMALL_SECTION_COUNT] {
        &self.leaves
    }
    pub fn apply(&mut self, updates: &[SectionUpdate]) -> Result<(), StoreError> {
        validate_updates(updates, false)?;
        for update in updates {
            let id = update.section.id();
            self.leaves[id as usize] = section_digest(id, &update.bytes);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Independent schema-28 fixture: do not generate this from the roster.
    /// A coordinated rename/reorder must not silently reinterpret stored sections.
    #[test]
    fn schema_28_section_identities_are_stable() {
        let expected = [
            SmallSection::Stack,
            SmallSection::RetiredFreeList,
            SmallSection::Keys,
            SmallSection::Names,
            SmallSection::Symbols,
            SmallSection::Meter,
            SmallSection::Arrays,
            SmallSection::Collections,
            SmallSection::Registry,
            SmallSection::Errors,
            SmallSection::Buffers,
            SmallSection::TypedArrays,
            SmallSection::DataViews,
            SmallSection::Wrappers,
            SmallSection::Regexps,
            SmallSection::ArgumentsBrands,
            SmallSection::Temporal,
            SmallSection::Intl,
            SmallSection::NameFloor,
            SmallSection::Iterators,
            SmallSection::Dates,
            SmallSection::Functions,
            SmallSection::Proxies,
            SmallSection::Accessors,
            SmallSection::IntlBoundFunctions,
            SmallSection::PrivateElements,
            SmallSection::DisposableStacks,
            SmallSection::Generators,
            SmallSection::ErrorFrames,
            SmallSection::Promises,
            SmallSection::AsyncInstances,
            SmallSection::IndexProperties,
        ];
        assert_eq!(SmallSection::ALL, expected);
        for (id, section) in expected.into_iter().enumerate() {
            assert_eq!(section.id(), id as u32);
            assert_eq!(section.vm_section() as u8, id as u8);
            assert_eq!(SmallSection::from_id(id as u32).unwrap(), section);
        }
    }

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
    fn section_length_boundary_requires_no_payload_allocation() {
        assert_eq!(checked_section_length(0).unwrap(), 0);
        assert_eq!(checked_section_length(u32::MAX as usize).unwrap(), u32::MAX);
        if let Some(too_large) = (u32::MAX as usize).checked_add(1) {
            assert!(matches!(
                checked_section_length(too_large),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "small section length"
                )))
            ));
        }
    }

    #[test]
    fn malformed_sections_have_specific_refusals() {
        assert!(matches!(
            SmallSection::from_id(32),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "small section id"
            )))
        ));
        assert!(matches!(
            split_small_state(&[]),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "small section header"
            )))
        ));
        assert!(matches!(
            split_small_state(&1u32.to_be_bytes()),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "small section payload"
            )))
        ));
        let mut extra = frame_small_state(&[&[]; SMALL_SECTION_COUNT]).unwrap();
        extra.push(0);
        assert!(matches!(
            split_small_state(&extra),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "extra small sections"
            )))
        ));
        let update = SectionUpdate {
            section: SmallSection::Arrays,
            bytes: vec![],
        };
        assert!(matches!(
            validate_updates(&[update.clone(), update], false),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "duplicate small section"
            )))
        ));
        assert!(matches!(
            validate_updates(&[], true),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "missing initial small sections"
            )))
        ));
        assert!(matches!(
            validate_payload(
                SmallSection::RetiredFreeList,
                &crate::image::encode_u32s(&[7])
            ),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "noncanonical small section payload"
            )))
        ));
        let signature = crate::Signature::new("ironhorse-worker-v1");
        let machine = ironhorse_vm::Interp::new();
        let image = crate::machine::MachineSnapshot::snapshot_image(&machine, &signature).unwrap();
        let mut batch =
            crate::store::image_to_batch_unchecked(&image, 1, crate::store::CommitToken::ZERO);
        assert!(!batch.small.is_empty());
        batch.small_updates = Some(vec![]);
        assert!(matches!(
            validate_batch(&batch, false),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "conflicting small-state representations"
            )))
        ));
    }

    /// The digest formula is the one schemas 28 through 35 used: this pins
    /// one value, so a change to it is deliberate.
    #[test]
    fn section_digest_is_stable() {
        let mut h = crate::sha256::Sha256::new();
        h.update(b"T");
        h.update(&7u32.to_be_bytes());
        h.update(b"payload");
        assert_eq!(
            section_hash(SmallSection::Collections, b"payload"),
            h.finalize()
        );
        assert_eq!(SmallSection::Collections.id(), 7);
    }

    #[test]
    fn incremental_hashes_match_full_rebuilds_and_bind_section_identity() {
        let mut payloads = sample_payloads();
        let refs = std::array::from_fn(|id| payloads[id].as_slice());
        let mut leaves = SectionLeaves::from_payloads(&refs);
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
            assert_eq!(leaves, SectionLeaves::from_payloads(&refs));
        }
        let before = leaves.clone();
        leaves.apply(&[]).unwrap();
        assert_eq!(before, leaves);
        let update = SectionUpdate {
            section: SmallSection::Arrays,
            bytes: vec![],
        };
        assert!(leaves.apply(&[update.clone(), update.clone()]).is_err());
        assert_eq!(before, leaves, "invalid updates must be atomic");
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
            before, leaves,
            "explicit empty payloads change section hashes"
        );
        // A digest binds its section's identity: equal payloads in two
        // sections digest differently, so swapping them is a change.
        let mut swapped = sample_payloads();
        swapped[SmallSection::Arrays.id() as usize] = b"same".to_vec();
        swapped[SmallSection::Collections.id() as usize] = b"other".to_vec();
        let refs = std::array::from_fn(|id| swapped[id].as_slice());
        let before = SectionLeaves::from_payloads(&refs);
        swapped.swap(
            SmallSection::Arrays.id() as usize,
            SmallSection::Collections.id() as usize,
        );
        let refs = std::array::from_fn(|id| swapped[id].as_slice());
        let after = SectionLeaves::from_payloads(&refs);
        assert_ne!(before, after);
        let (arrays, collections) = (
            SmallSection::Arrays.id() as usize,
            SmallSection::Collections.id() as usize,
        );
        assert_ne!(before.hashes()[arrays], after.hashes()[collections]);
    }
}
