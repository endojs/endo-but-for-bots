//! Persisted row schemas shared by capture and restore.
use super::*;

/// One serialized `arrays` row as [`Interp::arrays_snapshot`] hands it
/// out: `(owner slot, spec length, items ascending by index)`.
pub type ArraySnapshot = (u32, u32, Vec<(u32, Slot)>);

/// One serialized `index_props` row as [`Interp::index_props_snapshot`] hands
/// it out: `(owner slot, high-water mark, items ascending by index)`.
///
/// The middle field is NOT an array `length` — an ordinary object has none,
/// and nothing bounds the indices. It is the greatest index ever stored plus
/// one, which only rises, so a row may carry a high-water mark with no items
/// left under it: that is the tombstone `resident_indexed_limit` reads to keep
/// the array-iterator cursor domain a since-deleted index opened.
pub type IndexPropsSnapshot = (u32, u32, Vec<(u32, Slot)>);

/// One serialized `collections` row: `(owner slot, kind code,
/// table_length, entries in insertion order)`.
pub type CollectionSnapshot = (u32, u8, u32, Vec<(Slot, Slot)>);

/// One built-in iterator cursor as the snapshot carries it (the ledger
/// `Iterators` row, the `ITER` atom) — [`Interp::iterators_snapshot`]'s
/// emission and [`RestoreSession::restore_iterators`]'s input. Kinds: 0-2 array
/// values/keys/entries, 3 for-in enumerator, 4 string, 5-7 collection
/// keys/values/entries, 8 for an `Iterator.from` generic wrapper, and 9 for a
/// RegExp String Iterator. Two boundary
/// normalizations make the row pure data: a collection cursor's `index` is the
/// LIVE-ENTRY ORDINAL (the
/// `COLL` row compacts tombstones, so the ordinal IS the physical index
/// in the restored dense table), and `clear()`-staleness folds into
/// `done` (the absolute clear-generation counter is unobservable; only
/// "retired" is).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IteratorRow {
    pub owner: u32,
    pub kind: u8,
    /// The iterated slot (weak). `u32::MAX` — [`crate::value::SlotIndex::NULL`]
    /// — for a string iterator, whose text lives in `str_bytes`.
    pub iterable: u32,
    pub index: u32,
    pub done: bool,
    /// The reused `{value, done}` result object's slot. For kind 8, an
    /// internal arena holder containing the cached `next` value.
    pub result: u32,
    /// For-in keys as `(id, index)` pairs (`id == 0` ⇒ an array index).
    pub enum_keys: Vec<(u16, u32)>,
    /// A String or RegExp String Iterator's UTF-16BE input; kind 4 uses `index`
    /// as a byte offset.
    pub str_bytes: Vec<u8>,
}

/// One guest or bound function's serializable metadata.
#[derive(Clone, Debug, PartialEq)]
pub struct FunctionRow {
    pub owner: u32,
    pub segment: Option<u32>,
    pub body_start: Option<u64>,
    pub body_len: u64,
    pub closures: u32,
    pub name: String,
    pub arity: u32,
    pub name_chunk: u32,
    pub is_generator: bool,
    pub home: u32,
    pub class_derived: Option<bool>,
}

/// One `Function.prototype.bind` wrapper's internal slots.
#[derive(Clone, Debug, PartialEq)]
pub struct BoundFunctionRow {
    pub owner: u32,
    pub target: u32,
    pub this_arg: Slot,
    pub args: Vec<Slot>,
}

/// Atomic snapshot unit for guest callability.
///
/// Segment indices in `functions` refer to the compact `segments` vector.
/// Constructor links, bound data, and deleted metadata are bundled because
/// carrying any one without the function rows would restore a partial exotic.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct FunctionStateSnapshot {
    /// Boot-native name chunks move during GC even though their code and
    /// identities are rebuilt. None denotes the legacy boot-offset contract.
    /// Some carries the authoritative surviving subset; absent owners may
    /// already have been collected and their slots reused by guest objects.
    pub native_names: Option<Vec<(u32, u32)>>,
    pub segments: Vec<Vec<u8>>,
    pub functions: Vec<FunctionRow>,
    pub bound_functions: Vec<BoundFunctionRow>,
    pub ctor_prototypes: Vec<(u32, u32)>,
    pub deleted_meta: Vec<(u32, u16)>,
}

