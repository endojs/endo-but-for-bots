//! The index-arena value and heap model (design § Value and heap
//! model). XS's pointer-linked slot graph becomes index arenas:
//!
//! - `SlotIndex(u32)` replaces `txSlot*`; the slot heap is an arena of
//!   32-byte slot records with a free list (XS's "slots never move").
//! - `ChunkOffset(u32)` replaces chunk pointers; the chunk heap is a
//!   growable byte arena with the same header discipline, ready for the
//!   slide-compaction GC that lands in stage 2.
//!
//! The 32-byte record layout is held exactly (resolved question 5) so
//! `currentHeapCount` semantics and snapshot slot images stay aligned
//! with the oracle: kind + flag + 16-bit id + next-index + 16-byte
//! payload. Stage 1 exercises the immediate value kinds (undefined,
//! null, boolean, integer, number); reference/string kinds carry their
//! arena handles and are filled in as later stages land the object
//! model and GC.

/// XS's `XS_NO_ID` (`xs.h`): the sentinel key id meaning "no name". A
/// `constructor_function`/`function` opcode carries it as the name operand
/// for an anonymous function; a real (inferred or declared) name is any
/// other id.
pub const XS_NO_ID: u16 = 0;

/// Slot records per dirty-tracking page — the canonical page geometry
/// of the snapshot store seam (design
/// `designs/ironhorse-snapshot-store-seam.md`). The vm owns the
/// constant because the arenas' dirty bitmaps are keyed to it and the
/// snapshot crate depends on the vm, never the reverse; `ironhorse-snapshot`
/// re-exports it as the store page size. Changing it is a store-schema
/// version bump.
pub const SLOTS_PER_PAGE: u32 = 256;

/// Chunk-arena bytes per dirty-tracking extent (same ownership and
/// versioning discipline as [`SLOTS_PER_PAGE`]).
pub const CHUNK_EXTENT_BYTES: u32 = 64 * 1024;

/// Handle into the slot arena. `u32::MAX` is the null sentinel
/// (XS's `C_NULL`), never a live index.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct SlotIndex(pub u32);

impl SlotIndex {
    pub const NULL: SlotIndex = SlotIndex(u32::MAX);
    #[inline]
    pub fn is_null(self) -> bool {
        self.0 == u32::MAX
    }
}

/// Handle into the chunk (byte) arena.
#[derive(Copy, Clone, Debug, PartialEq, Eq, Hash)]
pub struct ChunkOffset(pub u32);

impl ChunkOffset {
    pub const NULL: ChunkOffset = ChunkOffset(u32::MAX);
    #[inline]
    pub fn is_null(self) -> bool {
        self.0 == u32::MAX
    }
}

