//! The BULK side tables — array items, index properties and collection
//! entries — behind counting accessors (store-seam design § Plan:
//! counted side-table ref-page accessors).
//!
//! The partial collector roots from the pages side-table values
//! reference. Before this module, finding those pages walked every
//! side-table entry (O(live), ~1 ms at 480k slots); the three BULK
//! tables carry almost all of that weight. Here their maps are
//! **private to this module**, and the only mutation routes are
//! methods that apply symmetric per-page refcount deltas via the same
//! [`Slot::each_ref_slot`] projection the enumeration visitor uses —
//! so the collector reads a standing page map in
//! O(pages-with-refs) instead of walking entries.
//!
//! **Privacy is the soundness mechanism.** With the fields private,
//! the compiler forces every current and future mutation site through
//! the counted path; a missed site is a compile error, not a silent
//! leak (missed decrement = permanent root) or corruption (missed
//! increment = freeing a live page). The one deliberate escape hatch
//! is [`ArrayData::for_each_value_mut_chunk_remap`] /
//! [`CollectionData::for_each_entry_mut_chunk_remap`] for the full
//! collector's CHUNK-offset rewrite, which by contract never changes
//! which SLOTS a value references (slots do not move; only the chunk
//! arena compacts) — and the store-integrity parity check in the page
//! projection would catch a violation.
//!
//! Neither type implements `Clone`: a bare clone would carry entries
//! whose pages were never counted. There are no cloning call sites
//! today; a future one must add a counted clone here, beside the
//! counts it must maintain.

use crate::side_storage;
use crate::value::{ChunkArena, Slot, SlotIndex, SLOTS_PER_PAGE};

/// Per-page reference counts for BULK side-table-held references
/// (`page -> live reference count`) and a lifetime poison latch: the nonzero
/// key set IS the collector's bulk root-page set. Owned by the
/// interpreter beside the tables; threaded into every counted
/// mutation.
#[derive(Debug, Default)]
pub(crate) struct SideRefCounts {
    counts: std::collections::HashMap<u32, u32>,
    poisoned: std::cell::Cell<bool>,
}

impl SideRefCounts {
    pub(crate) fn new() -> SideRefCounts {
        SideRefCounts {
            counts: std::collections::HashMap::new(),
            poisoned: std::cell::Cell::new(false),
        }
    }

    pub(crate) fn page_of(r: SlotIndex) -> Option<u32> {
        // The null sentinel and any out-of-arena index are skipped at
        // READ time by the bitmap bound; skip null here so the map
        // never carries a phantom page for it.
        if r.is_null() {
            None
        } else {
            Some(r.0 / SLOTS_PER_PAGE)
        }
    }

    /// The parity net's comparison: the standing counts against a fresh
    /// per-page recount of the bulk tables (`walked`, keyed like
    /// [`Self::page_of`]). Exact counts, not page bits: a missed decrement
    /// on a page another reference still pins, or a missed increment
    /// beside an existing one, leaves the page SET unchanged and only the
    /// count can see it. Reports the lowest mismatching page so the
    /// diagnostic is deterministic.
    pub(crate) fn mismatch_against(
        &self,
        walked: &std::collections::HashMap<u32, u64>,
    ) -> Option<crate::gc::SideRefParityMismatch> {
        let pages: std::collections::BTreeSet<u32> =
            self.counts.keys().chain(walked.keys()).copied().collect();
        pages.into_iter().find_map(|page| {
            let counted = u64::from(self.counts.get(&page).copied().unwrap_or(0));
            let walked = walked.get(&page).copied().unwrap_or(0);
            (counted != walked).then_some(crate::gc::SideRefParityMismatch {
                page,
                counted,
                walked,
            })
        })
    }

    fn add_slot(&mut self, s: &Slot) {
        s.each_ref_slot(|r| {
            if let Some(page) = Self::page_of(r) {
                let n = self.counts.entry(page).or_insert(0);
                if let Some(next) = n.checked_add(1) {
                    *n = next;
                } else {
                    self.poison();
                }
            }
        });
    }

    fn remove_slot(&mut self, s: &Slot) {
        s.each_ref_slot(|r| {
            if let Some(page) = Self::page_of(r) {
                match self.counts.get_mut(&page) {
                    Some(n) if *n > 1 => *n -= 1,
                    Some(1) => {
                        self.counts.remove(&page);
                    }
                    _ => {
                        // A decrement without a matching increment is
                        // exactly the corruption class this module
                        // exists to prevent. Refuse collection and
                        // checkpointing in every build profile, even
                        // if later mutations restore the page set.
                        self.poison();
                    }
                }
            }
        });
    }

    pub(crate) fn poison(&self) {
        self.poisoned.set(true);
    }

    pub(crate) fn is_poisoned(&self) -> bool {
        self.poisoned.get()
    }

    /// OR the counted pages into a page bitmap (the partial
    /// collector's projection). Out-of-bitmap pages are skipped, like
    /// the enumeration projection skips out-of-arena indices.
    pub(crate) fn or_into_bits(&self, bits: &mut [bool]) {
        for &page in self.counts.keys() {
            if let Some(b) = bits.get_mut(page as usize) {
                *b = true;
            }
        }
    }

    /// The counted page set, sorted — the unit tests' comparand.
    #[cfg(test)]
    pub(crate) fn pages_sorted(&self) -> Vec<u32> {
        let mut v: Vec<u32> = self.counts.keys().copied().collect();
        v.sort_unstable();
        v
    }
}

/// What one [`ArrayData::insert_item`] is charged against its host-allocator
/// pre-flight ([`crate::value::preflight_host_growth`]). On the audited
/// 64-bit build, a million sequential inserts into a `BTreeMap<u32, Slot>`
/// allocate one node every six inserts, 55.6 bytes per item, and no node
/// is larger than 416 bytes, so 512 is about nine times the average and
/// the 128 inserts between two pre-flights stay well inside their block.
const ITEM_GROWTH_BOUND: usize = 512;

