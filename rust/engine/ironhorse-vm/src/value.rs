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

use std::cell::{Cell, Ref, RefCell};
use std::rc::Rc;

/// A source of snapshot pages for **lazy reification** (store seam
/// design, phase 3): the arenas fault a page/extent in on first touch
/// instead of reading the whole heap at resume. Implemented outside
/// the vm (the snapshot crate adapts its `HeapStore` to this), keeping
/// the dependency direction snapshot → vm.
///
/// Reads are infallible by signature: the store was validated
/// exhaustively at open (every promised row present at its exact
/// length), so a failure here is genuine I/O trouble mid-crank, and an
/// implementation reports it by panicking with a named message — the
/// deterministic crashed-crank path, exactly how a stale index or a
/// corrupted invariant already dies (design decision 7).
pub trait PageSource {
    /// The records of slot page `page`, exactly the page's snapshot
    /// length (a partial last page returns its remainder).
    fn slot_page(&self, page: u32) -> Vec<Slot>;
    /// The raw bytes of chunk extent `ext`, exactly the extent's
    /// snapshot length.
    fn chunk_extent(&self, ext: u32) -> Vec<u8>;
}

/// The lazy backing of a [`SlotArena`]: the page source plus one
/// residency bit per attach-time page. `Cell` residency bits let the
/// by-value read path fault through `&self`; pages past the
/// attach-time count are locally allocated and implicitly resident.
struct SlotBacking {
    source: Rc<dyn PageSource>,
    resident: Vec<Cell<bool>>,
    /// The attach-time record count — what the source's geometry can
    /// serve, and the exact-length bound every fault is checked
    /// against (a short row must die loudly, not install placeholder
    /// records beside real ones).
    snapshot_count: u32,
}

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
    /// The record storage. `Cell` (identical layout to `Slot`, zero
    /// runtime bookkeeping) is what lets the lazy fault path install a
    /// page's records through `&self` in `forbid(unsafe_code)` code;
    /// reads are by value (`Slot` is `Copy`), which after inlining
    /// loads only the fields a caller actually touches.
    slots: Vec<Cell<Slot>>,
    free: Vec<u32>,
    /// Twin of `free` as one bit per record, kept in exact sync by
    /// every free-list writer: `free` keeps the LIFO reuse order the
    /// snapshot serializes; this bitmap answers "is `i` free?" in O(1).
    /// Without it the sweep and the page-granular partial collector
    /// scan the free `Vec` per record — O(records x free-list length),
    /// quadratic on exactly the large-free-list heaps the segmented
    /// free list (store seam phase 9) exists to support.
    free_marks: Vec<bool>,
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
    /// Lazy-reification backing (store seam design, phase 3): `None`
    /// on every machine except one resumed lazily, so the detached hot
    /// path pays one always-false branch. Residency is **grow-only**:
    /// pages fault in and stay (design decision 3).
    lazy: Option<SlotBacking>,
}

impl SlotArena {
    pub fn new() -> SlotArena {
        SlotArena {
            slots: Vec::new(),
            free: Vec::new(),
            free_marks: Vec::new(),
            marks: Vec::new(),
            live: 0,
            dirty: Vec::new(),
            lazy: None,
        }
    }

    /// Construct a lazily-backed arena over `source` (store seam
    /// design, phase 3): `slot_count` records pre-sized as
    /// placeholders, no page read yet. The free list and live count
    /// come from the checkpoint's small state; record content faults
    /// in per page on first touch. Content is identical to an eager
    /// restore by construction — a fault installs exactly the records
    /// the store holds.
    pub fn lazy_from_parts(
        slot_count: u32,
        free: Vec<u32>,
        live: u32,
        source: Rc<dyn PageSource>,
    ) -> SlotArena {
        let pages = slot_count.div_ceil(SLOTS_PER_PAGE) as usize;
        let mut free_marks = vec![false; slot_count as usize];
        for &i in &free {
            free_marks[i as usize] = true;
        }
        SlotArena {
            slots: (0..slot_count).map(|_| Cell::new(Slot::undefined())).collect(),
            free,
            free_marks,
            marks: vec![false; slot_count as usize],
            live,
            dirty: vec![false; pages],
            lazy: Some(SlotBacking {
                source,
                resident: (0..pages).map(|_| Cell::new(false)).collect(),
                snapshot_count: slot_count,
            }),
        }
    }