/// Slot kind byte. Values mirror the XS `XS_*_KIND` ordering for the
/// kinds stage 1 uses; the full ~66-kind set arrives with the object
/// model in stage 2.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Undefined = 0,
    Null = 1,
    Boolean = 2,
    Integer = 3,
    Number = 4,
    /// String data living in the chunk arena (UTF-16 big-endian code units,
    /// revised 2026-07-06 from CESU-8 — resolved question 4). Payload holds a
    /// `ChunkOffset`.
    String = 5,
    /// An object instance living in the slot arena (XS's
    /// `XS_INSTANCE_KIND`). The instance's own slot is the head of its
    /// property list: `next` points to the first property slot (a
    /// [`Kind::Property`]), or [`SlotIndex::NULL`] for a property-less
    /// object. The payload's `Reference` names the instance's prototype
    /// instance, or [`SlotIndex::NULL`] for a null prototype. This is the
    /// allocation-faithful object heap the stage-2b design calls for:
    /// the global object and every object literal is a real arena
    /// instance whose properties are real arena slots.
    Instance = 6,
    /// A named own property of an instance (XS's property slot in the
    /// `next`-linked property list). `id` is the property key (an
    /// interned name id), `value` the property value, and `next` the
    /// following property in the owner's list.
    Property = 7,
    /// A Symbol primitive (XS's `XS_SYMBOL_KIND`). The payload's `Reference`
    /// names a fresh descriptor slot allocated per `Symbol()` call (holding
    /// the description string or `undefined`), so two symbols are `===` iff
    /// they name the *same* descriptor slot — the identity that makes
    /// `Symbol('a') !== Symbol('a')` while a well-known `Symbol.iterator ===
    /// Symbol.iterator`. `typeof` is "symbol"; coercing one to a string
    /// throws a `TypeError` (a bare symbol completion aborts).
    Symbol = 8,
    /// Reference to a heap instance (slot arena). Payload holds a
    /// `SlotIndex`.
    Reference = 10,
    /// A not-yet-initialized binding (XS's `XS_UNINITIALIZED_KIND`, the
    /// "kind < 0" sentinel a `let`/`const`/`this` binding carries before
    /// its initializer runs; reading it is a TDZ ReferenceError).
    Uninitialized = 11,
    /// A closure scope slot (XS's `XS_CLOSURE_KIND`): a scope cell that
    /// indirects to a **shared heap cell** rather than holding the value
    /// inline. The payload's `Reference` names the cell slot (a heap slot
    /// holding the actual value); `id` is the captured binding's name. This
    /// is what makes a captured variable shared between the defining frame
    /// and the closures that captured it — reads/writes go through the one
    /// cell, so a mutation in one is visible in all (`new_closure` allocates
    /// the cell; `store` captures it into a closure environment; `retrieve`
    /// imports it into a callee frame; `get`/`set`/`var`/`pull_closure`
    /// read/write through it).
    Closure = 9,
    /// An environment/reference sentinel produced by `EVAL_REFERENCE`
    /// and friends and consumed by `GET_VARIABLE`/`SET_VARIABLE`. The
    /// payload's `Reference` names the environment the variable resolves
    /// against (the global instance, or `SlotIndex::NULL` for the
    /// active frame's own scope).
    EnvReference = 12,
    /// A computed property key produced by `XS_CODE_AT`/`AT_2` (XS's
    /// `XS_AT_KIND`) and consumed by `GET_PROPERTY_AT`/`SET_PROPERTY_AT`/
    /// `NEW_PROPERTY_AT`/`DELETE_PROPERTY_AT`. The payload's [`Payload::At`]
    /// carries the resolved `(id, index)`: a named key sets `id` (a symbol
    /// id) with `index == 0`; an integer/number index key sets `id ==
    /// XS_NO_ID` with the array index. A transient stack value only (never
    /// stored in a property slot or snapshotted), so it needs no GC edge.
    At = 13,
    /// A BigInt primitive (XS's `XS_BIGINT_KIND`). The payload's
    /// [`Payload::BigInt`] names a chunk holding the arbitrary-precision
    /// value: one sign byte (`0` positive, `1` negative) followed by the
    /// magnitude as little-endian `u32` digits (XS's `txU4` limbs), least
    /// significant first, trailing-zero-trimmed — so the digit count (the
    /// chunk's `(len - 1) / 4`) is XS's `bigint.size`, the quantity
    /// `XS_BIGINT_METERING` charges per arithmetic step. `typeof` is
    /// `"bigint"`.
    BigInt = 14,
}

impl Kind {
    /// Decode a kind byte (the `#[repr(u8)]` discriminant), for the snapshot
    /// reader deserializing a `HEAP` slot image. Returns `None` for a byte
    /// that names no kind — a corrupt/foreign snapshot record.
    pub fn from_u8(b: u8) -> Option<Kind> {
        Some(match b {
            0 => Kind::Undefined,
            1 => Kind::Null,
            2 => Kind::Boolean,
            3 => Kind::Integer,
            4 => Kind::Number,
            5 => Kind::String,
            6 => Kind::Instance,
            7 => Kind::Property,
            8 => Kind::Symbol,
            9 => Kind::Closure,
            10 => Kind::Reference,
            11 => Kind::Uninitialized,
            12 => Kind::EnvReference,
            13 => Kind::At,
            14 => Kind::BigInt,
            _ => return None,
        })
    }
}

/// The 16-byte value payload (XS's value union arm subset for stage 1).
#[derive(Copy, Clone, Debug, PartialEq)]
pub enum Payload {
    None,
    Boolean(bool),
    /// `txInteger` is 32-bit in XS.
    Integer(i32),
    Number(f64),
    String(ChunkOffset),
    Reference(SlotIndex),
    /// A computed property key (`Kind::At`): `(id, index)`. `id ==
    /// XS_NO_ID` means an integer array index (`index`); a non-zero `id`
    /// names a symbol/string key (`index` unused).
    At(u16, u32),
    /// A BigInt (`Kind::BigInt`): the chunk holding `[sign: u8][LE u32
    /// digits]`. Relocated by the slide-compactor like a `String`.
    BigInt(ChunkOffset),
}

