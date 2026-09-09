#![forbid(unsafe_code)]
//! Validated JavaScript machine persistence: containers and paged heap stores.
//!
//! The canonical FourCC grammar is [`format::CANONICAL_ATOM_ORDER`], under an
//! IronHorse version discriminator. This is not an XS snapshot importer.
//! [`slot_codec`] serializes fields independently of Rust's resident struct layout.
//! [`versions`] names the compatibility identifiers and their bump rules.
//!
//! [`image::GatedImage`] admits production writes; [`image::ValidatedSnapshot`]
//! admits restore. [`machine::MachineSnapshot`] provides file/CAS operations and
//! [`store::HeapStore`] / [`store::HeapStoreCommit`] separate backend storage from
//! shared validation and commit admission. Container and store versions are distinct.
//! The outer Endo workspace embeds this machinery directly, not through xsnap.
//!
//! [`sidetable::SideTable`] records serialized, reconstructed and boundary-gated state.
//! Functions, proxies and accessors are carried; unsupported live states still refuse
//! persistence. See `rust/engine/ARCHITECTURE.md` for the four seams, and the schema
//! perspectives in `designs/ironhorse-snapshot-schema*.md` for field-change obligations.
//! This crate forbids unsafe Rust; the outer SQLite backend is outside that scope.

mod stored_slots;

pub mod atom;
pub mod format;
pub mod image;
pub mod machine;
pub use ironhorse_vm::sha256;
pub mod sidetable;
pub mod slot_codec;
pub mod store;
pub mod store_file;
pub mod store_sections;
pub mod versions;
// Backend-parameterized acceptance suites (metamorphic determinism,
// checkpoint locks) for OTHER crates' backends to instantiate; test
// support only, hence feature-gated.
#[cfg(feature = "store-suite")]
pub mod store_suite;
// Scratch-dir guard for the src test modules only (integration
// binaries carry their own copy in tests/common/).
#[cfg(test)]
pub(crate) mod test_dir;

pub use atom::{Atom, AtomError, AtomReader, AtomWriter};
pub use format::{
    FourCc, Signature, SignatureError, SnapshotError, Version, VersionError, ACCS, ARRY, BLOC,
    COLL, CREA, DATE, DISP, FUNC, GENR, HEAP, IBFN, KEYS, METR, NAME, PRIV, PROX, REGY, SIGN, STAC,
    SYMB, VERS, XS_M,
};
pub use image::{
    read_machine, read_validated_machine, write_machine, ArrayImage, CollectionImage,
    CreationParams, DateImage, GatedImage, MachineImage, MeterImage, RegistryImage,
    ValidatedSnapshot,
};
pub use machine::{
    from_snapshot_bytes, from_snapshot_file, image_to_interp, resume_from_cas, MachineSnapshot,
    MachineSnapshotError,
};
pub use sidetable::{Coverage, Descriptor, SideTable};
pub use slot_codec::{decode_slot, decode_slots, encode_slot, encode_slots, SLOT_RECORD_BYTES};
pub use store::{
    check_epoch, chunk_extent_count, chunk_extent_len, export_to_container, image_to_batch,
    import_from_container, slot_page_count, slot_page_len, store_to_image, validate_store,
    CheckpointBatch, CommitStats, HeapStore, HeapStoreCommit, MemoryStore, SmallState, StoreError,
    StoreManifest, ValidatedStoreState, CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE, STORE_SCHEMA_VERSION,
};
pub use store_file::{FileStore, FILE_MAGIC};

#[cfg(any(test, feature = "unchecked-tooling"))]
pub use image::write_machine_unchecked;
#[cfg(any(test, feature = "unchecked-tooling"))]
pub use store::image_to_batch_unchecked;
