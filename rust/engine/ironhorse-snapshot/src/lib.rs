#![forbid(unsafe_code)]
//! ironhorse-snapshot: the ironhorse XS_M atom-container writer/reader and
//! index-arena heap serializer (design `designs/ironhorse-engine.md`
//! § Snapshots, requirement 1c; the callback-signature discipline from
//! `designs/daemon-xs-worker-snapshot.md`).
//!
//! Ironhorse writes and reads the length-prefixed big-endian FourCC atom
//! grammar — `XS_M` over `VERS`/`SIGN`/`CREA`/`BLOC`/`HEAP`/`STAC`/
//! `KEYS`/`NAME`/`SYMB` — with an **ironhorse `VERS` discriminator** so an
//! ironhorse snapshot is never mistaken for a XS one and vice versa. The
//! XS importer is out of scope (resolved question 3): this crate is the
//! Rust-native writer and reader only.
//!
//! Because the heap is index arenas, the writer is a **serializer, not a
//! relocator**: a `SlotIndex`/`ChunkOffset` is already position-
//! independent, so the `HEAP`/`BLOC` atoms are the flat arena images and a
//! read reconstructs identical arenas ([`ironhorse_vm::SlotArena::from_image`]
//! / [`ironhorse_vm::ChunkArena::from_image`]).
//!
//! # Surface (what child 3 builds on)
//!
//! - [`atom`] — the raw FourCC atom container ([`atom::AtomWriter`] /
//!   [`atom::AtomReader`]).
//! - [`format`] — the tags, the ironhorse [`format::Version`] discriminator,
//!   and the host callback-table [`format::Signature`] scheme.
//! - [`slot_codec`] — [`ironhorse_vm::Slot`] ↔ fixed-width record.
//! - [`image`] — [`image::MachineImage`] plus [`image::write_machine`] /
//!   [`image::read_machine`] for low-level tooling, and the
//!   proof-carrying [`image::ValidatedSnapshot`] the `Machine`-level
//!   adoption surface consumes. Includes the [`image::MeterImage`] `METR`
//!   atom (meter state across suspend, design row 6).
//! - [`machine`] — the xsnap-shaped `Machine` surface (stage-6 child 3):
//!   the [`machine::MachineSnapshot`] extension trait on `ironhorse_vm::Interp`
//!   (`write_snapshot_to_file`/`suspend_to_cas`) plus
//!   [`machine::from_snapshot_file`]/[`machine::resume_from_cas`]. Its
//!   suspend-point contract (between-crank quiescence) is documented there.
//! - [`sha256`] — the dependency-free, `unsafe`-free SHA-256 the CAS
//!   content addressing uses.
//!
//! # Side-table completeness (the bug class this crate designs against)
//!
//! A machine's reachable state is not wholly in the arenas: dozens of
//! `Interp` side tables hold per-instance and per-activation state. An
//! atom grammar that misses one is the snapshot-shaped version of a
//! missing GC root. [`sidetable::SideTable`] enumerates them explicitly,
//! one compiler-forced variant per table, each with its current
//! [`sidetable::Coverage`] — so the remaining atoms are a compile-checked
//! ledger, never a silent omission.
//!
//! The whole crate is `#![forbid(unsafe_code)]` (the engine unsafe budget
//! is zero, design § Minimizing `unsafe`).

pub mod atom;
pub mod format;
pub mod image;
pub mod machine;
pub mod sha256;
pub mod sidetable;
pub mod slot_codec;
pub mod store;
pub mod store_file;
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
    FourCc, Signature, SignatureError, SnapshotError, Version, VersionError, ARRY, BLOC, COLL,
    CREA, DATE, FUNC, HEAP, KEYS, METR, NAME, PROX, REGY, SIGN, STAC, SYMB, VERS, XS_M,
};
pub use image::{
    read_machine, read_validated_machine, write_machine, ArrayImage, CollectionImage,
    CreationParams, DateImage, MachineImage, MeterImage, RegistryImage, ValidatedSnapshot,
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
    CheckpointBatch, CommitStats, HeapStore, MemoryStore, SmallState, StoreError, StoreManifest,
    ValidatedStoreState, CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE, STORE_SCHEMA_VERSION,
};
pub use store_file::{FileStore, FILE_MAGIC};