/// One 32-byte slot record. The struct is deliberately compact; the
/// `#[repr(C)]`-style field order matches XS's `txSlot` (next, id,
/// flag, kind, value) so a future snapshot writer is a serializer, not
/// a relocator (design § Snapshots).
#[derive(Copy, Clone, Debug, PartialEq)]
pub struct Slot {
    /// XS `next` link (property lists, frame chains): a slot index.
    pub next: SlotIndex,
    /// XS 16-bit `ID`. Doubles as the argument count on frame slots.
    pub id: u16,
    /// XS `flag` byte.
    pub flag: u8,
    pub kind: Kind,
    pub value: Payload,
}

impl Slot {
    #[inline]
    pub fn undefined() -> Slot {
        Slot::of(Kind::Undefined, Payload::None)
    }
    #[inline]
    pub fn null() -> Slot {
        Slot::of(Kind::Null, Payload::None)
    }
    #[inline]
    pub fn boolean(b: bool) -> Slot {
        Slot::of(Kind::Boolean, Payload::Boolean(b))
    }
    #[inline]
    pub fn integer(i: i32) -> Slot {
        Slot::of(Kind::Integer, Payload::Integer(i))
    }
    #[inline]
    pub fn number(n: f64) -> Slot {
        Slot::of(Kind::Number, Payload::Number(n))
    }
    #[inline]
    pub fn uninitialized() -> Slot {
        Slot::of(Kind::Uninitialized, Payload::None)
    }
    /// An object instance whose prototype is `prototype` (or
    /// [`SlotIndex::NULL`] for a null prototype) and whose property list
    /// starts empty (`next == NULL`). Properties are appended by linking
    /// [`Kind::Property`] slots through `next`.
    #[inline]
    pub fn instance(prototype: SlotIndex) -> Slot {
        Slot::of(Kind::Instance, Payload::Reference(prototype))
    }
    /// A named own property slot: key `id`, value `value`, no successor.
    #[inline]
    pub fn property(id: u16, value: Payload) -> Slot {
        let mut s = Slot::of(Kind::Property, value);
        s.id = id;
        s
    }
    #[inline]
    pub fn of(kind: Kind, value: Payload) -> Slot {
        Slot {
            next: SlotIndex::NULL,
            id: 0,
            flag: 0,
            kind,
            value,
        }
    }

    /// Invoke `f` with every slot index this slot references as a GC
    /// edge: its `next` link (property/frame chains) and any
    /// reference-bearing payload arm. The mark-sweep tracer
    /// ([`crate::gc`]) uses this; extend it whenever a new
    /// reference-bearing [`Payload`] arm lands.
    #[inline]
    pub fn each_ref_slot(&self, mut f: impl FnMut(SlotIndex)) {
        if !self.next.is_null() {
            f(self.next);
        }
        match self.value {
            Payload::Reference(r) => f(r),
            _ => {}
        }
    }

    /// The chunk this slot references (a heap-string payload), if any —
    /// what the slide-compactor must relocate and rewrite.
    #[inline]
    pub fn chunk_ref(&self) -> Option<ChunkOffset> {
        match self.value {
            Payload::String(o) => Some(o),
            Payload::BigInt(o) => Some(o),
            _ => None,
        }
    }

    /// Rewrite this slot's chunk reference after compaction. A no-op on
    /// a slot that holds no chunk offset.
    #[inline]
    pub fn set_chunk_ref(&mut self, off: ChunkOffset) {
        match self.value {
            Payload::String(_) => self.value = Payload::String(off),
            Payload::BigInt(_) => self.value = Payload::BigInt(off),
            _ => {}
        }
    }

    #[inline]
    pub fn as_integer(&self) -> Option<i32> {
        match self.value {
            Payload::Integer(i) => Some(i),
            _ => None,
        }
    }
    #[inline]
    pub fn as_number(&self) -> Option<f64> {
        match self.value {
            Payload::Number(n) => Some(n),
            _ => None,
        }
    }
}

