//! Stable small-state section identities and incremental integrity primitives.
//!
//! Schema 28 binds the 32 payloads independently. Older schemas retain their
//! monolithic leaf until the verified migration restamps the manifest.
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
    pub const fn vm_section(self) -> ironhorse_vm::SnapshotSection {
        match self {
            Self::Stack => ironhorse_vm::SnapshotSection::Stack,
            Self::RetiredFreeList => ironhorse_vm::SnapshotSection::RetiredFreeList,
            Self::Keys => ironhorse_vm::SnapshotSection::Keys,
            Self::Names => ironhorse_vm::SnapshotSection::Names,
            Self::Symbols => ironhorse_vm::SnapshotSection::Symbols,
            Self::Meter => ironhorse_vm::SnapshotSection::Meter,
            Self::Arrays => ironhorse_vm::SnapshotSection::Arrays,
            Self::Collections => ironhorse_vm::SnapshotSection::Collections,
            Self::Registry => ironhorse_vm::SnapshotSection::Registry,
            Self::Errors => ironhorse_vm::SnapshotSection::Errors,
            Self::Buffers => ironhorse_vm::SnapshotSection::Buffers,
            Self::TypedArrays => ironhorse_vm::SnapshotSection::TypedArrays,
            Self::DataViews => ironhorse_vm::SnapshotSection::DataViews,
            Self::Wrappers => ironhorse_vm::SnapshotSection::Wrappers,
            Self::Regexps => ironhorse_vm::SnapshotSection::Regexps,
            Self::ArgumentsBrands => ironhorse_vm::SnapshotSection::ArgumentsBrands,
            Self::Temporal => ironhorse_vm::SnapshotSection::Temporal,
            Self::Intl => ironhorse_vm::SnapshotSection::Intl,
            Self::NameFloor => ironhorse_vm::SnapshotSection::NameFloor,
            Self::Iterators => ironhorse_vm::SnapshotSection::Iterators,
            Self::Dates => ironhorse_vm::SnapshotSection::Dates,
            Self::Functions => ironhorse_vm::SnapshotSection::Functions,
            Self::Proxies => ironhorse_vm::SnapshotSection::Proxies,
            Self::Accessors => ironhorse_vm::SnapshotSection::Accessors,
            Self::IntlBoundFunctions => ironhorse_vm::SnapshotSection::IntlBoundFunctions,
            Self::PrivateElements => ironhorse_vm::SnapshotSection::PrivateElements,
            Self::DisposableStacks => ironhorse_vm::SnapshotSection::DisposableStacks,
            Self::Generators => ironhorse_vm::SnapshotSection::Generators,
            Self::ErrorFrames => ironhorse_vm::SnapshotSection::ErrorFrames,
            Self::Promises => ironhorse_vm::SnapshotSection::Promises,
            Self::AsyncInstances => ironhorse_vm::SnapshotSection::AsyncInstances,
            Self::IndexProperties => ironhorse_vm::SnapshotSection::IndexProperties,
        }
    }
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

pub fn section_hash(section: SmallSection, bytes: &[u8]) -> [u8; 32] {
    leaf_hash(LEAF_SECTION, section.id(), bytes)
}

