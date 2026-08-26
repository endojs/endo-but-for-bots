//! The BULK side tables — array items and collection entries — behind
//! counting accessors (store-seam design § Plan: counted side-table
//! ref-page accessors).
//!
//! The partial collector roots from the pages side-table values
//! reference. Before this module, finding those pages walked every
//! side-table entry (O(live), ~1 ms at 480k slots); the two BULK
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
//! arena compacts) — and the debug parity assertion in the page
//! projection would catch a violation.
//!
//! Neither type implements `Clone`: a bare clone would carry entries
//! whose pages were never counted. There are no cloning call sites
//! today; a future one must add a counted clone here, beside the
//! counts it must maintain.

use crate::value::{Slot, SlotIndex, SLOTS_PER_PAGE};

/// Per-page reference counts for BULK side-table-held references
/// (`page -> live reference count`), plus nothing else: the nonzero
/// key set IS the collector's bulk root-page set. Owned by the
/// interpreter beside the tables; threaded into every counted
/// mutation.
#[derive(Debug, Default)]
pub(crate) struct SideRefCounts {
    counts: std::collections::HashMap<u32, u32>,
}

impl SideRefCounts {
    pub(crate) fn new() -> SideRefCounts {
        SideRefCounts {
            counts: std::collections::HashMap::new(),
        }
    }

    fn page_of(r: SlotIndex) -> Option<u32> {
        // The null sentinel and any out-of-arena index are skipped at
        // READ time by the bitmap bound; skip null here so the map
        // never carries a phantom page for it.
        if r.is_null() {
            None
        } else {
            Some(r.0 / SLOTS_PER_PAGE)
        }
    }

    fn add_slot(&mut self, s: &Slot) {
        s.each_ref_slot(|r| {
            if let Some(page) = Self::page_of(r) {
                *self.counts.entry(page).or_insert(0) += 1;
            }
        });
    }

