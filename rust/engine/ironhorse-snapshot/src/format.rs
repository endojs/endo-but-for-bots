//! The snapshot format constants: the FourCC atom tags, the Ironhorse `VERS`
//! discriminator, and the host `SIGN` callback-table signature scheme
//! (design `designs/ironhorse-engine.md` § Snapshots; the signature
//! discipline from `designs/daemon-xs-worker-snapshot.md`).

use crate::atom::AtomError;

/// A 4-byte FourCC atom tag (big-endian ASCII, as in `xsSnapshot.c`).
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
pub struct FourCc(pub [u8; 4]);

impl FourCc {
    /// The tag rendered as text, for diagnostics.
    pub fn as_str(&self) -> &str {
        std::str::from_utf8(&self.0).unwrap_or("????")
    }
}

/// The outer container envelope (XS's machine snapshot container).
pub const XS_M: FourCc = FourCc(*b"XS_M");

/// `VERS` — engine version, slot width, endianness, plus the Ironhorse
/// discriminator ([`IRONHORSE_MAGIC`]).
pub const VERS: FourCc = FourCc(*b"VERS");
/// `SIGN` — host callback-table signature.
pub const SIGN: FourCc = FourCc(*b"SIGN");
/// `CREA` — machine creation parameters.
pub const CREA: FourCc = FourCc(*b"CREA");
/// `BLOC` — chunk-heap (byte-arena) data.
pub const BLOC: FourCc = FourCc(*b"BLOC");
/// `HEAP` — slot-heap images (the flat slot-record array + free list).
pub const HEAP: FourCc = FourCc(*b"HEAP");
/// `STAC` — the interpreter's live stack slots.
pub const STAC: FourCc = FourCc(*b"STAC");
/// `KEYS` — the key table (runtime-interned property keys).
pub const KEYS: FourCc = FourCc(*b"KEYS");
/// `NAME` — the name table (program symbol names, id-ordered).
pub const NAME: FourCc = FourCc(*b"NAME");
/// `SYMB` — the symbol table (well-known / registered symbol identities).
pub const SYMB: FourCc = FourCc(*b"SYMB");
/// `METR` — the metering state (design row 6): the frozen 16.16
/// fixed-point counters plus the cost-table version that produced them,
/// so a resumed machine continues its meter exactly. Ironhorse-specific (XS
/// carries meter state differently), which the Ironhorse `VERS` discriminator
/// already fences off.
pub const METR: FourCc = FourCc(*b"METR");
/// `ARRY` — the arrays side table (side-table ledger `Arrays` row):
/// per-instance spec length + sparse item map. Ironhorse-specific (XS
/// keeps array items in chunks); **emitted only when non-empty**, so
/// side-table-free machines keep their exact pre-ledger container
/// bytes — the CAS/blob identity every golden vector pins.
pub const ARRY: FourCc = FourCc(*b"ARRY");
/// `COLL` — the collections side table (ledger `Collections` row):
/// Map/Set/WeakMap/WeakSet kind, table geometry, and insertion-ordered
/// entries. Ironhorse-specific; emitted only when non-empty (see
/// [`ARRY`]).
pub const COLL: FourCc = FourCc(*b"COLL");
/// `REGY` — the `Symbol.for` registry (ledger `SymbolRegistry` row):
/// key bytes → descriptor slot, pairwise. Ironhorse-specific; emitted
/// only when non-empty (see [`ARRY`]). Distinct from `KEYS`/`SYMB`,
/// which keep their XS meanings (runtime-interned property keys /
/// well-known symbol identities) for the ledger rows still pending.
pub const REGY: FourCc = FourCc(*b"REGY");
/// `ERRD` — the error-data side table (ledger `ErrorData` row): per
/// Error instance, the construction-time constructor name and optional
/// message the abort-value render consults. Ironhorse-specific;
/// emitted only when non-empty (see [`ARRY`]).
pub const ERRD: FourCc = FourCc(*b"ERRD");
/// `ABUF` — the array-buffers side table (ledger `ArrayBuffers` row):
/// per instance, the backing chunk offset + byte length + brand flags
/// (detached/shared). The backing BYTES travel in `BLOC`; this is the
/// geometry that makes them readable. Ironhorse-specific; emitted only
/// when non-empty (see [`ARRY`]).
pub const ABUF: FourCc = FourCc(*b"ABUF");
/// `TARR` — the typed-arrays side table (ledger `TypedArrays` row):
/// per view, element kind + buffer slot + byte offset + element
/// length. Ironhorse-specific; emitted only when non-empty (see
/// [`ARRY`]).
pub const TARR: FourCc = FourCc(*b"TARR");
/// `DVIW` — the data-views side table (ledger `DataViews` row): per
/// view, buffer slot + byte offset + byte length. Ironhorse-specific;
/// emitted only when non-empty (see [`ARRY`]).
pub const DVIW: FourCc = FourCc(*b"DVIW");
/// `WRAP` — the primitive-wrapper side table (ledger `WrapperData`
/// row): per wrapper instance, its boxed value slot. Ironhorse-specific;
/// emitted only when non-empty (see [`ARRY`]).
pub const WRAP: FourCc = FourCc(*b"WRAP");
/// `REGX` — the regular-expression side table (ledger `RegExps` row): per
/// instance, `(source, flags, legacyLastIndex)`; current lastIndex state rides
/// its ordinary `HEAP` property, while the compiled program recompiles from
/// the pair at restore. Ironhorse-specific; emitted only when non-empty (see
/// [`ARRY`]).
pub const REGX: FourCc = FourCc(*b"REGX");
/// `ARGB` — the arguments-exotic brand set (the `Arrays` row's
/// satellite): the branded owners, ascending. Ironhorse-specific;
/// emitted only when non-empty (see [`ARRY`]).
pub const ARGB: FourCc = FourCc(*b"ARGB");
/// `TMPR` — the four Temporal record tables (ledger `TemporalRecords`
/// row): instants, durations, plains, zoneds, each owner-ascending.
/// Ironhorse-specific; emitted only when non-empty (see [`ARRY`]).
pub const TMPR: FourCc = FourCc(*b"TMPR");
/// `ITER` — the built-in iterator cursors (ledger `Iterators` row):
/// array/string/for-in/collection cursors, owner-ascending, with the
/// collection cursors carried as live-entry ordinals and staleness
/// folded into `done` (see the vm's `IteratorRow`). Ironhorse-specific;
/// emitted only when non-empty (see [`ARRY`]).
pub const ITER: FourCc = FourCc(*b"ITER");
/// `DATE` — Date `[[DateValue]]` records (ledger `Dates` row): owner
/// plus raw IEEE-754 bits, owner-ascending. Ironhorse-specific;
/// emitted only when non-empty (see [`ARRY`]).
pub const DATE: FourCc = FourCc(*b"DATE");
/// `FUNC` — the atomic guest-callability cluster: retained bytecode
/// segments, guest/bound function metadata, constructor→prototype links,
/// and deleted `.name`/`.length` tombstones.
pub const FUNC: FourCc = FourCc(*b"FUNC");
/// `PROX` — proxy target/handler/revocation records and revoker links.
pub const PROX: FourCc = FourCc(*b"PROX");
/// `ACCS` — guest accessor getter/setter mappings.
pub const ACCS: FourCc = FourCc(*b"ACCS");
/// `IBFN` — runtime Intl bound compare/format function links.
pub const IBFN: FourCc = FourCc(*b"IBFN");
/// `PRIV` — private value and accessor elements keyed by receiver and
/// lexical brand slots.
pub const PRIV: FourCc = FourCc(*b"PRIV");
/// `DISP` — DisposableStack/AsyncDisposableStack state and records.
pub const DISP: FourCc = FourCc(*b"DISP");
/// `GENR` — synchronous generator lifecycle and saved activations.
pub const GENR: FourCc = FourCc(*b"GENR");
/// `PRMS` — the promise cluster: per-instance settlement state and
/// pending reactions, resolving-function links, `[[AlreadyResolved]]`
/// guards, and combinator accumulators, cross-validated as one unit.
pub const PRMS: FourCc = FourCc(*b"PRMS");