/// An Array instance's internal state (kept in `Interp::arrays`): the
/// spec `length` and the sparse item map. Item indices are u32 (a
/// hole). A `BTreeMap` keeps the indices ordered so `for-in`
/// enumeration and `Array.prototype` iteration visit them in
/// ascending index order, matching XS's item-chunk order. The map is
/// private: mutate through the counted methods.
///
/// The present items are charged against the chunk ceiling at
/// [`crate::side_storage::ARRAY_ITEM_BYTES`] each, by capacity class of
/// their count ([`crate::side_storage::array_items_charge`]). Every method
/// that adds or removes an item takes the [`ChunkArena`] that holds the
/// ledger, so a missed site is a compile error, as for the page counts. A
/// sparse `length` costs nothing: only present items are charged.
#[derive(Debug, Default)]
pub(crate) struct ArrayData {
    pub(crate) length: u32,
    items: std::collections::BTreeMap<u32, Slot>,
    /// How many items carry a non-default descriptor flag — a sealed,
    /// frozen, non-enumerable or non-writable element.
    ///
    /// Kept as a COUNT rather than recomputed because
    /// [`Self::has_attributed_items`] gates the dense fast paths, which run
    /// per element: an O(items) scan there would make `push` in a loop
    /// quadratic. Every mutation of the map goes through the counted methods
    /// below for exactly this reason; there is deliberately no `items_mut`.
    attributed: u32,
}

impl ArrayData {
    /// Read-only view of the item map.
    pub(crate) fn items(&self) -> &std::collections::BTreeMap<u32, Slot> {
        &self.items
    }

    /// The side storage this row is charged against the chunk ceiling.
    pub(crate) fn side_charge(&self) -> u64 {
        side_storage::array_items_charge(self.items.len() as u64)
    }

    /// Whether any element carries a non-default descriptor flag.
    ///
    /// The dense fast paths ([`Interp::dense_array_this`] and the
    /// `*_fast_safe` predicates) may only run when this is false. They write
    /// items directly, without carrying attributes across, so over an
    /// attributed element they would erase or relocate its flags — turning
    /// `Object.freeze(a); a.reverse()` into a silent mutation of a frozen
    /// array. Attributed elements used to be PROMOTED out of the item map by
    /// `array_define_index`, which broke `items().len() == length` and made
    /// these paths decline as a side effect; stamping them in place removed
    /// that accident, so the condition is now stated outright.
    pub(crate) fn has_attributed_items(&self) -> bool {
        self.attributed != 0
    }

    fn count_added(&mut self, value: &Slot) {
        if value.flag != 0 {
            self.attributed += 1;
        }
    }

    fn count_removed(&mut self, value: &Slot) {
        if value.flag != 0 {
            self.attributed -= 1;
        }
    }

    /// Set one item's descriptor flags, keeping the attributed count in step.
    /// Returns false when there is no item at `index`.
    pub(crate) fn set_item_flag(&mut self, index: u32, flag: u8) -> bool {
        let Some(item) = self.items.get_mut(&index) else {
            return false;
        };
        let was = item.flag;
        item.flag = flag;
        if was == 0 && flag != 0 {
            self.attributed += 1;
        } else if was != 0 && flag == 0 {
            self.attributed -= 1;
        }
        true
    }

    /// OR `mask` into every item's descriptor flags (the template-array
    /// freeze), keeping the attributed count in step.
    pub(crate) fn or_all_item_flags(&mut self, mask: u8) {
        if mask == 0 {
            return;
        }
        for item in self.items.values_mut() {
            if item.flag == 0 {
                self.attributed += 1;
            }
            item.flag |= mask;
        }
    }

    /// Store `value` at `index`. A new index that crosses into the next
    /// capacity class is charged first; a refused charge halts the crank
    /// with `HeapExhausted` before the map changes.
    pub(crate) fn insert_item(
        &mut self,
        index: u32,
        value: Slot,
        refs: &mut SideRefCounts,
        chunks: &mut ChunkArena,
    ) -> Option<Slot> {
        let present = self.items.len() as u64;
        if side_storage::at_class_boundary(present) && !self.items.contains_key(&index) {
            chunks.reserve_side(
                side_storage::array_items_charge(present + 1)
                    - side_storage::array_items_charge(present),
            );
        }
        self.store_item(index, value, refs)
    }

    /// [`Self::insert_item`] without the charge: the resume path, which
    /// rebuilds rows the guest already paid for. The interpreter derives the
    /// ledger from the restored tables afterwards.
    pub(crate) fn restore_item(
        &mut self,
        index: u32,
        value: Slot,
        refs: &mut SideRefCounts,
    ) -> Option<Slot> {
        self.store_item(index, value, refs)
    }

    fn store_item(&mut self, index: u32, value: Slot, refs: &mut SideRefCounts) -> Option<Slot> {
        // A `BTreeMap` insert allocates nodes infallibly, so pre-flight the
        // host allocator instead, before any mutation of the map.
        crate::value::preflight_host_growth(ITEM_GROWTH_BOUND);
        refs.add_slot(&value);
        self.count_added(&value);
        let displaced = self.items.insert(index, value);
        if let Some(old) = &displaced {
            refs.remove_slot(old);
            let old = *old;
            self.count_removed(&old);
        }
        displaced
    }

    pub(crate) fn remove_item(
        &mut self,
        index: &u32,
        refs: &mut SideRefCounts,
        chunks: &mut ChunkArena,
    ) -> Option<Slot> {
        let removed = self.items.remove(index);
        if let Some(old) = &removed {
            refs.remove_slot(old);
            let old = *old;
            self.count_removed(&old);
            let present = self.items.len() as u64;
            chunks.release_side(
                side_storage::array_items_charge(present + 1)
                    - side_storage::array_items_charge(present),
            );
        }
        removed
    }

    pub(crate) fn clear_items(&mut self, refs: &mut SideRefCounts, chunks: &mut ChunkArena) {
        for s in self.items.values() {
            refs.remove_slot(s);
        }
        chunks.release_side(self.side_charge());
        self.items.clear();
        self.attributed = 0;
    }

    /// Decrement every item's refs — the whole-row removal path (the
    /// GC sweep and the partial collector's page sweep drop the row
    /// itself afterwards). O(items dropped), amortized like the sweep.
    /// The collectors re-derive the side-storage ledger once they finish.
    pub(crate) fn drop_refs(&self, refs: &mut SideRefCounts) {
        for s in self.items.values() {
            refs.remove_slot(s);
        }
    }