    /// Fault page `page` in if a backing is attached and the page is
    /// not yet resident. `&self`: the install writes through the
    /// record `Cell`s and flips a `Cell` residency bit. Never touches
    /// dirty bits — a faulted page equals the store's copy, so the
    /// next checkpoint owes nothing for it.
    ///
    /// `#[cold]`/`#[inline(never)]`: this body must never inline into
    /// the `get` fast path (89 interpreter call sites) — the detached
    /// hot loop pays only the `lazy.is_some()` branch, not the fault
    /// machinery's code size (the phase-3 benchmark gate's measured
    /// icache concern).
    #[cold]
    #[inline(never)]
    fn ensure_page_resident(&self, page: u32) {
        let Some(backing) = &self.lazy else { return };
        let Some(bit) = backing.resident.get(page as usize) else {
            // Past the attach-time page count: locally allocated,
            // implicitly resident.
            return;
        };
        if bit.get() {
            return;
        }
        let records = backing.source.slot_page(page);
        let start = page as usize * SLOTS_PER_PAGE as usize;
        // Exact length, both directions: a short row would silently
        // leave placeholder records marked resident (the review's
        // silent-corruption finding); a long row would overrun.
        let expected = (backing.snapshot_count as usize)
            .min(start + SLOTS_PER_PAGE as usize)
            .saturating_sub(start);
        assert!(
            records.len() == expected,
            "page source returned {} records for page {page}, expected {expected} (corrupt or torn store row)",
            records.len(),
        );
        for (k, s) in records.into_iter().enumerate() {
            self.slots[start + k].set(s);
        }
        bit.set(true);
    }

    /// **Evict** a clean, source-backed, resident page (store seam
    /// phase 8): flip its residency off so the next touch re-faults
    /// from the store. Refused (returns false) for dirty pages (their
    /// content exists nowhere else yet), pages past the backed range
    /// (locally allocated, no backing), and non-resident pages.
    /// Content-identical by construction: a re-fault installs exactly
    /// the committed bytes, so any evict schedule is observably
    /// irrelevant — the adversarial-evict metamorphic arm locks it.
    /// The dense record array keeps its RAM until sparse backing
    /// (phase 9); eviction is the correctness machinery.
    #[must_use = "a false return means the page was NOT evicted (dirty, unbacked, or non-resident)"]
    pub fn evict_page(&self, page: u32) -> bool {
        let Some(backing) = &self.lazy else {
            return false;
        };
        let Some(bit) = backing.resident.get(page as usize) else {
            return false;
        };
        // An absent dirty bit fails closed (refuse the evict) — the
        // same conservative default as `compact`'s `was_dirty`. The
        // bitmaps are same-length by construction, so the arm is
        // belt-and-braces, and a guard whose job is "this content
        // exists elsewhere" must not fail open.
        if !bit.get() || self.dirty.get(page as usize).copied().unwrap_or(true) {
            return false;
        }
        bit.set(false);
        true
    }

    /// Pre-touch one page (the adversarial-prefetch hook the
    /// metamorphic determinism suite drives; harmless no-op when
    /// detached or already resident).
    pub fn touch_page(&self, page: u32) {
        self.ensure_page_resident(page);
    }

    /// Advance the lazy backing to the CURRENT geometry — called by
    /// the store session after ITS OWN successful checkpoint (phase 8
    /// review fix). Records appended since attach are committed rows
    /// now, so their pages become store-backed (evictable and
    /// re-faultable, marked resident: they live in memory), and the
    /// tail page's expected fault length tracks the committed row
    /// rather than the attach-time one. No-op on a detached arena.
    pub fn advance_backing(&mut self) {
        let count = self.slots.len() as u32;
        if let Some(backing) = &mut self.lazy {
            backing.snapshot_count = count;
            let pages = count.div_ceil(SLOTS_PER_PAGE) as usize;
            while backing.resident.len() < pages {
                backing.resident.push(Cell::new(true));
            }
        }
    }

    /// Fault every attach-time page in. `&self` (Cell installs), so
    /// the whole-arena readers (`records`, blob export) work on a lazy
    /// arena without a `&mut` ripple through the snapshot surface.
    pub fn ensure_all_resident(&self) {
        if let Some(backing) = &self.lazy {
            for page in 0..backing.resident.len() as u32 {
                self.ensure_page_resident(page);
            }
        }
    }

    /// Whether every attach-time page is resident (trivially true when
    /// detached).
    pub fn is_fully_resident(&self) -> bool {
        match &self.lazy {
            None => true,
            Some(b) => b.resident.iter().all(|c| c.get()),
        }
    }