/// A slot arena: fixed-size 32-byte records that never move, with a
/// free list. This is XS's slot heap; the mark-sweep collector
/// ([`crate::gc`]) sweeps it to the free list (design § Value and heap
/// model). Because it is index-based it is safe code: a stale index is
/// a kind-checked logic bug, not undefined behavior.
#[derive(Default)]
pub struct SlotArena {
    slots: Vec<Slot>,
    free: Vec<u32>,
    /// One mark bit per slot, used by the mark-sweep collector. A slot
    /// is never both free and marked; the collector clears all marks
    /// before a collection and sweeps the unmarked-and-not-already-free
    /// slots onto the free list.
    marks: Vec<bool>,
    /// Count of live (non-free) slots, mirroring `currentHeapCount`.
    live: u32,
    /// One dirty bit per [`SLOTS_PER_PAGE`]-record page, set by the
    /// record-mutating paths ([`SlotArena::alloc`],
    /// [`SlotArena::get_mut`]) and drained by the incremental snapshot
    /// checkpoint (design `designs/ironhorse-snapshot-store-seam.md`).
    /// Host bookkeeping only — nothing observable reads it, the same
    /// determinism firewall as the cost recorder. `free`/`sweep`/`mark`
    /// do not set bits: they never change record bytes (the free list
    /// travels in the checkpoint's small state, and mark bits are
    /// transient).
    dirty: Vec<bool>,
}

impl SlotArena {
    pub fn new() -> SlotArena {
        SlotArena {
            slots: Vec::new(),
            free: Vec::new(),
            marks: Vec::new(),
            live: 0,
            dirty: Vec::new(),
        }
    }

    /// Set the dirty bit of the page holding record `i`, growing the
    /// bitmap on first touch of a new page.
    #[inline]
    fn mark_dirty_slot(&mut self, i: u32) {
        let page = (i / SLOTS_PER_PAGE) as usize;
        if page >= self.dirty.len() {
            self.dirty.resize(page + 1, false);
        }
        self.dirty[page] = true;
    }

    /// Allocate a slot, reusing the free list first (XS semantics).
    pub fn alloc(&mut self, slot: Slot) -> SlotIndex {
        self.live += 1;
        if let Some(i) = self.free.pop() {
            self.slots[i as usize] = slot;
            self.marks[i as usize] = false;
            self.mark_dirty_slot(i);
            SlotIndex(i)
        } else {
            let i = self.slots.len() as u32;
            self.slots.push(slot);
            self.marks.push(false);
            self.mark_dirty_slot(i);
            SlotIndex(i)
        }
    }

    /// Return a slot to the free list.
    pub fn free(&mut self, index: SlotIndex) {
        debug_assert!(!index.is_null());
        self.free.push(index.0);
        self.live -= 1;
    }

    #[inline]
    pub fn get(&self, index: SlotIndex) -> &Slot {
        &self.slots[index.0 as usize]
    }
    #[inline]
    pub fn get_mut(&mut self, index: SlotIndex) -> &mut Slot {
        // A `&mut` record may be written through, so its page is
        // conservatively dirty (a read-only `get_mut` over-marks, which
        // costs a redundant page write at the next checkpoint, never a
        // missed one).
        self.mark_dirty_slot(index.0);
        &mut self.slots[index.0 as usize]
    }

    /// Total slot records ever allocated (live + free). The collector
    /// walks this range when sweeping.
    #[inline]
    pub fn capacity(&self) -> u32 {
        self.slots.len() as u32
    }

    // --- mark-sweep support (see `crate::gc`) ---

    /// Clear every mark bit. Called at the start of a collection.
    pub fn clear_marks(&mut self) {
        for m in self.marks.iter_mut() {
            *m = false;
        }
    }

    /// Mark a slot reachable. Returns `true` if it was not already
    /// marked, so the tracer can avoid re-following an already-visited
    /// slot (cycle safety).
    #[inline]
    pub fn mark(&mut self, index: SlotIndex) -> bool {
        if index.is_null() {
            return false;
        }
        let i = index.0 as usize;
        if self.marks[i] {
            false
        } else {
            self.marks[i] = true;
            true
        }
    }

    #[inline]
    pub fn is_marked(&self, index: SlotIndex) -> bool {
        !index.is_null() && self.marks[index.0 as usize]
    }

    /// Whether `index` currently sits on the free list (a swept or
    /// never-live record). Linear in the free-list length; used only by
    /// the sweep bookkeeping and tests, not on any hot path.
    fn is_free(&self, i: u32) -> bool {
        self.free.contains(&i)
    }

    /// Sweep: every allocated slot that is not marked and not already
    /// free returns to the free list. Returns the number of slots
    /// reclaimed. Mirrors `fxSweep` reclaiming unmarked slots.
    pub fn sweep(&mut self) -> u32 {
        let mut reclaimed = 0u32;
        for i in 0..self.slots.len() as u32 {
            if !self.marks[i as usize] && !self.is_free(i) {
                self.free.push(i);
                self.live -= 1;
                reclaimed += 1;
            }
        }
        reclaimed
    }