    /// Replace the whole item map (the shift/unshift rebuild shape):
    /// decrement everything displaced, increment everything new —
    /// O(old + new), on paths that were already O(n). A larger map is
    /// charged before anything changes.
    pub(crate) fn replace_items(
        &mut self,
        new_items: std::collections::BTreeMap<u32, Slot>,
        refs: &mut SideRefCounts,
        chunks: &mut ChunkArena,
    ) {
        let before = self.side_charge();
        let after = side_storage::array_items_charge(new_items.len() as u64);
        if after > before {
            chunks.reserve_side(after - before);
        } else {
            chunks.release_side(before - after);
        }
        for s in self.items.values() {
            refs.remove_slot(s);
        }
        self.attributed = 0;
        for s in new_items.values() {
            refs.add_slot(s);
            if s.flag != 0 {
                self.attributed += 1;
            }
        }
        self.items = new_items;
    }

    /// The full collector's CHUNK-offset rewrite: mutable access to
    /// every value WITHOUT a refs delta, sound because chunk
    /// compaction never changes which SLOTS a value references
    /// (slots do not move). Do not use for anything else — the debug
    /// parity check in the page projection is watching, and the
    /// attributed count is not maintained here, so the callback must not
    /// change any item's `flag`.
    pub(crate) fn for_each_value_mut_chunk_remap(&mut self, mut f: impl FnMut(&mut Slot)) {
        for s in self.items.values_mut() {
            f(s);
        }
    }
}

/// Which collection an instance is (XS's `XS_MAP_KIND`/`XS_SET_KIND`/
/// `XS_WEAK_MAP_KIND`/`XS_WEAK_SET_KIND` internal slot).
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub(crate) enum CollKind {
    Map,
    Set,
    WeakMap,
    WeakSet,
}

impl CollKind {
    /// The stable wire code for snapshot serialization (side-table
    /// ledger). Codes are frozen: a renumbering would misread every
    /// stored collection.
    pub(crate) fn code(self) -> u8 {
        match self {
            CollKind::Map => 0,
            CollKind::Set => 1,
            CollKind::WeakMap => 2,
            CollKind::WeakSet => 3,
        }
    }

    pub(crate) fn from_code(code: u8) -> Option<CollKind> {
        match code {
            0 => Some(CollKind::Map),
            1 => Some(CollKind::Set),
            2 => Some(CollKind::WeakMap),
            3 => Some(CollKind::WeakSet),
            _ => None,
        }
    }

    fn is_weak(self) -> bool {
        matches!(self, CollKind::WeakMap | CollKind::WeakSet)
    }
}

/// A key's SameValueZero class for the lookup index. Numbers, booleans,
/// the empty kinds and references compare exactly. A String or BigInt key
/// is represented by a hash of its content, never by a copy of it, so the
/// index costs a fixed width per entry however long the key is (one long
/// string used as a key in many collections used to be copied into every
/// one of them); entries whose content hash collides are told apart by
/// comparing the stored key itself (`CollectionData::find`). The hash is
/// keyed per process, so a guest cannot aim collisions, and it decides only
/// where a lookup starts, never its answer. Content keys hold no chunk
/// offsets, so this derived index survives chunk compaction and is not a GC
/// root.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum CollKey {
    Empty(u8),
    Boolean(bool),
    Number(u64),
    String(u64),
    BigInt(u64),
    Reference(SlotIndex),
}

impl CollKey {
    /// Whether keys of this class must be compared by content.
    fn by_content(self) -> bool {
        matches!(self, CollKey::String(_) | CollKey::BigInt(_))
    }

    /// The process-keyed content hash a String or BigInt key is indexed by.
    pub(crate) fn content_hash(content: impl std::hash::Hash) -> u64 {
        use std::hash::BuildHasher;
        static KEYS: std::sync::OnceLock<std::collections::hash_map::RandomState> =
            std::sync::OnceLock::new();
        KEYS.get_or_init(std::collections::hash_map::RandomState::new)
            .hash_one(content)
    }
}

#[derive(Debug, Default)]
struct CollectionIndex {
    positions: std::collections::HashMap<CollKey, usize>,
    keys: Vec<Option<CollKey>>,
    // Snapshot decoding historically admits duplicate keys, and distinct
    // String or BigInt keys can share a content hash. Keep subsequent
    // positions of the same class in ascending order, preserving first-live
    // lookup on deletion.
    duplicates: std::collections::HashMap<CollKey, std::collections::VecDeque<usize>>,
}

/// One physical entry of a collection's insertion-ordered list: a live
/// key/value pair or a tombstone, with the sequence number it was appended
/// under. Sequence numbers ascend along the list and are never reused, so a
/// cursor that holds one survives the list compacting underneath it.
#[derive(Clone, Copy, Debug)]
pub(crate) struct CollEntry {
    seq: u64,
    kv: Option<(Slot, Slot)>,
}

/// A position in a collection's insertion order, held across guest calls by
/// iterators and by native loops (`forEach`, the Set methods). `seq` is the
/// least sequence number not yet visited; `hint` caches the physical index
/// it was last found at, revalidated on every use. Cursors survive
/// compaction because they name entries by sequence number, not by place.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CollCursor {
    pub(crate) seq: u64,
    pub(crate) hint: u32,
}