    /// How many attach-time pages are resident (all of them when
    /// detached) — the working-set observability the strengthened
    /// lazy-resume lock asserts against.
    pub fn resident_page_count(&self) -> u32 {
        match &self.lazy {
            None => self.slots.len().div_ceil(SLOTS_PER_PAGE as usize) as u32,
            Some(b) => b.resident.iter().filter(|c| c.get()).count() as u32,
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
            // Fault the page first: overwriting one record of a
            // non-resident page and then marking nothing would let a
            // later fault clobber this fresh allocation with store
            // bytes.
            self.ensure_page_resident(i / SLOTS_PER_PAGE);
            self.slots[i as usize].set(slot);
            self.free_marks[i as usize] = false;
            self.marks[i as usize] = false;
            self.mark_dirty_slot(i);
            SlotIndex(i)
        } else {
            let i = self.slots.len() as u32;
            // A partial attach-time tail page must be faulted before
            // records are appended beside its stored ones.
            self.ensure_page_resident(i / SLOTS_PER_PAGE);
            self.slots.push(Cell::new(slot));
            self.free_marks.push(false);
            self.marks.push(false);
            self.mark_dirty_slot(i);
            SlotIndex(i)
        }
    }

    /// Return a slot to the free list.
    pub fn free(&mut self, index: SlotIndex) {
        debug_assert!(!index.is_null());
        self.free.push(index.0);
        self.free_marks[index.0 as usize] = true;
        self.live -= 1;
    }

