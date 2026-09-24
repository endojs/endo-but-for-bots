//! The **snapshot store seam** (design
//! `designs/ironhorse-snapshot-store-seam.md`): the paged
//! logical image and the [`HeapStore`] trait that lets the whole-heap
//! snapshot artifact be replaced by a keyed store for incremental dirty-page
//! checkpoints and lazy heap reification.
//!
//! The seam sits **below the atom grammar and above the arenas**: pages
//! and extents reuse the existing canonical encodings (the
//! [`crate::slot_codec`] record for slots, the raw chunk-arena bytes for
//! chunks, the [`crate::image`] payload codecs for the small state), so
//! there is one logical format with two containers — the `XS_M` atom
//! container for interchange and a keyed store for residence. The
//! identity locks below ([`export_to_container`] /
//! [`import_from_container`]) hold the two forms byte-equivalent.
//!
//! # What a store holds
//!
//! | Object | Content | Atom equivalent |
//! |---|---|---|
//! | Slot page `p` | up to [`SLOTS_PER_PAGE`] × 20-byte slot records, index order | a fixed span of the `HEAP` record array |
//! | Chunk extent `e` | up to [`CHUNK_EXTENT_BYTES`] raw chunk-arena bytes | a fixed span of `BLOC` |
//! | Small state | stack, free list, keys/names/symbols, meter | `STAC`, the `HEAP` header, `KEYS`/`NAME`/`SYMB`, `METR` |
//! | Manifest | version + signature + creation + geometry + epoch | `VERS`/`SIGN`/`CREA` |
//!
//! The free list is persisted verbatim in segments: its LIFO order is
//! load-bearing for deterministic slot reuse after resume. The 32 small-state
//! sections include BULK side tables, so they need not be small. Schema 28
//! checkpoints send only changed sections; full framing remains the import
//! and export representation.
//!
//! # Trust and fail-closed discipline
//!
//! A resident store is the machine it holds, and resume trusts it (the
//! store-seam design's trust model). Open runs the compatibility gates
//! ([`check_open_gates`]: format readability, the schema range, the signature
//! with its boot fingerprint) and the cost-table gate, and decodes what the
//! restore needs; the decoders and the restore guard it against engine bugs
//! with ordinary bounds checks. Free-list segments and small state are read
//! up front; lazy resume avoids eagerly loading slot and chunk rows, and each
//! later fault checks its row's length and references in the VM's fault
//! installer. A row read that fails there unwinds as the store's own error
//! (`crate::machine::StoreFault`); a row that does not decode is a named
//! crashed crank. [`validate_store`] and [`validate_store_content`] check a
//! store's correctness on request. Every decoder clamps pre-reservations to
//! what the payload can hold, as in the malformed-count regressions in
//! [`crate::image`].
//!
//! Like the rest of the crate this module is `forbid(unsafe_code)` and
//! keeps backend dependencies behind the store trait. SQLite lives daemon-side
//! (design § Crate and dependency layout), and the in-crate
//! reference stores are [`MemoryStore`] here and
//! [`crate::store_file::FileStore`].

use crate::format::{Signature, SnapshotError, Version};
use crate::image::encode_names;
use crate::image::{decode_strings, CreationParams, MachineImage, MeterImage};
use crate::slot_codec::{decode_slots, encode_slot, SLOT_RECORD_BYTES};
use ironhorse_vm::SymbolName;
use ironhorse_vm::{Slot, COST_TABLE_VERSION};

/// The canonical page/extent geometry, owned by the vm because the
/// arenas' dirty bitmaps are keyed to it (`ironhorse_vm::value`) and the
/// dependency runs snapshot → vm. A page blob is `SLOTS_PER_PAGE ×`
/// [`SLOT_RECORD_BYTES`] bytes and an extent is `CHUNK_EXTENT_BYTES`
/// raw bytes (the last of each may be shorter). Changing either is a
/// store-schema version bump, not a silent re-read.
pub use ironhorse_vm::{CHUNK_EXTENT_BYTES, SLOTS_PER_PAGE};

/// The store schema version, independent of the snapshot
/// [`crate::format::IRONHORSE_FORMAT_VERSION`] (which governs the record
/// encodings both containers share). Bumped on any change to the page
/// geometry, the manifest layout, the small-state layout, or the
/// addition or removal of a persisted row class. A new persisted row class
/// must not silently change the interpretation of an existing schema stamp.
///
/// Schemas 5 through 35 carried an integrity root over row-leaf hashes and
/// a commit-seal chain, which the store-seam design's phase 13 retired
/// (schema 36); the notes below describe them as they were.
///
/// v5: page-edge summaries joined the integrity root (with a section
/// geometry header and length-prefixed edge entries in both the root
/// and the seal encodings), and commit verified summaries against the
/// rows they travel with (in debug builds only since phase 13's stage 1).
///
/// v6: the flat root became per-class Merkle trees (same leaves, new
/// combination), enabling O(dirty·log n) commit maintenance.
///
/// v7 (the side-table ledger): the small state grew three sections —
/// arrays, collections, `Symbol.for` registry — so resumed machines
/// keep their bulk side tables. v6→v7 migration appends the three
/// sections EMPTY (a pure 12-byte suffix; a v6-era machine had
/// nothing persisted in them by definition) and restamps the root for
/// the changed small leaf.
/// v26: NAME entries use canonical XS CESU-8 instead of UTF-8. Migration
/// converts the name section and recomputes the root, preserving all ids.
/// v27 binds the manifest core and collection cadence into the seal, which
/// open verified until phase 13's stage 1, and admits one canonical
/// encoding of small state.
/// v28 binds the 32 small-state payloads independently under a fixed section tree.
/// Migration from v27 preserves payload bytes and export framing.
/// v29: FUNC persists surviving boot-native name chunk locations.
/// v30: GENR and ASYN may carry explicit saved-handler code segments.
/// v31: PRMS may carry the first reported unhandled rejection.
/// v32: FUNC may carry the shared Realm, environment, module, root and job graph.
/// v33: shared FUNC may also carry stable host-service identities and captures.
/// v34: ASYN may carry async generator instances after the activations, and
/// the `AsyncGenerator*` reaction kinds resume. Migration is an identity
/// restamp: an older ASYN payload has no generator trailer.
/// v35: ASYN may carry the `Array.fromAsync` accumulations after the generator
/// trailer, and the `FromAsync*` reaction kinds resume. Migration is an
/// identity restamp: an older ASYN payload has no fromAsync trailer.
/// v36 (phase 13, stage 2): the row-leaf hashes, the integrity root and the
/// commit seal are gone, and the manifest carries a random [`CommitToken`]
/// in their place. Migration seeds the token from the stored seal and
/// drops the leaf storage; rows and small-state payloads are unchanged.
pub const STORE_SCHEMA_VERSION: u32 = 36;
/// The oldest schema [`migrate_store`] can upgrade in place. Decode
/// accepts the whole supported range; validation refuses an
/// un-migrated older store with [`StoreError::NeedsMigration`], and
/// anything newer than CURRENT fails closed (no downgrade path).
pub const STORE_SCHEMA_MIN_SUPPORTED: u32 = 5;

/// A store that cannot be used, or an operation on it that failed.
/// Gate failures reuse the [`SnapshotError`] taxonomy so a foreign or
/// mismatched store fails with exactly the vocabulary the container
/// reader uses.
#[derive(Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum StoreError {
    /// The machine is not at a quiescent crank boundary:
    /// its last crank halted. Rewind or complete a crank before
    /// persisting.
    MachineNotQuiescent,
    /// A live Machine operation failed (for example, host-root allocation).
    /// This does not classify the stored heap as corrupt.
    MachineOperation(String),
    /// The heap holds unsupported live state identified by
    /// `Interp::stored_unpersistable_row_at_checkpoint`. Persistence
    /// refuses by row name rather than resume with missing state.
    PendingStateUnsupported { row: &'static str },
    /// The store has no committed epoch yet (a fresh store). Callers
    /// that require content (resume, export) fail on this; the first
    /// checkpoint expects it.
    Empty,
    /// An underlying I/O failure, rendered as text so the error stays
    /// `Eq`-comparable in tests (the pattern [`crate::machine`] uses for
    /// its own error split).
    ///
    /// Classified [`StoreFailure::Transient`], with one known limitation:
    /// the `std::io::ErrorKind` is destroyed at construction (`io_err`,
    /// `store_file.rs`), so a permanent medium failure — `PermissionDenied`,
    /// `NotFound` — is indistinguishable here from a retryable one. Carrying
    /// the kind means reshaping this variant across the SQLite backend in the
    /// other workspace; until then a supervisor should bound its retries
    /// rather than trust this class to terminate them.
    Io(String),
    /// A backend that cannot serve this operation at all — an in-place
    /// migration on a store whose medium does not support one, or a SQLite
    /// store opened on a read-only database. Deterministic and permanent,
    /// which is why it is not [`StoreError::Io`]: a retry loop over a
    /// capability refusal never terminates.
    Unsupported(&'static str),
    /// The CALLER's [`CheckpointBatch`] failed validation. The store is not
    /// implicated: this is a malformed request, and the inner error names
    /// which check it failed.
    ///
    /// Batch validation reuses the same vocabulary as at-rest verification
    /// (`RowLength`, `SummaryMismatch`, `MissingRow`), so without this
    /// wrapper a rejected commit would classify as a poisoned store and tell
    /// a supervisor to tear down a healthy session.
    BatchRejected(Box<StoreError>),
    /// The VM reported that its own state is wrong
    /// (`ironhorse_vm::Halt::EngineInvariant` or `Halt::Panic`), or a lazy
    /// fault found the store borrowed for a commit (a checkpoint that
    /// walked a page it never faulted). Never a refusal: the machine
    /// cannot be trusted to continue.
    EngineInvariant(String),
    /// A decode/validation failure in the shared snapshot vocabulary
    /// (version, signature, cost-table, corrupt payload).
    Snapshot(SnapshotError),
    /// The geometry promises a row the store cannot produce — a missing
    /// slot page or chunk extent, named by kind and index.
    MissingRow(&'static str, u32),
    /// A row exists but its length disagrees with the geometry.
    RowLength {
        kind: &'static str,
        index: u32,
        expected: usize,
        found: usize,
    },
    /// A commit whose epoch does not advance the stored epoch by
    /// exactly one (or does not start at 1 on an empty store) — the
    /// split-brain / replayed-batch guard.
    EpochMismatch { expected: u64, found: u64 },
    /// A commit whose `prev_token` does not match the stored manifest's
    /// [`CommitToken`], or a session whose recorded token no longer
    /// matches the store — an equal-epoch fork, copy, or foreign store that
    /// a bare epoch counter cannot distinguish. Also raised by
    /// [`HeapStore::replace_for_migration`] when the durable manifest is no
    /// longer the one the migration read, and by [`migrate_store`] when the
    /// handle it reads through shows another. The values are token hex, or
    /// a manifest's schema, epoch and token. Classified
    /// [`StoreFailure::Refused`].
    BaselineMismatch { expected: String, found: String },
    /// A first (full-write) checkpoint was aimed at a store that
    /// already holds an epoch. Adopting existing content is the resume
    /// path's job; silently overwriting it would discard a heap.
    NotEmpty { epoch: u64 },
    /// A decodable store written by an OLDER supported schema that
    /// has not been migrated yet — the open paths run
    /// [`migrate_store`] and never surface this; a read-only caller
    /// that cannot migrate reports it by name.
    NeedsMigration { found: u32 },
    /// A stored page-edge summary vector whose length disagrees with
    /// the manifest geometry. Refused before any reachability decision
    /// is made from the summaries: the partial collector FREES pages
    /// based on them, so a short vector (a truncated table) must fail
    /// closed rather than read as "no outgoing edges".
    SummaryCount { expected: u32, found: u32 },
    /// A page-edge summary disagrees with the page row it describes (or a
    /// summary travels without its row / a row without its summary). A
    /// debug build's commit recomputes every traveling summary from the
    /// row's records, and the full validator every stored one — the
    /// summaries must stay a pure function of row content, or the
    /// collector's stored reachability diverges from the heap it frees
    /// from.
    SummaryMismatch { page: u32 },
}

/// What a caller holding a [`StoreError`] should do about it.
///
/// A supervisor at the daemon seam has exactly three responses available, and
/// before this classifier existed it could not tell them apart: every store
/// failure arrived as one opaque string (review finding F157). The variant
/// alone is not enough either — a caller would have to re-derive this table
/// from every variant and keep it in step by hand.
///
/// Classification is a property of the failure, not of the caller, so it lives
/// beside the variants and [`StoreError::classify`] is an exhaustive match: a
/// new variant does not compile until it states its answer.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum StoreFailure {
    /// The medium failed and the same call may succeed later: I/O. This is
    /// the only class for which a retry is meaningful — but see
    /// [`StoreError::Io`], which cannot yet separate a permanent medium
    /// failure from a retryable one, so bound the retries.
    Transient,
    /// A deterministic refusal: the answer will not change on its own.
    /// Either a gate the caller has to satisfy (quiesce, migrate, adopt
    /// rather than overwrite), an identity that will never match this engine,
    /// or a malformed request. Retrying is a busy-loop.
    ///
    /// [`StoreError::Empty`] lands here and is often not a failure at all —
    /// a fresh store answering "nothing yet". A caller that can create one
    /// should test for it by variant rather than by class.
    Refused,
    /// The stored state contradicts itself, so nothing read from it can be
    /// trusted: a container that will not parse, a geometry that promises rows
    /// the store cannot produce, page summaries that disagree with the rows
    /// they travel beside. Tear the session down rather than resume; a partial
    /// read is the failure mode this class exists to prevent.
    Poisoned,
}

impl StoreError {
    /// How a caller should respond to this failure. See [`StoreFailure`].
    pub fn classify(&self) -> StoreFailure {
        match self {
            // The medium, and only the medium. A capability the backend does
            // not have is `Unsupported`, not this.
            StoreError::Io(_) => StoreFailure::Transient,

            // Gates the caller can satisfy, and identities that will not
            // change: deterministic either way.
            StoreError::MachineNotQuiescent
            | StoreError::MachineOperation(_)
            | StoreError::PendingStateUnsupported { .. }
            | StoreError::Empty
            | StoreError::Unsupported(_)
            | StoreError::EpochMismatch { .. }
            | StoreError::BaselineMismatch { .. }
            | StoreError::NotEmpty { .. }
            | StoreError::NeedsMigration { .. } => StoreFailure::Refused,

            // The caller's request was malformed. The inner error names which
            // check failed, but the store itself is uninvolved, so the class
            // is the wrapper's and not the inner error's.
            StoreError::BatchRejected(_) => StoreFailure::Refused,

            // The store's own content disagrees with itself.
            StoreError::MissingRow(_, _)
            | StoreError::RowLength { .. }
            | StoreError::SummaryCount { .. }
            | StoreError::SummaryMismatch { .. }
            | StoreError::EngineInvariant(_) => StoreFailure::Poisoned,

            // A decode failure splits the same way one level down: structural
            // damage poisons, a compatibility answer refuses. `VersionError`
            // splits again for the same reason — a truncated `VERS` atom is
            // damage, a version this engine will not read is an answer.
            StoreError::Snapshot(e) => match e {
                SnapshotError::Atom(_)
                | SnapshotError::Signature(_)
                | SnapshotError::MissingAtom(_)
                | SnapshotError::Corrupt(_) => StoreFailure::Poisoned,
                SnapshotError::Version(v) => {
                    use crate::format::VersionError as V;
                    match v {
                        V::Truncated | V::TrailingBytes => StoreFailure::Poisoned,
                        V::NotIronhorse(_)
                        | V::UnsupportedVersion(_)
                        | V::SlotWidthMismatch { .. }
                        | V::UnsupportedEndian(_) => StoreFailure::Refused,
                    }
                }
                SnapshotError::BootLayoutMismatch { .. }
                | SnapshotError::SignatureMismatch { .. }
                | SnapshotError::CostTableMismatch { .. } => StoreFailure::Refused,
            },
        }
    }
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::MachineNotQuiescent => {
                write!(f, "machine is not at a quiescent crank boundary")
            }
            StoreError::MachineOperation(what) => write!(f, "machine operation failed: {what}"),
            StoreError::PendingStateUnsupported { row } => {
                write!(f, "heap holds live {row}: that side table does not travel")
            }
            StoreError::Empty => write!(f, "store has no committed epoch"),
            StoreError::Io(what) => write!(f, "store io error: {what}"),
            StoreError::Unsupported(what) => write!(f, "backend cannot {what}"),
            StoreError::BatchRejected(inner) => write!(f, "commit batch rejected: {inner}"),
            StoreError::EngineInvariant(what) => {
                write!(f, "engine invariant violated: {what}")
            }
            StoreError::Snapshot(e) => write!(f, "store snapshot error: {e}"),
            StoreError::MissingRow(kind, index) => {
                write!(f, "store is missing {kind} row {index}")
            }
            StoreError::RowLength {
                kind,
                index,
                expected,
                found,
            } => write!(
                f,
                "{kind} row {index} is {found} bytes, geometry promises {expected}"
            ),
            // Neutral about which actor holds which value, for the same
            // reason as `BaselineMismatch` below: `check_epoch`
            // (`store.rs`) expects the store's next epoch and finds the
            // batch's, while `checkpoint_to_store_core` (`machine.rs:884`)
            // expects the SESSION's and finds the STORE's. Naming sides
            // would be right at one site and reversed at the other.
            StoreError::EpochMismatch { expected, found } => {
                write!(f, "epoch mismatch: expected {expected}, found {found}")
            }
            // Deliberately neutral about WHICH side is which. The
            // construction sites agree that `expected` is the value the
            // caller required and `found` is the value it met, but they do
            // not agree on whose value that is: at the checkpoint's pairing
            // the expectation is a session's tracked token and the finding
            // is the store's, and at the commit's succession check the
            // expectation is the store's and the finding is the batch's.
            // Naming a side here would be right at some sites and actively
            // misleading at others.
            StoreError::BaselineMismatch { expected, found } => {
                write!(f, "baseline mismatch: expected {expected}, found {found}")
            }
            StoreError::NotEmpty { epoch } => write!(
                f,
                "first checkpoint aimed at a store already holding epoch {epoch}"
            ),
            StoreError::NeedsMigration { found } => {
                write!(f, "store schema {found} needs migration before use")
            }
            StoreError::SummaryCount { expected, found } => write!(
                f,
                "page-edge summary vector holds {found} entries, geometry promises {expected}"
            ),
            StoreError::SummaryMismatch { page } => {
                write!(f, "page {page}'s edge summary disagrees with its row")
            }
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            StoreError::Snapshot(e) => Some(e),
            StoreError::BatchRejected(e) => Some(e.as_ref()),
            _ => None,
        }
    }
}

impl From<SnapshotError> for StoreError {
    fn from(e: SnapshotError) -> Self {
        StoreError::Snapshot(e)
    }
}

/// The per-epoch store header: the snapshot gates plus the paging
/// geometry. Rewritten whole on every commit (it is tiny); the
/// geometry names how many rows the store must hold, and every count
/// derives from `slot_count`/`chunk_len` via [`slot_page_count`] /
/// [`chunk_extent_count`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoreManifest {
    /// The shared snapshot format discriminator (ironhorse magic, format
    /// version, slot record width, endianness) — the `VERS` gate.
    pub version: Version,
    /// The store schema version ([`STORE_SCHEMA_VERSION`]) — page
    /// geometry and manifest/small-state layout.
    pub store_schema: u32,
    /// The host callback-table signature — the `SIGN` gate.
    pub signature: Signature,
    /// Machine creation parameters — the `CREA` payload.
    pub creation: CreationParams,
    /// Total slot records (live and free alike) — the `HEAP` record
    /// count. Monotone: the slot arena never shrinks its record array.
    pub slot_count: u32,
    /// Live slot count (`currentHeapCount`).
    pub slot_live: u32,
    /// Chunk-arena byte length. May shrink across a GC compaction.
    pub chunk_len: u64,
    /// Total free-list entries: the free list
    /// lives in dirty-diffed segment rows, and this is their geometry
    /// the same way `slot_count` is the pages'.
    pub free_len: u32,
    /// The checkpoint generation. 0 never appears in a committed
    /// manifest; the first commit is epoch 1.
    pub epoch: u64,
    /// Total COMPLETED cranks this store has absorbed (store schema 8).
    ///
    /// The cadence schedule is derived from THIS, not from a session
    /// counter, which is what makes it resume-invariant: a replica that
    /// suspends mid-window resumes with the same absolute count and so
    /// collects after exactly the same cranks as one that never
    /// suspended. A session-local counter reset by `open()` would change
    /// collection timing after resume and could change the durable heap
    /// even when per-crank results and computrons still agree.
    ///
    /// Absolute rather than "since the last collection" so the schedule
    /// cannot drift: two replicas at the same crank total agree on
    /// whether a collection is due, whatever their suspend histories.
    /// Advanced by exactly the number of cranks a commit makes durable,
    /// so `epoch` counts checkpoints and this counts cranks — they
    /// coincide only at `checkpoint_every: 1`.
    ///
    /// Reads 0 from a schema-7 store, which is correct: such a store
    /// predates the counter, and 0 is where a fresh one starts.
    pub cranks: u64,
    /// Replica-visible collection interval; zero disables scheduled collection.
    pub collect_every: u32,
    /// Successful durable collection events, including explicit collections.
    pub collections: u64,
    /// The token of the commit that wrote this manifest (schema 36). Each
    /// batch names the token of the store state it was built on, and
    /// [`check_succession`] pairs the two by equality, so a session cannot
    /// commit into a copy that has since diverged, or into another store at
    /// its own epoch: an epoch number alone cannot tell those apart. The
    /// token says nothing about the content; the store-seam design's trust
    /// model trusts the content. A manifest of an older schema reads its
    /// token from the first half of the commit seal it carried.
    pub token: CommitToken,
}