/// A Map/Set/WeakMap/WeakSet instance's internal state (XS's exotic
/// collection: the hash table + insertion-ordered entry list, or the
/// weak-entry list). Kept in the `Interp::collections` side table
/// like [`ArrayData`]; entry key/value slots are never swept
/// underneath it: collection runs only between cranks. `entries`
/// preserves insertion order (XS's `list` order, what
/// `forEach`/iterators visit); Set/WeakSet ignore the value half.
/// The entry list is private: mutate through the counted methods.
///
/// Deletion from a Map or Set leaves a tombstone, so the entries that follow
/// keep their places while lookups and cursors run; a delete followed by
/// re-add appends a new entry at the tail. Cursors name entries by sequence
/// number ([`CollCursor`]), so the list can drop its tombstones at any time:
/// it does so as soon as they outnumber the live entries, which keeps the
/// list within twice its live count at amortized constant cost per delete.
/// The snapshot view compacts them too (see `Interp::collections_snapshot`);
/// `Interp::iterators_snapshot` maps cursors to live-entry ordinals and
/// preserves retired cursors. The round-trip contract is exercised by
/// snapshot `iterator_carry.rs`.
///
/// The live entries are charged against the chunk ceiling by capacity class
/// ([`crate::side_storage::collection_charge`]). The charge depends on the
/// live count alone, which the snapshot preserves, so a restored machine
/// charges what the original did.
///
/// Metering is purely allocation-driven — xsMapSet.c contains no
/// `mxMeter` calls — so `table_length` tracks XS's power-of-two
/// address-array length (`fxResizeEntries`) to charge the
/// `fxNewChunk(length * 8)` on the exact rehash boundaries XS
/// crosses. Weak collections have no table (their entries hang off
/// the key object), so `table_length` is unused for them.
#[derive(Debug)]
pub(crate) struct CollectionData {
    pub(crate) kind: CollKind,
    entries: Vec<CollEntry>,
    live_count: usize,
    /// The sequence number the next appended entry takes.
    next_seq: u64,
    /// Materialized lazily, including only newly appended entries on each
    /// lookup. Restoring a collection never faults its content-key chunks.
    index: std::cell::RefCell<CollectionIndex>,
    pub(crate) table_length: u32,
    /// Bumped by [`Self::clear_entries`] only. A live cursor captures
    /// the generation at creation and dead-ends when it changes —
    /// XS's observable `clear` semantics (its purge frees the list a
    /// cursor's node pointer chains through, so the cursor never
    /// reaches entries added after a clear). Not persisted — the
    /// absolute counter is unobservable: carried cursors (the `ITER`
    /// row) fold staleness into `done` at the boundary and adopt the
    /// restored table's reset-to-zero generation, so the equality this
    /// counter feeds holds identically after a resume.
    generation: u32,
}

impl CollectionData {
    pub(crate) fn new(kind: CollKind, table_length: u32) -> CollectionData {
        CollectionData {
            kind,
            entries: Vec::new(),
            live_count: 0,
            next_seq: 0,
            index: std::cell::RefCell::default(),
            table_length,
            generation: 0,
        }
    }

    /// The clear-generation a cursor captures at creation; see the
    /// field doc.
    pub(crate) fn generation(&self) -> u32 {
        self.generation
    }

    /// The physical list length, tombstones included.
    pub(crate) fn physical_len(&self) -> usize {
        self.entries.len()
    }

    /// The live entries in insertion order (what `size`, `forEach`,
    /// and the snapshot see).
    pub(crate) fn live_entries(&self) -> impl Iterator<Item = &(Slot, Slot)> {
        self.entries.iter().filter_map(|entry| entry.kv.as_ref())
    }

    /// Count of live (non-tombstone) entries — the spec `size`.
    pub(crate) fn live_len(&self) -> usize {
        self.live_count
    }

    /// The side storage this row is charged against the chunk ceiling.
    pub(crate) fn side_charge(&self) -> u64 {
        side_storage::collection_charge(self.live_count as u64)
    }

    /// The value half of the live entry at physical index `at`, which the
    /// caller found with [`Self::find`].
    pub(crate) fn value_at(&self, at: usize) -> Slot {
        self.entries[at].kv.expect("value_at on tombstone").1
    }

    /// The physical index `cursor` resumes at: its hint when that is still
    /// the first entry at or past its sequence number, else a search.
    fn cursor_position(&self, cursor: &CollCursor) -> usize {
        let hint = cursor.hint as usize;
        let valid = hint <= self.entries.len()
            && (hint == 0 || self.entries[hint - 1].seq < cursor.seq)
            && (hint == self.entries.len() || self.entries[hint].seq >= cursor.seq);
        if valid {
            hint
        } else {
            self.entries.partition_point(|entry| entry.seq < cursor.seq)
        }
    }

    /// The next live entry at or after `cursor`, advancing it past that
    /// entry; `None` (with the cursor past every current entry) at the end.
    pub(crate) fn next_live(&self, cursor: &mut CollCursor) -> Option<(Slot, Slot)> {
        let mut at = self.cursor_position(cursor);
        while let Some(entry) = self.entries.get(at) {
            if let Some(kv) = entry.kv {
                cursor.seq = entry.seq + 1;
                cursor.hint = (at + 1) as u32;
                return Some(kv);
            }
            at += 1;
        }
        cursor.seq = self.next_seq;
        cursor.hint = self.entries.len() as u32;
        None
    }

    /// How many live entries precede `cursor`: its position in the
    /// compacted list a snapshot writes.
    pub(crate) fn live_ordinal(&self, cursor: &CollCursor) -> u32 {
        let end = self.cursor_position(cursor);
        self.entries[..end]
            .iter()
            .filter(|entry| entry.kv.is_some())
            .count() as u32
    }

    /// The physical index of the live entry whose key is SameValueZero to
    /// the probe `key`, by its index class. `canonicalize` classes a stored
    /// key; `same` compares a stored key with the probe, consulted only for
    /// String and BigInt classes, whose content hashes can collide.
    pub(crate) fn find(
        &self,
        key: &CollKey,
        mut canonicalize: impl FnMut(&Slot) -> CollKey,
        mut same: impl FnMut(&Slot) -> bool,
    ) -> Option<usize> {
        let mut guard = self.index.borrow_mut();
        let index = &mut *guard;
        let pending = self.entries.len() - index.keys.len();
        if index.keys.try_reserve(pending).is_err() || index.positions.try_reserve(pending).is_err()
        {
            crate::value::host_allocation_failed();
        }
        for at in index.keys.len()..self.entries.len() {
            let canonical = self.entries[at].kv.map(|(key, _)| canonicalize(&key));
            if let Some(canonical) = canonical {
                if let std::collections::hash_map::Entry::Vacant(entry) =
                    index.positions.entry(canonical)
                {
                    entry.insert(at);
                } else {
                    index.duplicates.entry(canonical).or_default().push_back(at);
                }
            }
            index.keys.push(canonical);
        }
        let head = *index.positions.get(key)?;
        if !key.by_content() {
            return Some(head);
        }
        let rest = index.duplicates.get(key);
        std::iter::once(head)
            .chain(rest.into_iter().flat_map(|rest| rest.iter().copied()))
            .find(|&at| self.entries[at].kv.is_some_and(|(stored, _)| same(&stored)))
    }