/// Root of a complete schema-28 small state, preserving its exact payload bytes.
pub fn framed_root(bytes: &[u8]) -> Result<[u8; 32], StoreError> {
    Ok(SectionLeaves::from_payloads(&split_small_state(bytes)?).root())
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

/// Canonical sparse sealing input. Identity sorting makes caller order irrelevant.
pub fn encode_updates(updates: &[SectionUpdate]) -> Vec<u8> {
    let mut ordered: Vec<_> = updates.iter().collect();
    ordered.sort_by_key(|u| u.section.id());
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(ordered.len() as u64).to_be_bytes());
    for update in ordered {
        bytes.extend_from_slice(&update.section.id().to_be_bytes());
        bytes.extend_from_slice(&(update.bytes.len() as u64).to_be_bytes());
        bytes.extend_from_slice(&update.bytes);
    }
    bytes
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
    let decoded =
        match section {
            SmallSection::Stack => {
                crate::image::decode_stack(bytes).map(|value| crate::image::encode_stack(&value))
            }
            SmallSection::RetiredFreeList => {
                crate::image::decode_u32s(bytes).map(|_| crate::image::encode_u32s(&[]))
            }
            SmallSection::Keys => crate::image::decode_strings(bytes)
                .map(|value| crate::image::encode_strings(&value)),
            SmallSection::Names => {
                crate::image::decode_names(bytes).map(|value| crate::image::encode_names(&value))
            }
            SmallSection::Symbols => crate::image::decode_symbol_keys(bytes)
                .map(|value| crate::image::encode_symbol_keys(&value)),
            SmallSection::Arrays => {
                crate::image::decode_arrays(bytes).map(|value| crate::image::encode_arrays(&value))
            }
            SmallSection::Collections => crate::image::decode_collections(bytes)
                .map(|value| crate::image::encode_collections(&value)),
            SmallSection::Registry => crate::image::decode_registry(bytes)
                .map(|value| crate::image::encode_registry(&value)),
            SmallSection::Errors => {
                crate::image::decode_errors(bytes).map(|value| crate::image::encode_errors(&value))
            }
            SmallSection::Buffers => crate::image::decode_buffers(bytes)
                .map(|value| crate::image::encode_buffers(&value)),
            SmallSection::TypedArrays => crate::image::decode_typed_arrays(bytes)
                .map(|value| crate::image::encode_typed_arrays(&value)),
            SmallSection::DataViews => crate::image::decode_data_views(bytes)
                .map(|value| crate::image::encode_data_views(&value)),
            SmallSection::Wrappers => crate::image::decode_wrappers(bytes)
                .map(|value| crate::image::encode_wrappers(&value)),
            SmallSection::Regexps => crate::image::decode_regexps(bytes)
                .map(|value| crate::image::encode_regexps(&value)),
            SmallSection::ArgumentsBrands => crate::image::decode_arguments_brands(bytes)
                .map(|value| crate::image::encode_arguments_brands(&value)),
            SmallSection::Temporal => crate::image::decode_temporal(bytes)
                .map(|value| crate::image::encode_temporal(&value)),
            SmallSection::Intl => {
                crate::image::decode_intl(bytes).map(|value| crate::image::encode_intl(&value))
            }
            SmallSection::Iterators => crate::image::decode_iterators(bytes)
                .map(|value| crate::image::encode_iterators(&value)),
            SmallSection::Dates => {
                crate::image::decode_dates(bytes).map(|value| crate::image::encode_dates(&value))
            }
            SmallSection::Functions => crate::image::decode_function_state(bytes)
                .map(|value| crate::image::encode_function_state(&value)),
            SmallSection::Proxies => crate::image::decode_proxy_state(bytes)
                .map(|value| crate::image::encode_proxy_state(&value)),
            SmallSection::Accessors => crate::image::decode_accessors(bytes)
                .map(|value| crate::image::encode_accessors(&value)),
            SmallSection::IntlBoundFunctions => crate::image::decode_intl_bound_functions(bytes)
                .map(|value| crate::image::encode_intl_bound_functions(&value)),
            SmallSection::PrivateElements => crate::image::decode_private_elements(bytes)
                .map(|value| crate::image::encode_private_elements(&value)),
            SmallSection::DisposableStacks => crate::image::decode_disposable_stacks(bytes)
                .map(|value| crate::image::encode_disposable_stacks(&value)),
            SmallSection::Generators => crate::image::decode_generators(bytes)
                .map(|value| crate::image::encode_generators(&value)),
            SmallSection::ErrorFrames => {
                crate::image::decode_error_frames(bytes).map(|_| bytes.to_vec())
            }
            SmallSection::Promises => crate::image::decode_promise_cluster(bytes)
                .map(|value| crate::image::encode_promise_cluster(&value)),
            SmallSection::AsyncInstances => crate::image::decode_async_instances(bytes)
                .map(|value| crate::image::encode_async_instances(&value)),
            SmallSection::IndexProperties => crate::image::decode_index_props(bytes)
                .map(|value| crate::image::encode_index_props(&value)),
            SmallSection::Meter => {
                crate::image::MeterImage::decode(bytes).map(|value| value.encode())
            }
            SmallSection::NameFloor => {
                if bytes.is_empty() || bytes.len() == 4 {
                    Ok(bytes.to_vec())
                } else {
                    Err(SnapshotError::Corrupt(
                        "small state name-floor section size",
                    ))
                }
            }
        };
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

pub fn updated_leaves(
    prior: Option<&SectionLeaves>,
    batch: &crate::store::CheckpointBatch,
) -> Result<SectionLeaves, StoreError> {
    validate_batch(batch, prior.is_none())?;
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

/// Merge only for whole-state adapters such as the reference FileStore.
pub fn merge_framed(
    prior: Option<&[u8]>,
    batch: &crate::store::CheckpointBatch,
) -> Result<Vec<u8>, StoreError> {
    validate_batch(batch, prior.is_none())?;
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
        let mut batch = crate::store::image_to_batch_unchecked(&image, 1, "");
        assert!(!batch.small.is_empty());
        batch.small_updates = Some(vec![]);
        assert!(matches!(
            validate_batch(&batch, false),
            Err(StoreError::Snapshot(crate::format::SnapshotError::Corrupt(
                "conflicting small-state representations"
            )))
        ));
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