/// A commit's pairing token: 16 random bytes, minted for every commit
/// (epoch 1 included) by whoever builds its batch, recorded in the
/// manifest, and named by the next batch as its predecessor. A committed
/// token is never zero and never equal to the one before it. It replaced
/// the commit seal's one job that was not about tampering: pairing a
/// session with the store state its batch was built on. Byte-identical
/// copies of a store share their token and still pair; a copy that has
/// taken a commit of its own does not.
#[derive(Copy, Clone, Default, PartialEq, Eq, Hash)]
pub struct CommitToken(pub [u8; 16]);

impl CommitToken {
    /// The predecessor of a store's first commit.
    pub const ZERO: CommitToken = CommitToken([0; 16]);

    /// Whether this is [`Self::ZERO`], which no commit may carry.
    pub fn is_zero(&self) -> bool {
        self.0 == [0; 16]
    }

    /// Lowercase hex, 32 characters.
    pub fn to_hex(&self) -> String {
        let mut s = String::with_capacity(32);
        for b in self.0 {
            s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
            s.push(char::from_digit((b & 0xf) as u32, 16).unwrap());
        }
        s
    }

    /// The token an older-schema manifest carries: the first 16 bytes of
    /// its hex commit seal. A store written before schema 36 always has a
    /// seal of at least that length.
    fn from_legacy_seal(seal: &str) -> Result<CommitToken, StoreError> {
        let digits = seal.as_bytes();
        if digits.len() < 32 {
            return Err(SnapshotError::Corrupt("store manifest seal shorter than a token").into());
        }
        let nibble = |c: u8| -> Result<u8, StoreError> {
            (c as char)
                .to_digit(16)
                .map(|d| d as u8)
                .ok_or(SnapshotError::Corrupt("store manifest seal not hex").into())
        };
        let mut token = [0u8; 16];
        for (i, byte) in token.iter_mut().enumerate() {
            *byte = (nibble(digits[2 * i])? << 4) | nibble(digits[2 * i + 1])?;
        }
        Ok(CommitToken(token))
    }

    /// The seal an older-schema manifest is written with when this build
    /// encodes one (test and tooling fixtures): the token's hex, padded to
    /// a seal's 64 characters, which [`Self::from_legacy_seal`] reads back.
    fn to_legacy_seal(self) -> String {
        let mut seal = self.to_hex();
        seal.push_str(&"0".repeat(32));
        seal
    }
}

impl std::fmt::Debug for CommitToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CommitToken({})", self.to_hex())
    }
}

impl std::fmt::Display for CommitToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.to_hex())
    }
}

/// Where commit tokens come from. The default, [`RandomTokens`], draws them
/// from randomly keyed hasher state; tests inject their own.
///
/// The pairing of a session with its store is token equality, so tokens
/// must be distinct across every store state a session could be pointed
/// at, not just from their predecessor: a source that repeats itself on two
/// copies of a store lets a session commit to the copy it did not read.
pub trait CommitTokenSource {
    /// The next token. [`mint_token`] refuses zero and the predecessor, and
    /// draws again.
    fn next_token(&mut self) -> CommitToken;
}

/// The default [`CommitTokenSource`]: 128 bits from two SipHash states
/// keyed from the operating system's randomness (the standard library's
/// `RandomState`, whose keys are drawn per thread and advanced at every
/// use), over a process-wide counter, the process id and the clock. Tokens
/// need to be distinct, not secret.
#[derive(Clone, Copy, Debug, Default)]
pub struct RandomTokens;

impl CommitTokenSource for RandomTokens {
    fn next_token(&mut self) -> CommitToken {
        use std::hash::{BuildHasher, Hasher};
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let state = std::collections::hash_map::RandomState::new();
        let mut halves = [0u64; 2];
        for (lane, half) in halves.iter_mut().enumerate() {
            let mut h = state.build_hasher();
            h.write_u64(count);
            h.write_u128(nanos);
            h.write_u32(std::process::id());
            h.write_usize(lane);
            *half = h.finish();
        }
        let mut token = [0u8; 16];
        token[..8].copy_from_slice(&halves[0].to_be_bytes());
        token[8..].copy_from_slice(&halves[1].to_be_bytes());
        CommitToken(token)
    }
}

/// Mint the token of a commit whose predecessor is `prev`: nonzero and
/// distinct from `prev`. A source that keeps returning either is broken,
/// and this panics rather than spin on it: [`RandomTokens`] cannot, and
/// an injected source is test tooling.
pub fn mint_token(source: &mut dyn CommitTokenSource, prev: CommitToken) -> CommitToken {
    for _ in 0..64 {
        let token = source.next_token();
        if !token.is_zero() && token != prev {
            return token;
        }
    }
    panic!("commit token source keeps returning zero or the predecessor");
}

/// Slot pages a `slot_count`-record arena occupies (the last page may
/// be partial).
pub fn slot_page_count(slot_count: u32) -> u32 {
    slot_count.div_ceil(SLOTS_PER_PAGE)
}

/// Chunk extents a `chunk_len`-byte arena occupies (the last extent
/// may be partial).
pub fn chunk_extent_count(chunk_len: u64) -> u32 {
    let per = CHUNK_EXTENT_BYTES as u64;
    u32::try_from(chunk_len.div_ceil(per)).unwrap_or(u32::MAX)
}

/// The record count of slot page `page` under `slot_count` (the last
/// page's remainder, [`SLOTS_PER_PAGE`] otherwise; 0 past the end).
pub fn slot_page_len(slot_count: u32, page: u32) -> usize {
    let start = (page as u64) * (SLOTS_PER_PAGE as u64);
    let end = ((page as u64) + 1) * (SLOTS_PER_PAGE as u64);
    let count = slot_count as u64;
    (count.min(end).saturating_sub(start)) as usize
}

/// The byte length of chunk extent `ext` under `chunk_len`.
pub fn chunk_extent_len(chunk_len: u64, ext: u32) -> usize {
    let per = CHUNK_EXTENT_BYTES as u64;
    let start = (ext as u64) * per;
    let end = ((ext as u64) + 1) * per;
    (chunk_len.min(end).saturating_sub(start)) as usize
}

impl StoreManifest {
    /// Serialize the manifest. Layout, all multi-byte fields
    /// big-endian: the 10-byte `VERS` payload, `store_schema` (u32),
    /// signature (u32 length + bytes), the 8-byte `CREA` payload,
    /// `slot_count` (u32), `slot_live` (u32), `chunk_len` (u64),
    /// `free_len` (u32), `epoch` (u64), `cranks` (u64), `collect_every`
    /// (u32), `collections` (u64) and the 16-byte commit token.
    ///
    /// A manifest stamped with an older schema encodes that schema's
    /// layout, the root and seal strings in place of the token (an empty
    /// root, and a seal [`CommitToken::to_legacy_seal`] reads back), with
    /// each schema's tail fields: this build writes one only for test and
    /// tooling fixtures that stand in for an older store.
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(&self.version.encode());
        v.extend_from_slice(&self.store_schema.to_be_bytes());
        let sig = self.signature.encode();
        v.extend_from_slice(&(sig.len() as u32).to_be_bytes());
        v.extend_from_slice(&sig);
        v.extend_from_slice(&self.creation.encode());
        v.extend_from_slice(&self.slot_count.to_be_bytes());
        v.extend_from_slice(&self.slot_live.to_be_bytes());
        v.extend_from_slice(&self.chunk_len.to_be_bytes());
        v.extend_from_slice(&self.free_len.to_be_bytes());
        v.extend_from_slice(&self.epoch.to_be_bytes());
        if self.store_schema >= 36 {
            v.extend_from_slice(&self.cranks.to_be_bytes());
            v.extend_from_slice(&self.collect_every.to_be_bytes());
            v.extend_from_slice(&self.collections.to_be_bytes());
            v.extend_from_slice(&self.token.0);
            return v;
        }
        // The legacy layout: an empty root, then the seal.
        v.extend_from_slice(&0u32.to_be_bytes());
        let seal = self.token.to_legacy_seal();
        v.extend_from_slice(&(seal.len() as u32).to_be_bytes());
        v.extend_from_slice(seal.as_bytes());
        // Schema 8 tail, appended AFTER the seal and ONLY when the
        // stamp says 8 — symmetric with the decoder, which reads it
        // under the same condition.
        if self.store_schema >= 8 {
            v.extend_from_slice(&self.cranks.to_be_bytes());
        }
        if self.store_schema >= 27 {
            v.extend_from_slice(&self.collect_every.to_be_bytes());
            v.extend_from_slice(&self.collections.to_be_bytes());
            // An empty parent seal.
            v.extend_from_slice(&0u32.to_be_bytes());
        }
        v
    }

    /// Decode a manifest, enforcing the ironhorse `VERS` gate and the
    /// store schema version. Fails closed on truncation; the signature
    /// length is bounds-checked before any reservation (the
    /// malformed-count discipline).
    pub fn decode(p: &[u8]) -> Result<StoreManifest, StoreError> {
        if p.len() < 10 {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest truncated",
            )));
        }
        let version = Version::decode(&p[0..10]).map_err(SnapshotError::Version)?;
        let mut i = 10usize;
        let take4 = |i: &mut usize| -> Result<[u8; 4], StoreError> {
            if *i + 4 > p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store manifest truncated",
                )));
            }
            let a = [p[*i], p[*i + 1], p[*i + 2], p[*i + 3]];
            *i += 4;
            Ok(a)
        };
        let take8 = |i: &mut usize| -> Result<[u8; 8], StoreError> {
            if *i + 8 > p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store manifest truncated",
                )));
            }
            let mut a = [0u8; 8];
            a.copy_from_slice(&p[*i..*i + 8]);
            *i += 8;
            Ok(a)
        };
        let store_schema = u32::from_be_bytes(take4(&mut i)?);
        if !(STORE_SCHEMA_MIN_SUPPORTED..=STORE_SCHEMA_VERSION).contains(&store_schema) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "unsupported store schema version",
            )));
        }
        let sig_len = u32::from_be_bytes(take4(&mut i)?) as usize;
        let sig_end = i
            .checked_add(sig_len)
            .filter(|&end| end <= p.len())
            .ok_or(SnapshotError::Corrupt("store manifest signature truncated"))?;
        let signature = Signature::decode(&p[i..sig_end]).map_err(SnapshotError::Signature)?;
        i = sig_end;
        let crea_hi = take4(&mut i)?;
        let crea_lo = take4(&mut i)?;
        let mut crea = [0u8; 8];
        crea[0..4].copy_from_slice(&crea_hi);
        crea[4..8].copy_from_slice(&crea_lo);
        let creation = CreationParams::decode(&crea)?;
        let slot_count = u32::from_be_bytes(take4(&mut i)?);
        let slot_live = u32::from_be_bytes(take4(&mut i)?);
        let chunk_len = u64::from_be_bytes(take8(&mut i)?);
        // A chunk offset is a u32, so no arena this format describes is
        // longer. This is only the coarse bound; open's tail-row check
        // ties the length to the stored rows before a lazy arena is sized
        // from it.
        if chunk_len > u64::from(u32::MAX) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest chunk length exceeds the chunk offset space",
            )));
        }
        let free_len = u32::from_be_bytes(take4(&mut i)?);
        let epoch = u64::from_be_bytes(take8(&mut i)?);
        if store_schema >= 36 {
            let cranks = u64::from_be_bytes(take8(&mut i)?);
            let collect_every = u32::from_be_bytes(take4(&mut i)?);
            let collections = u64::from_be_bytes(take8(&mut i)?);
            let mut token = [0u8; 16];
            token[..8].copy_from_slice(&take8(&mut i)?);
            token[8..].copy_from_slice(&take8(&mut i)?);
            if i != p.len() {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store manifest trailing bytes",
                )));
            }
            return Ok(StoreManifest {
                version,
                store_schema,
                signature,
                creation,
                slot_count,
                slot_live,
                chunk_len,
                free_len,
                epoch,
                cranks,
                collect_every,
                collections,
                token: CommitToken(token),
            });
        }
        // An older schema's layout, read for migration: the root and the
        // parent seal are dropped, and the seal yields the token.
        let root_len = u32::from_be_bytes(take4(&mut i)?) as usize;
        let root_end = i
            .checked_add(root_len)
            .filter(|&end| end <= p.len())
            .ok_or(SnapshotError::Corrupt("store manifest root truncated"))?;
        std::str::from_utf8(&p[i..root_end])
            .map_err(|_| SnapshotError::Corrupt("store manifest root not utf8"))?;
        i = root_end;
        let seal_len = u32::from_be_bytes(take4(&mut i)?) as usize;
        let seal_end = i
            .checked_add(seal_len)
            .filter(|&end| end <= p.len())
            .ok_or(SnapshotError::Corrupt("store manifest seal truncated"))?;
        let seal = std::str::from_utf8(&p[i..seal_end])
            .map_err(|_| SnapshotError::Corrupt("store manifest seal not utf8"))?
            .to_string();
        i = seal_end;
        // Schema 8 added the completed-crank counter as a tail field.
        // An older store simply does not carry it, and 0 is the right
        // reading: it predates the counter, and 0 is where a fresh
        // store starts — so a migrated store's schedule begins from the
        // migration rather than from a number it never recorded.
        let cranks = if store_schema >= 8 {
            u64::from_be_bytes(take8(&mut i)?)
        } else {
            0
        };
        let (collect_every, collections) = if store_schema >= 27 {
            let every = u32::from_be_bytes(take4(&mut i)?);
            let collections = u64::from_be_bytes(take8(&mut i)?);
            let len = u32::from_be_bytes(take4(&mut i)?) as usize;
            let end = i
                .checked_add(len)
                .ok_or(SnapshotError::Corrupt("manifest parent seal length"))?;
            let bytes = p
                .get(i..end)
                .ok_or(SnapshotError::Corrupt("manifest parent seal truncated"))?;
            std::str::from_utf8(bytes)
                .map_err(|_| SnapshotError::Corrupt("manifest parent seal not utf8"))?;
            i = end;
            (every, collections)
        } else {
            (0, 0)
        };
        // The encoding is canonical: a manifest that decodes but carries
        // extra bytes is malformed, not forward-compatible — format
        // evolution goes through the schema version gate above.
        if i != p.len() {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest trailing bytes",
            )));
        }
        Ok(StoreManifest {
            version,
            store_schema,
            signature,
            creation,
            slot_count,
            slot_live,
            chunk_len,
            free_len,
            epoch,
            cranks,
            collect_every,
            collections,
            token: CommitToken::from_legacy_seal(&seal)?,
        })
    }
}

/// A page's outgoing edge summary: the sorted, deduplicated set of
/// pages its records reference (self-edges excluded — a page trivially
/// reaches itself). A pure function of the page's records, so stored
/// summaries are recomputable from content. `check_batch` requires each
/// supplied summary to match its accompanying page records.
pub fn derive_page_edges(page: u32, records: &[Slot]) -> Vec<u32> {
    let mut targets = std::collections::BTreeSet::new();
    for r in records {
        r.each_ref_slot(|t| {
            // NULL is a link terminator, not a page; recording it
            // would fabricate an edge to page u32::MAX / SLOTS_PER_PAGE.
            if t.is_null() {
                return;
            }
            let tp = t.0 / SLOTS_PER_PAGE;
            if tp != page {
                targets.insert(tp);
            }
        });
    }
    targets.into_iter().collect()
}

/// Reachability over the STORED page-edge summaries alone: BFS from
/// `roots` (page indices) through [`HeapStore::page_edges`], never
/// reading row content — GC-shaped questions as indexed queries.
pub fn reachable_pages(
    store: &dyn HeapStore,
    roots: impl IntoIterator<Item = u32>,
) -> Result<std::collections::BTreeSet<u32>, StoreError> {
    Ok(bfs_pages(&store.page_edges()?, roots))
}

/// The dense in-Rust BFS both [`reachable_pages`] and the
/// [`HeapStore::reachable_page_set`] default body share: roots are in
/// the result even when out of range (edgeless), matching the SQLite
/// backend's CTE semantics (parity-locked there).
pub(crate) fn bfs_pages(
    edges: &[Vec<u32>],
    roots: impl IntoIterator<Item = u32>,
) -> std::collections::BTreeSet<u32> {
    let mut seen = std::collections::BTreeSet::new();
    let mut work: Vec<u32> = roots.into_iter().collect();
    while let Some(p) = work.pop() {
        if !seen.insert(p) {
            continue;
        }
        if let Some(ts) = edges.get(p as usize) {
            for &t in ts {
                if !seen.contains(&t) {
                    work.push(t);
                }
            }
        }
    }
    seen
}

/// Free-list entries per stored segment: the free list is stored in
/// dirty-diffed segment rows,
/// so LIFO churn rewrites only the tail segment and per-commit
/// small-state bytes are O(1) in heap size.
pub const FREE_SEG_ENTRIES: u32 = 4096;

/// Segments a `free_len`-entry free list occupies.
pub fn free_seg_count(free_len: u32) -> u32 {
    free_len.div_ceil(FREE_SEG_ENTRIES)
}

/// Entry count of segment `seg` under `free_len`.
pub fn free_seg_len(free_len: u32, seg: u32) -> usize {
    let start = (seg as u64) * (FREE_SEG_ENTRIES as u64);
    let end = ((seg as u64) + 1) * (FREE_SEG_ENTRIES as u64);
    ((free_len as u64).min(end).saturating_sub(start)) as usize
}

/// Encode one free-list segment (big-endian u32 entries).
pub fn encode_free_seg(entries: &[u32]) -> Vec<u8> {
    let mut v = Vec::with_capacity(entries.len() * 4);
    for e in entries {
        v.extend_from_slice(&e.to_be_bytes());
    }
    v
}

/// Split a full free list into `(segment index, encoded bytes)` rows.
pub fn encode_all_free_segs(free: &[u32]) -> Vec<(u32, Vec<u8>)> {
    let n = free_seg_count(free.len() as u32);
    (0..n)
        .map(|seg| {
            let start = (seg * FREE_SEG_ENTRIES) as usize;
            let end = free.len().min(start + FREE_SEG_ENTRIES as usize);
            (seg, encode_free_seg(&free[start..end]))
        })
        .collect()
}

/// Tag a [`check_batch`] failure as the CALLER's, not the store's.
///
/// Batch validation reuses the at-rest vocabulary (`RowLength`,
/// `SummaryMismatch`, `MissingRow`), which read as a poisoned store when they
/// describe stored content. A rejected commit is a malformed request against a
/// healthy store, and a supervisor that cannot tell the two apart tears down a
/// session it should merely have refused.
fn reject_batch(e: StoreError) -> StoreError {
    // Already tagged: do not double-wrap.
    if matches!(e, StoreError::BatchRejected(_)) {
        return e;
    }
    StoreError::BatchRejected(Box::new(e))
}