    /// Grow the list's storage to the next capacity class when it is full,
    /// so its capacity follows the same policy on every target. `false`
    /// means the host allocator refused growth the ceiling had admitted.
    fn grow_for_push(&mut self) -> bool {
        let len = self.entries.len();
        if len < self.entries.capacity() {
            return true;
        }
        let class = side_storage::capacity_class(len as u64 + 1) as usize;
        self.entries.try_reserve_exact(class - len).is_ok()
    }

    /// Append a new live entry. Crossing into the next capacity class is
    /// charged first; a refused charge halts the crank with `HeapExhausted`
    /// before the list changes.
    pub(crate) fn push_entry(
        &mut self,
        key: Slot,
        value: Slot,
        refs: &mut SideRefCounts,
        chunks: &mut ChunkArena,
    ) {
        let live = self.live_count as u64;
        let growth = if side_storage::at_class_boundary(live) {
            side_storage::collection_charge(live + 1) - side_storage::collection_charge(live)
        } else {
            0
        };
        chunks.reserve_side(growth);
        if !self.grow_for_push() {
            chunks.release_side(growth);
            crate::value::host_allocation_failed();
        }
        self.append(key, value, refs);
    }

    /// [`Self::push_entry`] without the charge: the resume path. The
    /// interpreter derives the ledger from the restored tables afterwards.
    pub(crate) fn restore_entry(&mut self, key: Slot, value: Slot, refs: &mut SideRefCounts) {
        if !self.grow_for_push() {
            crate::value::host_allocation_failed();
        }
        self.append(key, value, refs);
    }

    fn append(&mut self, key: Slot, value: Slot, refs: &mut SideRefCounts) {
        refs.add_slot(&key);
        refs.add_slot(&value);
        self.entries.push(CollEntry {
            seq: self.next_seq,
            kv: Some((key, value)),
        });
        self.next_seq += 1;
        self.live_count += 1;
    }

    /// Overwrite the value half of the live entry at physical index
    /// `at`. The caller found `at` via the key index, so a
    /// tombstone here is a logic error.
    pub(crate) fn set_entry_value(&mut self, at: usize, value: Slot, refs: &mut SideRefCounts) {
        refs.add_slot(&value);
        let entry = self.entries[at]
            .kv
            .as_mut()
            .expect("set_entry_value on tombstone");
        let old = std::mem::replace(&mut entry.1, value);
        refs.remove_slot(&old);
    }

    /// Delete the live entry at physical index `at`. Map/Set leave a
    /// tombstone so lookups and cursors keep their places (ECMA-262's
    /// emptied-entry model; note XS instead PURGES list nodes, so a cursor
    /// whose whole remaining chain was deleted dead-ends in XS where this
    /// model can still reach later appends — a deliberate spec-over-XS
    /// choice), and compact once tombstones outnumber the live entries.
    /// Weak collections have no iterators or `forEach` (both refuse), so
    /// they remove physically, keeping `collection_find` O(live) instead of
    /// O(ever-inserted).
    pub(crate) fn remove_entry(
        &mut self,
        at: usize,
        refs: &mut SideRefCounts,
        chunks: &mut ChunkArena,
    ) -> (Slot, Slot) {
        let (k, v) = self.entries[at]
            .kv
            .take()
            .expect("remove_entry on tombstone");
        refs.remove_slot(&k);
        refs.remove_slot(&v);
        self.live_count -= 1;
        let live = self.live_count as u64;
        chunks.release_side(
            side_storage::collection_charge(live + 1) - side_storage::collection_charge(live),
        );
        let index = self.index.get_mut();
        if let Some(canonical) = index.keys.get_mut(at).and_then(Option::take) {
            if index.positions.get(&canonical) == Some(&at) {
                let next = index
                    .duplicates
                    .get_mut(&canonical)
                    .and_then(|rest| rest.pop_front());
                if let Some(next) = next {
                    index.positions.insert(canonical, next);
                } else {
                    index.positions.remove(&canonical);
                }
            } else if let Some(rest) = index.duplicates.get_mut(&canonical) {
                rest.retain(|position| *position != at);
            }
            if index
                .duplicates
                .get(&canonical)
                .is_some_and(|rest| rest.is_empty())
            {
                index.duplicates.remove(&canonical);
            }
        }
        if self.kind.is_weak() {
            // Weak entries are physically removed (there are no cursors).
            // Shift cached positions with the existing physical-vector shift.
            if at < index.keys.len() {
                index.keys.remove(at);
                for position in index.positions.values_mut().chain(
                    index
                        .duplicates
                        .values_mut()
                        .flat_map(|rest| rest.iter_mut()),
                ) {
                    if *position > at {
                        *position -= 1;
                    }
                }
            }
            self.entries.remove(at);
            self.shrink_storage();
        } else if self.entries.len() - self.live_count > self.live_count {
            self.compact();
        }
        (k, v)
    }

    /// Drop every tombstone, keeping the live entries' order and sequence
    /// numbers, and re-derive the index positions from the classes already
    /// computed (no stored key is read again). O(list), run only once the
    /// tombstones outnumber the live entries, so amortized O(1) per delete.
    fn compact(&mut self) {
        let index = self.index.get_mut();
        let indexed = index.keys.len();
        let mut write = 0;
        let mut kept_indexed = 0;
        for read in 0..self.entries.len() {
            if self.entries[read].kv.is_some() {
                self.entries[write] = self.entries[read];
                if read < indexed {
                    index.keys[write] = index.keys[read];
                    kept_indexed += 1;
                }
                write += 1;
            }
        }
        self.entries.truncate(write);
        index.keys.truncate(kept_indexed);
        index.positions = std::collections::HashMap::new();
        index.duplicates = std::collections::HashMap::new();
        for (at, canonical) in index.keys.iter().enumerate() {
            let canonical = canonical.expect("a compacted entry is live");
            if let std::collections::hash_map::Entry::Vacant(entry) =
                index.positions.entry(canonical)
            {
                entry.insert(at);
            } else {
                index.duplicates.entry(canonical).or_default().push_back(at);
            }
        }
        self.shrink_storage();
    }