/// The error-frame side table: the call-frame names an Error captured at
/// CONSTRUCTION, which the `stack` accessor renders. Its own atom rather
/// than wider `ERRD` rows, so an older container stays an
/// encoding-identical subset and the read range keeps its meaning.
pub const ESTK: FourCc = FourCc(*b"ESTK");
/// `NFLR` — the installed-names floor (wave-6 W6-7): the id ceiling at
/// or below which partial install passes leave bindings alone. Four
/// big-endian bytes. Emitted only when it differs from the name-table
/// length (the conservative default a floor-less restore assumes), so
/// pre-floor containers and floor-at-table machines stay byte-stable.
pub const NFLR: FourCc = FourCc(*b"NFLR");
/// `INTL` — the nine Intl record tables (ledger `IntlRecords` row):
/// locales, collators, list formats, plural rules, number formats,
/// segmenters, segments, segment iterators, date-time formats, each
/// owner-ascending. Pure resolved-options data; the bound-function
/// link satellites travel with the `functions` row, not here.
/// Ironhorse-specific; emitted only when non-empty (see [`ARRY`]).
pub const INTL: FourCc = FourCc(*b"INTL");

/// The writer's canonical atom order — exactly the sequence
/// [`crate::image::write_machine`] emits (optional atoms simply absent
/// when their tables are empty). The reader requires a container's
/// atom sequence to be an IN-ORDER SUBSEQUENCE of this list: `find`
/// is order-blind and skips tags it does not know, so without the
/// gate a reordered container, or one carrying a junk-tagged atom,
/// would be a second accepted byte string for the same logical
/// machine — and one logical machine must have exactly one container
/// encoding, or its SHA-256 CAS key is not an identity. Refusing
/// UNKNOWN tags is sound because the `VERS` range gate runs first: a
/// container from a newer format (the one honest source of new tags)
/// is already refused by version.
pub const CANONICAL_ATOM_ORDER: &[FourCc] = &[
    VERS, SIGN, CREA, BLOC, HEAP, STAC, KEYS, NAME, SYMB, METR, ARRY, COLL, REGY, ERRD, ESTK,
    ABUF, TARR, DVIW, WRAP, REGX, ARGB, TMPR, INTL, ITER, DATE, FUNC, PROX, ACCS, IBFN, PRIV,
    DISP, GENR, PRMS, NFLR,
];