    fn remove_slot(&mut self, s: &Slot) {
        s.each_ref_slot(|r| {
            if let Some(page) = Self::page_of(r) {
                match self.counts.get_mut(&page) {
                    Some(n) if *n > 1 => *n -= 1,
                    Some(_) => {
                        self.counts.remove(&page);
                    }
                    None => {
                        // A decrement without a matching increment is
                        // exactly the corruption class this module
                        // exists to prevent; fail loudly in debug,
                        // saturate in release (the parity assertion
                        // in the page projection is the second net).
                        debug_assert!(false, "side-ref undercount on page {page}");
                    }
                }
            }
        });
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

/// An Array instance's internal state (kept in `Interp::arrays`): the
/// spec `length` and the sparse item map. Item indices are u32 (a
/// hole). A `BTreeMap` keeps the indices ordered so `for-in`
/// enumeration and `Array.prototype` iteration visit them in
/// ascending index order, matching XS's item-chunk order. The map is
/// private: mutate through the counted methods.
#[derive(Debug, Default)]
pub(crate) struct ArrayData {
    pub(crate) length: u32,
    items: std::collections::BTreeMap<u32, Slot>,
}

impl ArrayData {
    /// Read-only view of the item map.
    pub(crate) fn items(&self) -> &std::collections::BTreeMap<u32, Slot> {
        &self.items
    }

    pub(crate) fn insert_item(
        &mut self,
        index: u32,
        value: Slot,
        refs: &mut SideRefCounts,
    ) -> Option<Slot> {
        refs.add_slot(&value);
        let displaced = self.items.insert(index, value);
        if let Some(old) = &displaced {
            refs.remove_slot(old);
        }
        displaced
    }

    pub(crate) fn remove_item(&mut self, index: &u32, refs: &mut SideRefCounts) -> Option<Slot> {
        let removed = self.items.remove(index);
        if let Some(old) = &removed {
            refs.remove_slot(old);
        }
        removed
    }

    pub(crate) fn clear_items(&mut self, refs: &mut SideRefCounts) {
        for s in self.items.values() {
            refs.remove_slot(s);
        }
        self.items.clear();
    }

    /// Decrement every item's refs — the whole-row removal path (the
    /// GC sweep and the partial collector's page sweep drop the row
    /// itself afterwards). O(items dropped), amortized like the sweep.
    pub(crate) fn drop_refs(&self, refs: &mut SideRefCounts) {
        for s in self.items.values() {
            refs.remove_slot(s);
        }
    }

    /// Replace the whole item map (the shift/unshift rebuild shape):
    /// decrement everything displaced, increment everything new —
    /// O(old + new), on paths that were already O(n).
    pub(crate) fn replace_items(
        &mut self,
        new_items: std::collections::BTreeMap<u32, Slot>,
        refs: &mut SideRefCounts,
    ) {
        for s in self.items.values() {
            refs.remove_slot(s);
        }
        for s in new_items.values() {
            refs.add_slot(s);
        }
        self.items = new_items;
    }

    /// The full collector's CHUNK-offset rewrite: mutable access to
    /// every value WITHOUT a refs delta, sound because chunk
    /// compaction never changes which SLOTS a value references
    /// (slots do not move). Do not use for anything else — the debug
    /// parity assertion in the page projection is watching.
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
}

/// A Map/Set/WeakMap/WeakSet instance's internal state (XS's exotic
/// collection: the hash table + insertion-ordered entry list, or the
/// weak-entry list). Kept in the `Interp::collections` side table
/// like [`ArrayData`]; entry key/value slots are never swept
/// underneath it (the stage-2 no-mid-run-GC contract). `entries`
/// preserves insertion order (XS's `list` order, what
/// `forEach`/iterators visit); Set/WeakSet ignore the value half.
/// The entry list is private: mutate through the counted methods.
///
/// Deletion leaves a `None` tombstone (XS unlinks the list node but a
/// live iterator's cursor holds its place) so iterators and `forEach`
/// cursors indexing the physical list do not skip the entry that
/// follows a deletion; a delete followed by re-add appends a new
/// entry at the tail. Tombstones are a LIVE-machine artifact only:
/// the snapshot view compacts them (see
/// `Interp::collections_snapshot`), which is sound because iterator
/// cursors live in the `iterators` side table, an honest `Pending`
/// ledger row that does not round-trip.
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
    entries: Vec<Option<(Slot, Slot)>>,
    pub(crate) table_length: u32,
}

impl CollectionData {
    pub(crate) fn new(kind: CollKind, table_length: u32) -> CollectionData {
        CollectionData {
            kind,
            entries: Vec::new(),
            table_length,
        }
    }

    /// Read-only view of the physical entry list, tombstones included
    /// (iterator cursors index THIS list).
    pub(crate) fn entries(&self) -> &[Option<(Slot, Slot)>] {
        &self.entries
    }

    /// The live entries in insertion order (what `size`, `forEach`,
    /// and the snapshot see).
    pub(crate) fn live_entries(&self) -> impl Iterator<Item = &(Slot, Slot)> {
        self.entries.iter().flatten()
    }

    /// Count of live (non-tombstone) entries — the spec `size`.
    pub(crate) fn live_len(&self) -> usize {
        self.entries.iter().filter(|entry| entry.is_some()).count()
    }

    pub(crate) fn push_entry(&mut self, key: Slot, value: Slot, refs: &mut SideRefCounts) {
        refs.add_slot(&key);
        refs.add_slot(&value);
        self.entries.push(Some((key, value)));
    }

    /// Overwrite the value half of the live entry at physical index
    /// `at`. The caller found `at` via a live-entry scan, so a
    /// tombstone here is a logic error.
    pub(crate) fn set_entry_value(&mut self, at: usize, value: Slot, refs: &mut SideRefCounts) {
        refs.add_slot(&value);
        let entry = self.entries[at].as_mut().expect("set_entry_value on tombstone");
        let old = std::mem::replace(&mut entry.1, value);
        refs.remove_slot(&old);
    }