    /// Return storage the list no longer needs: down to its capacity class
    /// once it is at most a quarter full, so growing and shrinking around one
    /// class boundary cannot reallocate on every operation.
    fn shrink_storage(&mut self) {
        let class = side_storage::capacity_class(self.entries.len() as u64) as usize;
        if self.entries.capacity() > 2 * class.max(side_storage::MIN_CLASS as usize) {
            self.entries.shrink_to(class);
            let index = self.index.get_mut();
            index.keys.shrink_to(class);
        }
    }

    /// `Map.prototype.clear` / `Set.prototype.clear`: physically empty
    /// the list (XS's purge — reclaiming the memory and its charge) and bump
    /// the clear-generation so every live cursor dead-ends instead of
    /// aliasing its old position into entries added afterward.
    /// Snapshot `iterator_carry.rs::resumed_cleared_cursor_stays_retired`
    /// checks that this retirement survives a round trip. Plain deletes
    /// tombstone (spec-over-XS; see [`Self::remove_entry`]), while clear
    /// follows XS exactly.
    pub(crate) fn clear_entries(&mut self, refs: &mut SideRefCounts, chunks: &mut ChunkArena) {
        for (k, v) in self.live_entries() {
            refs.remove_slot(k);
            refs.remove_slot(v);
        }
        chunks.release_side(self.side_charge());
        self.entries = Vec::new();
        self.live_count = 0;
        *self.index.get_mut() = CollectionIndex::default();
        self.generation = self.generation.wrapping_add(1);
    }

    /// Whole-row removal decrement; see [`ArrayData::drop_refs`].
    pub(crate) fn drop_refs(&self, refs: &mut SideRefCounts) {
        for (k, v) in self.live_entries() {
            refs.remove_slot(k);
            refs.remove_slot(v);
        }
    }

    /// Retain only the live entries `keep` accepts, decrementing
    /// everything dropped — the full collector's dead-keyed
    /// weak-entry prune. Its only callers are WEAK collections, which
    /// no cursor can ever index (weak kinds have no iterators or
    /// `forEach`), so pruned entries — and any tombstones from before
    /// this model made weak deletes physical — are REMOVED, not
    /// tombstoned: a long-lived machine cycling weak-keyed entries
    /// must not grow its physical list by one slot per ever-inserted
    /// entry. `collection_index_tracks_lazy_appends_deletes_clear_and_weak_pruning`
    /// checks the resulting live index. Returns the number of live entries
    /// dropped. The collector re-derives the side-storage ledger afterwards.
    pub(crate) fn prune_entries(
        &mut self,
        refs: &mut SideRefCounts,
        mut keep: impl FnMut(&Slot, &Slot) -> bool,
    ) -> u32 {
        debug_assert!(
            self.kind.is_weak(),
            "prune_entries is the weak-collection dead-key sweep"
        );
        let mut dropped = 0u32;
        self.entries.retain(|entry| match entry.kv {
            None => false,
            Some((k, v)) => {
                if keep(&k, &v) {
                    true
                } else {
                    refs.remove_slot(&k);
                    refs.remove_slot(&v);
                    dropped += 1;
                    false
                }
            }
        });
        self.live_count -= dropped as usize;
        // Pruning compacts the physical positions. Rebuild lazily at the next
        // lookup, keeping the collector independent of content-key faults.
        *self.index.get_mut() = CollectionIndex::default();
        self.shrink_storage();
        dropped
    }