/// The Ironhorse discriminator embedded at the head of the `VERS` atom. An
/// Ironhorse snapshot is never mistaken for an XS one and vice versa
/// (design § Snapshots requirement 1c): XS's `VERS` payload begins with
/// its own version bytes, never this magic, so a reader that checks the
/// magic fails closed on a foreign container. The XS importer is out of
/// scope (resolved question 3), so this is the only `VERS` shape Ironhorse
/// reads.
pub const IRONHORSE_MAGIC: [u8; 4] = *b"IRON";

/// The Ironhorse snapshot format version — the stamp every writer
/// emits. Bumped on any change to the atom layout or the slot-record
/// encoding, INCLUDING the addition of state-bearing atoms (review
/// finding 1): version 2 marks the initial side-table atom family
/// (`ARRY`…`INTL`/`ITER`/`NFLR`), so a version-1 reader — which skips
/// unknown atoms and would silently drop arrays, collections, RegExps,
/// Intl records and iterator cursors — refuses a version-2 container
/// outright instead of resuming a degraded machine. Version 3 adds
/// the `DATE` state-bearing atom, which a version-2 reader would
/// likewise skip. Version 4 adds the atomic `FUNC` callability cluster;
/// version 5 adds proxy internal slots; version 6 adds accessors;
/// version 7 adds Intl bound-function links; version 8 adds private
/// elements; version 9 adds disposable stacks; version 10 adds
/// synchronous generators; version 11 adds error construction frames
/// (`ESTK`); version 12 adds the promise cluster (`PRMS`).
/// The reader accepts
/// [`IRONHORSE_FORMAT_VERSION_MIN_READ`]`..=`this and refuses anything
/// newer.
pub const IRONHORSE_FORMAT_VERSION: u32 = 12;

/// The oldest format version this reader still decodes. Version-1
/// containers predate the version-2 stamp; every version-1 writer in
/// this lineage either emitted the same atom encodings this reader
/// knows or refused machines whose state could not travel (the ledger
/// Pending gates), so reading them is sound — their absent side-table
/// atoms genuinely mean empty tables.
pub const IRONHORSE_FORMAT_VERSION_MIN_READ: u32 = 1;