    /// Read a record by value (`Slot` is `Copy`; after inlining only
    /// the touched fields load). Faults the record's page in when a
    /// lazy backing is attached; detached, the backing check is one
    /// always-false branch.
    #[inline]
    pub fn get(&self, index: SlotIndex) -> Slot {
        if self.lazy.is_some() {
            self.ensure_page_resident(index.0 / SLOTS_PER_PAGE);
        }
        self.slots[index.0 as usize].get()
    }
    #[inline]
    pub fn get_mut(&mut self, index: SlotIndex) -> &mut Slot {
        // Fault before handing out `&mut`: a partial overwrite of a
        // non-resident page must not be clobbered by a later fault.
        if self.lazy.is_some() {
            self.ensure_page_resident(index.0 / SLOTS_PER_PAGE);
        }
        // A `&mut` record may be written through, so its page is
        // conservatively dirty (a read-only `get_mut` over-marks, which
        // costs a redundant page write at the next checkpoint, never a
        // missed one).
        self.mark_dirty_slot(index.0);
        self.slots[index.0 as usize].get_mut()
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

    /// Whether `idx` is on the free list — the liveness query the
    /// store-side partial collector uses for page-granular freeing.
    pub fn is_free_index(&self, idx: SlotIndex) -> bool {
        self.is_free(idx.0)
    }

    /// Whether `i` currently sits on the free list (a swept or
    /// never-live record). O(1) via the `free_marks` twin bitmap — the
    /// sweep and the partial collector ask this once per record, so a
    /// free-`Vec` scan here would be quadratic in the free-list length.
    fn is_free(&self, i: u32) -> bool {
        self.free_marks.get(i as usize).copied().unwrap_or(false)
    }

    /// Sweep: every allocated slot that is not marked and not already
    /// free returns to the free list. Returns the number of slots
    /// reclaimed. Mirrors `fxSweep` reclaiming unmarked slots.
    pub fn sweep(&mut self) -> u32 {
        self.sweep_each(&mut |_| {})
    }

    /// Sweep, reporting each reclaimed index so the machine can drop
    /// side-table entries keyed by it (the GC side-table liveness
    /// contract) — same deterministic index order as [`Self::sweep`].
    pub fn sweep_each(&mut self, swept: &mut dyn FnMut(SlotIndex)) -> u32 {
        let mut reclaimed = 0u32;
        for i in 0..self.slots.len() as u32 {
            if !self.marks[i as usize] && !self.is_free(i) {
                self.free.push(i);
                self.free_marks[i as usize] = true;
                self.live -= 1;
                reclaimed += 1;
                swept(SlotIndex(i));
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
    /// (an index-arena snapshot never renumbers). On a lazy arena this
    /// faults everything in first (a whole-heap serialization needs the
    /// whole heap — freed records included, byte-exact, for export
    /// identity). Returns an owned copy; the whole-image consumers all
    /// copied anyway, and the incremental checkpoint uses
    /// [`SlotArena::page_records`] instead.
    pub fn records(&self) -> Vec<Slot> {
        self.ensure_all_resident();
        self.slots.iter().map(|c| c.get()).collect()
    }

    /// The records of one page (the incremental checkpoint's unit).
    /// Dirty pages are resident by construction (every dirtying path
    /// faults first), so this never reads the source for them; it
    /// still faults defensively for arbitrary callers.
    pub fn page_records(&self, page: u32) -> Vec<Slot> {
        self.ensure_page_resident(page);
        let start = (page as usize) * SLOTS_PER_PAGE as usize;
        let end = (start + SLOTS_PER_PAGE as usize).min(self.slots.len());
        self.slots[start..end].iter().map(|c| c.get()).collect()
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
        let mut free_marks = vec![false; slots.len()];
        for &i in &free {
            free_marks[i as usize] = true;
        }
        SlotArena {
            slots: slots.into_iter().map(Cell::new).collect(),
            free,
            free_marks,
            marks,
            live,
            dirty,
            lazy: None,
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
/// The chunk byte storage: plain and fully resident (every machine
/// except a lazily resumed one), or lazily backed by a [`PageSource`].
/// An enum rather than an always-on `RefCell` so the detached read
/// path is a plain slice borrow behind one discriminant branch, with
/// zero borrow bookkeeping.
enum ChunkBytes {
    Plain(Vec<u8>),
    Lazy {
        /// The byte space, pre-sized to the snapshot length with
        /// placeholder zeros; extents fault in on demand. `RefCell`
        /// because reads (`payload`/`len_of`/`slice`) are `&self` deep
        /// under the interpreter's borrow chains — a fault takes a
        /// short `borrow_mut`, installs, drops it, and the read then
        /// hands out a shared [`Ref`] guard.
        cell: RefCell<Vec<u8>>,
        /// One residency bit per attach-time extent; bytes past
        /// `snapshot_len` are locally allocated and implicitly
        /// resident.
        resident: Vec<Cell<bool>>,
        source: Rc<dyn PageSource>,
        /// The chunk length at attach — the byte range the source can
        /// serve; a fault never writes past it (locally appended bytes
        /// are not the store's to overwrite).
        snapshot_len: usize,
    },
}

impl Default for ChunkBytes {
    fn default() -> ChunkBytes {
        ChunkBytes::Plain(Vec::new())
    }
}

/// A read guard over chunk bytes: a plain borrow on a resident arena,
/// a [`Ref`] on a lazy one. Derefs to `[u8]`, so existing byte-slice
/// consumers keep working; the discriminant branch is the whole
/// detached cost.
pub enum ChunkSlice<'a> {
    Plain(&'a [u8]),
    Guard(Ref<'a, [u8]>),
}

impl std::ops::Deref for ChunkSlice<'_> {
    type Target = [u8];
    #[inline]
    fn deref(&self) -> &[u8] {
        match self {
            ChunkSlice::Plain(s) => s,
            ChunkSlice::Guard(r) => r,
        }
    }
}

impl std::fmt::Debug for ChunkSlice<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        (**self).fmt(f)
    }
}

// Byte-lexicographic comparison over the viewed bytes, so the string
// relational/equality opcodes keep comparing stored UTF-16BE payloads
// directly (byte order equals code-unit order — the property the
// encoding was chosen for).
impl PartialEq for ChunkSlice<'_> {
    #[inline]
    fn eq(&self, other: &Self) -> bool {
        **self == **other
    }
}
impl Eq for ChunkSlice<'_> {}
impl PartialOrd for ChunkSlice<'_> {
    #[inline]
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for ChunkSlice<'_> {
    #[inline]
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (**self).cmp(&**other)
    }
}

#[derive(Default)]
pub struct ChunkArena {
    bytes: ChunkBytes,
    /// One dirty bit per [`CHUNK_EXTENT_BYTES`]-byte extent of the byte
    /// space, set by the byte-mutating paths ([`ChunkArena::alloc`],
    /// [`ChunkArena::slice_mut`], [`ChunkArena::compact`]) and drained
    /// by the incremental snapshot checkpoint. Host bookkeeping only;
    /// see the twin bitmap on [`SlotArena`]. Dirty extents are resident
    /// by construction: every dirtying path faults first.
    dirty: Vec<bool>,
}

impl ChunkArena {
    pub fn new() -> ChunkArena {
        ChunkArena {
            bytes: ChunkBytes::Plain(Vec::new()),
            dirty: Vec::new(),
        }
    }

    /// Construct a lazily-backed arena over `source` (store seam
    /// design, phase 3): `snapshot_len` placeholder bytes, extents
    /// faulting in on first touch.
    pub fn lazy_from_parts(snapshot_len: usize, source: Rc<dyn PageSource>) -> ChunkArena {
        let exts = snapshot_len.div_ceil(CHUNK_EXTENT_BYTES as usize);
        ChunkArena {
            bytes: ChunkBytes::Lazy {
                cell: RefCell::new(vec![0u8; snapshot_len]),
                resident: (0..exts).map(|_| Cell::new(false)).collect(),
                source,
                snapshot_len,
            },
            dirty: vec![false; exts],
        }
    }

    /// Fault every extent covering byte range `[start, end)` in.
    /// `&self`: takes a short `borrow_mut` per missing extent. Callers
    /// holding a [`ChunkSlice`] guard must not call this (single-
    /// threaded `RefCell` discipline; the read paths fault **before**
    /// taking their guard). `#[cold]`/`#[inline(never)]` for the same
    /// icache reason as `SlotArena::ensure_page_resident` — though the
    /// chunk read path only reaches here through the `Lazy` enum arm,
    /// so the detached path never even branches to it.
    #[cold]
    #[inline(never)]
    fn ensure_range_resident(&self, start: usize, end: usize) {
        let ChunkBytes::Lazy {
            cell,
            resident,
            source,
            snapshot_len,
        } = &self.bytes
        else {
            return;
        };
        if start >= *snapshot_len || end <= start {
            return;
        }
        let per = CHUNK_EXTENT_BYTES as usize;
        let first = start / per;
        let last = (end.min(*snapshot_len) - 1) / per;
        for ext in first..=last {
            let Some(bit) = resident.get(ext) else { continue };
            if bit.get() {
                continue;
            }
            let bytes = source.chunk_extent(ext as u32);
            let ext_start = ext * per;
            let expected = (*snapshot_len).min(ext_start + per) - ext_start;
            assert!(
                bytes.len() == expected,
                "extent source returned {} bytes for extent {ext}, expected {expected} (corrupt or torn store row)",
                bytes.len(),
            );
            let mut v = cell.borrow_mut();
            v[ext_start..ext_start + bytes.len()].copy_from_slice(&bytes);
            drop(v);
            bit.set(true);
        }
    }

    /// **Evict** a clean, source-backed, resident extent (store seam
    /// phase 8) — same contract as [`SlotArena::evict_page`], plus:
    /// refused while any chunk guard is live (the bytes must not
    /// vanish under a reader).
    #[must_use = "a false return means the extent was NOT evicted (dirty, unbacked, non-resident, or guarded)"]
    pub fn evict_extent(&self, ext: u32) -> bool {
        let ChunkBytes::Lazy { cell, resident, .. } = &self.bytes else {
            return false;
        };
        let Some(bit) = resident.get(ext as usize) else {
            return false;
        };
        // Absent dirty bit fails closed, as on `evict_page`.
        if !bit.get() || self.dirty.get(ext as usize).copied().unwrap_or(true) {
            return false;
        }
        // A live ChunkSlice guard borrows the cell; never evict under
        // a reader.
        if cell.try_borrow_mut().is_err() {
            return false;
        }
        bit.set(false);
        true
    }

    /// Advance the lazy backing to the CURRENT geometry after the
    /// session's own checkpoint — the extent-space twin of
    /// [`SlotArena::advance_backing`]. No-op when detached (including
    /// after a compaction's downgrade to plain storage).
    pub fn advance_backing(&mut self) {
        let len = self.len();
        if let ChunkBytes::Lazy {
            resident,
            snapshot_len,
            ..
        } = &mut self.bytes
        {
            *snapshot_len = len;
            let exts = len.div_ceil(CHUNK_EXTENT_BYTES as usize);
            while resident.len() < exts {
                resident.push(Cell::new(true));
            }
        }
    }

    /// Pre-touch one extent (the adversarial-prefetch hook; no-op when
    /// detached or already resident).
    pub fn touch_extent(&self, ext: u32) {
        let per = CHUNK_EXTENT_BYTES as usize;
        self.ensure_range_resident(ext as usize * per, (ext as usize + 1) * per);
    }

    /// Compare two chunk payloads — the ONLY sanctioned way to read
    /// two chunks at once. Pre-faults BOTH before taking the two
    /// guards: on a lazy heap, constructing the second guard over a
    /// non-resident extent would `borrow_mut` under the first guard's
    /// live `Ref` and panic (the adversarial review's critical
    /// finding). New two-chunk comparisons go through here, never
    /// through two bare [`Self::payload`] calls.
    pub fn compare_payloads(&self, a: ChunkOffset, b: ChunkOffset) -> std::cmp::Ordering {
        self.ensure_payload_resident(a);
        self.ensure_payload_resident(b);
        self.payload(a).cmp(&self.payload(b))
    }

    /// Fault the header and payload extents of the block at `off` in,
    /// WITHOUT taking a read guard. Callers that hold two
    /// [`ChunkSlice`] guards at once (the string comparison opcodes)
    /// MUST pre-fault every operand through this before taking the
    /// first guard: constructing a second guard whose extents are
    /// non-resident would otherwise `borrow_mut` under the first
    /// guard's live `Ref` — the adversarial-review critical finding
    /// (a lazily resumed machine crashing on `a === b` across
    /// extents while every other run mode succeeds).
    pub fn ensure_payload_resident(&self, off: ChunkOffset) {
        if matches!(self.bytes, ChunkBytes::Plain(_)) || off.is_null() {
            return;
        }
        let h = (off.0 as usize)
            .checked_sub(CHUNK_HEADER)
            .expect("chunk offset below header (corrupt heap)");
        self.ensure_range_resident(h, h + CHUNK_HEADER);
        let len = self.len_of(off);
        let start = off.0 as usize;
        self.ensure_range_resident(start, start + len);
    }

    /// Fault every attach-time extent in (`&self`).
    pub fn ensure_all_resident(&self) {
        if let ChunkBytes::Lazy { snapshot_len, .. } = &self.bytes {
            self.ensure_range_resident(0, *snapshot_len);
        }
    }

    /// Whether every attach-time extent is resident (trivially true
    /// when detached).
    pub fn is_fully_resident(&self) -> bool {
        match &self.bytes {
            ChunkBytes::Plain(_) => true,
            ChunkBytes::Lazy { resident, .. } => resident.iter().all(|c| c.get()),
        }
    }

    /// How many attach-time extents are resident (all of them when
    /// detached).
    pub fn resident_extent_count(&self) -> u32 {
        match &self.bytes {
            ChunkBytes::Plain(v) => v.len().div_ceil(CHUNK_EXTENT_BYTES as usize) as u32,
            ChunkBytes::Lazy { resident, .. } => resident.iter().filter(|c| c.get()).count() as u32,
        }
    }

    /// A shared view of byte range `[start, end)`, faulting it in
    /// first on a lazy arena.
    #[inline]
    fn view(&self, start: usize, end: usize) -> ChunkSlice<'_> {
        match &self.bytes {
            ChunkBytes::Plain(v) => ChunkSlice::Plain(&v[start..end]),
            ChunkBytes::Lazy { cell, .. } => {
                self.ensure_range_resident(start, end);
                ChunkSlice::Guard(Ref::map(cell.borrow(), |v| &v[start..end]))
            }
        }
    }

    /// The current logical byte length.
    #[inline]
    fn len(&self) -> usize {
        match &self.bytes {
            ChunkBytes::Plain(v) => v.len(),
            ChunkBytes::Lazy { cell, .. } => cell.borrow().len(),
        }
    }

    /// The byte vector, for the `&mut` mutation paths (no runtime
    /// borrow cost: `RefCell::get_mut` is compile-time exclusive).
    #[inline]
    fn bytes_mut(&mut self) -> &mut Vec<u8> {
        match &mut self.bytes {
            ChunkBytes::Plain(v) => v,
            ChunkBytes::Lazy { cell, .. } => cell.get_mut(),
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
        // Fault the stored tail extent before appending beside its
        // bytes: an append lands mid-extent whenever the snapshot
        // length is not extent-aligned, and that extent's stored
        // prefix must be real before the extent can ever be read.
        let header = self.len();
        if header > 0 {
            self.ensure_range_resident(header - 1, header);
        }
        let v = self.bytes_mut();
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        let off = v.len() as u32;
        v.extend_from_slice(data);
        let end = v.len();
        debug_assert_eq!(off as usize, header + CHUNK_HEADER);
        self.mark_dirty_range(header, end);
        ChunkOffset(off)
    }

    /// The stored length of the block whose payload begins at `off`.
    /// An offset below the header width can only come from a corrupt
    /// heap (record-content corruption is not validated at open —
    /// design's named limitation); it dies as a uniformly named
    /// deterministic panic in every build profile rather than a
    /// debug-only underflow.
    #[inline]
    pub fn len_of(&self, off: ChunkOffset) -> usize {
        let h = (off.0 as usize)
            .checked_sub(CHUNK_HEADER)
            .expect("chunk offset below header (corrupt heap)");
        let hdr = self.view(h, h + CHUNK_HEADER);
        u32::from_le_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as usize
    }

    /// A shared view of `len` bytes of the block whose payload begins
    /// at `off`, faulting the covering extents in on a lazy arena. The
    /// guard derefs to `[u8]`; callers must not hold it across a
    /// mutation of this arena (the compiler enforces that for the
    /// plain arm, and the `RefCell` enforces it deterministically for
    /// the lazy arm).
    #[inline]
    pub fn slice(&self, off: ChunkOffset, len: usize) -> ChunkSlice<'_> {
        let start = off.0 as usize;
        self.view(start, start + len)
    }

    /// The whole payload of the block at `off`, using its stored length.
    #[inline]
    pub fn payload(&self, off: ChunkOffset) -> ChunkSlice<'_> {
        self.slice(off, self.len_of(off))
    }