/// The batch admission checks — the shared per-commit verification
/// every backend runs BEFORE persisting anything, so all three refuse
/// the same batches for the same reasons. The shared `commit_contract`
/// tests exercise these gates across backends:
///
/// 1. Row indices: every traveling row and page-edge summary lies inside
///    the batch's own geometry, since a backend writes rows by index.
/// 2. Grown-region presence: every row of a grown geometry region
///    (pages, extents, free segments alike) must travel in the batch
///    — O(grown), prior rows exist by induction.
/// 3. Row lengths against the batch's OWN manifest geometry, so a short
///    or long row is refused here rather than when a later resume or
///    fault reads it.
/// 4. Summary coupling (v5): page-edge summaries travel for EXACTLY
///    the traveling page rows, and in debug builds each is re-derived
///    from the row beside it ([`derive_page_edges`]); the full
///    validator re-derives every stored summary.
///
/// The prior geometry is the stored manifest's. The section payloads are
/// validated by [`check_succession`], once per commit.
pub fn check_batch(
    prior: Option<&StoreManifest>,
    batch: &CheckpointBatch,
) -> Result<(), StoreError> {
    let n_pages = slot_page_count(batch.manifest.slot_count) as usize;
    let n_exts = chunk_extent_count(batch.manifest.chunk_len) as usize;
    let n_frees = free_seg_count(batch.manifest.free_len) as usize;
    let [prior_pages_len, prior_exts_len, prior_frees_len] = prior.map_or([0, 0, 0], |prev| {
        [
            slot_page_count(prev.slot_count) as usize,
            chunk_extent_count(prev.chunk_len) as usize,
            free_seg_count(prev.free_len) as usize,
        ]
    });

    // Every traveling row inside the new geometry: a backend writes rows
    // by index, and one past the geometry would survive in the store
    // (the commit drops only rows past the new geometry's end, which is
    // exactly where such a row claims to be).
    for (kind, count, indices) in [
        (
            "slot page",
            n_pages,
            batch.slot_pages.iter().map(|(i, _)| *i).collect::<Vec<_>>(),
        ),
        (
            "chunk extent",
            n_exts,
            batch.chunk_extents.iter().map(|(i, _)| *i).collect(),
        ),
        (
            "free segment",
            n_frees,
            batch.free_segs.iter().map(|(i, _)| *i).collect(),
        ),
        (
            "page-edge summary",
            n_pages,
            batch.page_edges.iter().map(|(i, _)| *i).collect(),
        ),
    ] {
        if let Some(&index) = indices.iter().find(|&&i| i as usize >= count) {
            return Err(StoreError::MissingRow(kind, index));
        }
    }

    let batch_pages: std::collections::HashSet<u32> =
        batch.slot_pages.iter().map(|(p, _)| *p).collect();
    let batch_exts: std::collections::HashSet<u32> =
        batch.chunk_extents.iter().map(|(e, _)| *e).collect();
    let batch_frees: std::collections::HashSet<u32> =
        batch.free_segs.iter().map(|(f, _)| *f).collect();
    for page in prior_pages_len as u32..n_pages as u32 {
        if !batch_pages.contains(&page) {
            return Err(StoreError::MissingRow("slot page", page));
        }
    }
    for ext in prior_exts_len as u32..n_exts as u32 {
        if !batch_exts.contains(&ext) {
            return Err(StoreError::MissingRow("chunk extent", ext));
        }
    }
    for seg in prior_frees_len as u32..n_frees as u32 {
        if !batch_frees.contains(&seg) {
            return Err(StoreError::MissingRow("free segment", seg));
        }
    }

    // Boundary rows: the growth
    // checks above cover indexes the new geometry ADDS, but a total
    // (`slot_count`/`chunk_len`/`free_len`) that changes WITHIN an
    // existing row changes that row's geometry-derived length without
    // adding any index — a crafted batch could omit the affected tail
    // row and land a store whose retained row disagrees with its new
    // manifest (caught only at the next open). Require the prior tail
    // and the new tail of each class to travel whenever their
    // expected length changes between the prior and the new manifest.
    // Every legitimate producer already satisfies this: growth writes
    // the tail page, compaction rewrites the tail extent, free churn
    // ships the changed segments.
    if let Some(prev) = prior {
        fn require_boundaries(
            kind: &'static str,
            count0: u32,
            count1: u32,
            len0: impl Fn(u32) -> usize,
            len1: impl Fn(u32) -> usize,
            traveling: &std::collections::HashSet<u32>,
        ) -> Result<(), StoreError> {
            let check = |idx: u32| -> Result<(), StoreError> {
                if len0(idx) != len1(idx) && !traveling.contains(&idx) {
                    return Err(StoreError::MissingRow(kind, idx));
                }
                Ok(())
            };
            // The prior tail, when retained under the new geometry.
            if count0 > 0 && count0 - 1 < count1 {
                check(count0 - 1)?;
            }
            // The new tail, when it already existed under the prior
            // geometry (distinct from the prior tail).
            if count1 > 0 && count1 - 1 < count0 && count1 != count0 {
                check(count1 - 1)?;
            }
            Ok(())
        }
        require_boundaries(
            "slot page",
            slot_page_count(prev.slot_count),
            n_pages as u32,
            |i| slot_page_len(prev.slot_count, i),
            |i| slot_page_len(batch.manifest.slot_count, i),
            &batch_pages,
        )?;
        require_boundaries(
            "chunk extent",
            chunk_extent_count(prev.chunk_len),
            n_exts as u32,
            |e| chunk_extent_len(prev.chunk_len, e),
            |e| chunk_extent_len(batch.manifest.chunk_len, e),
            &batch_exts,
        )?;
        require_boundaries(
            "free segment",
            free_seg_count(prev.free_len),
            n_frees as u32,
            |s| free_seg_len(prev.free_len, s),
            |s| free_seg_len(batch.manifest.free_len, s),
            &batch_frees,
        )?;
    }

    for (i, bytes) in &batch.slot_pages {
        let expected = slot_page_len(batch.manifest.slot_count, *i) * SLOT_RECORD_BYTES;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "slot page",
                index: *i,
                expected,
                found: bytes.len(),
            });
        }
    }
    for (e, bytes) in &batch.chunk_extents {
        let expected = chunk_extent_len(batch.manifest.chunk_len, *e);
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "chunk extent",
                index: *e,
                expected,
                found: bytes.len(),
            });
        }
    }
    for (s, bytes) in &batch.free_segs {
        let expected = free_seg_len(batch.manifest.free_len, *s) * 4;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "free segment",
                index: *s,
                expected,
                found: bytes.len(),
            });
        }
    }

    let edge_pages: std::collections::HashSet<u32> =
        batch.page_edges.iter().map(|(p, _)| *p).collect();
    if let Some(&odd) = batch_pages.symmetric_difference(&edge_pages).next() {
        return Err(StoreError::SummaryMismatch { page: odd });
    }
    // Re-deriving each summary from its encoded rows guards the engine's
    // own derivation, which the checkpoint runs on the records in hand;
    // debug builds keep it, and `validate_store_content` re-derives every
    // stored summary.
    if cfg!(debug_assertions) {
        let rows_by_page: std::collections::HashMap<u32, &Vec<u8>> =
            batch.slot_pages.iter().map(|(p, b)| (*p, b)).collect();
        for (i, targets) in &batch.page_edges {
            let bytes = rows_by_page[i];
            let records = decode_slots(bytes).map_err(|_| {
                StoreError::Snapshot(SnapshotError::Corrupt("store slot page record"))
            })?;
            if derive_page_edges(*i, &records) != *targets {
                return Err(StoreError::SummaryMismatch { page: *i });
            }
        }
    }
    Ok(())
}

// Accumulate declarations in their historical order, which also determines
// derived Debug output. Codec ordering remains an independent roster policy.
macro_rules! define_small_state_chain {
    (($d:tt); $($section:ident => $next:ident, $(#[$attr:meta])* $field:ident: $ty:ty;)*) => {
        macro_rules! small_state_fields {
            $(($section; [$d ($d declared:tt)*]) => {
                small_state_fields!($next; [$d ($d declared)* $(#[$attr])* pub $field: $ty,]);
            };)*
            (End; [$d ($d declared:tt)*]) => {
                /// The whole-on-every-commit remainder of the machine state: the value
                /// stack, the slot free list, the key/name/symbol tables, the meter,
                /// and (store schema 7, the side-table ledger) the bulk side tables
                /// and `Symbol.for` registry. Each section reuses its atom payload
                /// encoding verbatim.
                #[derive(Clone, Debug, PartialEq)]
                pub struct SmallState { $d ($d declared)* }
            };
        }
        small_state_fields!(Stack; []);
    };
}
macro_rules! define_small_state {
    ($($section:ident {
        image_field: $field:ident,
        builder: $builder:ident,
        live: [$($live:tt)*],
        bounds: [$($bounds:tt)*],
        gate: [$($gate:tt)*],
        restore: [$($restore:tt)*],
        initialize: [$($next:ident; $(#[$attr:meta])* $init_field:ident: $ty:ty = $init:expr)?],
        $($rest:tt)*
    })*) => {
        define_small_state_chain!(($); $($($section => $next, $(#[$attr])* $init_field: $ty;)?) *);
    };
}
crate::snapshot_roster::snapshot_payloads!(define_small_state);

impl SmallState {
    /// Encode the 32 payloads separately, without framing, in
    /// the fixed order stack, free list, keys, names, symbols, meter,
    /// arrays, collections, registry, errors, buffers, typed arrays,
    /// data views, wrappers, regexps, arguments brands, temporal,
    /// intl, name floor, iterators, dates, function state, proxy state,
    /// accessors, Intl bound functions, private elements, disposable stacks,
    /// generators, error frames, promises, async instances, and index properties
    /// (arrays/collections/registry since store schema 7 — the
    /// side-table ledger; the 6→7 migration appends them empty, a
    /// pure 12-byte suffix — errors since schema 9, the typed-array
    /// family since schema 10, the data-only language rows since
    /// schema 11, the Intl record tables plus the installed-names
    /// floor since schema 12, and the iterator cursors since schema
    /// 13, Date records since schema 14, and retained function state
    /// since schema 15, and proxy state since schema 16, whose
    /// migrations append their empty sections the same; accessors join
    /// in schema 17, Intl bound functions in schema 18, and private
    /// elements in schema 19, disposable stacks in schema 20,
    /// synchronous generators in schema 21, error frames in schema 22,
    /// the promise cluster in schema 23, and async activations in schema 24
    /// the same way). Since store schema v4 the free-list section is
    /// always EMPTY in stored small state — the list lives in
    /// dirty-diffed segment rows — but the section slot
    /// stays so the layout is stable; the atom container path still
    /// carries the list via the image, not this encoding.
    pub fn encode_sections(&self) -> [Vec<u8>; 32] {
        crate::store_sections::SmallSection::ALL.map(|section| self.encode_section(section))
    }

    pub fn encode_section(&self, section: crate::store_sections::SmallSection) -> Vec<u8> {
        #[cfg(test)]
        crate::machine::extraction_counts::encode(section);
        crate::snapshot_roster::encode_payload(self, section)
    }

    /// Encode all section payloads with the legacy framing, byte-for-byte.
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::new();
        for s in self.encode_sections() {
            v.extend_from_slice(&(s.len() as u32).to_be_bytes());
            v.extend_from_slice(&s);
        }
        v
    }

    /// Decode the sections, in the order the encoder appends them. Every
    /// section length is
    /// bounds-checked against the remaining payload before it is
    /// sliced.
    pub fn decode(p: &[u8]) -> Result<SmallState, StoreError> {
        let small = Self::decode_legacy(p)?;
        if small.encode() != p {
            return Err(SnapshotError::Corrupt("non-canonical small state").into());
        }
        Ok(small)
    }

    fn decode_legacy(p: &[u8]) -> Result<SmallState, StoreError> {
        crate::snapshot_roster::decode_legacy_payloads(p)
    }
}

/// One atomic checkpoint: the full manifest, full or sparse small-state
/// sections, and only the **dirty** slot pages and chunk extents, already
/// encoded. `commit` applies all of it or none of it, and drops any
/// stored row beyond the new geometry (a chunk arena may shrink across
/// a GC compaction; stale rows must not survive to satisfy a later,
/// larger geometry).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointBatch {
    /// The commit token of the store state this batch was computed
    /// against ([`CommitToken::ZERO`] for the epoch-1 full write into an
    /// empty store). Every backend refuses a batch whose `prev_token`
    /// differs from the stored manifest's token ([`check_succession`]).
    /// The batch's own token rides in its manifest.
    pub prev_token: CommitToken,
    pub manifest: StoreManifest,
    /// Full encoded [`SmallState`] when `small_updates` is absent.
    pub small: Vec<u8>,
    /// Sparse section replacements. When present, `small` must be empty.
    /// Omission preserves a section; an explicit empty payload replaces it.
    pub small_updates: Option<Vec<crate::store_sections::SectionUpdate>>,
    /// `(page index, encoded records)` for each dirty slot page.
    pub slot_pages: Vec<(u32, Vec<u8>)>,
    /// `(extent index, raw bytes)` for each dirty chunk extent.
    pub chunk_extents: Vec<(u32, Vec<u8>)>,
    /// `(segment index, encoded entries)` for each free-list segment the
    /// checkpoint may have changed: those from the arena's low-water mark
    /// on, so LIFO churn carries only the tail segment.
    pub free_segs: Vec<(u32, Vec<u8>)>,
    /// `(page index, sorted outgoing page targets)` for each dirty
    /// slot page — the **persisted page-edge summaries**:
    /// which pages this page's records reference. Derived purely from
    /// the page's records ([`derive_page_edges`]), committed with them,
    /// and the substrate for reachability-as-indexed-queries
    /// ([`reachable_pages`]) — a collector consulting them never
    /// faults row content.
    pub page_edges: Vec<(u32, Vec<u32>)>,
}

/// An admitted batch. Only the shared commit gate can construct this
/// token; backend hooks receive no batch until succession, geometry and
/// summaries have passed.
pub struct VerifiedCommit<'a> {
    batch: &'a CheckpointBatch,
}

impl<'a> VerifiedCommit<'a> {
    /// Consume admission, yielding the immutable batch.
    pub fn batch(self) -> &'a CheckpointBatch {
        self.batch
    }
}

/// A backend invokes this gate with its current manifest while holding its
/// transaction or exclusive commit access. The returned token is the only
/// way the hook obtains the batch it will persist.
pub type CommitVerifier<'a> =
    dyn FnMut(Option<&StoreManifest>) -> Result<VerifiedCommit<'a>, StoreError> + 'a;

/// Non-overridable checkpoint admission for every [`HeapStore`]. The blanket
/// implementation prevents backend implementations from replacing the gate.
pub trait HeapStoreCommit: HeapStore {
    /// Apply a checkpoint through the shared admission gauntlet. The backend
    /// supplies its baseline under commit isolation and only sees the batch
    /// after verification succeeds. Nothing stored is re-derived here: the
    /// store is trusted (the store-seam design's trust model), and the
    /// succession check pairs the batch with the stored state by its token.
    fn commit(&mut self, batch: &CheckpointBatch) -> Result<(), StoreError> {
        self.commit_verified(&mut |stored| {
            check_succession(stored, batch)?;
            check_batch(stored, batch).map_err(reject_batch)?;
            Ok(VerifiedCommit { batch })
        })
    }
}

impl<S: HeapStore + ?Sized> HeapStoreCommit for S {}

/// The keyed snapshot store: point reads by page/extent index and one
/// atomic batch commit. Implementations: [`MemoryStore`] (tests and
/// reference), [`crate::store_file::FileStore`] (single-file reference,
/// pure Rust), and the daemon-side SQLite backend (design § Crate and
/// dependency layout — deliberately outside this `forbid(unsafe_code)`
/// workspace).
///
/// Reads return the raw stored bytes; [`store_to_image`] and the
/// resume path decode them through the shared codecs, so a backend
/// never re-implements an encoding.
pub trait HeapStore {
    /// The current manifest, or [`StoreError::Empty`] before the first
    /// commit.
    fn manifest(&self) -> Result<StoreManifest, StoreError>;
    /// The encoded [`SmallState`] of the current epoch.
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError>;
    /// Fixed-size section hash inventory. Whole-state fallback is for reference
    /// backends; database backends override this without reading payloads.
    fn small_section_hashes(
        &self,
    ) -> Result<[[u8; 32]; crate::store_sections::SMALL_SECTION_COUNT], StoreError> {
        Ok(*crate::store_sections::SectionLeaves::from_payloads(
            &crate::store_sections::split_small_state(&self.read_small_state()?)?,
        )
        .hashes())
    }
    /// The raw bytes of slot page `page`.
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError>;
    /// The raw bytes of chunk extent `ext`.
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError>;
    /// Row lengths WITHOUT row contents, index-ordered: `(slot page
    /// byte lengths, chunk extent byte lengths)`. The metadata-scale
    /// validator ([`validate_store`]) checks the row inventory against
    /// this without O(heap) slot/chunk content I/O; backends serve it
    /// from metadata (directory entries, `length(bytes)` aggregates).
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError>;
    /// The raw bytes of free-list segment `seg`.
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError>;
    /// The stored page-edge summaries, index-ordered: one
    /// sorted target list per slot page. Metadata-scale; maintained by
    /// `commit` from the batch's `page_edges`.
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError>;
    /// Acquire commit isolation (or enforce a documented single-writer contract),
    /// invoke `verify` with the current manifest, then atomically persist
    /// the batch it admits. This hook has no raw batch argument, so it
    /// cannot accidentally skip the common verification step.
    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError>;
    /// How many page-edge summaries the store holds — the geometry
    /// gate the partial collector checks before deciding anything
    /// from the summaries (a truncated store must fail closed, not
    /// read as maximal garbage). Provided: counts the dense read;
    /// backends answer from metadata (the SQLite backend's
    /// `COUNT(*)`).
    fn summary_page_count(&self) -> Result<u32, StoreError> {
        Ok(self.page_edges()?.len() as u32)
    }
    /// Page reachability from `roots` over the stored summaries — the
    /// decision query of summary-driven partial collection. Provided:
    /// reads the whole edge set and BFSes in Rust (O(pages) transfer
    /// however small the answer). Backends with an indexed edge
    /// representation override it with a query whose transfer is
    /// proportional to the ANSWER — the SQLite backend serves it as a
    /// recursive CTE over its normalized pairs, with
    /// dense/CTE parity locked by test. Roots appear in the result
    /// even when out of range (they are edgeless), on both paths.
    fn reachable_page_set(
        &self,
        roots: &[u32],
    ) -> Result<std::collections::BTreeSet<u32>, StoreError> {
        Ok(bfs_pages(&self.page_edges()?, roots.iter().copied()))
    }

    /// Compare the backend's own derived indexes with the state they are
    /// derived from, for [`validate_store_content`]: the SQLite backend
    /// checks its normalized `edge_pairs` against the page-edge
    /// summaries. Provided: a backend that derives no index has nothing
    /// to compare.
    fn check_derived_indexes(&self) -> Result<(), StoreError> {
        Ok(())
    }

    /// Re-read the manifest from DURABLE state, bypassing any cached
    /// view this handle holds.
    ///
    /// [`migrate_store`] starts from this rather than from
    /// [`Self::manifest`]. Since `open()` stopped migrating, the gap
    /// between opening a store and upgrading it is caller-controlled and
    /// unbounded, so a handle that cached an old header at open can reach
    /// the ladder long after another handle upgraded the file. Reading
    /// durably instead, that handle sees the current schema and correctly
    /// reports nothing to do. A handle whose cached view is behind the
    /// durable manifest is refused before the migration reads from it, and
    /// [`Self::replace_for_migration`]'s comparison closes the remaining
    /// window.
    ///
    /// The default is [`Self::manifest`], which is exact for a backend
    /// that holds no cache — the in-memory and SQLite stores both read
    /// their state on every call. `FileStore`, which caches its header,
    /// overrides it.
    fn reread_manifest(&self) -> Result<StoreManifest, StoreError> {
        self.manifest()
    }

    /// [`migrate_store`]'s one write, and nothing else's: replace the
    /// stored manifest and small state with `to` and `small`, verbatim,
    /// and drop any row-leaf hashes an older schema kept. It bypasses
    /// succession, because a migration restamps unchanged rows.
    ///
    /// One atomic write, made only while the durable manifest still equals
    /// `from`, the one the migration read; otherwise it refuses with
    /// [`StoreError::BaselineMismatch`] and writes nothing, so a second
    /// handle's migration or commit in between is never overwritten. The
    /// small state is stored in `to`'s layout. The default refuses, so
    /// read-only or exotic backends stay honest.
    fn replace_for_migration(
        &mut self,
        from: &StoreManifest,
        to: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        let _ = (from, to, small);
        Err(StoreError::Unsupported("migrate a manifest in place"))
    }

    /// The subset of `targets` with at least one inbound edge from a
    /// page OUTSIDE `targets` — the generational collector's
    /// old-generation seed query (an un-dirtied page's stored edges
    /// are its current edges, so an inbound edge from one is a live
    /// retention path). Dense default reads the whole edge table;
    /// indexed backends answer from the reverse index with transfer
    /// proportional to the ANSWER.
    fn externally_referenced(&self, targets: &[u32]) -> Result<Vec<u32>, StoreError> {
        let tset: std::collections::BTreeSet<u32> = targets.iter().copied().collect();
        let edges = self.page_edges()?;
        let mut hit: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        for (page, outs) in edges.iter().enumerate() {
            if tset.contains(&(page as u32)) {
                continue;
            }
            for t in outs {
                if tset.contains(t) {
                    hit.insert(*t);
                }
            }
        }
        Ok(hit.into_iter().collect())
    }

    /// Reachability from `roots` RESTRICTED to the `within` set (the
    /// generational collector's dirty-region expansion: edges leaving
    /// the region land on old pages, which the generational pass
    /// never frees, so the walk stops at the region boundary). Roots
    /// outside `within` contribute nothing. Dense default; indexed
    /// backends can serve it with a bounded recursive query.
    fn reachable_within(
        &self,
        roots: &[u32],
        within: &[u32],
    ) -> Result<std::collections::BTreeSet<u32>, StoreError> {
        let wset: std::collections::BTreeSet<u32> = within.iter().copied().collect();
        let edges = self.page_edges()?;
        let mut seen: std::collections::BTreeSet<u32> = std::collections::BTreeSet::new();
        let mut frontier: Vec<u32> = roots.iter().copied().filter(|r| wset.contains(r)).collect();
        for &r in &frontier {
            seen.insert(r);
        }
        while let Some(p) = frontier.pop() {
            if let Some(outs) = edges.get(p as usize) {
                for &t in outs {
                    if wset.contains(&t) && seen.insert(t) {
                        frontier.push(t);
                    }
                }
            }
        }
        Ok(seen)
    }
}

/// Peek the meter's cost-table version from a small-state PREFIX: the
/// first six sections (stack, free list, keys, names, symbols, meter)
/// have held the same positions since schema 5, every ladder step
/// appends sections strictly AFTER them, and the peek never reads the
/// schema-variable tail — so it decodes identically under every
/// schema [`migrate_store`] supports. See the cost-table gate there.
fn peek_cost_table_version(p: &[u8]) -> Result<String, StoreError> {
    let mut i = 0usize;
    let mut read_small_section = |name: &'static str| -> Result<&[u8], StoreError> {
        if p.len() - i < 4 {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(name)));
        }
        let len = u32::from_be_bytes([p[i], p[i + 1], p[i + 2], p[i + 3]]) as usize;
        i += 4;
        // The wire length can exhaust usize on 32-bit targets.
        let end = match i.checked_add(len).filter(|&end| end <= p.len()) {
            Some(end) => end,
            None => return Err(StoreError::Snapshot(SnapshotError::Corrupt(name))),
        };
        let s = &p[i..end];
        i = end;
        Ok(s)
    };
    let _ = read_small_section("small state stack section")?;
    let _ = read_small_section("small state free-list section")?;
    let _ = read_small_section("small state keys section")?;
    let _ = read_small_section("small state names section")?;
    let _ = read_small_section("small state symbols section")?;
    let meter = MeterImage::decode(read_small_section("small state meter section")?)?;
    Ok(meter.cost_table_version)
}

/// Upgrade a decodable OLDER store in place to the current schema.
/// Returns true when a migration ran, false when the store was
/// already current (or empty). Forward only — open refuses anything
/// newer than current.
///
/// The ladder runs in memory, over the manifest and the small state (no
/// step touches a row), starting from the durable manifest
/// ([`HeapStore::reread_manifest`]). The result is checked against the
/// store's rows at the metadata scale ([`validate_store`]'s checks) and
/// then written once, through [`HeapStore::replace_for_migration`], which
/// refuses if the store moved since the migration read it and drops the
/// row-leaf hashes the old schema kept. The small state and rows come
/// through the handle, so a handle whose view is behind the durable
/// manifest (a `FileStore` another handle has written since it loaded) is
/// refused with [`StoreError::BaselineMismatch`] before anything is read.
/// A crash before that write leaves the store exactly as it was; a store
/// is never half migrated. The first commit token is the first half of the
/// seal the store carried ([`StoreManifest::token`]).
///
/// Restamping is authorized by the SAME callback-table signature the
/// resume path checks: a store whose signature is incompatible with
/// `expected_sig` is refused HERE, before any bytes change, so a
/// mis-pointed daemon can never one-way restamp a foreign store out
/// from under its rightful owner. Migration therefore lives with the
/// caller that knows the signature — the
/// raw `open()` no longer runs it — and this is the reason it takes
/// `expected_sig` rather than reading only the store.
pub fn migrate_store(
    store: &mut dyn HeapStore,
    expected_sig: &Signature,
) -> Result<bool, StoreError> {
    // DURABLE, not the handle's cached view: another handle may have
    // upgraded the store since this one opened it.
    let from = match store.reread_manifest() {
        Ok(m) => m,
        Err(StoreError::Empty) => return Ok(false),
        Err(e) => return Err(e),
    };
    from.signature.check_boot()?;
    expected_sig.check_boot()?;
    if from.store_schema == STORE_SCHEMA_VERSION {
        return Ok(false);
    }
    if !(STORE_SCHEMA_MIN_SUPPORTED..STORE_SCHEMA_VERSION).contains(&from.store_schema) {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "unsupported store schema version",
        )));
    }
    // Signature gate BEFORE the write: only a daemon that could actually
    // resume this store (compatible callback table) may upgrade it. An
    // incompatible signature fails closed with the same error the open
    // gates would raise, leaving the store's bytes untouched for its
    // rightful owner.
    if !from.signature.is_compatible_with(expected_sig) {
        return Err(StoreError::Snapshot(SnapshotError::SignatureMismatch {
            expected: expected_sig.clone(),
            found: from.signature.clone(),
        }));
    }
    // The small state and the rows come through the handle, which may
    // serve them from a view older than the durable manifest: the write
    // would then pair the durable rows with a stale small state.
    check_migration_baseline(&store.manifest()?, &from)?;
    // Cost-table gate BEFORE the write too: a store whose meter ran under
    // a different cost table can NEVER resume on this engine — open
    // refuses it after any migration — so restamping it forward would
    // wedge it: the new implementation still refuses it and the old one
    // no longer recognizes the schema. Refuse here, bytes untouched, with
    // the same error open would raise. The peek parses only the
    // small-state PREFIX (the first six sections, whose positions every
    // supported schema shares), so it works under the SOURCE schema
    // without decoding the schema-variable tail.
    let mut small = store.read_small_state()?;
    let cost = peek_cost_table_version(&small)?;
    if cost != COST_TABLE_VERSION {
        return Err(StoreError::Snapshot(SnapshotError::CostTableMismatch {
            expected: COST_TABLE_VERSION.to_string(),
            found: cost,
        }));
    }
    let mut manifest = from.clone();
    while manifest.store_schema < STORE_SCHEMA_VERSION {
        migrate_step(&mut manifest, &mut small)?;
    }
    // The one write happens only for a result that passes the
    // metadata-scale checks against the store's own rows.
    validate_state(&*store, manifest.clone(), &small, expected_sig)?;
    store.replace_for_migration(&from, &manifest, &small)?;
    Ok(true)
}

/// One ladder step, in memory: advance `manifest` and `small` by one
/// schema. Every step leaves the rows alone.
fn migrate_step(manifest: &mut StoreManifest, small: &mut Vec<u8>) -> Result<(), StoreError> {
    let schema = manifest.store_schema;
    match schema {
        // 5 → 6 changed only the retired root's formula.
        5 => {}
        // 7 → 8: the durable crank counter. 0 is the honest reading of a
        // store that predates it: a schedule derived from it begins at
        // the migration rather than pretending to a history it never
        // recorded.
        7 => manifest.cranks = 0,
        // 25 → 26: NAME entries become canonical XS CESU-8.
        25 => *small = names_to_cesu8(small)?,
        // 26 → 27: one canonical encoding of the small state.
        26 => *small = SmallState::decode_legacy(small)?.encode(),
        // 27 → 28 split the retired small-state leaf into sections over the
        // same payloads, and 28 through 35 are identity restamps (payloads
        // that an older schema could not carry are simply absent). 35 → 36
        // drops the root, the seal and the leaves, which the manifest
        // decode and `replace_for_migration` take care of.
        27..=35 => {}
        _ => match LADDER.iter().find(|&&(target, _)| target - 1 == schema) {
            Some(&(_, extra_len)) => small.resize(small.len() + extra_len, 0),
            None => {
                return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "unsupported store schema version",
                )))
            }
        },
    }
    manifest.store_schema = schema + 1;
    Ok(())
}