/// Slot-record width tag written into `VERS`: Ironhorse's serialized slot
/// image is a fixed [`crate::slot_codec::SLOT_RECORD_BYTES`]-byte record
/// (its own encoding, not XS's 32-byte in-memory `txSlot`), recorded so a
/// reader can reject a snapshot whose record width it cannot decode.
pub const SLOT_WIDTH_TAG: u8 = crate::slot_codec::SLOT_RECORD_BYTES as u8;

/// Endianness marker (multi-byte integers in the atom grammar are always
/// big-endian, as in `xsSnapshot.c`; the byte records this explicitly so a
/// future little-endian variant is a version bump, not a silent
/// misread). `0x01` = big-endian.
pub const ENDIAN_BIG: u8 = 0x01;

/// The decoded `VERS` atom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Version {
    pub format_version: u32,
    pub slot_width: u8,
    pub endian: u8,
}

impl Version {
    /// The current ironhorse version stamp.
    pub fn current() -> Version {
        Version {
            format_version: IRONHORSE_FORMAT_VERSION,
            slot_width: SLOT_WIDTH_TAG,
            endian: ENDIAN_BIG,
        }
    }

    /// Serialize the `VERS` payload: `ENDR` magic, then version, slot
    /// width, endianness.
    pub fn encode(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(4 + 4 + 1 + 1);
        v.extend_from_slice(&IRONHORSE_MAGIC);
        v.extend_from_slice(&self.format_version.to_be_bytes());
        v.push(self.slot_width);
        v.push(self.endian);
        v
    }

    /// Decode a `VERS` payload, enforcing the ironhorse discriminator and a
    /// known format version.
    pub fn decode(payload: &[u8]) -> Result<Version, VersionError> {
        if payload.len() < 10 {
            return Err(VersionError::Truncated);
        }
        if payload[0..4] != IRONHORSE_MAGIC {
            let mut m = [0u8; 4];
            m.copy_from_slice(&payload[0..4]);
            return Err(VersionError::NotIronhorse(m));
        }
        let format_version = u32::from_be_bytes([payload[4], payload[5], payload[6], payload[7]]);
        // The read RANGE, not the write stamp: an older readable
        // version decodes (its atoms are a subset with the same
        // encodings), while a NEWER one is refused — its atoms may
        // carry state this reader would silently skip (review
        // finding 1).
        if !(IRONHORSE_FORMAT_VERSION_MIN_READ..=IRONHORSE_FORMAT_VERSION)
            .contains(&format_version)
        {
            return Err(VersionError::UnsupportedVersion(format_version));
        }
        let slot_width = payload[8];
        if slot_width != SLOT_WIDTH_TAG {
            return Err(VersionError::SlotWidthMismatch {
                expected: SLOT_WIDTH_TAG,
                found: slot_width,
            });
        }
        let endian = payload[9];
        if endian != ENDIAN_BIG {
            return Err(VersionError::UnsupportedEndian(endian));
        }
        Ok(Version {
            format_version,
            slot_width,
            endian,
        })
    }

    /// Whether THIS reader decodes a container/store stamped `self`: a
    /// format version inside the read range with the one slot width and
    /// endianness. Every [`Version::decode`] survivor satisfies it; the
    /// store's open gate re-checks it explicitly rather than comparing
    /// equality with [`Version::current`], so an older readable stamp
    /// opens (and migrates) instead of failing as a mismatch.
    pub fn is_readable(&self) -> bool {
        (IRONHORSE_FORMAT_VERSION_MIN_READ..=IRONHORSE_FORMAT_VERSION)
            .contains(&self.format_version)
            && self.slot_width == SLOT_WIDTH_TAG
            && self.endian == ENDIAN_BIG
    }
}

/// A `VERS` atom that ironhorse refuses to read.
#[derive(Debug, PartialEq, Eq)]
pub enum VersionError {
    Truncated,
    /// The `VERS` payload did not carry the [`IRONHORSE_MAGIC`] discriminator —
    /// a foreign (e.g. XS) snapshot, whose import is out of scope.
    NotIronhorse([u8; 4]),
    UnsupportedVersion(u32),
    SlotWidthMismatch { expected: u8, found: u8 },
    UnsupportedEndian(u8),
}