impl FunctionStateSnapshot {
    pub fn is_empty(&self) -> bool {
        self.native_names.is_none()
            && self.segments.is_empty()
            && self.functions.is_empty()
            && self.bound_functions.is_empty()
            && self.ctor_prototypes.is_empty()
            && self.deleted_meta.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyRow {
    pub owner: u32,
    pub target: u32,
    pub handler: u32,
    pub revoked: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProxyRevokerRow {
    pub owner: u32,
    pub proxy: u32,
    pub name_chunk: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProxyStateSnapshot {
    pub proxies: Vec<ProxyRow>,
    pub revokers: Vec<ProxyRevokerRow>,
}

impl ProxyStateSnapshot {
    pub fn is_empty(&self) -> bool {
        self.proxies.is_empty() && self.revokers.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AccessorRow {
    pub owner: u32,
    pub id: u16,
    pub get: Option<Slot>,
    pub set: Option<Slot>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IntlBoundFunctionRow {
    /// 0 = Collator compare, 1 = NumberFormat format.
    pub kind: u8,
    pub function: u32,
    pub owner: u32,
    pub name: String,
    pub name_chunk: u32,
    pub arity: u32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrivateValueRow {
    pub receiver: u32,
    pub brand: u32,
    pub value: Slot,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PrivateAccessorRow {
    pub receiver: u32,
    pub brand: u32,
    pub get: Option<Slot>,
    pub set: Option<Slot>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrivateElementSnapshot {
    pub values: Vec<PrivateValueRow>,
    pub accessors: Vec<PrivateAccessorRow>,
}

impl PrivateElementSnapshot {
    pub fn is_empty(&self) -> bool {
        self.values.is_empty() && self.accessors.is_empty()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DisposalRecordRow {
    pub resource: Slot,
    pub method: Slot,
    pub pass_resource: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DisposableStackRow {
    pub owner: u32,
    pub disposed: bool,
    pub asynchronous: bool,
    pub records: Vec<DisposalRecordRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SavedJumpRow {
    pub target_pc: u64,
    /// Canonical code-segment index. Legacy rows without this field resolve
    /// through the enclosing saved frame's current function.
    pub segment: Option<u32>,
    pub stack_offset: u64,
    pub locals_len: u64,
    pub id_map: Vec<(u16, u64)>,
    pub call_depth_offset: u64,
    pub env: Slot,
    pub flag: u8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SavedFrameRow {
    pub locals: Vec<Slot>,
    pub id_map: Vec<(u16, u64)>,
    pub args: Vec<Slot>,
    pub this_val: Slot,
    pub env: Slot,
    pub cur_func: u32,
    pub cur_target: bool,
    pub target_func: u32,
    pub strict: bool,
    pub result: Slot,
    pub stack_slice: Vec<Slot>,
    pub jumps: Vec<SavedJumpRow>,
    pub resume_pc: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GeneratorRow {
    /// 0 = SuspendedStart, 1 = SuspendedYield, 2 = Completed.
    pub state: u8,
    pub owner: u32,
    pub frame: Option<SavedFrameRow>,
}

/// A suspended async function, carried with its promise cluster. Completed
/// instances have no resumable state and are omitted.
#[derive(Clone, Debug, PartialEq)]
pub struct AsyncRow {
    pub owner: u32,
    pub frame: SavedFrameRow,
    pub result_promise: u32,
    pub resolve: Slot,
    pub reject: Slot,
}

/// One registered reaction of a pending [`PromiseRow`] (the serialized
/// [`PromiseReaction`]). The four handler/capability slots are ordinary
/// value slots; `kind` is the reaction's drain behavior:
///
/// | byte | kind | `a` | `b` |
/// |------|------|-----|-----|
/// | 0 | `User` | — | — |
/// | 1 | `FinallyReturn` | — | — |
/// | 2 | `Combine` | combinator index | element index |
/// | 3–10 | the async-flavored kinds | | |
/// | 11 | `FinallyAwait` | original rejection boolean | — |
/// | 12 | `CombineDirect` | combinator index | element index |
///
/// Byte 3 (`AsyncAwait`) names an activation in `ASYN`. Bytes 4–10
/// (the three `AsyncGenerator*`s and four `FromAsync*`s) name machinery whose rows
/// are still Pending in the snapshot ledger, so the persist gate
/// refuses a machine holding one
/// ([`Interp::stored_unpersistable_row`]) and the decoder refuses the
/// byte. `FinallyAwait` is resumable from the ordinary promise cluster.
/// The encoding is total so every refusal lives at the boundary, not in a
/// lossy encoder.
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PromiseReactionRow {
    pub on_fulfilled: Slot,
    pub on_rejected: Slot,
    pub resolve: Slot,
    pub reject: Slot,
    pub kind: u8,
    pub a: u32,
    pub b: u32,
}

/// One promise instance's settlement state (the serialized
/// [`PromiseData`]): status, result, pending reactions, and the
/// handled-state flag [`Interp::has_unhandled_rejection`] reads.
#[derive(Clone, Debug, PartialEq)]
pub struct PromiseRow {
    pub owner: u32,
    /// 0 = Pending, 1 = Fulfilled, 2 = Rejected. A settled row carries
    /// no reactions (settlement drains them into the job queue, and the
    /// quiescence gate requires that queue empty).
    pub state: u8,
    pub result: Slot,
    pub ever_handled: bool,
    pub reactions: Vec<PromiseReactionRow>,
}

/// One runtime-minted Promise callable's bound data (the serialized
/// [`PromiseFnData`] plus the `FuncInfo` fields restore rebuilds — mirroring
/// [`IntlBoundFunctionRow`], the other runtime-minted native population that
/// travels outside `FUNC`).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct PromiseFnRow {
    pub function: u32,
    /// Settled promise for a resolving function; hidden record object for a
    /// capability executor or `finally` closure (reserved high guard tags).
    pub promise: u32,
    /// Resolve/reject polarity for a resolving pair, or original-completion
    /// polarity for a `finally` closure.
    pub reject: bool,
    /// Index into [`PromiseClusterSnapshot::guards`], the pair's shared
    /// `[[AlreadyResolved]]` boolean. `u32::MAX` marks a capability executor;
    /// the next two lower values mark a finally handler and value thunk.
    pub guard: u32,
    /// The callable's interned empty-name chunk. Carried (not re-interned) so
    /// restore mutates no arena.
    pub name_chunk: u32,
}

/// One `Promise.all`/`allSettled`/`race`/`any` shared accumulator (the
/// serialized [`CombinatorState`]).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct CombinatorRow {
    /// 0 = All, 1 = AllSettled, 2 = Race, 3 = Any.
    pub kind: u8,
    pub resolve: Slot,
    pub reject: Slot,
    pub remaining: u32,
    pub results: u32,
}

/// The atomic promise cluster: the four side tables whose rows
/// cross-reference each other (a reaction indexes `combinators`, a
/// resolving function indexes `guards` and names a `promises` row), so
/// they travel — and are validated — together, exactly as `FUNC`
/// bundles functions with their segments.
///
/// The two index arenas are emitted in COMPACTED form: the snapshot
/// verb applies the same liveness rule as the collector's
/// `compact_reaction_arenas` (a guard is live while a resolving pair
/// names it; a combinator while a pending `Combine` reaction does) and
/// remaps the holders onto the dense arenas. Indices never surface to
/// the guest, so the normalization is invisible — and it makes the
/// encoding canonical: a continued machine and its resumed twin emit
/// byte-identical clusters even before the continued one's next sweep.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PromiseClusterSnapshot {
    /// Rooted first reported rejection; its PromiseRow carries the reason.
    pub unhandled_rejection: Option<u32>,
    pub async_instances: Vec<AsyncRow>,
    pub promises: Vec<PromiseRow>,
    pub functions: Vec<PromiseFnRow>,
    pub guards: Vec<bool>,
    pub combinators: Vec<CombinatorRow>,
}

impl PromiseClusterSnapshot {
    pub fn is_empty(&self) -> bool {
        self.unhandled_rejection.is_none()
            && self.promises.is_empty()
            && self.async_instances.is_empty()
            && self.functions.is_empty()
            && self.guards.is_empty()
            && self.combinators.is_empty()
    }
}