/// Target schema and empty-section suffix length for content-preserving steps.
/// Each section starts with a zero u32 byte length. These historical widths
/// must remain fixed even when the current small-state format grows.
const LADDER: &[(u32, usize)] = &[
    (7, 12),  // Side-table ledger: three sections.
    (9, 4),   // Error data.
    (10, 12), // Array buffers, typed arrays, and DataViews.
    (11, 16), // Wrappers, regexps, arguments, and template records.
    (12, 8),  // Intl records and installed-names floor.
    (13, 4),  // Iterator cursors.
    (14, 4),  // Date values.
    (15, 4),  // Retained callable metadata.
    (16, 4),  // Proxy slots and revoker links.
    (17, 4),  // Guest accessor mappings.
    (18, 4),  // Intl bound-function links.
    (19, 4),  // Private values and accessors.
    (20, 4),  // Resource-management stacks.
    (21, 4),  // Generator activations.
    (22, 4),  // Error frames.
    (23, 4),  // Promise cluster.
    (24, 4),  // Async activations.
    (25, 4),  // Indexed properties.
];

// Separate the address arithmetic from slicing so its usize boundary can be
// exercised without allocating an address-space-sized legacy snapshot.
fn name_migration_section_end(cursor: usize, len: usize) -> Result<usize, SnapshotError> {
    cursor
        .checked_add(len)
        .ok_or(SnapshotError::Corrupt("name migration length"))
}

/// The 25 → 26 step's small state: section 3, NAME, re-encoded as
/// canonical XS CESU-8, every other section byte for byte.
fn names_to_cesu8(small: &[u8]) -> Result<Vec<u8>, StoreError> {
    let mut cursor = 0usize;
    let mut new_small = Vec::new();
    for index in 0..4 {
        let header = small
            .get(cursor..cursor + 4)
            .ok_or(SnapshotError::Corrupt("name migration header"))?;
        let len = u32::from_be_bytes(header.try_into().unwrap()) as usize;
        cursor += 4;
        let end = name_migration_section_end(cursor, len)?;
        let section = small
            .get(cursor..end)
            .ok_or(SnapshotError::Corrupt("name migration body"))?;
        if index == 3 {
            let names: Vec<SymbolName> = decode_strings(section)?
                .into_iter()
                .map(SymbolName::from)
                .collect();
            let encoded = encode_names(&names);
            new_small.extend_from_slice(&(encoded.len() as u32).to_be_bytes());
            new_small.extend_from_slice(&encoded);
        } else {
            new_small.extend_from_slice(header);
            new_small.extend_from_slice(section);
        }
        cursor = end;
    }
    new_small.extend_from_slice(&small[cursor..]);
    Ok(new_small)
}

/// The succession discipline every [`HeapStoreCommit::commit`] enforces:
/// the first commit into an empty store is epoch 1 and names
/// [`CommitToken::ZERO`] as its predecessor; every later commit advances the
/// stored epoch by exactly one and names the stored token. A batch's own
/// token is nonzero and differs from its predecessor, so the next batch can
/// tell the two states apart. Anything else is a replayed or forked batch
/// and fails closed.
pub fn check_succession(
    stored: Option<&StoreManifest>,
    batch: &CheckpointBatch,
) -> Result<(), StoreError> {
    // The batch's own token is the caller's defect (a broken token source,
    // a hand-built batch), not the store's.
    if batch.manifest.token.is_zero() {
        return Err(reject_batch(
            SnapshotError::Corrupt("commit token must be nonzero").into(),
        ));
    }
    if batch.manifest.token == batch.prev_token {
        return Err(reject_batch(
            SnapshotError::Corrupt("commit token must differ from its predecessor").into(),
        ));
    }

    if let Some(previous) = stored {
        if previous.collect_every != batch.manifest.collect_every {
            return Err(SnapshotError::Corrupt("collection cadence mismatch").into());
        }
        if batch.manifest.cranks < previous.cranks
            || batch.manifest.collections < previous.collections
        {
            return Err(SnapshotError::Corrupt("durable counter regression").into());
        }
    }
    if let Some(prior) = stored {
        if prior.store_schema < STORE_SCHEMA_VERSION {
            return Err(StoreError::NeedsMigration {
                found: prior.store_schema,
            });
        }
        if prior.store_schema > STORE_SCHEMA_VERSION {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "unsupported store schema version",
            )));
        }
    }
    if batch.manifest.store_schema != STORE_SCHEMA_VERSION {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "checkpoint requires current store schema",
        )));
    }
    check_epoch(stored.map(|m| m.epoch), batch.manifest.epoch)?;
    // The pairing: a batch names the token of the store state it was
    // built on, compared by equality.
    let expected = stored.map_or(CommitToken::ZERO, |m| m.token);
    if batch.prev_token != expected {
        return Err(StoreError::BaselineMismatch {
            expected: expected.to_hex(),
            found: batch.prev_token.to_hex(),
        });
    }
    // The commit's one validation of the section payloads it writes:
    // each must decode and re-encode to itself, because resume refuses a
    // non-canonical one, so an engine bug here would otherwise write a
    // store its own resume cannot read.
    crate::store_sections::validate_batch(batch, stored.is_none())?;
    Ok(())
}

pub fn check_epoch(stored: Option<u64>, batch_epoch: u64) -> Result<(), StoreError> {
    // A decoded manifest may legally carry u64::MAX; an exhausted
    // epoch is corrupt input, not a wrap to epoch 0.
    let expected =
        match stored {
            None => 1,
            Some(e) => e.checked_add(1).ok_or(StoreError::Snapshot(
                crate::format::SnapshotError::Corrupt("store epoch exhausted"),
            ))?,
        };
    if batch_epoch != expected {
        return Err(StoreError::EpochMismatch {
            expected,
            found: batch_epoch,
        });
    }
    Ok(())
}

// --- image ↔ paged form ---

/// Split a flat record array into `(page, bytes)` rows for every page —
/// the full (epoch-1) batch shape. `checkpoint_to_store` produces dirty
/// subsets from the arena's dirty bitmap instead.
pub fn encode_all_slot_pages(slots: &[Slot]) -> Vec<(u32, Vec<u8>)> {
    let count = slots.len() as u32;
    let pages = slot_page_count(count);
    let mut out = Vec::with_capacity(pages as usize);
    for page in 0..pages {
        out.push((page, encode_slot_page(slots, page)));
    }
    out
}

/// Encode one slot page from the flat record array.
pub fn encode_slot_page(slots: &[Slot], page: u32) -> Vec<u8> {
    let count = slots.len() as u32;
    let len = slot_page_len(count, page);
    let start = (page * SLOTS_PER_PAGE) as usize;
    let mut bytes = Vec::with_capacity(len * SLOT_RECORD_BYTES);
    for slot in &slots[start..start + len] {
        encode_slot(slot, &mut bytes);
    }
    bytes
}

/// Split the chunk arena's raw bytes into `(extent, bytes)` rows for
/// every extent.
pub fn encode_all_chunk_extents(chunks: &[u8]) -> Vec<(u32, Vec<u8>)> {
    let len = chunks.len() as u64;
    let exts = chunk_extent_count(len);
    let mut out = Vec::with_capacity(exts as usize);
    for ext in 0..exts {
        out.push((ext, encode_chunk_extent(chunks, ext)));
    }
    out
}

/// Slice one chunk extent out of the arena's raw bytes.
pub fn encode_chunk_extent(chunks: &[u8], ext: u32) -> Vec<u8> {
    let len = chunk_extent_len(chunks.len() as u64, ext);
    let start = (ext as u64 * CHUNK_EXTENT_BYTES as u64) as usize;
    chunks[start..start + len].to_vec()
}

/// The full-write batch of a [`MachineImage`] at `epoch` — every page,
/// every extent. This is the first-checkpoint and
/// [`import_from_container`] shape; incremental batches are built by
/// the machine surface from dirty bits. The batch names `prev_token` as its
/// predecessor ([`CommitToken::ZERO`] for an empty store) and carries a
/// fresh token from [`RandomTokens`].
///
/// ```compile_fail
/// use ironhorse_snapshot::{CommitToken, MachineImage, image_to_batch};
/// fn unchecked_batch(image: &MachineImage) { image_to_batch(image, 1, CommitToken::ZERO); }
/// ```
pub fn image_to_batch(
    image: &crate::image::GatedImage,
    epoch: u64,
    prev_token: CommitToken,
) -> CheckpointBatch {
    image_to_batch_with_cadence(image, epoch, prev_token, 0, &mut RandomTokens)
}

/// Build an arbitrary full batch for adversarial tooling, without a live gate.
/// Normal persistence uses [`image_to_batch`] and its immutable proof token.
#[cfg(any(test, feature = "unchecked-tooling"))]
pub fn image_to_batch_unchecked(
    image: &MachineImage,
    epoch: u64,
    prev_token: CommitToken,
) -> CheckpointBatch {
    encode_image_batch(image, epoch, prev_token, 0, &mut RandomTokens)
}

pub(crate) fn image_to_batch_with_cadence(
    image: &crate::image::GatedImage,
    epoch: u64,
    prev_token: CommitToken,
    collect_every: u32,
    tokens: &mut dyn CommitTokenSource,
) -> CheckpointBatch {
    encode_image_batch(image.image(), epoch, prev_token, collect_every, tokens)
}

fn encode_image_batch(
    image: &MachineImage,
    epoch: u64,
    prev_token: CommitToken,
    collect_every: u32,
    tokens: &mut dyn CommitTokenSource,
) -> CheckpointBatch {
    let manifest = StoreManifest {
        version: image.version.clone(),
        store_schema: STORE_SCHEMA_VERSION,
        signature: image.signature.clone(),
        creation: image.creation.clone(),
        slot_count: image.slots.len() as u32,
        slot_live: image.slot_live,
        chunk_len: image.chunks.len() as u64,
        free_len: image.slot_free.len() as u32,
        epoch,
        // A container carries no crank history — importing one starts
        // the cadence schedule from zero, exactly like a fresh store.
        cranks: 0,
        collect_every,
        collections: 0,
        token: mint_token(tokens, prev_token),
    };
    let small = crate::snapshot_roster::small_from_image(image);
    let small_bytes = small.encode();
    let slot_pages = encode_all_slot_pages(&image.slots);
    let chunk_extents = encode_all_chunk_extents(&image.chunks);
    let free_segs = encode_all_free_segs(&image.slot_free);
    let page_edges: Vec<(u32, Vec<u32>)> = (0..slot_page_count(manifest.slot_count))
        .map(|page| {
            let start = (page * SLOTS_PER_PAGE) as usize;
            let end = image.slots.len().min(start + SLOTS_PER_PAGE as usize);
            (page, derive_page_edges(page, &image.slots[start..end]))
        })
        .collect();
    CheckpointBatch {
        prev_token,
        manifest,
        small: small_bytes,
        small_updates: None,
        slot_pages,
        chunk_extents,
        free_segs,
        page_edges,
    }
}

/// The compatibility gates open runs before restoring anything: format
/// readability, the store schema range ([`StoreError::NeedsMigration`] for
/// an older supported schema), and the callback-table signature with its
/// boot fingerprint. They ask whether this build can read the store, not
/// whether its content is right: under the store-seam design's trust model
/// the store is the machine it holds. The cost-table gate needs the small
/// state and runs where it is decoded.
pub fn check_open_gates(
    manifest: &StoreManifest,
    expected_sig: &Signature,
) -> Result<(), StoreError> {
    // Readability, not equality with the write stamp: an older
    // READABLE format version opens — its
    // atoms are a subset with the same encodings, and the schema
    // ladder migrates its sections — while a newer one was
    // already refused at manifest decode. The next checkpoint restamps
    // the manifest at the current version.
    if !manifest.version.is_readable() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store version stamp mismatch",
        )));
    }
    if manifest.store_schema < STORE_SCHEMA_VERSION {
        // Decodable but old: the opener runs [`migrate_store`] (with
        // the signature that authorizes the restamp) before resuming;
        // reaching here un-migrated is a caller bug or a read-only
        // surface, and fails closed by name.
        return Err(StoreError::NeedsMigration {
            found: manifest.store_schema,
        });
    }
    if manifest.store_schema > STORE_SCHEMA_VERSION {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "unsupported store schema version",
        )));
    }
    manifest.signature.check_boot()?;
    expected_sig.check_boot()?;
    if !manifest.signature.is_compatible_with(expected_sig) {
        return Err(StoreError::Snapshot(SnapshotError::SignatureMismatch {
            expected: expected_sig.clone(),
            found: manifest.signature.clone(),
        }));
    }
    Ok(())
}

/// What a lazy resume reads before it restores anything: the manifest, and
/// the decoded small state with the free list reassembled from its segment
/// rows, both past [`check_open_gates`] and the cost-table gate.
pub(crate) struct OpenedStore {
    pub(crate) manifest: StoreManifest,
    pub(crate) small: SmallState,
}

/// Open a store for a lazy resume: the compatibility gates, then the
/// decoding restore needs (the small state, with the cost-table gate, and
/// the free list). Nothing is re-verified; the restore's own checks (the
/// VM's free-list and accounting checks as it builds the slot arena, its
/// symbol-key table and empty-stack checks) and the caller's small-state
/// bounds gate guard it against engine bugs.
///
/// The lazy arenas are sized from the manifest's geometry before any row
/// is read, so open ties the geometry to the rows first: the live/free
/// accounting, and the last slot page and chunk extent present at the
/// lengths the geometry gives them ([`check_tail_rows`]). Two row reads,
/// not the inventory walk, refuse a garbled count before it can size an
/// allocation.
pub(crate) fn open_store(
    store: &dyn HeapStore,
    expected_sig: &Signature,
) -> Result<OpenedStore, StoreError> {
    let manifest = store.manifest()?;
    // The gates before the read: a store this build cannot open is refused
    // as such, without paying for (or failing on) its small state.
    check_open_gates(&manifest, expected_sig)?;
    let small = store.read_small_state()?;
    open_state(store, manifest, &small, expected_sig)
}

/// [`open_store`] over a manifest and an encoded small state the caller
/// supplies, with the store's rows: a migration opens its in-memory result
/// this way before writing it.
fn open_state(
    store: &dyn HeapStore,
    manifest: StoreManifest,
    small: &[u8],
    expected_sig: &Signature,
) -> Result<OpenedStore, StoreError> {
    check_open_gates(&manifest, expected_sig)?;
    let mut small = SmallState::decode(small)?;
    if manifest.cost_gate_mismatch(&small) {
        return Err(StoreError::Snapshot(SnapshotError::CostTableMismatch {
            expected: COST_TABLE_VERSION.to_string(),
            found: small.meter.cost_table_version.clone(),
        }));
    }
    small.slot_free = read_free_list(store, &manifest)?;
    check_accounting(&manifest)?;
    check_tail_rows(store, &manifest)?;
    Ok(OpenedStore { manifest, small })
}

/// Every record is live or on the free list.
fn check_accounting(manifest: &StoreManifest) -> Result<(), StoreError> {
    if manifest.free_len as u64 + manifest.slot_live as u64 != manifest.slot_count as u64 {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store live/free/count accounting mismatch",
        )));
    }
    Ok(())
}