    /// See [`ArrayData::for_each_value_mut_chunk_remap`].
    pub(crate) fn for_each_entry_mut_chunk_remap(&mut self, mut f: impl FnMut(&mut Slot)) {
        for (k, v) in self
            .entries
            .iter_mut()
            .filter_map(|entry| entry.kv.as_mut())
        {
            f(k);
            f(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{Kind, Payload};

    fn refslot(idx: u32) -> Slot {
        Slot::of(Kind::Reference, Payload::Reference(SlotIndex(idx)))
    }

    fn arena() -> ChunkArena {
        ChunkArena::new()
    }

    fn reference_key(key: &Slot) -> CollKey {
        match key.value {
            Payload::Reference(reference) => CollKey::Reference(reference),
            _ => panic!("fixture uses references"),
        }
    }

    fn never_by_content(_: &Slot) -> bool {
        unreachable!("reference keys compare exactly")
    }

    #[test]
    fn restored_duplicate_keys_keep_first_live_resolution() {
        for kind in [CollKind::Map, CollKind::WeakMap] {
            let mut refs = SideRefCounts::new();
            let mut chunks = arena();
            let mut data = CollectionData::new(kind, 1);
            let key = CollKey::Reference(SlotIndex(1));
            for value in 0..3 {
                data.restore_entry(refslot(1), Slot::integer(value), &mut refs);
            }
            chunks.set_side_reserved(data.side_charge());
            for value in 0..3 {
                let at = data.find(&key, reference_key, never_by_content).unwrap();
                assert_eq!(data.value_at(at), Slot::integer(value));
                data.remove_entry(at, &mut refs, &mut chunks);
            }
            assert_eq!(data.find(&key, reference_key, never_by_content), None);
            assert_eq!(data.live_len(), 0);
            assert_eq!(chunks.side_reserved(), 0);
        }
    }

    #[test]
    fn weak_delete_shifts_index_frontier_before_unindexed_appends() {
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut data = CollectionData::new(CollKind::WeakMap, 0);
        data.push_entry(refslot(1), Slot::integer(1), &mut refs, &mut chunks);
        let find = |data: &CollectionData, n| {
            data.find(&reference_key(&refslot(n)), reference_key, never_by_content)
        };
        assert_eq!(find(&data, 1), Some(0));
        data.push_entry(refslot(2), Slot::integer(2), &mut refs, &mut chunks);
        data.remove_entry(0, &mut refs, &mut chunks);
        data.push_entry(refslot(1), Slot::integer(3), &mut refs, &mut chunks);
        assert_eq!(find(&data, 2), Some(0));
        assert_eq!(find(&data, 1), Some(1));
    }

    #[test]
    fn collection_index_tracks_lazy_appends_deletes_clear_and_weak_pruning() {
        for kind in [
            CollKind::Map,
            CollKind::Set,
            CollKind::WeakMap,
            CollKind::WeakSet,
        ] {
            let mut refs = SideRefCounts::new();
            let mut chunks = arena();
            let mut data = CollectionData::new(kind, 1);
            let calls = std::cell::Cell::new(0);
            for n in 1..=100 {
                data.push_entry(refslot(n), Slot::integer(n as i32), &mut refs, &mut chunks);
                assert_eq!(
                    data.find(
                        &reference_key(&refslot(n)),
                        |key| {
                            calls.set(calls.get() + 1);
                            reference_key(key)
                        },
                        never_by_content
                    ),
                    Some((n - 1) as usize)
                );
            }
            let find = |data: &CollectionData, n| {
                data.find(&reference_key(&refslot(n)), reference_key, never_by_content)
            };
            assert_eq!(calls.get(), 100, "each stored key is indexed once");
            data.remove_entry(20, &mut refs, &mut chunks);
            assert_eq!(data.live_len(), 99);
            assert_eq!(find(&data, 21), None);
            let expected = if kind.is_weak() { 98 } else { 99 };
            assert_eq!(find(&data, 100), Some(expected));
            // Delete an entry in the unindexed suffix, then append again.
            data.push_entry(refslot(101), Slot::undefined(), &mut refs, &mut chunks);
            let last = data.physical_len() - 1;
            data.remove_entry(last, &mut refs, &mut chunks);
            data.push_entry(refslot(102), Slot::undefined(), &mut refs, &mut chunks);
            assert!(find(&data, 102).is_some());
            assert_eq!(find(&data, 101), None);
            if kind.is_weak() {
                let dropped = data.prune_entries(
                    &mut refs,
                    |key, _| matches!(key.value, Payload::Reference(SlotIndex(n)) if n % 2 == 0),
                );
                assert_eq!(data.live_len(), 100 - dropped as usize);
                assert_eq!(find(&data, 1), None);
                let at = find(&data, 100).unwrap();
                assert_eq!(data.value_at(at), Slot::integer(100));
                chunks.set_side_reserved(data.side_charge());
            }
            data.clear_entries(&mut refs, &mut chunks);
            assert_eq!(data.live_len(), 0);
            assert_eq!(chunks.side_reserved(), 0);
            assert_eq!(data.generation(), 1);
            assert_eq!(find(&data, 100), None);
            data.push_entry(refslot(100), Slot::undefined(), &mut refs, &mut chunks);
            assert_eq!(find(&data, 100), Some(0));
        }
    }

    #[test]
    fn tombstones_compact_before_they_outnumber_live_entries() {
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut data = CollectionData::new(CollKind::Map, 1);
        let find = |data: &CollectionData, n| {
            data.find(&reference_key(&refslot(n)), reference_key, never_by_content)
        };
        // A set/delete churn on distinct keys never grows the list past
        // twice the live count.
        data.push_entry(refslot(1), Slot::integer(1), &mut refs, &mut chunks);
        for n in 2..10_000 {
            data.push_entry(refslot(n), Slot::integer(n as i32), &mut refs, &mut chunks);
            let at = find(&data, n).unwrap();
            data.remove_entry(at, &mut refs, &mut chunks);
            assert!(data.physical_len() <= 2 * data.live_len());
        }
        assert_eq!(data.live_len(), 1);
        assert_eq!(chunks.side_reserved(), side_storage::collection_charge(1));
        // Deleting the last live entry empties the list.
        let at = find(&data, 1).unwrap();
        data.remove_entry(at, &mut refs, &mut chunks);
        assert_eq!(data.physical_len(), 0);
        assert_eq!(chunks.side_reserved(), 0);
        assert!(refs.pages_sorted().is_empty());
    }

    #[test]
    fn cursors_survive_compaction_and_see_later_appends() {
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut data = CollectionData::new(CollKind::Set, 1);
        for n in 0..8 {
            data.push_entry(Slot::integer(n), Slot::undefined(), &mut refs, &mut chunks);
        }
        let mut cursor = CollCursor::default();
        let mut seen = Vec::new();
        for _ in 0..3 {
            seen.push(data.next_live(&mut cursor).unwrap().0);
        }
        // Delete 0..=5 (three behind the cursor, three ahead); the list
        // compacts when the tombstones outnumber the live entries.
        for n in 0..6 {
            let key = CollKey::Number((n as f64).to_bits());
            let canonical = |key: &Slot| match key.value {
                Payload::Integer(n) => CollKey::Number((n as f64).to_bits()),
                _ => unreachable!(),
            };
            let at = data.find(&key, canonical, never_by_content).unwrap();
            data.remove_entry(at, &mut refs, &mut chunks);
        }
        // The fifth delete compacted (five tombstones, three live); the
        // sixth left one tombstone beside two live entries.
        assert_eq!((data.physical_len(), data.live_len()), (3, 2));
        assert_eq!(data.live_ordinal(&cursor), 0);
        data.push_entry(Slot::integer(8), Slot::undefined(), &mut refs, &mut chunks);
        while let Some((key, _)) = data.next_live(&mut cursor) {
            seen.push(key);
        }
        let ints: Vec<Slot> = [0, 1, 2, 6, 7, 8].into_iter().map(Slot::integer).collect();
        assert_eq!(seen, ints);
        // A finished cursor resumes at the next append, not before it.
        data.push_entry(Slot::integer(9), Slot::undefined(), &mut refs, &mut chunks);
        assert_eq!(
            data.next_live(&mut cursor),
            Some((Slot::integer(9), Slot::undefined()))
        );
        assert_eq!(data.live_ordinal(&cursor), 4);
    }

    #[test]
    fn colliding_content_classes_resolve_by_comparison() {
        // Two different "strings" forced into one content class: lookup
        // falls through to the comparison, deletion keeps the other.
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut data = CollectionData::new(CollKind::Map, 1);
        let class = CollKey::String(7);
        data.push_entry(Slot::integer(1), Slot::integer(10), &mut refs, &mut chunks);
        data.push_entry(Slot::integer(2), Slot::integer(20), &mut refs, &mut chunks);
        let probe = |n: i32| move |stored: &Slot| *stored == Slot::integer(n);
        assert_eq!(data.find(&class, |_| class, probe(2)), Some(1));
        assert_eq!(data.find(&class, |_| class, probe(1)), Some(0));
        assert_eq!(data.find(&class, |_| class, probe(3)), None);
        data.remove_entry(0, &mut refs, &mut chunks);
        assert_eq!(data.find(&class, |_| class, probe(2)), Some(1));
        assert_eq!(data.find(&class, |_| class, probe(1)), None);
    }

    #[test]
    fn parity_mismatch_reports_the_lowest_page_and_exact_counts() {
        let mut refs = SideRefCounts::new();
        refs.add_slot(&refslot(10)); // page 0
        refs.add_slot(&refslot(300)); // page 1
        refs.add_slot(&refslot(300)); // page 1 again
        let walked = |pages: &[(u32, u64)]| pages.iter().copied().collect();
        assert_eq!(refs.mismatch_against(&walked(&[(0, 1), (1, 2)])), None);
        // A missed decrement on a still-pinned page: the page set agrees,
        // the count does not.
        let m = refs.mismatch_against(&walked(&[(0, 1), (1, 1)])).unwrap();
        assert_eq!((m.page, m.counted, m.walked), (1, 2, 1));
        // A page the walk sees that the counts never learned about, and
        // the lowest page wins when several disagree.
        let m = refs
            .mismatch_against(&walked(&[(0, 1), (1, 2), (2, 1)]))
            .unwrap();
        assert_eq!((m.page, m.counted, m.walked), (2, 0, 1));
        let m = refs.mismatch_against(&walked(&[(1, 2)])).unwrap();
        assert_eq!((m.page, m.counted, m.walked), (0, 1, 0));
    }

    #[test]
    fn side_ref_undercount_latches_poison_after_counts_recover() {
        let mut refs = SideRefCounts::new();
        refs.remove_slot(&refslot(10));
        assert!(refs.is_poisoned());
        refs.add_slot(&refslot(10));
        refs.remove_slot(&refslot(10));
        assert!(refs.pages_sorted().is_empty());
        assert!(refs.is_poisoned(), "balanced later writes cannot unpoison");
    }

    #[test]
    fn side_ref_overflow_latches_poison_without_wrapping() {
        let mut refs = SideRefCounts::new();
        refs.counts.insert(0, u32::MAX);
        refs.add_slot(&refslot(10));
        assert_eq!(refs.counts[&0], u32::MAX);
        assert!(refs.is_poisoned());
    }

    #[test]
    fn array_mutations_keep_counts_symmetric() {
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut a = ArrayData::default();
        a.insert_item(0, refslot(10), &mut refs, &mut chunks); // page 0
        a.insert_item(1, refslot(300), &mut refs, &mut chunks); // page 1
                                                                // Displacement: the page-0 ref is decremented when index 0 is
                                                                // overwritten with a page-2 ref.
        a.insert_item(0, refslot(600), &mut refs, &mut chunks);
        assert_eq!(refs.pages_sorted(), vec![1, 2]);
        // Whole-map replacement decrements everything displaced and
        // counts everything new.
        let mut shifted = std::collections::BTreeMap::new();
        shifted.insert(0u32, refslot(300));
        a.replace_items(shifted, &mut refs, &mut chunks);
        assert_eq!(refs.pages_sorted(), vec![1]);
        a.clear_items(&mut refs, &mut chunks);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
        // Non-reference values contribute nothing.
        a.insert_item(0, Slot::integer(7), &mut refs, &mut chunks);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
    }

    #[test]
    fn array_items_are_charged_by_class_and_released_symmetrically() {
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut a = ArrayData::default();
        for n in 0..1000u32 {
            a.insert_item(n, Slot::integer(n as i32), &mut refs, &mut chunks);
            assert_eq!(chunks.side_reserved(), a.side_charge());
        }
        // Overwriting and sparse indices change nothing but the count.
        a.insert_item(5, Slot::integer(0), &mut refs, &mut chunks);
        a.insert_item(u32::MAX - 1, Slot::integer(0), &mut refs, &mut chunks);
        assert_eq!(
            chunks.side_reserved(),
            side_storage::array_items_charge(1001)
        );
        for n in (0..1000u32).rev() {
            a.remove_item(&n, &mut refs, &mut chunks);
            assert_eq!(chunks.side_reserved(), a.side_charge());
        }
        a.clear_items(&mut refs, &mut chunks);
        assert_eq!(chunks.side_reserved(), 0);
    }

    #[test]
    fn a_refused_charge_leaves_the_row_unchanged() {
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut a = ArrayData::default();
        for n in 0..4u32 {
            a.insert_item(n, Slot::integer(0), &mut refs, &mut chunks);
        }
        chunks.set_ceiling(chunks.byte_size() + chunks.side_reserved() as usize);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            a.insert_item(4, Slot::integer(0), &mut refs, &mut chunks);
        }));
        assert!(refused.unwrap_err().is::<crate::value::HeapExhausted>());
        assert_eq!(a.items().len(), 4);
        assert_eq!(chunks.side_reserved(), side_storage::array_items_charge(4));
        // Replacing an existing item needs no new class.
        a.insert_item(3, Slot::integer(1), &mut refs, &mut chunks);
        let mut c = CollectionData::new(CollKind::Map, 1);
        let refused = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.push_entry(Slot::integer(1), Slot::integer(1), &mut refs, &mut chunks);
        }));
        assert!(refused.is_err());
        assert_eq!((c.live_len(), c.physical_len()), (0, 0));
    }

    #[test]
    fn collection_mutations_keep_counts_symmetric() {
        let mut refs = SideRefCounts::new();
        let mut chunks = arena();
        let mut c = CollectionData::new(CollKind::Map, 0);
        c.push_entry(refslot(5), refslot(700), &mut refs, &mut chunks); // pages 0, 2
        c.set_entry_value(0, refslot(300), &mut refs); // 2 -> 1
        assert_eq!(refs.pages_sorted(), vec![0, 1]);
        let (_k, _v) = c.remove_entry(0, &mut refs, &mut chunks);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
        c.push_entry(refslot(5), Slot::undefined(), &mut refs, &mut chunks);
        c.push_entry(refslot(260), refslot(261), &mut refs, &mut chunks);
        c.clear_entries(&mut refs, &mut chunks);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
        assert_eq!(chunks.side_reserved(), 0);
        // The whole-row drop path (sweep/retain) decrements without
        // consuming the row.
        c.push_entry(refslot(5), refslot(700), &mut refs, &mut chunks);
        c.drop_refs(&mut refs);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
    }
}