    /// Live slot count. XS accounts 32 bytes per slot; this is the
    /// count `currentHeapCount` reports.
    #[inline]
    pub fn live_count(&self) -> u32 {
        self.live
    }

    /// Slot heap footprint in bytes, held at 32 per record (resolved
    /// question 5) so heap accounting stays comparable with XS.
    #[inline]
    pub fn byte_size(&self) -> usize {
        self.slots.len() * 32
    }

    // --- snapshot support (see `ironhorse-snapshot`) ---
    //
    // The snapshot writer is a *serializer*, not a relocator (design §
    // Snapshots): because slots never move and are addressed by index, the
    // HEAP atom is just the flat record array plus the free list, and a
    // read reconstructs an identical arena. These accessors expose exactly
    // the state a faithful `HEAP` round-trip needs and nothing more.

    /// Every slot record ever allocated (live and freed alike), in index
    /// order — the flat image the `HEAP` atom serializes. Freed records are
    /// serialized as-is so slot indices are preserved across a round-trip
    /// (an index-arena snapshot never renumbers).
    #[inline]
    pub fn records(&self) -> &[Slot] {
        &self.slots
    }

    /// The free list (indices returned to the arena, LIFO reuse order), so a
    /// restored arena reuses the same records in the same order as the
    /// original would have — keeping post-restore allocation deterministic.
    #[inline]
    pub fn free_list(&self) -> &[u32] {
        &self.free
    }

    /// Rebuild an arena from a serialized image: the flat record array, the
    /// free list, and the live count. Marks are reset (a snapshot is taken
    /// on a quiescent machine, outside any collection — design § Snapshots
    /// constraint 1), so no mark state needs to survive. The dirty bitmap
    /// starts clean: a just-restored arena is byte-identical to its store,
    /// so the next incremental checkpoint owes nothing.
    pub fn from_image(slots: Vec<Slot>, free: Vec<u32>, live: u32) -> SlotArena {
        let marks = vec![false; slots.len()];
        let dirty = vec![false; slots.len().div_ceil(SLOTS_PER_PAGE as usize)];
        SlotArena {
            slots,
            free,
            marks,
            live,
            dirty,
        }
    }

    // --- incremental-checkpoint dirty tracking (store seam design) ---

    /// The pages whose records changed since the last
    /// [`SlotArena::clear_dirty`], ascending. Peek-only: the checkpoint
    /// clears the bits only after its store commit succeeds, so a failed
    /// commit forgets nothing.
    pub fn dirty_pages(&self) -> Vec<u32> {
        self.dirty
            .iter()
            .enumerate()
            .filter_map(|(p, &d)| if d { Some(p as u32) } else { None })
            .collect()
    }

    /// Reset the dirty bitmap after a successful checkpoint commit.
    pub fn clear_dirty(&mut self) {
        for d in self.dirty.iter_mut() {
            *d = false;
        }
    }
}

/// The size of a chunk's length header, in bytes. Each block in the
/// arena is laid out `[u32 length][payload...]`, mirroring XS's
/// `txChunk` header discipline (a size field precedes each chunk) so
/// the slide-compactor can walk and relocate blocks without external
/// bookkeeping.
const CHUNK_HEADER: usize = 4;

/// The chunk arena: variable-size data (strings as UTF-16 big-endian code
/// units, ArrayBuffers, BigInt digits, bytecode). Each block carries a length
/// header so [`ChunkArena::compact`] can slide-compact during GC,
/// rewriting `ChunkOffset`s exactly where XS rewrites chunk pointers.
#[derive(Default)]
pub struct ChunkArena {
    bytes: Vec<u8>,
    /// One dirty bit per [`CHUNK_EXTENT_BYTES`]-byte extent of the byte
    /// space, set by the byte-mutating paths ([`ChunkArena::alloc`],
    /// [`ChunkArena::slice_mut`], [`ChunkArena::compact`]) and drained
    /// by the incremental snapshot checkpoint. Host bookkeeping only;
    /// see the twin bitmap on [`SlotArena`].
    dirty: Vec<bool>,
}

impl ChunkArena {
    pub fn new() -> ChunkArena {
        ChunkArena {
            bytes: Vec::new(),
            dirty: Vec::new(),
        }
    }

    /// Mark every extent covering byte range `[start, end)` dirty,
    /// growing the bitmap as the byte space grows.
    #[inline]
    fn mark_dirty_range(&mut self, start: usize, end: usize) {
        if end <= start {
            return;
        }
        let per = CHUNK_EXTENT_BYTES as usize;
        let first = start / per;
        let last = (end - 1) / per;
        if last >= self.dirty.len() {
            self.dirty.resize(last + 1, false);
        }
        for e in first..=last {
            self.dirty[e] = true;
        }
    }