/// The last slot page and the last chunk extent the manifest's geometry
/// promises exist at the lengths it gives them. A geometry that promises
/// more rows than the store holds fails here, on its tail row.
fn check_tail_rows(store: &dyn HeapStore, manifest: &StoreManifest) -> Result<(), StoreError> {
    if let Some(page) = slot_page_count(manifest.slot_count).checked_sub(1) {
        let found = store.read_slot_page(page)?.len();
        let expected = slot_page_len(manifest.slot_count, page) * SLOT_RECORD_BYTES;
        if found != expected {
            return Err(StoreError::RowLength {
                kind: "slot page",
                index: page,
                expected,
                found,
            });
        }
    }
    if let Some(ext) = chunk_extent_count(manifest.chunk_len).checked_sub(1) {
        let found = store.read_chunk_extent(ext)?.len();
        let expected = chunk_extent_len(manifest.chunk_len, ext);
        if found != expected {
            return Err(StoreError::RowLength {
                kind: "chunk extent",
                index: ext,
                expected,
                found,
            });
        }
    }
    Ok(())
}

/// Reassemble the free list from its segment rows. Each row must have the
/// length the manifest's `free_len` gives it — the decoding needs that
/// much — but nothing else about the entries is checked here.
fn read_free_list(store: &dyn HeapStore, manifest: &StoreManifest) -> Result<Vec<u32>, StoreError> {
    // Clamp the pre-reservation: the manifest count is confirmed only by
    // the row reads below.
    let mut free: Vec<u32> = Vec::with_capacity((manifest.free_len as usize).min(1 << 16));
    for seg in 0..free_seg_count(manifest.free_len) {
        let bytes = store.read_free_seg(seg)?;
        let expected = free_seg_len(manifest.free_len, seg) * 4;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "free segment",
                index: seg,
                expected,
                found: bytes.len(),
            });
        }
        free.extend(
            bytes
                .chunks_exact(4)
                .map(|c| u32::from_be_bytes(c.try_into().unwrap())),
        );
    }
    Ok(free)
}

/// Read a whole store back into the plain-data [`MachineImage`] — the
/// eager-reify path, and the bridge to the atom container. The inverse
/// of [`image_to_batch`] + [`HeapStoreCommit::commit`].
///
/// Reads and decodes every row and runs the decoding's bounds checks
/// (every row's exact length, the heap records' references and chunk
/// offsets, the small state's references, buffer lengths against their
/// chunk headers) as guards against engine bugs, and verifies nothing
/// beyond them: under the store-seam design's trust model the store is the
/// machine it holds, so export and [`root_hash`], which ride this path,
/// describe the heap as stored. [`validate_store_content`] is the explicit
/// check.
pub fn store_to_image(store: &dyn HeapStore) -> Result<MachineImage, StoreError> {
    store_to_image_at(store, &store.manifest()?)
}

/// [`store_to_image`] over a manifest the caller has already read.
pub(crate) fn store_to_image_at(
    store: &dyn HeapStore,
    manifest: &StoreManifest,
) -> Result<MachineImage, StoreError> {
    // Schema gate first: an older store needs migrating, and its small
    // state would not decode under the current section layout.
    // `root_hash` and `export_to_container` ride this path, so they must
    // report the distinction between migration and corruption too.
    if manifest.store_schema < STORE_SCHEMA_VERSION {
        return Err(StoreError::NeedsMigration {
            found: manifest.store_schema,
        });
    }
    if manifest.store_schema > STORE_SCHEMA_VERSION {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "unsupported store schema version",
        )));
    }
    let small = SmallState::decode(&store.read_small_state()?)?;
    if manifest.cost_gate_mismatch(&small) {
        return Err(StoreError::Snapshot(SnapshotError::CostTableMismatch {
            expected: COST_TABLE_VERSION.to_string(),
            found: small.meter.cost_table_version.clone(),
        }));
    }

    let pages = slot_page_count(manifest.slot_count);
    // Clamp the pre-reservation: the manifest count is confirmed only by
    // the row reads below (the over-allocation trophy class).
    let mut slots: Vec<Slot> = Vec::with_capacity((manifest.slot_count as usize).min(1 << 16));
    for page in 0..pages {
        let bytes = store.read_slot_page(page)?;
        let expected = slot_page_len(manifest.slot_count, page) * SLOT_RECORD_BYTES;
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "slot page",
                index: page,
                expected,
                found: bytes.len(),
            });
        }
        slots.extend(
            decode_slots(&bytes).map_err(|_| SnapshotError::Corrupt("store slot page record"))?,
        );
    }

    let exts = chunk_extent_count(manifest.chunk_len);
    // Same clamp discipline as the slot reservation above.
    let mut chunks: Vec<u8> = Vec::with_capacity((manifest.chunk_len as usize).min(1 << 24));
    for ext in 0..exts {
        let bytes = store.read_chunk_extent(ext)?;
        let expected = chunk_extent_len(manifest.chunk_len, ext);
        if bytes.len() != expected {
            return Err(StoreError::RowLength {
                kind: "chunk extent",
                index: ext,
                expected,
                found: bytes.len(),
            });
        }
        chunks.extend_from_slice(&bytes);
    }

    let slot_free = read_free_list(store, manifest)?;
    let image =
        crate::snapshot_roster::image_from_small(small, manifest.clone(), chunks, slots, slot_free);
    crate::image::check_machine_image_bounds(&image)?;
    crate::image::check_buffer_chunk_lengths(&image.buffers, &image.chunks)?;
    Ok(image)
}

impl StoreManifest {
    fn cost_gate_mismatch(&self, small: &SmallState) -> bool {
        small.meter.validate().is_err()
    }
}

/// A store's manifest and decoded small state (the free list reassembled
/// from its segment rows), as [`validate_store`] checked them.
#[derive(Clone, Debug)]
pub struct ValidatedStoreState {
    manifest: StoreManifest,
    small: SmallState,
}

impl ValidatedStoreState {
    /// The validated manifest.
    pub fn manifest(&self) -> &StoreManifest {
        &self.manifest
    }

    /// The validated decoded small state.
    pub fn small(&self) -> &SmallState {
        &self.small
    }
}

/// Check a store's correctness at the metadata scale: the compatibility
/// gates, then the manifest's and small state's own invariants (a nonzero
/// epoch and token, the symbol-key counter above the name table, an empty
/// stack), the live/free accounting, the row inventory (every promised
/// slot page and chunk extent exists at its exact length, from metadata
/// rather than contents), the summary count, the free list (in range and
/// distinct) and the small state's semantic bounds against the manifest's
/// geometry.
///
/// This is an explicit check, not a gate: the resume paths do not run it,
/// because under the store-seam design's trust model the store is the
/// machine it holds. Tests and fuzz targets run it, and [`migrate_store`]
/// runs it over its result before writing. [`validate_store_content`] also
/// reads and checks every row.
pub fn validate_store(
    store: &dyn HeapStore,
    expected_sig: &Signature,
) -> Result<ValidatedStoreState, StoreError> {
    let manifest = store.manifest()?;
    check_open_gates(&manifest, expected_sig)?;
    let small = store.read_small_state()?;
    validate_state(store, manifest, &small, expected_sig)
}

/// [`validate_store`] over a manifest and an encoded small state the
/// caller supplies, with the store's rows.
fn validate_state(
    store: &dyn HeapStore,
    manifest: StoreManifest,
    small: &[u8],
    expected_sig: &Signature,
) -> Result<ValidatedStoreState, StoreError> {
    let OpenedStore { manifest, small } = open_state(store, manifest, small, expected_sig)?;
    if manifest.token.is_zero() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store manifest commit token zero",
        )));
    }
    if manifest.epoch == 0 {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store manifest epoch 0",
        )));
    }
    // The symbol-key counter must clear the name table — the store
    // mirror of `read_machine`'s check (a counter at or below the
    // table aliases a symbol id onto a string key at restore).
    if (small.symbols.next_id as usize) <= small.names.len() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "symbol-key table: counter inside the name table",
        )));
    }
    // Quiescence, the store mirror of `read_machine`'s STAC gate:
    // checkpoints only ever commit quiescent machines, whose value stack
    // is empty.
    if !small.stack.is_empty() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "STAC not empty at a quiescent boundary",
        )));
    }

    // The live/free accounting and the tail rows were checked by
    // `open_store`.

    // Row inventory: every promised row exists at its exact length —
    // from METADATA, not contents, so this level does no O(heap) row I/O.
    let (page_lens, ext_lens) = store.inventory()?;
    let n_pages = slot_page_count(manifest.slot_count);
    if page_lens.len() != n_pages as usize {
        return Err(StoreError::MissingRow("slot page", page_lens.len() as u32));
    }
    for (page, found) in page_lens.iter().enumerate() {
        let expected = slot_page_len(manifest.slot_count, page as u32) * SLOT_RECORD_BYTES;
        if *found != expected {
            return Err(StoreError::RowLength {
                kind: "slot page",
                index: page as u32,
                expected,
                found: *found,
            });
        }
    }
    let n_exts = chunk_extent_count(manifest.chunk_len);
    if ext_lens.len() != n_exts as usize {
        return Err(StoreError::MissingRow(
            "chunk extent",
            ext_lens.len() as u32,
        ));
    }
    for (ext, found) in ext_lens.iter().enumerate() {
        let expected = chunk_extent_len(manifest.chunk_len, ext as u32);
        if *found != expected {
            return Err(StoreError::RowLength {
                kind: "chunk extent",
                index: ext as u32,
                expected,
                found: *found,
            });
        }
    }
    // One page-edge summary per slot page, the count the collectors check
    // before deciding anything from the summaries.
    let summaries = store.summary_page_count()?;
    if summaries != n_pages {
        return Err(StoreError::SummaryCount {
            expected: n_pages,
            found: summaries,
        });
    }
    // The free list `open_store` reassembled: in range and distinct. A
    // duplicated free index passes the accounting check but aliases one
    // record to two allocations after resume; with distinctness, the
    // accounting makes the live/free partition exact.
    if small.slot_free.iter().any(|&f| f >= manifest.slot_count) {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "store free-list index out of range",
        )));
    }
    {
        let mut seen = std::collections::HashSet::with_capacity(small.slot_free.len());
        if !small.slot_free.iter().all(|f| seen.insert(*f)) {
            return Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store free-list contains duplicate indices",
            )));
        }
    }

    // Semantic bounds for everything the small state carries — stack,
    // symbols, and the side tables — against the manifest's geometry. It
    // runs after the free-list checks so the free set is sound: a
    // side-table row owned by a free slot is refused, while freed heap
    // records stay opaque.
    crate::image::check_small_state_bounds(
        &small,
        manifest.slot_count,
        manifest.chunk_len as usize,
    )
    .map_err(StoreError::Snapshot)?;

    Ok(ValidatedStoreState { manifest, small })
}

/// Check a store's correctness completely: [`validate_store`]'s
/// metadata-scale checks, then every row read, decoded and bounds-checked
/// (as [`store_to_image`] does), the stored property ids audited against
/// the name and symbol-key tables, each page-edge summary re-derived from
/// its page's records, each small-state section digest re-derived from its
/// payload, and the backend's derived indexes compared with their sources
/// ([`HeapStore::check_derived_indexes`]). It reads the whole store.
///
/// A section digest is checked here as a cache that change detection
/// relies on, against the payload it was derived from, never as evidence
/// about the payload: a store whose content was edited consistently
/// passes, because under the store-seam design's trust model it is the
/// machine it now describes.
pub fn validate_store_content(
    store: &dyn HeapStore,
    expected_sig: &Signature,
) -> Result<ValidatedStoreState, StoreError> {
    let state = validate_store(store, expected_sig)?;
    let image = store_to_image_at(store, &state.manifest)?;
    if image.stored_unregistered_key_id().is_some() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "stored property id outside the name and symbol-key tables",
        )));
    }
    let edges = store.page_edges()?;
    if edges.len() != slot_page_count(state.manifest.slot_count) as usize {
        return Err(StoreError::SummaryCount {
            expected: slot_page_count(state.manifest.slot_count),
            found: edges.len() as u32,
        });
    }
    for (page, targets) in edges.iter().enumerate() {
        let start = page * SLOTS_PER_PAGE as usize;
        let end = image.slots.len().min(start + SLOTS_PER_PAGE as usize);
        if derive_page_edges(page as u32, &image.slots[start..end]) != *targets {
            return Err(StoreError::SummaryMismatch { page: page as u32 });
        }
    }
    let derived = crate::store_sections::SectionLeaves::from_payloads(
        &crate::store_sections::split_small_state(&store.read_small_state()?)?,
    );
    if store.small_section_hashes()? != *derived.hashes() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "small-state section digest disagrees with its payload",
        )));
    }
    store.check_derived_indexes()?;
    Ok(state)
}

// --- container ↔ store (the identity locks) ---

/// Export the store's current epoch as canonical `XS_M` container
/// bytes — the same bytes [`crate::image::write_machine`] produces for
/// the equivalent live machine, so a store state keeps CAS-grade
/// content identity (design decision 6) and full interchange with the
/// blob path.
pub fn export_to_container(store: &dyn HeapStore) -> Result<Vec<u8>, StoreError> {
    Ok(crate::image::write_machine(
        &crate::image::GatedImage::new(store_to_image(store)?)?,
    )?)
}

/// Seed a store from canonical container bytes (a full epoch-1 write),
/// enforcing the container gates against `expected_sig` exactly as
/// [`crate::image::read_machine`] does. The identity lock is
/// `export_to_container(import_from_container(bytes)) == bytes` for canonical
/// current-writer output. Accepted legacy Number NaN encodings normalize on
/// import/export, changing content identity once; raw buffer bytes do not.
/// The container gates are the check: the store this writes is then trusted
/// like any other (the store-seam design's trust model).
/// Untouched legacy pages need not be rewritten until checkpoint dirties them.
pub fn import_from_container(
    bytes: &[u8],
    expected_sig: &Signature,
    store: &mut dyn HeapStore,
) -> Result<(), StoreError> {
    let image = crate::image::read_validated_machine(bytes, expected_sig)?.into_image();
    // The blob half of the id-space audit: nothing may ADOPT a
    // container whose heap stores a property id outside both key
    // tables — crafted or torn bytes, or a pre-unification blob that
    // persisted a then-unresumable intern. The scan is
    // O(heap) and this path already decoded the whole image.
    if image.stored_unregistered_key_id().is_some() {
        return Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "stored property id outside the name and symbol-key tables",
        )));
    }
    store.commit(&image_to_batch(
        &crate::image::GatedImage::new(image)?,
        1,
        CommitToken::ZERO,
    ))
}

/// The store state's **logical identity**: the SHA-256 of its canonical
/// export (design decision 6 — identity is logical, not file bytes,
/// because a database file is not byte-canonical). Equals the CAS key
/// [`crate::machine::MachineSnapshot::suspend_to_cas`] would produce
/// for the same machine state, so blob-suspended and store-checkpointed
/// workers share one content-address space. Computed via a full export
/// today; an incrementally maintained page-hash tree is the design's
/// named future work for when this becomes hot.
pub fn root_hash(store: &dyn HeapStore) -> Result<String, StoreError> {
    Ok(crate::sha256::hex_sha256(&export_to_container(store)?))
}

// --- the in-memory reference store ---

/// What one [`HeapStoreCommit::commit`] wrote, for the incremental-
/// checkpoint acceptance tests in `tests/store_checkpoint.rs` that
/// check writes scale with the changed state.
#[derive(Copy, Clone, Debug, Default, PartialEq, Eq)]
pub struct CommitStats {
    pub slot_pages_written: usize,
    pub chunk_extents_written: usize,
    /// Free-list segment rows written, so tests can verify that LIFO
    /// churn rewrites only the affected tail segments.
    pub free_segs_written: usize,
    pub small_sections_written: usize,
    pub small_bytes_written: usize,
}

/// The comparison every [`HeapStore::replace_for_migration`] makes before
/// writing: the durable manifest must still be `from`, the one the
/// migration read. A second handle's migration or commit in between
/// changed its schema or its epoch and token. [`migrate_store`] also makes
/// it before it reads, with the handle's own view as `stored`.
pub fn check_migration_baseline(
    stored: &StoreManifest,
    from: &StoreManifest,
) -> Result<(), StoreError> {
    if stored != from {
        let label = |m: &StoreManifest| {
            format!(
                "schema {} epoch {} token {}",
                m.store_schema, m.epoch, m.token
            )
        };
        return Err(StoreError::BaselineMismatch {
            expected: label(from),
            found: label(stored),
        });
    }
    Ok(())
}

/// The in-memory [`HeapStore`]: the reference semantics every backend
/// must match, and the store the crate's own tests run against.
#[derive(Default)]
pub struct MemoryStore {
    manifest: Option<StoreManifest>,
    /// The whole framed small state of a store stamped before schema 28,
    /// which kept it as one leaf; empty once `sections` holds it.
    small: Vec<u8>,
    sections: Option<[Vec<u8>; crate::store_sections::SMALL_SECTION_COUNT]>,
    section_leaves: Option<crate::store_sections::SectionLeaves>,
    slot_pages: std::collections::HashMap<u32, Vec<u8>>,
    chunk_extents: std::collections::HashMap<u32, Vec<u8>>,
    free_segs: std::collections::HashMap<u32, Vec<u8>>,
    edges: Vec<Vec<u32>>,
    last_commit: CommitStats,
}

impl MemoryStore {
    pub fn new() -> MemoryStore {
        MemoryStore::default()
    }

    /// Row counts written by the most recent commit.
    pub fn last_commit_stats(&self) -> CommitStats {
        self.last_commit
    }
}