    /// A mutable view of `len` bytes of the block whose payload begins at
    /// `off` — for in-place mutation of an ArrayBuffer backing store
    /// (TypedArray/DataView element writes), which XS does by writing
    /// directly through `arrayBuffer.address`. Faults the covering
    /// extents first: a partial overwrite of a non-resident extent must
    /// not leave placeholder bytes beside fresh ones.
    #[inline]
    pub fn slice_mut(&mut self, off: ChunkOffset, len: usize) -> &mut [u8] {
        let start = off.0 as usize;
        self.ensure_range_resident(start, start + len);
        self.mark_dirty_range(start, start + len);
        &mut self.bytes_mut()[start..start + len]
    }

    /// Slide-compact: keep only the blocks whose payload offsets are in
    /// `live`, packing them to the front of the arena in ascending
    /// offset order, and return the old→new payload-offset remap the
    /// caller applies to every live `ChunkOffset` (design § Value and
    /// heap model: "offsets are rewritten exactly where XS rewrites
    /// pointers"). Duplicate/unknown offsets in `live` are ignored.
    pub fn compact(&mut self, live: &[ChunkOffset]) -> std::collections::HashMap<ChunkOffset, ChunkOffset> {
        use std::collections::{HashMap, HashSet};
        // Compaction reads every live block, so it is the amortized
        // full reifier on a lazy arena (design decision 4); after it,
        // every offset has changed and the source is stale, so the
        // arena downgrades to plain fully-resident storage.
        self.ensure_all_resident();

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

        // Validate every live block against the CURRENT bytes BEFORE
        // the backing vector is taken below: a corrupt offset or
        // length (record-content corruption is not validated at open —
        // the design's named limitation) must die here, while the
        // arena is still intact. Panicking after the take would unwind
        // with the byte space emptied — a machine caught by
        // `catch_unwind` would then serialize a zero-length chunk
        // space under offsets that point past its end.
        {
            let total = self.len();
            for &old in &seen {
                let h = (old.0 as usize)
                    .checked_sub(CHUNK_HEADER)
                    .expect("chunk offset below header (corrupt heap)");
                assert!(h + CHUNK_HEADER <= total, "chunk header out of range (corrupt heap)");
                let len = self.len_of(old);
                // checked_add, not `+`: on a 32-bit usize a corrupt
                // u32 length can wrap the sum past the guard, and the
                // later slice would then panic AFTER the byte space
                // was taken — exactly the state-loss this validation
                // pass exists to prevent (review finding). Panicking
                // HERE is fine: nothing has been taken yet.
                let end = (old.0 as usize)
                    .checked_add(len)
                    .expect("chunk payload length overflows (corrupt heap)");
                assert!(end <= total, "chunk payload out of range (corrupt heap)");
            }
        }

        let old_bytes = std::mem::take(self.bytes_mut());
        // In-range by the validation pass above; the arithmetic cannot
        // panic between the take and the reinstall.
        let len_at = |off: ChunkOffset| -> usize {
            let h = off.0 as usize - CHUNK_HEADER;
            u32::from_le_bytes([
                old_bytes[h],
                old_bytes[h + 1],
                old_bytes[h + 2],
                old_bytes[h + 3],
            ]) as usize
        };

        let mut fresh: Vec<u8> = Vec::with_capacity(old_bytes.len());
        let mut remap: HashMap<ChunkOffset, ChunkOffset> = HashMap::new();
        for old in seen {
            let len = len_at(old);
            let start = old.0 as usize;
            let header = fresh.len();
            fresh.extend_from_slice(&(len as u32).to_le_bytes());
            let new_off = fresh.len() as u32;
            fresh.extend_from_slice(&old_bytes[start..start + len]);
            debug_assert_eq!(new_off as usize, header + CHUNK_HEADER);
            remap.insert(old, ChunkOffset(new_off));
        }
        // Incremental compaction dirt (store seam phase 7): an extent
        // is dirty only if its BYTES actually changed — a compaction
        // that moves little (garbage clustered at the tail) re-commits
        // little. The geometry may have shrunk, so the bitmap tracks
        // the new extent count; an extent wholly identical to its old
        // bytes at the same positions stays clean, because the store
        // already holds exactly those bytes.
        let exts = fresh.len().div_ceil(CHUNK_EXTENT_BYTES as usize);
        let per = CHUNK_EXTENT_BYTES as usize;
        let mut dirty = Vec::with_capacity(exts);
        for e in 0..exts {
            let start = e * per;
            let end = fresh.len().min(start + per);
            let changed = match old_bytes.get(start..end) {
                Some(old) => old != &fresh[start..end],
                // The old space was shorter here: new content, dirty.
                None => true,
            };
            // Uncommitted PRE-compaction dirt must survive: the diff
            // above compares against pre-compaction MEMORY, but the
            // store holds the last COMMITTED bytes, which may differ
            // even where compaction moved nothing.
            let was_dirty = self.dirty.get(e).copied().unwrap_or(true);
            // A shrunk FINAL extent also counts as changed when ITS
            // OWN byte count shrank — the stored row carried the old,
            // longer length. Compare the old space clamped to this
            // extent, not whole-space lengths: dropping entire
            // trailing extents while the surviving tail's own bytes
            // are identical leaves that tail clean (the geometry
            // shrink travels in the manifest, and the store deletes
            // rows past the new extent count).
            let tail_shrunk = e == exts - 1 && old_bytes.len().min(start + per) > fresh.len();
            dirty.push(changed || was_dirty || tail_shrunk);
        }
        self.bytes = ChunkBytes::Plain(fresh);
        self.dirty = dirty;
        remap
    }