    /// Append bytes behind a length header, returning the offset of the
    /// payload (not the header). Strings are stored as UTF-16 big-endian code
    /// units (revised 2026-07-06 from CESU-8; resolved question 4), so a byte-
    /// lexicographic compare of two string payloads equals their code-unit
    /// (ECMAScript string) ordering.
    pub fn alloc(&mut self, data: &[u8]) -> ChunkOffset {
        let header = self.bytes.len();
        self.bytes
            .extend_from_slice(&(data.len() as u32).to_le_bytes());
        let off = self.bytes.len() as u32;
        self.bytes.extend_from_slice(data);
        debug_assert_eq!(off as usize, header + CHUNK_HEADER);
        self.mark_dirty_range(header, self.bytes.len());
        ChunkOffset(off)
    }

    /// The stored length of the block whose payload begins at `off`.
    #[inline]
    pub fn len_of(&self, off: ChunkOffset) -> usize {
        let h = off.0 as usize - CHUNK_HEADER;
        u32::from_le_bytes([
            self.bytes[h],
            self.bytes[h + 1],
            self.bytes[h + 2],
            self.bytes[h + 3],
        ]) as usize
    }

    #[inline]
    pub fn slice(&self, off: ChunkOffset, len: usize) -> &[u8] {
        let start = off.0 as usize;
        &self.bytes[start..start + len]
    }

    /// The whole payload of the block at `off`, using its stored length.
    #[inline]
    pub fn payload(&self, off: ChunkOffset) -> &[u8] {
        self.slice(off, self.len_of(off))
    }

    /// A mutable view of `len` bytes of the block whose payload begins at
    /// `off` — for in-place mutation of an ArrayBuffer backing store
    /// (TypedArray/DataView element writes), which XS does by writing
    /// directly through `arrayBuffer.address`.
    #[inline]
    pub fn slice_mut(&mut self, off: ChunkOffset, len: usize) -> &mut [u8] {
        let start = off.0 as usize;
        self.mark_dirty_range(start, start + len);
        &mut self.bytes[start..start + len]
    }

    /// Slide-compact: keep only the blocks whose payload offsets are in
    /// `live`, packing them to the front of the arena in ascending
    /// offset order, and return the old→new payload-offset remap the
    /// caller applies to every live `ChunkOffset` (design § Value and
    /// heap model: "offsets are rewritten exactly where XS rewrites
    /// pointers"). Duplicate/unknown offsets in `live` are ignored.
    pub fn compact(&mut self, live: &[ChunkOffset]) -> std::collections::HashMap<ChunkOffset, ChunkOffset> {
        use std::collections::{HashMap, HashSet};
        let mut seen: Vec<ChunkOffset> = live
            .iter()
            .copied()
            .filter(|o| !o.is_null())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        // Relocate in ascending source order so the copy never overlaps
        // a not-yet-moved block.
        seen.sort_by_key(|o| o.0);

        let mut fresh: Vec<u8> = Vec::with_capacity(self.bytes.len());
        let mut remap: HashMap<ChunkOffset, ChunkOffset> = HashMap::new();
        for old in seen {
            let len = self.len_of(old);
            let start = old.0 as usize;
            let header = fresh.len();
            fresh.extend_from_slice(&(len as u32).to_le_bytes());
            let new_off = fresh.len() as u32;
            fresh.extend_from_slice(&self.bytes[start..start + len]);
            debug_assert_eq!(new_off as usize, header + CHUNK_HEADER);
            remap.insert(old, ChunkOffset(new_off));
        }
        self.bytes = fresh;
        // The whole byte space was rewritten (and possibly shrunk):
        // every surviving extent is dirty, and the bitmap tracks the
        // new, smaller geometry so a checkpoint never names an extent
        // past the compacted end.
        let exts = self.bytes.len().div_ceil(CHUNK_EXTENT_BYTES as usize);
        self.dirty = vec![true; exts];
        remap
    }

    #[inline]
    pub fn byte_size(&self) -> usize {
        self.bytes.len()
    }

    // --- snapshot support (see `ironhorse-snapshot`) ---