impl HeapStore for MemoryStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.manifest.clone().ok_or(StoreError::Empty)
    }

    fn replace_for_migration(
        &mut self,
        from: &StoreManifest,
        to: &StoreManifest,
        small: &[u8],
    ) -> Result<(), StoreError> {
        check_migration_baseline(&self.manifest()?, from)?;
        let sections = if to.store_schema >= 28 {
            let refs = crate::store_sections::split_small_state(small)?;
            Some(std::array::from_fn(|id| refs[id].to_vec()))
        } else {
            None
        };
        self.section_leaves = sections.as_ref().map(|rows| {
            crate::store_sections::SectionLeaves::from_payloads(&std::array::from_fn(|id| {
                rows[id].as_slice()
            }))
        });
        self.sections = sections;
        self.small = if self.sections.is_some() {
            Vec::new()
        } else {
            small.to_vec()
        };
        self.manifest = Some(to.clone());
        Ok(())
    }

    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        if let Some(sections) = &self.sections {
            crate::store_sections::frame_small_state(&std::array::from_fn(|id| {
                sections[id].as_slice()
            }))
        } else {
            Ok(self.small.clone())
        }
    }

    fn small_section_hashes(
        &self,
    ) -> Result<[[u8; 32]; crate::store_sections::SMALL_SECTION_COUNT], StoreError> {
        self.section_leaves
            .as_ref()
            .map(|leaves| *leaves.hashes())
            .ok_or(StoreError::Empty)
    }

    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        // Empty-store gate for point-read parity across backends: an
        // uncommitted store is `Empty`; `MissingRow` means a committed
        // store lacks the row.
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        self.slot_pages
            .get(&page)
            .cloned()
            .ok_or(StoreError::MissingRow("slot page", page))
    }

    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        self.chunk_extents
            .get(&ext)
            .cloned()
            .ok_or(StoreError::MissingRow("chunk extent", ext))
    }

    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        let m = self.manifest()?;
        let mut pages = Vec::with_capacity(slot_page_count(m.slot_count) as usize);
        for page in 0..slot_page_count(m.slot_count) {
            pages.push(
                self.slot_pages
                    .get(&page)
                    .ok_or(StoreError::MissingRow("slot page", page))?
                    .len(),
            );
        }
        let mut exts = Vec::with_capacity(chunk_extent_count(m.chunk_len) as usize);
        for ext in 0..chunk_extent_count(m.chunk_len) {
            exts.push(
                self.chunk_extents
                    .get(&ext)
                    .ok_or(StoreError::MissingRow("chunk extent", ext))?
                    .len(),
            );
        }
        Ok((pages, exts))
    }

    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        Ok(self.edges.clone())
    }

    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        if self.manifest.is_none() {
            return Err(StoreError::Empty);
        }
        self.free_segs
            .get(&seg)
            .cloned()
            .ok_or(StoreError::MissingRow("free segment", seg))
    }

    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        let batch = verify(self.manifest.as_ref())?.batch();
        let pages = slot_page_count(batch.manifest.slot_count);
        let exts = chunk_extent_count(batch.manifest.chunk_len);
        let next_sections =
            crate::store_sections::updated_leaves(self.section_leaves.as_ref(), batch)?;
        let updates = crate::store_sections::batch_updates(batch)?;
        let mut edges = self.edges.clone();
        edges.resize(pages as usize, Vec::new());
        for (page, targets) in &batch.page_edges {
            edges[*page as usize] = targets.clone();
        }
        for (page, bytes) in &batch.slot_pages {
            self.slot_pages.insert(*page, bytes.clone());
        }
        for (ext, bytes) in &batch.chunk_extents {
            self.chunk_extents.insert(*ext, bytes.clone());
        }
        self.edges = edges;
        for (seg, bytes) in &batch.free_segs {
            self.free_segs.insert(*seg, bytes.clone());
        }
        let n_frees = free_seg_count(batch.manifest.free_len);
        self.free_segs.retain(|&s, _| s < n_frees);
        // Drop rows beyond the new geometry (chunk shrink across a GC
        // compaction; slot pages are monotone but the sweep is uniform).
        self.slot_pages.retain(|&p, _| p < pages);
        self.chunk_extents.retain(|&e, _| e < exts);
        let rows = self
            .sections
            .get_or_insert_with(|| std::array::from_fn(|_| Vec::new()));
        let small_sections_written = updates.len();
        let small_bytes_written = updates.iter().map(|u| u.bytes.len()).sum();
        for update in updates {
            rows[update.section.id() as usize] = update.bytes;
        }
        self.section_leaves = Some(next_sections);
        self.small.clear();
        self.manifest = Some(batch.manifest.clone());
        self.last_commit = CommitStats {
            slot_pages_written: batch.slot_pages.len(),
            chunk_extents_written: batch.chunk_extents.len(),
            free_segs_written: batch.free_segs.len(),
            small_sections_written,
            small_bytes_written,
        };
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::{encode_strings, read_machine};
    use crate::machine::MachineSnapshot;
    use ironhorse_vm::Interp;

    #[test]
    fn name_floor_section_has_exact_width() {
        use crate::store_sections::SmallSection;
        let bytes = image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).small;
        let mut small = SmallState::decode(&bytes).unwrap();
        small.names = vec![SymbolName::from("name")];
        let encode = |floor: Vec<u8>| {
            let mut sections = small.encode_sections();
            sections[SmallSection::NameFloor as usize] = floor;
            let mut out = Vec::new();
            for section in sections {
                out.extend_from_slice(&(section.len() as u32).to_be_bytes());
                out.extend_from_slice(&section);
            }
            out
        };
        for floor in [vec![], vec![0; 4]] {
            assert!(SmallState::decode(&encode(floor)).is_ok());
        }
        for length in [1, 2, 3, 5, 8] {
            assert_eq!(
                SmallState::decode(&encode(vec![0; length])).unwrap_err(),
                StoreError::Snapshot(SnapshotError::Corrupt(
                    "small state name-floor section size"
                ))
            );
        }
    }

    /// Exercise the actual decoder and migration prefix reader with short
    /// headers, truncated payloads, and a wire length that overflows usize
    /// after the header on 32-bit targets. The intact image is a control.
    #[test]
    fn small_section_framing_refusals() {
        let bytes = image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).small;
        let small = SmallState::decode(&bytes).unwrap();
        assert_eq!(
            peek_cost_table_version(&bytes).unwrap(),
            small.meter.cost_table_version
        );
        let sections = small.encode_sections();
        let mut prefix = Vec::new();
        for (section, payload) in sections.iter().enumerate() {
            let mut malformed = Vec::new();
            for header_bytes in 0..4 {
                let mut short = prefix.clone();
                short.extend_from_slice(&(payload.len() as u32).to_be_bytes()[..header_bytes]);
                malformed.push(short);
            }
            let mut oversized = prefix.clone();
            oversized.extend_from_slice(&u32::MAX.to_be_bytes());
            malformed.push(oversized);
            if !payload.is_empty() {
                let mut short = prefix.clone();
                short.extend_from_slice(&(payload.len() as u32).to_be_bytes());
                short.extend_from_slice(&payload[..payload.len() - 1]);
                malformed.push(short);
            }
            for bytes in malformed {
                let error = SmallState::decode(&bytes).unwrap_err();
                if section < 6 {
                    assert_eq!(peek_cost_table_version(&bytes).unwrap_err(), error);
                }
                match section {
                    0 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state stack section"))
                    ),
                    1 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state free-list section"
                        ))
                    ),
                    2 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state keys section"))
                    ),
                    3 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state names section"))
                    ),
                    4 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state symbols section"))
                    ),
                    5 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state meter section"))
                    ),
                    6 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state arrays section"))
                    ),
                    7 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state collections section"
                        ))
                    ),
                    8 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state registry section"
                        ))
                    ),
                    9 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state errors section"))
                    ),
                    10 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state buffers section"))
                    ),
                    11 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state typed-arrays section"
                        ))
                    ),
                    12 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state data-views section"
                        ))
                    ),
                    13 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state wrappers section"
                        ))
                    ),
                    14 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state regexps section"))
                    ),
                    15 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state arguments section"
                        ))
                    ),
                    16 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state temporal section"
                        ))
                    ),
                    17 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state intl section"))
                    ),
                    18 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state name-floor section"
                        ))
                    ),
                    19 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state iterators section"
                        ))
                    ),
                    20 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state dates section"))
                    ),
                    21 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state function section"
                        ))
                    ),
                    22 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state proxy section"))
                    ),
                    23 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state accessor section"
                        ))
                    ),
                    24 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state Intl bound-function section"
                        ))
                    ),
                    25 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state private-element section"
                        ))
                    ),
                    26 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state disposable-stack section"
                        ))
                    ),
                    27 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state generator section"
                        ))
                    ),
                    28 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state error-frames section"
                        ))
                    ),
                    29 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state promise section"))
                    ),
                    30 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt("small state async section"))
                    ),
                    31 => assert_eq!(
                        error,
                        StoreError::Snapshot(SnapshotError::Corrupt(
                            "small state index-props section"
                        ))
                    ),
                    _ => unreachable!(),
                }
            }
            prefix.extend_from_slice(&(payload.len() as u32).to_be_bytes());
            prefix.extend_from_slice(payload);
        }
        assert_eq!(prefix, bytes);
    }

    fn sig() -> Signature {
        Signature::new("ironhorse-store-test-v1")
    }

    // The captured oracle bytecodes the machine-level snapshot tests
    // use (`crate::machine::tests`): PROG_A completes "6", PROG_B "1".
    const PROG_A: [u8; 44] = [
        0x0b, 0x00, 0x4b, 0xe0, 0x38, 0x00, 0x00, 0x2e, 0x13, 0x0b, 0x01, 0x9e, 0x01, 0x86, 0x01,
        0x00, 0x02, 0x00, 0xe6, 0x01, 0x92, 0x5c, 0x01, 0x72, 0x01, 0x01, 0xbb, 0x44, 0x58, 0x92,
        0x42, 0xe0, 0x89, 0x02, 0x00, 0x72, 0x04, 0x28, 0x72, 0x05, 0xab, 0x01, 0xbb, 0xa9,
    ];

    fn ran_image() -> MachineImage {
        let mut m = Interp::new();
        let a = m.run(&PROG_A);
        assert!(a.completed);
        m.snapshot_image_for_testing(&sig()).expect("gated image")
    }

    #[test]
    fn error_frames_require_an_error_owner_in_both_formats() {
        use crate::format::ERRD;
        use crate::image::{encode_errors, write_machine_unchecked, ErrorImage};
        use crate::store_sections::SmallSection;
        use crate::{AtomReader, AtomWriter};
        let mut image = ran_image();
        image.errors = vec![ErrorImage {
            owner: 1,
            name: "Error".into(),
            message: None,
            frames: vec!["origin".into()],
        }];
        let bytes = write_machine_unchecked(&image);
        assert_eq!(read_machine(&bytes, &sig()).unwrap(), image);
        let reader = AtomReader::parse(&bytes).unwrap();
        assert!(reader.find(ERRD).is_some());
        let mut writer = AtomWriter::new();
        for atom in reader.atoms() {
            if atom.tag != ERRD {
                writer.atom(atom.tag, atom.payload).unwrap();
            }
        }
        assert_eq!(
            read_machine(&writer.finish().unwrap(), &sig()),
            Err(SnapshotError::Corrupt(
                "error-frame side table: owner has no error row"
            ))
        );

        let bytes = image_to_batch_unchecked(&image, 1, CommitToken::ZERO).small;
        let small = SmallState::decode(&bytes).unwrap();
        assert_eq!(small.errors, image.errors);
        let mut sections = small.encode_sections();
        sections[SmallSection::Errors as usize] = encode_errors(&[]);
        let mut bytes = Vec::new();
        for section in sections {
            bytes.extend_from_slice(&(section.len() as u32).to_be_bytes());
            bytes.extend_from_slice(&section);
        }
        assert_eq!(
            SmallState::decode(&bytes).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt(
                "error-frame side table: owner has no error row"
            ))
        );
    }

    #[test]
    fn symbol_counter_must_clear_names_in_both_formats() {
        use crate::image::write_machine_unchecked;
        let mut image = ran_image();
        image.names = vec![SymbolName::from("name")];
        image.name_floor = None;
        image.symbols.next_id = 2;
        assert_eq!(
            read_machine(&write_machine_unchecked(&image), &sig()).unwrap(),
            image
        );
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        validate_store(&store, &sig()).unwrap();
        for next_id in [0, 1] {
            let mut invalid = image.clone();
            invalid.symbols.next_id = next_id;
            assert_eq!(
                read_machine(&write_machine_unchecked(&invalid), &sig()),
                Err(SnapshotError::Corrupt(
                    "symbol-key table: counter inside the name table"
                ))
            );
            let mut store = MemoryStore::new();
            store
                .commit(&image_to_batch_unchecked(&invalid, 1, CommitToken::ZERO))
                .unwrap();
            assert_eq!(
                validate_store(&store, &sig()).unwrap_err(),
                StoreError::Snapshot(SnapshotError::Corrupt(
                    "symbol-key table: counter inside the name table"
                ))
            );
            // Both resume paths refuse it as the restore rebuilds the table.
            assert_eq!(
                crate::machine::resume_from_store(&store, &sig()).unwrap_err(),
                StoreError::Snapshot(SnapshotError::Corrupt("symbol-key table does not restore"))
            );
            assert_eq!(
                crate::machine::resume_from_store_lazy(
                    std::rc::Rc::new(std::cell::RefCell::new(store)),
                    &sig()
                )
                .unwrap_err(),
                StoreError::Snapshot(SnapshotError::Corrupt("symbol-key table does not restore"))
            );
        }
    }

    #[test]
    fn append_migrations_add_exactly_their_empty_sections() {
        // Independent historical wire contract: target schema / added bytes.
        // Pin individual steps so moving four bytes between adjacent steps
        // cannot pass merely because a complete v5-to-current migration works.
        const EXPECTED: &[(u32, usize)] = &[
            (7, 12),
            (9, 4),
            (10, 12),
            (11, 16),
            (12, 8),
            (13, 4),
            (14, 4),
            (15, 4),
            (16, 4),
            (17, 4),
            (18, 4),
            (19, 4),
            (20, 4),
            (21, 4),
            (22, 4),
            (23, 4),
            (24, 4),
            (25, 4),
        ];
        assert_eq!(LADDER, EXPECTED);
        let base = image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).manifest;
        for &(target, extra_len) in EXPECTED {
            let mut manifest = StoreManifest {
                store_schema: target - 1,
                ..base.clone()
            };
            let mut small = vec![0x71, 0x00, 0xff];
            migrate_step(&mut manifest, &mut small).unwrap();
            let mut expected_small = vec![0x71, 0x00, 0xff];
            expected_small.extend(vec![0; extra_len]);
            assert_eq!(small, expected_small);
            assert_eq!(
                manifest,
                StoreManifest {
                    store_schema: target,
                    ..base.clone()
                }
            );
        }
        // Every other step leaves the small state alone, except the two
        // that rewrite it (25 and 26), and 7 resets the crank counter.
        for schema in STORE_SCHEMA_MIN_SUPPORTED..STORE_SCHEMA_VERSION {
            if LADDER.iter().any(|&(target, _)| target == schema + 1)
                || schema == 25
                || schema == 26
            {
                continue;
            }
            let mut manifest = StoreManifest {
                store_schema: schema,
                cranks: 9,
                ..base.clone()
            };
            let mut small = vec![0x71, 0x00, 0xff];
            migrate_step(&mut manifest, &mut small).unwrap();
            assert_eq!(small, [0x71, 0x00, 0xff]);
            assert_eq!(manifest.store_schema, schema + 1);
            assert_eq!(manifest.cranks, if schema == 7 { 0 } else { 9 });
        }
    }

    #[test]
    fn paging_math_covers_partial_tails() {
        assert_eq!(slot_page_count(0), 0);
        assert_eq!(slot_page_count(1), 1);
        assert_eq!(slot_page_count(SLOTS_PER_PAGE), 1);
        assert_eq!(slot_page_count(SLOTS_PER_PAGE + 1), 2);
        assert_eq!(
            slot_page_len(SLOTS_PER_PAGE + 1, 0),
            SLOTS_PER_PAGE as usize
        );
        assert_eq!(slot_page_len(SLOTS_PER_PAGE + 1, 1), 1);
        assert_eq!(slot_page_len(SLOTS_PER_PAGE + 1, 2), 0);
        let e = CHUNK_EXTENT_BYTES as u64;
        assert_eq!(chunk_extent_count(0), 0);
        assert_eq!(chunk_extent_count(e), 1);
        assert_eq!(chunk_extent_count(e + 1), 2);
        assert_eq!(chunk_extent_len(e + 1, 0), CHUNK_EXTENT_BYTES as usize);
        assert_eq!(chunk_extent_len(e + 1, 1), 1);
    }

    #[test]
    fn manifest_round_trips_and_gates() {
        let m = StoreManifest {
            version: Version::current(),
            store_schema: STORE_SCHEMA_VERSION,
            signature: sig(),
            creation: CreationParams {
                initial_slot_count: 7,
                initial_chunk_bytes: 9,
            },
            slot_count: 300,
            slot_live: 200,
            chunk_len: 70_000,
            free_len: 5,
            epoch: 3,
            cranks: 41,
            collect_every: 3,
            collections: 7,
            token: CommitToken([0x5a; 16]),
        };
        let bytes = m.encode();
        let back = StoreManifest::decode(&bytes).unwrap();
        assert_eq!(back, m);
        assert_eq!(back.cranks, 41, "the schema-8 crank counter round-trips");

        // A chunk length past the u32 chunk-offset space is refused at
        // decode, before anything can size an arena by it; the largest
        // addressable length decodes.
        for (chunk_len, fits) in [
            (u64::from(u32::MAX), true),
            (u64::from(u32::MAX) + 1, false),
        ] {
            let long = StoreManifest {
                chunk_len,
                ..m.clone()
            };
            let decoded = StoreManifest::decode(&long.encode());
            if fits {
                assert_eq!(decoded.unwrap(), long);
            } else {
                assert_eq!(
                    decoded.unwrap_err(),
                    StoreError::Snapshot(SnapshotError::Corrupt(
                        "store manifest chunk length exceeds the chunk offset space"
                    ))
                );
            }
        }

        // A foreign VERS magic fails closed through the shared gate.
        let mut foreign = bytes.clone();
        foreign[0..4].copy_from_slice(b"XSXS");
        match StoreManifest::decode(&foreign) {
            Err(StoreError::Snapshot(SnapshotError::Version(_))) => {}
            other => panic!("expected version gate, got {other:?}"),
        }

        // A claimed signature length past the payload fails closed
        // before any reservation (malformed-count discipline).
        let mut huge = bytes.clone();
        huge[14..18].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            StoreManifest::decode(&huge),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest signature truncated"
            )))
        );

        // Exact consumption: a decodable manifest followed by any
        // trailing byte is malformed, not forward-compatible.
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(
            StoreManifest::decode(&trailing),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest trailing bytes"
            )))
        );

        // Every field past the signature is fixed-width, ending in the
        // 16-byte token; cut at every byte.
        let signature_end = 18 + m.signature.encode().len();
        let epoch_end = signature_end + 36;
        assert_eq!(epoch_end + 36, bytes.len());
        for length in 0..bytes.len() {
            let result = StoreManifest::decode(&bytes[..length]);
            if (18..signature_end).contains(&length) {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "store manifest signature truncated"
                    )))
                );
            } else {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "store manifest truncated"
                    ))),
                    "prefix {length}"
                );
            }
        }
        for schema in [STORE_SCHEMA_MIN_SUPPORTED - 1, STORE_SCHEMA_VERSION + 1] {
            let mut invalid = bytes.clone();
            invalid[10..14].copy_from_slice(&schema.to_be_bytes());
            assert_eq!(
                StoreManifest::decode(&invalid),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "unsupported store schema version"
                )))
            );
        }

        // An older schema's layout, read for migration: this build writes
        // it (for fixtures) with an empty root and a seal the token reads
        // back from, and each schema carries its own tail fields.
        for schema in [STORE_SCHEMA_MIN_SUPPORTED, 7, 8, 26, 27, 35] {
            let legacy = StoreManifest {
                store_schema: schema,
                cranks: if schema >= 8 { 41 } else { 0 },
                collect_every: if schema >= 27 { 3 } else { 0 },
                collections: if schema >= 27 { 7 } else { 0 },
                ..m.clone()
            };
            assert_eq!(StoreManifest::decode(&legacy.encode()).unwrap(), legacy);
        }
        // A legacy manifest as an older build wrote it: the root and the
        // parent seal are read and dropped, and the token is the first half
        // of the seal.
        let legacy_bytes = |root: &[u8], seal: &[u8], parent: &[u8]| {
            let mut v = StoreManifest {
                store_schema: 35,
                ..m.clone()
            }
            .encode();
            v.truncate(epoch_end);
            v.extend_from_slice(&(root.len() as u32).to_be_bytes());
            v.extend_from_slice(root);
            v.extend_from_slice(&(seal.len() as u32).to_be_bytes());
            v.extend_from_slice(seal);
            v.extend_from_slice(&41u64.to_be_bytes());
            v.extend_from_slice(&3u32.to_be_bytes());
            v.extend_from_slice(&7u64.to_be_bytes());
            v.extend_from_slice(&(parent.len() as u32).to_be_bytes());
            v.extend_from_slice(parent);
            v
        };
        let (root, seal, parent) = (
            b"r00t".as_slice(),
            b"00112233445566778899aabbccddeeff0123456789abcdef0123456789abcdef".as_slice(),
            b"parent".as_slice(),
        );
        let bytes = legacy_bytes(root, seal, parent);
        assert_eq!(
            StoreManifest::decode(&bytes).unwrap(),
            StoreManifest {
                store_schema: 35,
                token: CommitToken([
                    0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
                    0xdd, 0xee, 0xff
                ]),
                ..m.clone()
            }
        );
        for short in [&seal[..31], b""] {
            assert_eq!(
                StoreManifest::decode(&legacy_bytes(root, short, parent)),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store manifest seal shorter than a token"
                )))
            );
        }
        assert_eq!(
            StoreManifest::decode(&legacy_bytes(
                root,
                &b"0011223344556677889g".repeat(2),
                parent
            )),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest seal not hex"
            )))
        );
        let root_start = epoch_end + 4;
        let root_end = root_start + root.len();
        let seal_start = root_end + 4;
        let seal_end = seal_start + seal.len();
        let parent_start = seal_end + 24;
        assert_eq!(parent_start + parent.len(), bytes.len());
        for length in 0..bytes.len() {
            let result = StoreManifest::decode(&bytes[..length]);
            if (18..signature_end).contains(&length) {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "store manifest signature truncated"
                    )))
                );
            } else if (root_start..root_end).contains(&length) {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "store manifest root truncated"
                    )))
                );
            } else if (seal_start..seal_end).contains(&length) {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "store manifest seal truncated"
                    )))
                );
            } else if length >= parent_start {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "manifest parent seal truncated"
                    )))
                );
            } else {
                assert_eq!(
                    result,
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "store manifest truncated"
                    ))),
                    "prefix {length}"
                );
            }
        }
        let mut invalid = bytes.clone();
        invalid[root_start..root_end].fill(0xff);
        assert_eq!(
            StoreManifest::decode(&invalid),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest root not utf8"
            )))
        );
        invalid = bytes.clone();
        invalid[seal_start..seal_end].fill(0xff);
        assert_eq!(
            StoreManifest::decode(&invalid),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest seal not utf8"
            )))
        );
        invalid = bytes.clone();
        invalid[parent_start] = 0xff;
        assert_eq!(
            StoreManifest::decode(&invalid),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "manifest parent seal not utf8"
            )))
        );
        invalid = bytes.clone();
        invalid[root_start - 4..root_start].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            StoreManifest::decode(&invalid),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest root truncated"
            )))
        );
        invalid = bytes;
        invalid[seal_start - 4..seal_start].copy_from_slice(&u32::MAX.to_be_bytes());
        assert_eq!(
            StoreManifest::decode(&invalid),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "store manifest seal truncated"
            )))
        );
    }

    #[test]
    fn small_state_round_trips() {
        let s = SmallState {
            index_props: Vec::new(),
            stack: vec![Slot::boolean(true), Slot::integer(-4)],
            slot_free: vec![9, 2, 5],
            keys: vec!["dyn".to_string()],
            names: vec!["Object".into(), "x".into()],
            symbols: crate::image::SymbolKeyImage {
                next_id: u16::MAX - 3,
                pairs: vec![(u16::MAX - 2, 11), (u16::MAX - 1, 22)],
            },
            meter: MeterImage::current(),
            arrays: Vec::new(),
            collections: Vec::new(),
            registry: Vec::new(),
            errors: Vec::new(),
            buffers: Vec::new(),
            typed_arrays: Vec::new(),
            data_views: Vec::new(),
            wrappers: Vec::new(),
            regexps: Vec::new(),
            dates: Vec::new(),
            function_state: ironhorse_vm::snapshot_api::FunctionStateSnapshot::default(),
            proxy_state: ironhorse_vm::snapshot_api::ProxyStateSnapshot::default(),
            accessors: Vec::new(),
            intl_bound_functions: Vec::new(),
            private_elements: ironhorse_vm::snapshot_api::PrivateElementSnapshot::default(),
            disposable_stacks: Vec::new(),
            generators: Vec::new(),
            promise_cluster: ironhorse_vm::snapshot_api::PromiseClusterSnapshot::default(),
            arguments_brands: Vec::new(),
            temporal: crate::image::TemporalImage::default(),
            intl: ironhorse_vm::snapshot_api::IntlTables::default(),
            name_floor: None,
            iterators: Vec::new(),
        };
        // Since schema v4 the free list does NOT ride in small state
        // (it lives in segment rows); the round-trip drops it.
        let mut expected = s.clone();
        expected.slot_free = Vec::new();
        assert_eq!(SmallState::decode(&s.encode()).unwrap(), expected);
    }

    #[test]
    fn small_state_truncation_fails_closed() {
        let s = SmallState {
            index_props: Vec::new(),
            stack: vec![],
            slot_free: vec![],
            keys: vec![],
            names: vec![],
            symbols: crate::image::SymbolKeyImage::default(),
            meter: MeterImage::current(),
            arrays: Vec::new(),
            collections: Vec::new(),
            registry: Vec::new(),
            errors: Vec::new(),
            buffers: Vec::new(),
            typed_arrays: Vec::new(),
            data_views: Vec::new(),
            wrappers: Vec::new(),
            regexps: Vec::new(),
            dates: Vec::new(),
            function_state: ironhorse_vm::snapshot_api::FunctionStateSnapshot::default(),
            proxy_state: ironhorse_vm::snapshot_api::ProxyStateSnapshot::default(),
            accessors: Vec::new(),
            intl_bound_functions: Vec::new(),
            private_elements: ironhorse_vm::snapshot_api::PrivateElementSnapshot::default(),
            disposable_stacks: Vec::new(),
            generators: Vec::new(),
            promise_cluster: ironhorse_vm::snapshot_api::PromiseClusterSnapshot::default(),
            arguments_brands: Vec::new(),
            temporal: crate::image::TemporalImage::default(),
            intl: ironhorse_vm::snapshot_api::IntlTables::default(),
            name_floor: None,
            iterators: Vec::new(),
        };
        let bytes = s.encode();
        for cut in [0, 3, 7, bytes.len() - 1] {
            assert!(
                SmallState::decode(&bytes[..cut]).is_err(),
                "truncation at {cut} must fail closed"
            );
        }
        // And the mirror image: bytes past the sixth section are
        // malformed, not ignorable.
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert_eq!(
            SmallState::decode(&trailing).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("small state trailing bytes"))
        );
    }

    #[test]
    fn epoch_discipline_is_enforced() {
        assert!(check_epoch(None, 1).is_ok());
        assert_eq!(
            check_epoch(None, 2),
            Err(StoreError::EpochMismatch {
                expected: 1,
                found: 2
            })
        );
        assert!(check_epoch(Some(4), 5).is_ok());
        assert_eq!(
            check_epoch(Some(4), 4),
            Err(StoreError::EpochMismatch {
                expected: 5,
                found: 4
            })
        );
    }

    /// The identity lock: container → store → container is
    /// byte-identical, so the two forms are the same logical format.
    #[test]
    fn container_import_export_is_byte_identical() {
        let image = ran_image();
        let bytes = crate::image::write_machine_unchecked(&image);

        let mut store = MemoryStore::new();
        import_from_container(&bytes, &sig(), &mut store).expect("imports");
        let exported = export_to_container(&store).expect("exports");
        assert_eq!(exported, bytes, "the round-trip is byte-identical");

        // And the exported bytes still pass the container reader's own
        // gates.
        assert_eq!(read_machine(&exported, &sig()).unwrap(), image);
    }

    #[test]
    fn legacy_nan_import_normalizes_numbers_but_preserves_chunk_bytes() {
        use ironhorse_vm::{ChunkArena, Payload, Slot};
        let raw = 0xfff0_0000_0000_0001u64;
        let mut image = ran_image();
        image.version.format_version = 15;
        image.function_state.native_names = None;
        let slot_index = image.slots.len();
        image.slots.push(Slot::number(f64::NAN));
        image.slot_live += 1;
        let mut chunks = ChunkArena::from_image(image.chunks);
        chunks.alloc(&raw.to_be_bytes());
        image.chunks = chunks.raw_vec();
        let canonical = crate::image::write_machine_unchecked(&image);
        let record = crate::slot_codec::encode_slots(&[Slot::number(f64::NAN)]);
        let offsets: Vec<_> = canonical
            .windows(record.len())
            .enumerate()
            .filter_map(|(i, bytes)| (bytes == record).then_some(i))
            .collect();
        assert_eq!(offsets.len(), 1);
        let mut legacy = canonical.clone();
        legacy[offsets[0] + 10..offsets[0] + 18].copy_from_slice(&raw.to_be_bytes());
        let decoded = read_machine(&legacy, &sig()).unwrap();
        let Payload::Number(n) = decoded.slots[slot_index].value else {
            panic!("expected number")
        };
        assert_eq!(n.to_bits(), raw);
        assert_eq!(crate::image::write_machine_unchecked(&decoded), canonical);
        let mut store = MemoryStore::new();
        import_from_container(&legacy, &sig(), &mut store).unwrap();
        validate_store(&store, &sig()).unwrap();
        assert_eq!(export_to_container(&store).unwrap(), canonical);
        assert_eq!(store_to_image(&store).unwrap().chunks, image.chunks);
        assert_eq!(
            crate::image::write_machine_unchecked(&read_machine(&canonical, &sig()).unwrap()),
            canonical
        );
    }

    /// A machine image survives the paged form exactly (every page and
    /// extent, partial tails included).
    #[test]
    fn image_batch_store_image_round_trips() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .expect("commits");
        let back = store_to_image(&store).expect("reads back");
        assert_eq!(back, image);
    }

    #[test]
    fn validate_accepts_a_committed_store() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        let validated = validate_store(&store, &sig()).expect("validates");
        let manifest = validated.manifest();
        let small = validated.small();
        assert_eq!(manifest.epoch, 1);
        assert_eq!(manifest.slot_count as usize, image.slots.len());
        assert_eq!(small.slot_free, image.slot_free);
    }

    #[test]
    fn validate_fails_closed_on_empty_store() {
        let store = MemoryStore::new();
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::Empty
        );
    }

    #[test]
    fn validate_fails_closed_on_signature_mismatch() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        match validate_store(&store, &Signature::new("other-host")) {
            Err(StoreError::Snapshot(SnapshotError::SignatureMismatch { .. })) => {}
            other => panic!("expected signature mismatch, got {other:?}"),
        }
    }

    #[test]
    fn validate_fails_closed_on_cost_table_mismatch() {
        let mut image = ran_image();
        image.meter.cost_table_version = "ironhorse-meter-999".to_string();
        let mut store = MemoryStore::new();
        assert!(matches!(
            store.commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO)),
            Err(StoreError::Snapshot(
                SnapshotError::CostTableMismatch { .. }
            ))
        ));
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        store.sections.as_mut().unwrap()
            [crate::store_sections::SmallSection::Meter.id() as usize] = image.meter.encode();
        match validate_store(&store, &sig()) {
            Err(StoreError::Snapshot(SnapshotError::CostTableMismatch { .. })) => {}
            other => panic!("expected cost-table mismatch, got {other:?}"),
        }
    }

    #[test]
    fn store_refuses_matching_version_with_changed_weights() {
        let mut image = ran_image();
        image.meter.cost_table_digest[0] ^= 1;
        let mut store = MemoryStore::new();
        assert!(matches!(
            store.commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO)),
            Err(StoreError::Snapshot(
                SnapshotError::CostTableMismatch { .. }
            ))
        ));
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        store.sections.as_mut().unwrap()
            [crate::store_sections::SmallSection::Meter.id() as usize] = image.meter.encode();
        assert!(matches!(
            validate_store(&store, &sig()),
            Err(StoreError::Snapshot(
                SnapshotError::CostTableMismatch { .. }
            ))
        ));
        store.manifest.as_mut().unwrap().store_schema = STORE_SCHEMA_VERSION - 1;
        assert!(matches!(
            migrate_store(&mut store, &sig()),
            Err(StoreError::Snapshot(
                SnapshotError::CostTableMismatch { .. }
            ))
        ));
    }

    #[test]
    fn manifest_version_and_epoch_have_exact_refusals() {
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        validate_store(&store, &sig()).unwrap();
        let original = store.manifest.clone();
        store.manifest.as_mut().unwrap().version.format_version = u32::MAX;
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("store version stamp mismatch"))
        );
        store.manifest = original;
        store.manifest.as_mut().unwrap().epoch = 0;
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("store manifest epoch 0"))
        );
    }

    /// Eager reification reads the rows as stored: under the store-seam
    /// design's trust model a length-preserving edit at rest is the
    /// machine the store now describes, and the store keeps no row digest
    /// that could disagree with it.
    #[test]
    fn eager_store_reads_rows_as_stored() {
        let mut image = ran_image();
        image.slot_free.push(image.slots.len() as u32);
        image.slots.push(Slot::undefined());
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        let control = store_to_image(&store).unwrap();
        let last = store.chunk_extents[&0].len() - 1;
        store.chunk_extents.get_mut(&0).unwrap()[last] ^= 1;
        let edited = store_to_image(&store).unwrap();
        assert_eq!(edited.chunks[last], control.chunks[last] ^ 1);
        validate_store(&store, &sig()).unwrap();
    }

    /// The shared consistent-edit suite on the reference store, whose rows
    /// at rest are its maps.
    #[test]
    fn consistent_edits_resume_on_the_reference_store() {
        crate::store_suite::consistent_edits_resume(
            MemoryStore::new(),
            |mut store, kind, index, _old, new| {
                let rows = match kind {
                    "slot page" => &mut store.slot_pages,
                    "chunk extent" => &mut store.chunk_extents,
                    "free segment" => &mut store.free_segs,
                    "small section" => {
                        let sections = store.sections.as_mut().expect("a sectioned small state");
                        sections[index as usize] = new.to_vec();
                        let payloads = std::array::from_fn(|id| &sections[id][..]);
                        store.section_leaves = Some(
                            crate::store_sections::SectionLeaves::from_payloads(&payloads),
                        );
                        return store;
                    }
                    "manifest" => {
                        store.manifest = Some(StoreManifest::decode(new).unwrap());
                        return store;
                    }
                    other => panic!("no {other} rows here"),
                };
                rows.insert(index, new.to_vec());
                store
            },
        );
    }

    /// The small-state section digests are change detection: the full
    /// validator re-derives them from their payloads, and nothing on the
    /// run-time path does.
    #[test]
    fn a_stale_section_digest_is_refused_by_the_full_validator_only() {
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        validate_store_content(&store, &sig()).unwrap();
        store.section_leaves = Some(crate::store_sections::SectionLeaves::from_hashes(
            [[0; 32]; crate::store_sections::SMALL_SECTION_COUNT],
        ));
        validate_store(&store, &sig()).unwrap();
        store_to_image(&store).unwrap();
        assert_eq!(
            validate_store_content(&store, &sig()).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt(
                "small-state section digest disagrees with its payload"
            ))
        );
    }

    #[test]
    fn succession_metadata_has_exact_refusals() {
        let image = ran_image();
        let first = image_to_batch_unchecked(&image, 1, CommitToken::ZERO);
        check_succession(None, &first).unwrap();
        let previous = first.manifest;
        let next = image_to_batch_unchecked(&image, 2, previous.token);
        check_succession(Some(&previous), &next).unwrap();
        let mut invalid = next.clone();
        invalid.manifest.collect_every = previous.collect_every + 1;
        assert_eq!(
            check_succession(Some(&previous), &invalid),
            Err(StoreError::Snapshot(SnapshotError::Corrupt(
                "collection cadence mismatch"
            )))
        );
        for collections in [false, true] {
            let mut prior = previous.clone();
            if collections {
                prior.collections = next.manifest.collections + 1;
            } else {
                prior.cranks = next.manifest.cranks + 1;
            }
            assert_eq!(
                check_succession(Some(&prior), &next),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "durable counter regression"
                )))
            );
            // Equality is permitted: a checkpoint need not complete a crank.
            let mut equal = next.clone();
            equal.manifest.collections = prior.collections;
            equal.manifest.cranks = prior.cranks;
            check_succession(Some(&prior), &equal).unwrap();
        }
        assert_eq!(check_epoch(Some(u64::MAX - 1), u64::MAX), Ok(()));
        for attempted in [0, 1, u64::MAX] {
            assert_eq!(
                check_epoch(Some(u64::MAX), attempted),
                Err(StoreError::Snapshot(SnapshotError::Corrupt(
                    "store epoch exhausted"
                )))
            );
        }
    }

    /// The token pairing: a batch names the stored token (zero for an
    /// empty store) as its predecessor, and carries a token of its own that
    /// is nonzero and differs from that predecessor.
    #[test]
    fn succession_pairs_batches_on_the_commit_token() {
        let image = ran_image();
        let first = image_to_batch_unchecked(&image, 1, CommitToken::ZERO);
        assert!(!first.manifest.token.is_zero());
        let previous = first.manifest.clone();
        let next = image_to_batch_unchecked(&image, 2, previous.token);
        assert_ne!(next.manifest.token, previous.token);
        let other = CommitToken([0xab; 16]);
        let mismatch = |expected: CommitToken, found: CommitToken| {
            Err(StoreError::BaselineMismatch {
                expected: expected.to_hex(),
                found: found.to_hex(),
            })
        };
        let mut invalid = first.clone();
        invalid.prev_token = other;
        assert_eq!(
            check_succession(None, &invalid),
            mismatch(CommitToken::ZERO, other)
        );
        invalid = next.clone();
        invalid.prev_token = other;
        assert_eq!(
            check_succession(Some(&previous), &invalid),
            mismatch(previous.token, other)
        );
        invalid = next.clone();
        invalid.prev_token = CommitToken::ZERO;
        assert_eq!(
            check_succession(Some(&previous), &invalid),
            mismatch(previous.token, CommitToken::ZERO)
        );
        invalid = next.clone();
        invalid.manifest.token = CommitToken::ZERO;
        assert_eq!(
            check_succession(Some(&previous), &invalid),
            Err(StoreError::BatchRejected(Box::new(StoreError::Snapshot(
                SnapshotError::Corrupt("commit token must be nonzero")
            ))))
        );
        invalid = next.clone();
        invalid.manifest.token = previous.token;
        assert_eq!(
            check_succession(Some(&previous), &invalid),
            Err(StoreError::BatchRejected(Box::new(StoreError::Snapshot(
                SnapshotError::Corrupt("commit token must differ from its predecessor")
            ))))
        );
        // The pairing is equality and nothing more: any other token the
        // store holds is refused, and any fresh token is accepted.
        invalid = next.clone();
        invalid.manifest.token = other;
        check_succession(Some(&previous), &invalid).unwrap();
        let mut stored = previous.clone();
        stored.token = other;
        assert_eq!(
            check_succession(Some(&stored), &next),
            mismatch(other, previous.token)
        );
    }

    /// Minting refuses zero and the predecessor, and gives up on a source
    /// that returns nothing else.
    #[test]
    fn mint_token_redraws_zero_and_the_predecessor() {
        struct Script(Vec<CommitToken>);
        impl CommitTokenSource for Script {
            fn next_token(&mut self) -> CommitToken {
                self.0.remove(0)
            }
        }
        let prev = CommitToken([1; 16]);
        let fresh = CommitToken([2; 16]);
        let mut source = Script(vec![CommitToken::ZERO, prev, fresh]);
        assert_eq!(mint_token(&mut source, prev), fresh);
        let mut stuck = Script(vec![prev; 64]);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            mint_token(&mut stuck, prev)
        }))
        .is_err());
        let mut random = RandomTokens;
        let drawn: std::collections::HashSet<CommitToken> = (0..64)
            .map(|_| mint_token(&mut random, CommitToken::ZERO))
            .collect();
        assert_eq!(drawn.len(), 64);
        assert!(!drawn.contains(&CommitToken::ZERO));
        assert_eq!(fresh.to_hex(), "02".repeat(16));
    }

    #[test]
    fn free_lists_require_valid_distinct_indices() {
        let mut valid = ran_image();
        for _ in 0..2 {
            valid.slot_free.push(valid.slots.len() as u32);
            valid.slots.push(Slot::undefined());
        }
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&valid, 1, CommitToken::ZERO))
            .unwrap();
        validate_store(&store, &sig()).unwrap();
        for duplicate in [false, true] {
            let mut invalid = valid.clone();
            let last = invalid.slot_free.len() - 1;
            invalid.slot_free[last] = if duplicate {
                invalid.slot_free[last - 1]
            } else {
                invalid.slots.len() as u32
            };
            let mut store = MemoryStore::new();
            store
                .commit(&image_to_batch_unchecked(&invalid, 1, CommitToken::ZERO))
                .unwrap();
            // Both resume paths refuse the free list as they build the slot
            // arena from it, without the validator.
            assert_eq!(
                crate::machine::resume_from_store(&store, &sig()).unwrap_err(),
                StoreError::Snapshot(SnapshotError::Corrupt("invalid slot arena image"))
            );
            let shared = std::rc::Rc::new(std::cell::RefCell::new(store));
            assert_eq!(
                crate::machine::resume_from_store_lazy(shared.clone(), &sig()).unwrap_err(),
                StoreError::Snapshot(SnapshotError::Corrupt("invalid lazy arena metadata"))
            );
            let store = std::rc::Rc::try_unwrap(shared).ok().unwrap().into_inner();
            if duplicate {
                assert_eq!(
                    validate_store(&store, &sig()).unwrap_err(),
                    StoreError::Snapshot(SnapshotError::Corrupt(
                        "store free-list contains duplicate indices"
                    ))
                );
            } else {
                assert_eq!(
                    validate_store(&store, &sig()).unwrap_err(),
                    StoreError::Snapshot(SnapshotError::Corrupt(
                        "store free-list index out of range"
                    ))
                );
            }
        }
    }

    #[test]
    fn malformed_slot_record_is_rejected_by_decoding() {
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        store_to_image(&store).unwrap();
        let bytes = store.slot_pages.get_mut(&0).unwrap();
        bytes[0] = 200; // not a Kind discriminant
        assert_eq!(
            store_to_image(&store).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("store slot page record"))
        );
    }

    /// No commit writes a zero token, and the validator names one; resume
    /// trusts it, and the next commit names it as its predecessor.
    #[test]
    fn validate_refuses_a_zero_commit_token() {
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        validate_store(&store, &sig()).unwrap();
        store.manifest.as_mut().unwrap().token = CommitToken::ZERO;
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("store manifest commit token zero"))
        );
        assert_eq!(
            crate::machine::resume_from_store(&store, &sig())
                .unwrap()
                .token(),
            CommitToken::ZERO
        );
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                2,
                CommitToken::ZERO,
            ))
            .unwrap();
        validate_store(&store, &sig()).unwrap();
    }

    #[test]
    fn validate_fails_closed_on_missing_row() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        // Drop a promised page: the inventory scan must name it.
        store.slot_pages.remove(&0);
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::MissingRow("slot page", 0)
        );
    }

    #[test]
    fn validate_fails_closed_on_row_length_mismatch() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        let short = store.slot_pages.get(&0).unwrap()[..SLOT_RECORD_BYTES].to_vec();
        store.slot_pages.insert(0, short);
        match validate_store(&store, &sig()) {
            Err(StoreError::RowLength {
                kind: "slot page",
                index: 0,
                ..
            }) => {}
            other => panic!("expected row-length failure, got {other:?}"),
        }
    }

    #[test]
    fn name_migration_section_end_refuses_address_overflow() {
        for (cursor, len, expected) in [
            (0, 0, 0),
            (4, 0, 4),
            (4, usize::MAX - 4, usize::MAX),
            (usize::MAX, 0, usize::MAX),
        ] {
            assert_eq!(name_migration_section_end(cursor, len), Ok(expected));
        }
        for (cursor, len) in [(4, usize::MAX - 3), (4, usize::MAX), (usize::MAX, 1)] {
            assert_eq!(
                name_migration_section_end(cursor, len),
                Err(SnapshotError::Corrupt("name migration length"))
            );
        }
    }

    #[test]
    fn image_transfer_takes_free_list_from_arena_segments() {
        let image = ran_image();
        let manifest = image_to_batch_unchecked(&image, 1, CommitToken::ZERO).manifest;
        let mut small = crate::snapshot_roster::small_from_image(&image);
        // A retired small-state payload must not override the reconstructed
        // arena's free-list segments, even if supplied by legacy tooling.
        small.slot_free = vec![u32::MAX];
        let rebuilt = crate::snapshot_roster::image_from_small(
            small,
            manifest,
            image.chunks.clone(),
            image.slots.clone(),
            image.slot_free.clone(),
        );
        assert_eq!(rebuilt, image);
    }

    #[test]
    fn legacy_decoder_preserves_section_order_and_truncation_errors() {
        let canonical = image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).small;
        // Historical framing order, independent of the roster and atom order.
        let labels = [
            "small state stack section",
            "small state free-list section",
            "small state keys section",
            "small state names section",
            "small state symbols section",
            "small state meter section",
            "small state arrays section",
            "small state collections section",
            "small state registry section",
            "small state errors section",
            "small state buffers section",
            "small state typed-arrays section",
            "small state data-views section",
            "small state wrappers section",
            "small state regexps section",
            "small state arguments section",
            "small state temporal section",
            "small state intl section",
            "small state name-floor section",
            "small state iterators section",
            "small state dates section",
            "small state function section",
            "small state proxy section",
            "small state accessor section",
            "small state Intl bound-function section",
            "small state private-element section",
            "small state disposable-stack section",
            "small state generator section",
            "small state error-frames section",
            "small state promise section",
            "small state async section",
            "small state index-props section",
        ];
        let sections = crate::store_sections::split_small_state(&canonical).unwrap();
        let mut offset = 0;
        for (payload, label) in sections.iter().zip(labels) {
            for cut in [offset, offset + 3] {
                assert_eq!(
                    SmallState::decode_legacy(&canonical[..cut]).unwrap_err(),
                    StoreError::Snapshot(SnapshotError::Corrupt(label))
                );
            }
            if !payload.is_empty() {
                let cut = offset + 4 + payload.len() - 1;
                assert_eq!(
                    SmallState::decode_legacy(&canonical[..cut]).unwrap_err(),
                    StoreError::Snapshot(SnapshotError::Corrupt(label))
                );
            }
            offset += 4 + payload.len();
        }
        assert_eq!(offset, canonical.len());
        let mut trailing = canonical;
        trailing.push(0);
        assert_eq!(
            SmallState::decode_legacy(&trailing).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("small state trailing bytes"))
        );
    }

    #[test]
    fn every_appended_table_accepts_legacy_empty_payload_only_at_migration_boundary() {
        let canonical = image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).small;
        let sections = crate::store_sections::split_small_state(&canonical).unwrap();
        // IDs 6 onward were appended as zero-width migration suffixes.
        // ID 18 is the optional floor: empty is already its canonical form.
        for id in (6..32).filter(|id| *id != 18) {
            let mut legacy_sections = sections;
            legacy_sections[id] = &[];
            let legacy = crate::store_sections::frame_small_state(&legacy_sections).unwrap();
            let decoded = SmallState::decode_legacy(&legacy).unwrap();
            let normalized = decoded.encode();
            assert_ne!(
                normalized, legacy,
                "section {id} requires canonical payload"
            );
            assert_eq!(
                SmallState::decode(&legacy).unwrap_err(),
                StoreError::Snapshot(SnapshotError::Corrupt("non-canonical small state"))
            );
            assert_eq!(
                SmallState::decode(&normalized).unwrap(),
                decoded,
                "section {id}"
            );
        }
    }

    #[test]
    fn name_migration_requires_complete_section_headers_and_bodies() {
        // Migration interprets only NAME; opaque earlier sections and the tail
        // must survive byte-for-byte. This tests the individual migration step.
        let mut small = Vec::new();
        let mut headers = Vec::new();
        for section in [
            vec![1],
            vec![2, 3],
            vec![4],
            encode_strings(&["name".into()]),
        ] {
            headers.push(small.len());
            small.extend_from_slice(&(section.len() as u32).to_be_bytes());
            small.extend_from_slice(&section);
        }
        let end = small.len();
        small.extend_from_slice(b"opaque tail");
        let migrated = names_to_cesu8(&small).unwrap();
        assert_eq!(&migrated[..headers[3]], &small[..headers[3]]);
        assert!(migrated.ends_with(b"opaque tail"));
        let names = encode_names(&[SymbolName::from("name")]);
        let mut expected = small[..headers[3]].to_vec();
        expected.extend_from_slice(&(names.len() as u32).to_be_bytes());
        expected.extend_from_slice(&names);
        expected.extend_from_slice(b"opaque tail");
        assert_eq!(migrated, expected);
        let mut manifest = image_to_batch_unchecked(&ran_image(), 1, CommitToken::ZERO).manifest;
        manifest.store_schema = 25;
        let mut stepped = small.clone();
        migrate_step(&mut manifest, &mut stepped).unwrap();
        assert_eq!((manifest.store_schema, stepped), (26, expected));
        for (index, &header) in headers.iter().enumerate() {
            for cut in header..header + 4 {
                assert_eq!(
                    names_to_cesu8(&small[..cut]),
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "name migration header"
                    )))
                );
            }
            let body_end = headers.get(index + 1).copied().unwrap_or(end);
            for cut in header + 4..body_end {
                assert_eq!(
                    names_to_cesu8(&small[..cut]),
                    Err(StoreError::Snapshot(SnapshotError::Corrupt(
                        "name migration body"
                    )))
                );
            }
        }
    }

    #[test]
    fn small_state_rejects_legacy_empty_sections_until_migrated() {
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        let canonical = store.read_small_state().unwrap();
        let mut offset = 0;
        for _ in 0..6 {
            let len =
                u32::from_be_bytes(canonical[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4 + len;
        }
        // The arrays table is empty, but its canonical encoding has a count.
        assert_eq!(&canonical[offset..offset + 8], &[0, 0, 0, 4, 0, 0, 0, 0]);
        let mut legacy = canonical.clone();
        legacy.drain(offset + 4..offset + 8);
        legacy[offset..offset + 4].copy_from_slice(&0u32.to_be_bytes());
        assert_eq!(
            SmallState::decode(&legacy).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("non-canonical small state"))
        );
        assert_eq!(
            SmallState::decode_legacy(&legacy).unwrap().encode(),
            canonical
        );
        let current = store.manifest().unwrap();
        let old = StoreManifest {
            store_schema: 26,
            ..current.clone()
        };
        store
            .replace_for_migration(&current, &old, &legacy)
            .unwrap();
        assert!(migrate_store(&mut store, &sig()).unwrap());
        validate_store_content(&store, &sig()).unwrap();
        assert_eq!(store.read_small_state().unwrap(), canonical);
        assert_eq!(store.manifest().unwrap(), current);
    }

    #[test]
    fn validate_fails_closed_on_accounting_mismatch() {
        let image = ran_image();
        let mut corrupt = image.clone();
        corrupt.slot_live += 1;
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&corrupt, 1, CommitToken::ZERO))
            .unwrap();
        assert_eq!(
            validate_store(&store, &sig()).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt(
                "store live/free/count accounting mismatch"
            ))
        );
        // Both resume paths refuse it too: eager resume as the slot arena is
        // built, lazy resume at open, before the arenas are sized.
        assert_eq!(
            crate::machine::resume_from_store(&store, &sig()).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt("invalid slot arena image"))
        );
        assert_eq!(
            crate::machine::resume_from_store_lazy(
                std::rc::Rc::new(std::cell::RefCell::new(store)),
                &sig()
            )
            .unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt(
                "store live/free/count accounting mismatch"
            ))
        );
    }

    /// A migration validates its result against the store's rows at the
    /// metadata scale before its one write: a defect no ladder step reads
    /// (here, the live/free accounting) refuses the migration and leaves
    /// the store as it was.
    #[test]
    fn a_migration_refuses_what_the_metadata_scale_validator_refuses_before_writing() {
        let mut corrupt = ran_image();
        corrupt.slot_live += 1;
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&corrupt, 1, CommitToken::ZERO))
            .unwrap();
        // Restamp it one identity step back, so the ladder runs.
        let current = store.manifest().unwrap();
        let old = StoreManifest {
            store_schema: STORE_SCHEMA_VERSION - 1,
            ..current.clone()
        };
        let small = store.read_small_state().unwrap();
        store.replace_for_migration(&current, &old, &small).unwrap();
        assert_eq!(
            migrate_store(&mut store, &sig()).unwrap_err(),
            StoreError::Snapshot(SnapshotError::Corrupt(
                "store live/free/count accounting mismatch"
            ))
        );
        assert_eq!(store.manifest().unwrap(), old, "nothing is written");
        assert_eq!(store.read_small_state().unwrap(), small);
    }

    /// A reference store with one read skewed: a durable manifest that reads
    /// one way while the handle's reads show another (`reread`), or a small
    /// state that cannot be read (`small_unreadable`).
    struct ProbeStore {
        inner: MemoryStore,
        reread: Option<StoreManifest>,
        small_unreadable: bool,
    }

    impl HeapStore for ProbeStore {
        fn manifest(&self) -> Result<StoreManifest, StoreError> {
            self.inner.manifest()
        }
        fn reread_manifest(&self) -> Result<StoreManifest, StoreError> {
            match &self.reread {
                Some(manifest) => Ok(manifest.clone()),
                None => self.inner.reread_manifest(),
            }
        }
        fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
            if self.small_unreadable {
                return Err(StoreError::Io("small state unreadable".to_string()));
            }
            self.inner.read_small_state()
        }
        fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
            self.inner.read_slot_page(page)
        }
        fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
            self.inner.read_chunk_extent(ext)
        }
        fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
            self.inner.inventory()
        }
        fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
            self.inner.read_free_seg(seg)
        }
        fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
            self.inner.page_edges()
        }
        fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
            self.inner.commit_verified(verify)
        }
        fn replace_for_migration(
            &mut self,
            from: &StoreManifest,
            to: &StoreManifest,
            small: &[u8],
        ) -> Result<(), StoreError> {
            self.inner.replace_for_migration(from, to, small)
        }
    }

    /// A migration refuses a store that moved since it read the durable
    /// manifest (another handle's migration or commit): before it reads
    /// through a handle whose view is not that manifest, and in the write
    /// itself, a compare-and-swap on it. Either way nothing is written.
    #[test]
    fn a_migration_refuses_a_store_that_moved_since_it_read_it() {
        let mut inner = MemoryStore::new();
        inner
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        let current = inner.manifest().unwrap();
        let small = inner.read_small_state().unwrap();
        let stale = StoreManifest {
            store_schema: STORE_SCHEMA_VERSION - 1,
            ..current.clone()
        };
        // An unreadable small state: the refusal comes before the read.
        let mut store = ProbeStore {
            inner,
            reread: Some(stale.clone()),
            small_unreadable: true,
        };
        let label = |m: &StoreManifest| {
            format!(
                "schema {} epoch {} token {}",
                m.store_schema, m.epoch, m.token
            )
        };
        assert_eq!(
            migrate_store(&mut store, &sig()).unwrap_err(),
            StoreError::BaselineMismatch {
                expected: label(&stale),
                found: label(&current),
            }
        );
        assert_eq!(store.inner.manifest().unwrap(), current);
        assert_eq!(store.inner.read_small_state().unwrap(), small);
        // The hook itself, on the reference store: it compares `from` with
        // the stored manifest, an empty store has nothing to replace, and a
        // matching one is replaced verbatim.
        assert_eq!(
            store.inner.replace_for_migration(&stale, &current, &small),
            Err(StoreError::BaselineMismatch {
                expected: label(&stale),
                found: label(&current),
            })
        );
        assert_eq!(store.inner.manifest().unwrap(), current);
        assert_eq!(
            MemoryStore::new().replace_for_migration(&current, &stale, &small),
            Err(StoreError::Empty)
        );
        store
            .inner
            .replace_for_migration(&current, &stale, &small)
            .unwrap();
        assert_eq!(store.inner.manifest().unwrap(), stale);
    }

    /// Open and the metadata-scale validator answer the compatibility gates
    /// before they read the small state, so a store this build cannot open
    /// is refused as such, even when its small state cannot be read.
    #[test]
    fn the_open_gates_run_before_the_small_state_is_read() {
        let mut inner = MemoryStore::new();
        inner
            .commit(&image_to_batch_unchecked(
                &ran_image(),
                1,
                CommitToken::ZERO,
            ))
            .unwrap();
        let current = inner.manifest().unwrap();
        let older = StoreManifest {
            store_schema: STORE_SCHEMA_VERSION - 1,
            ..current.clone()
        };
        let small = inner.read_small_state().unwrap();
        inner
            .replace_for_migration(&current, &older, &small)
            .unwrap();
        let store = ProbeStore {
            inner,
            reread: None,
            small_unreadable: true,
        };
        let needs = || StoreError::NeedsMigration {
            found: STORE_SCHEMA_VERSION - 1,
        };
        assert_eq!(validate_store(&store, &sig()).err(), Some(needs()));
        assert_eq!(open_store(&store, &sig()).err(), Some(needs()));
    }

    /// Lazy resume sizes its arenas from the manifest's geometry, so open
    /// refuses a geometry that promises rows the store does not hold, on
    /// the tail row, before anything is allocated from it.
    #[test]
    fn lazy_open_refuses_a_geometry_its_tail_rows_do_not_back() {
        let image = ran_image();
        let batch = image_to_batch_unchecked(&image, 1, CommitToken::ZERO);
        let lazy = |store: MemoryStore| {
            crate::machine::resume_from_store_lazy(
                std::rc::Rc::new(std::cell::RefCell::new(store)),
                &sig(),
            )
            .map(drop)
        };
        let pages = slot_page_count(batch.manifest.slot_count);
        let exts = chunk_extent_count(batch.manifest.chunk_len);
        assert!(pages > 0 && exts > 0, "the fixture has rows of both kinds");
        for (label, edit, refusal) in [
            (
                "slot count",
                (|m: &mut StoreManifest| {
                    m.slot_count += 1 << 30;
                    m.slot_live += 1 << 30;
                }) as fn(&mut StoreManifest),
                StoreError::MissingRow("slot page", pages - 1 + (1 << 22)),
            ),
            (
                "chunk length",
                |m: &mut StoreManifest| m.chunk_len += 1 << 30,
                StoreError::MissingRow("chunk extent", exts - 1 + (1 << 14)),
            ),
        ] {
            let mut store = MemoryStore::new();
            store.commit(&batch).unwrap();
            edit(store.manifest.as_mut().unwrap());
            assert_eq!(lazy(store).unwrap_err(), refusal, "{label}");
        }
        // The tail row at the wrong length is refused the same way.
        let mut store = MemoryStore::new();
        store.commit(&batch).unwrap();
        let manifest = store.manifest.as_mut().unwrap();
        if chunk_extent_len(manifest.chunk_len, exts - 1) > 1 {
            manifest.chunk_len -= 1;
        } else {
            manifest.chunk_len += 1;
        }
        assert!(matches!(
            lazy(store).unwrap_err(),
            StoreError::RowLength {
                kind: "chunk extent",
                ..
            }
        ));
    }

    /// A shrink (the GC-compaction shape) drops stale rows: a later
    /// geometry never resurrects bytes from a dead extent.
    #[test]
    fn commit_drops_rows_beyond_the_new_geometry() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        let exts_before = chunk_extent_count(store.manifest().unwrap().chunk_len);

        // Same machine state, chunk arena "compacted" to empty. A real
        // compaction rewrites every stored chunk offset with the bytes
        // it moves; mirror that coherence (the image bounds gate
        // refuses an image whose slots point into chunks it lacks) by
        // degrading chunk-bearing slots to chunk-free values in place —
        // chain links, ids, and accounting untouched.
        let mut shrunk = image.clone();
        shrunk.chunks = Vec::new();
        for slot in shrunk.slots.iter_mut().chain(shrunk.stack.iter_mut()) {
            if slot.chunk_ref().is_some() {
                slot.kind = ironhorse_vm::Kind::Integer;
                slot.value = ironhorse_vm::Payload::Integer(0);
            }
        }
        // Function name chunks are external chunk holders. This
        // geometry-only fixture drops the corresponding function rows
        // together with the arena bytes.
        shrunk.function_state = ironhorse_vm::snapshot_api::FunctionStateSnapshot::default();
        let prev = store.manifest().unwrap().token;
        let mut batch = image_to_batch_unchecked(&shrunk, 2, prev);
        batch.chunk_extents.clear(); // nothing to write; drop-only
        store.commit(&batch).unwrap();

        assert!(exts_before > 0, "the fixture must have had chunk bytes");
        assert!(store.chunk_extents.is_empty(), "stale extents dropped");
        // The exported form agrees with the shrunk image.
        assert_eq!(store_to_image(&store).unwrap().chunks, Vec::<u8>::new());
    }

    #[test]
    fn memory_store_reports_commit_stats() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        let batch = image_to_batch_unchecked(&image, 1, CommitToken::ZERO);
        store.commit(&batch).unwrap();
        assert_eq!(
            store.last_commit_stats(),
            CommitStats {
                slot_pages_written: batch.slot_pages.len(),
                chunk_extents_written: batch.chunk_extents.len(),
                free_segs_written: batch.free_segs.len(),
                small_sections_written: crate::store_sections::SMALL_SECTION_COUNT,
                small_bytes_written: batch.small.len()
                    - 4 * crate::store_sections::SMALL_SECTION_COUNT,
            }
        );
    }

    /// The segment split at exactly the `FREE_SEG_ENTRIES` boundary
    /// (and one past it, and empty): counts, per-segment lengths, and
    /// ORDER-exact reassembly: the LIFO reuse order determines allocation
    /// identity after resume.
    #[test]
    fn free_seg_boundaries_split_and_reassemble_exactly() {
        let b = FREE_SEG_ENTRIES;
        for n in [0u32, 1, b - 1, b, b + 1, 2 * b, 2 * b + 1] {
            let free: Vec<u32> = (0..n).rev().collect();
            let segs = encode_all_free_segs(&free);
            assert_eq!(segs.len(), free_seg_count(n) as usize, "count at n={n}");
            let mut back: Vec<u32> = Vec::new();
            for (k, (idx, bytes)) in segs.iter().enumerate() {
                assert_eq!(*idx as usize, k, "dense ascending segment indices");
                assert_eq!(
                    bytes.len(),
                    free_seg_len(n, *idx) * 4,
                    "exact per-segment length at n={n}, seg={idx}"
                );
                back.extend(
                    bytes
                        .chunks_exact(4)
                        .map(|c| u32::from_be_bytes(c.try_into().unwrap())),
                );
            }
            assert_eq!(back, free, "order-exact reassembly at n={n}");
        }
    }

    #[test]
    fn commit_refuses_a_geometry_change_that_omits_the_affected_tail_row() {
        // The grown-region check
        // covers indexes the new geometry ADDS, but a total that
        // changes WITHIN the existing tail row changes that row's
        // geometry-derived length without adding any index. A crafted
        // batch that shrinks `chunk_len` inside the same extent and
        // omits that extent must be refused at COMMIT — not discovered
        // at the next open as a length mismatch.
        let mut m = Interp::new();
        assert!(m.run(&PROG_A).completed);
        let image1 = m.snapshot_image_for_testing(&sig()).expect("gated image");
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image1, 1, CommitToken::ZERO))
            .unwrap();
        let prev = store.manifest().unwrap();

        let mut image2 = image1.clone();
        assert!(
            image2.chunks.len() >= 8,
            "fixture carries chunk bytes to shrink within the tail extent"
        );
        image2.chunks.truncate(image2.chunks.len() - 4);
        let tail_ext = chunk_extent_count(image2.chunks.len() as u64) - 1;

        // A well-formed batch for the shrunk image commits fine (the
        // tail extent travels with its new length)…
        let good = image_to_batch_unchecked(&image2, 2, prev.token);
        assert!(
            good.chunk_extents.iter().any(|(e, _)| *e == tail_ext),
            "image_to_batch ships the affected tail extent"
        );
        {
            let mut s2 = MemoryStore::new();
            s2.commit(&image_to_batch_unchecked(&image1, 1, CommitToken::ZERO))
                .unwrap();
            let token = s2.manifest().unwrap().token;
            s2.commit(&image_to_batch_unchecked(&image2, 2, token))
                .unwrap();
        }

        // …but the same batch with the tail extent OMITTED is refused
        // with the precise missing-row error.
        let mut crafted = image_to_batch_unchecked(&image2, 2, prev.token);
        crafted.chunk_extents.retain(|(e, _)| *e != tail_ext);
        // Wrapped: the omission is in the CALLER's batch, so the store is
        // not implicated and a supervisor should refuse the request rather
        // than tear the session down.
        assert_eq!(
            store.commit(&crafted),
            Err(StoreError::BatchRejected(Box::new(StoreError::MissingRow(
                "chunk extent",
                tail_ext
            )))),
            "the boundary row must travel when its expected length changes"
        );
    }

    /// Every traveling row and summary must lie inside the batch's own
    /// geometry: a backend writes rows by index, and one past the end would
    /// survive in the store. The refusal is the caller's, and nothing is
    /// written.
    #[test]
    fn commit_refuses_rows_and_summaries_past_the_batch_geometry() {
        let image = ran_image();
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&image, 1, CommitToken::ZERO))
            .unwrap();
        let prev = store.manifest().unwrap();
        let batch = image_to_batch_unchecked(&image, 2, prev.token);
        let pages = slot_page_count(batch.manifest.slot_count);
        let exts = chunk_extent_count(batch.manifest.chunk_len);
        let frees = free_seg_count(batch.manifest.free_len);
        let mut page = batch.clone();
        page.slot_pages.push((pages, batch.slot_pages[0].1.clone()));
        page.page_edges.push((pages, Vec::new()));
        let mut summary = batch.clone();
        summary.page_edges.push((pages + 3, Vec::new()));
        let mut extent = batch.clone();
        extent.chunk_extents.push((exts, vec![0; 4]));
        let mut segment = batch.clone();
        segment.free_segs.push((frees, Vec::new()));
        for (bad, kind, index) in [
            (page, "slot page", pages),
            (summary, "page-edge summary", pages + 3),
            (extent, "chunk extent", exts),
            (segment, "free segment", frees),
        ] {
            assert_eq!(
                store.commit(&bad),
                Err(StoreError::BatchRejected(Box::new(StoreError::MissingRow(
                    kind, index
                )))),
                "{kind}"
            );
            assert_eq!(store.manifest().unwrap(), prev);
        }
        store.commit(&batch).unwrap();
    }
}