/// The current boot-object layout generation. Bump this whenever
/// `Interp::create_intrinsics` changes any boot-derived slot identity or
/// metadata table. The engine-owned suffix prevents a host from accidentally
/// reusing its callback signature across an incompatible boot change.
pub const BOOT_LAYOUT_VERSION: u32 = 7;

const BOOT_LAYOUT_SIGNATURE_KEY: &str = "|ironhorse-boot=";

/// The ENGINE-COMPATIBILITY signature (`SIGN`). Identifies the engine build a
/// snapshot was written against, and gates adoption fail-closed: a reader
/// whose signature differs from the snapshot's refuses the read before any
/// restore runs, exactly as `fxReadSnapshot` does.
///
/// It covers two layouts, and a change to EITHER must bump it:
///
/// 1. **The host callback table.** Append-only: new host functions are
///    added at the end and existing indices never change (per
///    `designs/daemon-xs-worker-snapshot.md` § Callback table binding).
///    A callback index would otherwise bind to the wrong host function.
///
/// 2. **The boot-derived `SlotIndex` layout** — every slot
///    `create_intrinsics` allocates below `boot_slot_count`. Adoption
///    boots a fresh machine and then REPLACES its arenas with the
///    image's, so the boot-derived maps keyed by slot index (`functions`
///    above all, and every `*_proto` field) survive from the CURRENT
///    boot rather than being rebuilt from the snapshot. A container
///    written under a different boot layout would therefore attach this
///    build's boot metadata to the image's unrelated slots — silently.
///    Nothing else catches it: `boot_slot_count` is not serialized, and
///    `VERS` versions the WIRE SCHEMA (the atom set), not the heap the
///    atoms describe.
///
/// [`Signature::new`] appends the engine-owned boot-layout generation to the
/// host-provided callback-table signature. Store-backed workers and exported
/// containers are expected to survive daemon replacement and compatible
/// engine upgrades, so "same build only" is not an acceptable contract; this
/// makes the cross-build promise checkable without relying on every host to
/// remember a separate bump. Locked by
/// `crafted_row_refusals::a_container_from_a_foreign_boot_layout_is_refused`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Signature(String);

impl Signature {
    pub fn new(s: impl Into<String>) -> Signature {
        Signature(format!(
            "{}{BOOT_LAYOUT_SIGNATURE_KEY}{BOOT_LAYOUT_VERSION}",
            s.into()
        ))
    }

    /// Serialize the `SIGN` payload (the raw signature bytes).
    pub fn encode(&self) -> Vec<u8> {
        self.0.as_bytes().to_vec()
    }

    /// Decode a `SIGN` payload.
    pub fn decode(payload: &[u8]) -> Result<Signature, SignatureError> {
        match std::str::from_utf8(payload) {
            Ok(s) => Ok(Signature(s.to_string())),
            Err(_) => Err(SignatureError::NotUtf8),
        }
    }

    /// Whether a snapshot written under `self` may be read by a machine
    /// whose current signature is `current`. Equality is required: any
    /// difference means the callback table changed layout, so indices
    /// cannot be trusted.
    pub fn is_compatible_with(&self, current: &Signature) -> bool {
        self == current
    }
}

/// A `SIGN` atom that cannot be decoded.
#[derive(Debug, PartialEq, Eq)]
pub enum SignatureError {
    NotUtf8,
}