    #[inline]
    pub fn byte_size(&self) -> usize {
        self.len()
    }

    // --- snapshot support (see `ironhorse-snapshot`) ---

    /// The whole backing byte vector, header discipline included — the
    /// `BLOC` atom payload. Because `ChunkOffset`s are byte offsets into
    /// exactly these bytes, serializing them verbatim keeps every offset
    /// valid across a round-trip with no relocation (design § Snapshots:
    /// the writer is a serializer, not a relocator). On a lazy arena
    /// this faults everything in first (a whole-heap serialization
    /// needs the whole byte space); the incremental checkpoint uses
    /// [`ChunkArena::extent_bytes`] instead.
    pub fn raw_vec(&self) -> Vec<u8> {
        self.ensure_all_resident();
        match &self.bytes {
            ChunkBytes::Plain(v) => v.clone(),
            ChunkBytes::Lazy { cell, .. } => cell.borrow().clone(),
        }
    }

    /// The bytes of one extent under the current logical length (the
    /// incremental checkpoint's unit). Dirty extents are resident by
    /// construction; this still faults defensively for arbitrary
    /// callers.
    pub fn extent_bytes(&self, ext: u32) -> Vec<u8> {
        let per = CHUNK_EXTENT_BYTES as usize;
        let start = ext as usize * per;
        let end = (start + per).min(self.len());
        self.view(start, end).to_vec()
    }

    /// Rebuild a chunk arena from a serialized `BLOC` image. The dirty
    /// bitmap starts clean, as on [`SlotArena::from_image`].
    pub fn from_image(bytes: Vec<u8>) -> ChunkArena {
        let exts = bytes.len().div_ceil(CHUNK_EXTENT_BYTES as usize);
        ChunkArena {
            bytes: ChunkBytes::Plain(bytes),
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
        assert_eq!(&*c.payload(new_off), b"keep me");
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