    /// Delete the live entry at physical index `at`, leaving a
    /// tombstone in its place so live iterator cursors keep their
    /// position (the physical list never shifts under them).
    pub(crate) fn remove_entry(&mut self, at: usize, refs: &mut SideRefCounts) -> (Slot, Slot) {
        let (k, v) = self.entries[at].take().expect("remove_entry on tombstone");
        refs.remove_slot(&k);
        refs.remove_slot(&v);
        (k, v)
    }

    pub(crate) fn clear_entries(&mut self, refs: &mut SideRefCounts) {
        for (k, v) in self.entries.iter().flatten() {
            refs.remove_slot(k);
            refs.remove_slot(v);
        }
        self.entries.clear();
    }

    /// Whole-row removal decrement; see [`ArrayData::drop_refs`].
    pub(crate) fn drop_refs(&self, refs: &mut SideRefCounts) {
        for (k, v) in self.entries.iter().flatten() {
            refs.remove_slot(k);
            refs.remove_slot(v);
        }
    }

    /// Retain only the live entries `keep` accepts, decrementing
    /// everything dropped — the full collector's dead-keyed
    /// weak-entry prune. Dead-keyed entries become tombstones (not
    /// physical removals) for the same cursor-stability reason as
    /// [`Self::remove_entry`]; existing tombstones are left alone and
    /// not counted. Returns the number of entries dropped.
    pub(crate) fn prune_entries(
        &mut self,
        refs: &mut SideRefCounts,
        mut keep: impl FnMut(&Slot, &Slot) -> bool,
    ) -> u32 {
        let mut dropped = 0u32;
        for entry in &mut self.entries {
            let Some((k, v)) = entry else { continue };
            if !keep(k, v) {
                refs.remove_slot(k);
                refs.remove_slot(v);
                dropped += 1;
                *entry = None;
            }
        }
        dropped
    }

    /// See [`ArrayData::for_each_value_mut_chunk_remap`].
    pub(crate) fn for_each_entry_mut_chunk_remap(&mut self, mut f: impl FnMut(&mut Slot)) {
        for (k, v) in self.entries.iter_mut().flatten() {
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

    #[test]
    fn array_mutations_keep_counts_symmetric() {
        let mut refs = SideRefCounts::new();
        let mut a = ArrayData::default();
        a.insert_item(0, refslot(10), &mut refs); // page 0
        a.insert_item(1, refslot(300), &mut refs); // page 1
        // Displacement: the page-0 ref is decremented when index 0 is
        // overwritten with a page-2 ref.
        a.insert_item(0, refslot(600), &mut refs);
        assert_eq!(refs.pages_sorted(), vec![1, 2]);
        // Whole-map replacement decrements everything displaced and
        // counts everything new.
        let mut shifted = std::collections::BTreeMap::new();
        shifted.insert(0u32, refslot(300));
        a.replace_items(shifted, &mut refs);
        assert_eq!(refs.pages_sorted(), vec![1]);
        a.clear_items(&mut refs);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
        // Non-reference values contribute nothing.
        a.insert_item(0, Slot::integer(7), &mut refs);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
    }

    #[test]
    fn collection_mutations_keep_counts_symmetric() {
        let mut refs = SideRefCounts::new();
        let mut c = CollectionData::new(CollKind::Map, 0);
        c.push_entry(refslot(5), refslot(700), &mut refs); // pages 0, 2
        c.set_entry_value(0, refslot(300), &mut refs); // 2 -> 1
        assert_eq!(refs.pages_sorted(), vec![0, 1]);
        let (_k, _v) = c.remove_entry(0, &mut refs);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
        c.push_entry(refslot(5), Slot::undefined(), &mut refs);
        c.push_entry(refslot(260), refslot(261), &mut refs);
        c.clear_entries(&mut refs);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
        // The whole-row drop path (sweep/retain) decrements without
        // consuming the row.
        c.push_entry(refslot(5), refslot(700), &mut refs);
        c.drop_refs(&mut refs);
        assert_eq!(refs.pages_sorted(), Vec::<u32>::new());
    }
}