/// Errors surfacing from a whole-container decode. Wraps the per-atom
/// framing, version, and signature failures.
#[derive(Debug, PartialEq, Eq)]
pub enum SnapshotError {
    Atom(AtomError),
    Version(VersionError),
    Signature(SignatureError),
    /// The host's current signature does not match the snapshot's — the
    /// callback table changed layout since the snapshot was written.
    SignatureMismatch { expected: Signature, found: Signature },
    /// The snapshot's cost-table version does not match this engine's
    /// frozen table ([`ironhorse_vm::COST_TABLE_VERSION`]) — resuming would
    /// continue a meter under changed weights. Fails closed, the metering
    /// analogue of [`SnapshotError::SignatureMismatch`] (design row 6).
    CostTableMismatch { expected: String, found: String },
    /// A required atom (`VERS`, `SIGN`, `HEAP`, …) was absent.
    MissingAtom(FourCc),
    /// A structural payload was malformed (wrong length, bad slot record).
    Corrupt(&'static str),
}

impl From<AtomError> for SnapshotError {
    fn from(e: AtomError) -> Self {
        SnapshotError::Atom(e)
    }
}
impl From<VersionError> for SnapshotError {
    fn from(e: VersionError) -> Self {
        SnapshotError::Version(e)
    }
}
impl From<SignatureError> for SnapshotError {
    fn from(e: SignatureError) -> Self {
        SnapshotError::Signature(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_round_trips() {
        let v = Version::current();
        let bytes = v.encode();
        assert_eq!(Version::decode(&bytes).unwrap(), v);
    }

    #[test]
    fn version_rejects_foreign_magic() {
        // A XS-shaped VERS payload begins with version bytes, not ENDR.
        let mut payload = vec![0x08, 0x03, 0x01, 0x00]; // e.g. "8.3.1.0"
        payload.extend_from_slice(&[0, 0, 0, 0, 0, 0]);
        assert_eq!(
            Version::decode(&payload),
            Err(VersionError::NotIronhorse([0x08, 0x03, 0x01, 0x00]))
        );
    }

    #[test]
    fn version_rejects_unknown_format() {
        let mut payload = IRONHORSE_MAGIC.to_vec();
        payload.extend_from_slice(&999u32.to_be_bytes());
        payload.push(SLOT_WIDTH_TAG);
        payload.push(ENDIAN_BIG);
        assert_eq!(
            Version::decode(&payload),
            Err(VersionError::UnsupportedVersion(999))
        );
    }

    fn stamped(format_version: u32) -> Vec<u8> {
        let mut payload = IRONHORSE_MAGIC.to_vec();
        payload.extend_from_slice(&format_version.to_be_bytes());
        payload.push(SLOT_WIDTH_TAG);
        payload.push(ENDIAN_BIG);
        payload
    }

    /// Review finding 1: each state-bearing atom family advances the
    /// write stamp so an older exact-match reader refuses instead of
    /// skipping unknown state. Version 2 introduced the initial ledger
    /// atoms; version 3 introduces Date records; version 4 introduces
    /// retained function state; versions 5 and 6 introduce proxy and
    /// accessor state; versions 7 and 8 introduce Intl bound functions
    /// private elements, disposable stacks, and generators.
    #[test]
    fn the_write_stamp_is_past_the_side_table_addition() {
        assert!(IRONHORSE_FORMAT_VERSION >= 10, "the generator atom is a format bump");
        assert_eq!(Version::current().format_version, IRONHORSE_FORMAT_VERSION);
    }

    /// The read RANGE: the previous version still decodes (its atoms
    /// are a subset with the same encodings)…
    #[test]
    fn version_accepts_the_previous_readable_format() {
        let v = Version::decode(&stamped(IRONHORSE_FORMAT_VERSION_MIN_READ)).unwrap();
        assert_eq!(v.format_version, IRONHORSE_FORMAT_VERSION_MIN_READ);
        assert!(v.is_readable());
    }

    /// …while a FUTURE version — atoms this reader would silently
    /// skip — is refused by name.
    #[test]
    fn version_rejects_a_future_format() {
        assert_eq!(
            Version::decode(&stamped(IRONHORSE_FORMAT_VERSION + 1)),
            Err(VersionError::UnsupportedVersion(IRONHORSE_FORMAT_VERSION + 1))
        );
    }

    #[test]
    fn signature_round_trips_and_gates() {
        let s = Signature::new("ironhorse-worker-v1");
        assert_eq!(
            s.encode(),
            b"ironhorse-worker-v1|ironhorse-boot=7",
            "the engine-owned boot generation travels with every host signature"
        );
        assert_eq!(Signature::decode(&s.encode()).unwrap(), s);
        assert!(s.is_compatible_with(&Signature::new("ironhorse-worker-v1")));
        assert!(!s.is_compatible_with(&Signature::new("ironhorse-worker-v2")));
    }
}