    /// The whole backing byte vector, header discipline included — the
    /// `BLOC` atom payload. Because `ChunkOffset`s are byte offsets into
    /// exactly these bytes, serializing them verbatim keeps every offset
    /// valid across a round-trip with no relocation (design § Snapshots:
    /// the writer is a serializer, not a relocator).
    #[inline]
    pub fn raw(&self) -> &[u8] {
        &self.bytes
    }

    /// Rebuild a chunk arena from a serialized `BLOC` image. The dirty
    /// bitmap starts clean, as on [`SlotArena::from_image`].
    pub fn from_image(bytes: Vec<u8>) -> ChunkArena {
        let exts = bytes.len().div_ceil(CHUNK_EXTENT_BYTES as usize);
        ChunkArena {
            bytes,
            dirty: vec![false; exts],
        }
    }

    // --- incremental-checkpoint dirty tracking (store seam design) ---

    /// The extents whose bytes changed since the last
    /// [`ChunkArena::clear_dirty`], ascending. Peek-only, like
    /// [`SlotArena::dirty_pages`].
    pub fn dirty_extents(&self) -> Vec<u32> {
        self.dirty
            .iter()
            .enumerate()
            .filter_map(|(e, &d)| if d { Some(e as u32) } else { None })
            .collect()
    }

    /// Reset the dirty bitmap after a successful checkpoint commit.
    pub fn clear_dirty(&mut self) {
        for d in self.dirty.iter_mut() {
            *d = false;
        }
    }
}

/// ToInt32 (ECMAScript 7.1.5 / XS `fxNumberToInteger`): fold a number
/// into the signed 32-bit range used by the bitwise opcodes.
#[inline]
pub fn to_int32(n: f64) -> i32 {
    if !n.is_finite() {
        return 0;
    }
    // Truncate toward zero, then reduce modulo 2^32 into i32 range.
    let m = n.trunc();
    let m = m.rem_euclid(4294967296.0); // 2^32
    let u = m as u32; // exact: m in [0, 2^32)
    u as i32
}

/// The ECMAScript Number::toString(10) rendering (spec 6.1.6.1.20,
/// `Number::toString`) — XS's `fxNumberToString` / dtoa. Reproduces the
/// standard's exact fixed-vs-exponential threshold from the shortest
/// round-tripping decimal: exponential when the point position `n ≤ -6` or
/// `n > 21`, fixed otherwise, with the JS spellings for the non-finite and
/// signed-zero corners. Rust's default `{}` diverges from this in the
/// extremes (it never switches to `e` notation for small/large magnitudes,
/// so `(1e-7)` prints as `0.0000001` instead of `1e-7`), which is why the
/// shortest digits are re-formatted here.
pub fn number_to_ecma_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n < 0.0 { "-Infinity" } else { "Infinity" }.to_string();
    }
    if n == 0.0 {
        // Covers +0 and -0; JS String(-0) === "0".
        return "0".to_string();
    }
    let sign = if n < 0.0 { "-" } else { "" };
    let abs = n.abs();
    // Rust's `{:e}` gives the shortest round-tripping mantissa (one digit
    // before the point, trailing zeros stripped) and its base-10 exponent —
    // the `(s, k, e)` the spec's algorithm needs.
    let exp = format!("{:e}", abs);
    let (mantissa, exp10) = match exp.split_once('e') {
        Some((m, e)) => (m, e.parse::<i32>().unwrap_or(0)),
        None => return format!("{}{}", sign, abs), // unreachable for finite non-zero
    };
    // `s` = the significant digits (k of them); `point` = the spec's `n`,
    // the position of the decimal point relative to the first digit (so the
    // value is `0.s × 10^point`).
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let s = digits.trim_end_matches('0');
    let s = if s.is_empty() { "0" } else { s };
    let k = s.len() as i32;
    let point = exp10 + 1;
    let body = if k <= point && point <= 21 {
        // Digits followed by `point - k` trailing zeros (an integer).
        let mut out = String::from(s);
        out.push_str(&"0".repeat((point - k) as usize));
        out
    } else if 0 < point && point <= 21 {
        // `point` digits, a decimal point, then the remaining `k - point`.
        format!("{}.{}", &s[..point as usize], &s[point as usize..])
    } else if -6 < point && point <= 0 {
        // "0." then `-point` leading zeros then the digits.
        format!("0.{}{}", "0".repeat((-point) as usize), s)
    } else {
        // Exponential: one leading digit, the rest after a point, then
        // `e`, the sign of `point - 1`, and its magnitude.
        let e = point - 1;
        let esign = if e >= 0 { "+" } else { "-" };
        let head = if k == 1 {
            s.to_string()
        } else {
            format!("{}.{}", &s[..1], &s[1..])
        };
        format!("{}e{}{}", head, esign, e.abs())
    };
    format!("{}{}", sign, body)
}

#[cfg(test)]
mod dirty_tests {
    //! The dirty-tracking contract the incremental snapshot checkpoint
    //! relies on (store seam design): record/byte mutations mark their
    //! page/extent; free-list and mark-bit churn does not (those travel
    //! in the checkpoint's small state or are transient); restores
    //! start clean; a chunk compaction dirties exactly the new,
    //! possibly smaller, extent range.

    use super::*;

    #[test]
    fn slot_alloc_and_get_mut_mark_their_pages() {
        let mut a = SlotArena::new();
        let first = a.alloc(Slot::integer(1));
        assert_eq!(a.dirty_pages(), vec![0]);
        a.clear_dirty();
        assert!(a.dirty_pages().is_empty());

        // Fill past one page so the next alloc lands on page 1.
        for _ in 1..SLOTS_PER_PAGE {
            a.alloc(Slot::integer(0));
        }
        a.clear_dirty();
        a.alloc(Slot::integer(2));
        assert_eq!(a.dirty_pages(), vec![1]);

        a.clear_dirty();
        a.get_mut(first).value = Payload::Integer(9);
        assert_eq!(a.dirty_pages(), vec![0]);
    }

    #[test]
    fn slot_free_sweep_and_marks_do_not_dirty() {
        let mut a = SlotArena::new();
        let root = a.alloc(Slot::integer(1));
        let dead = a.alloc(Slot::integer(2));
        a.clear_dirty();

        // free: the record bytes are untouched; the free list travels
        // in small state.
        a.free(dead);
        assert!(a.dirty_pages().is_empty(), "free must not dirty");

        // mark bits are transient collector state.
        a.clear_marks();
        a.mark(root);
        assert!(a.dirty_pages().is_empty(), "marking must not dirty");
        a.sweep();
        assert!(a.dirty_pages().is_empty(), "sweep must not dirty");
    }

    #[test]
    fn slot_alloc_reusing_the_free_list_dirties_the_reused_page() {
        let mut a = SlotArena::new();
        let x = a.alloc(Slot::integer(1));
        a.free(x);
        a.clear_dirty();
        let y = a.alloc(Slot::integer(2));
        assert_eq!(y, x, "free-list reuse");
        assert_eq!(a.dirty_pages(), vec![0]);
    }

    #[test]
    fn slot_from_image_starts_clean() {
        let a = SlotArena::from_image(vec![Slot::integer(7); 300], vec![], 300);
        assert!(a.dirty_pages().is_empty());
    }

    #[test]
    fn chunk_alloc_marks_covered_extents() {
        let mut c = ChunkArena::new();
        c.alloc(b"hi");
        assert_eq!(c.dirty_extents(), vec![0]);
        c.clear_dirty();

        // An allocation spanning the extent boundary marks both sides.
        let big = vec![7u8; CHUNK_EXTENT_BYTES as usize];
        c.alloc(&big);
        assert_eq!(c.dirty_extents(), vec![0, 1]);
    }

    #[test]
    fn chunk_slice_mut_marks_only_the_touched_extents() {
        let mut c = ChunkArena::new();
        let pad = vec![0u8; CHUNK_EXTENT_BYTES as usize];
        c.alloc(&pad); // spans extents 0..=1
        let off = c.alloc(b"abcd"); // extent 1
        c.clear_dirty();
        c.slice_mut(off, 4)[0] = b'z';
        assert_eq!(c.dirty_extents(), vec![1]);
    }

    #[test]
    fn chunk_compact_dirties_exactly_the_new_extent_range() {
        let mut c = ChunkArena::new();
        let _dead = c.alloc(&vec![1u8; CHUNK_EXTENT_BYTES as usize]);
        let keep = c.alloc(b"keep me");
        c.clear_dirty();

        let remap = c.compact(&[keep]);
        let new_off = remap[&keep];
        assert_eq!(c.payload(new_off), b"keep me");
        // The compacted space fits in one extent, all of it dirty; the
        // stale second extent is gone from the bitmap entirely.
        assert_eq!(c.dirty_extents(), vec![0]);
    }

    #[test]
    fn chunk_from_image_starts_clean() {
        let c = ChunkArena::from_image(vec![9u8; (CHUNK_EXTENT_BYTES + 1) as usize]);
        assert!(c.dirty_extents().is_empty());
    }
}
