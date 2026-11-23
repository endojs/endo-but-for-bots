//! Exotic-membership superset bits: derived host bookkeeping, never persisted.
//!
//! Every exotic side table of the interpreter (an `IntMap` keyed by an
//! instance's [`SlotIndex`] whose membership changes how that instance answers
//! a property read or write) is an [`ExoticTable`]. Each table owns one bit of
//! a per-slot word in the machine's [`ExoticBits`], and the invariant is only
//! a **superset**: if `slot` is a key of a table, that table's bit is set in
//! `slot`'s word. A clear word therefore proves the instance is in none of the
//! tables, so a read or write may skip their probes; a set bit proves nothing
//! (the key may have been removed, or the slot freed and reused), and only
//! sends the caller down the existing probe chain, which re-checks the real
//! tables.
//!
//! The invariant is structural, not a convention every writer must follow:
//!
//! - [`ExoticTable`] has no `DerefMut` and exposes no `&mut` to its map, so
//!   the only ways to add a key are its own [`ExoticTable::insert`] and
//!   [`ExoticTable::update_or_default`], which set the bit before inserting.
//!   Every other mutator (`get_mut`, `update`, `update_values`, `remove`,
//!   `retain`, `retain_keys`) can only change values or drop keys, and a
//!   dropped key leaves a stale, harmless bit.
//! - A table is built only by [`ExoticTable::new`] from the machine's
//!   [`SnapshotDirt`], whose [`ExoticBits`] is the one every reader consults;
//!   there is no `Default`, `Clone`, `From` or `replace`, so no table holding
//!   keys can be swapped in from elsewhere.
//! - Bits are cleared only by [`ExoticBits::rebuild`], which recomputes the
//!   words from the tables themselves and commits the cleared words only when
//!   every table registered with this machine contributed; a missing table
//!   leaves the old words in place. The rebuild holds a shared borrow of the
//!   live words while it runs, so an insert racing it panics instead of being
//!   lost.
//!
//! Nothing here is persisted or metered: restore inserts through the tables
//! (so it sets the bits), and the collector rebuilds them after pruning.
use std::cell::{Cell, RefCell};
use std::ops::Deref;
use std::rc::Rc;

use crate::int_hash::IntMap;
use crate::snapshot_dirty::{SnapshotDirt, Tracked};
use crate::value::SlotIndex;

/// Which exotic side table a bit stands for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum ExoticKind {
    Arrays = 0,
    IndexProps,
    WrapperData,
    TemporalInstants,
    TemporalDurations,
    TemporalPlains,
    TemporalZoneds,
    DisposableStacks,
    ArrayBuffers,
    TypedArrays,
    DataViews,
    Regexps,
    Locales,
    Collators,
    Functions,
    Proxies,
}
const _: () = assert!((ExoticKind::Proxies as u32) < u16::BITS);

impl ExoticKind {
    #[inline]
    pub(crate) const fn bit(self) -> u16 {
        1 << self as u8
    }
}

#[cfg(debug_assertions)]
thread_local! {
    static DISABLED: Cell<bool> = const { Cell::new(false) };
}

/// Test hook (debug builds only): switch the readers' use of the words off on
/// this thread, so a differential test can run a program with the skipped
/// probes and without them. The words themselves are maintained either way.
#[cfg(debug_assertions)]
pub fn set_disabled_for_tests(disabled: bool) {
    DISABLED.with(|cell| cell.set(disabled));
}

/// Whether readers may trust a clear word: always, outside debug builds.
#[inline(always)]
pub(crate) fn enabled() -> bool {
    #[cfg(debug_assertions)]
    {
        !DISABLED.with(Cell::get)
    }
    #[cfg(not(debug_assertions))]
    {
        true
    }
}

/// Slot indices at or above this keep their bits in one shared overflow word
/// rather than the dense vector, which bounds the vector's host memory at two
/// bytes per slot below it (above every arena ceiling the engine admits).
const DENSE_LIMIT: u32 = 1 << 26;
const _: () = assert!(crate::value::CONSENSUS_MAX_SLOT_CEILING < DENSE_LIMIT);

/// One machine's exotic-membership words (see the module documentation).
#[derive(Default)]
pub(crate) struct ExoticBits {
    /// `words[i]` is the superset word of `SlotIndex(i)`; an index past the
    /// end has never been inserted below [`DENSE_LIMIT`].
    words: RefCell<Vec<u16>>,
    /// The union of the bits of every key at or above [`DENSE_LIMIT`].
    high: Cell<u16>,
    /// The bits of every table built over this machine's words.
    registered: Cell<u16>,
}

impl ExoticBits {
    /// The superset word of `slot`: zero only if no exotic table holds it.
    #[inline]
    pub(crate) fn word(&self, slot: SlotIndex) -> u16 {
        match self.words.borrow().get(slot.0 as usize) {
            Some(&word) => word,
            None => self.high.get(),
        }
    }

    fn set(&self, slot: SlotIndex, bit: u16) {
        Self::set_in(&mut self.words.borrow_mut(), &self.high, slot, bit);
    }

    fn set_in(words: &mut Vec<u16>, high: &Cell<u16>, slot: SlotIndex, bit: u16) {
        if slot.0 >= DENSE_LIMIT {
            high.set(high.get() | bit);
            return;
        }
        let at = slot.0 as usize;
        if at >= words.len() {
            words.resize(at + 1, 0);
        }
        words[at] |= bit;
    }

    /// Recompute the words from the tables: the caller reasserts every table
    /// into the returned [`Rebuild`] and then calls [`Rebuild::finish`].
    pub(crate) fn rebuild(self: &Rc<Self>) -> Rebuild<'_> {
        let live = self.words.borrow();
        let len = live.len();
        Rebuild {
            bits: self,
            _live: live,
            words: vec![0; len],
            high: Cell::new(0),
            covered: 0,
        }
    }
}

/// An in-progress [`ExoticBits::rebuild`].
pub(crate) struct Rebuild<'a> {
    bits: &'a Rc<ExoticBits>,
    /// Held for the rebuild's lifetime so a concurrent insert (which needs a
    /// mutable borrow) panics rather than landing in words about to be
    /// discarded.
    _live: std::cell::Ref<'a, Vec<u16>>,
    words: Vec<u16>,
    high: Cell<u16>,
    covered: u16,
}

impl Rebuild<'_> {
    /// Commit the recomputed words if every registered table contributed;
    /// otherwise keep the old words, which are a superset of the new ones.
    pub(crate) fn finish(self) {
        let Rebuild {
            bits,
            _live,
            words,
            high,
            covered,
        } = self;
        drop(_live);
        let registered = bits.registered.get();
        debug_assert_eq!(
            covered & registered,
            registered,
            "an exotic table was left out of the rebuild"
        );
        if covered & registered == registered {
            *bits.words.borrow_mut() = words;
            bits.high.set(high.get());
        }
    }
}

/// An exotic side table: a snapshot-tracked map whose every key has its
/// [`ExoticKind`] bit set in the machine's [`ExoticBits`].
pub(crate) struct ExoticTable<K, V> {
    rows: Tracked<IntMap<K, V>>,
    bits: Rc<ExoticBits>,
    bit: u16,
}

impl<V> ExoticTable<SlotIndex, V> {
    /// An empty table over the machine whose snapshot dirt is `dirt`.
    pub(crate) fn new(dirt: SnapshotDirt, mask: u64, kind: ExoticKind) -> Self {
        let bits = dirt.exotic_bits();
        // One table per kind and machine, so that a rebuild's coverage by
        // kind is coverage by table.
        assert!(
            bits.registered.get() & kind.bit() == 0,
            "a second {kind:?} table over one machine's exotic bits"
        );
        bits.registered.set(bits.registered.get() | kind.bit());
        Self {
            rows: Tracked::new(IntMap::default(), dirt, mask),
            bits,
            bit: kind.bit(),
        }
    }

    /// `HashMap::insert`, with the key's bit set first.
    pub(crate) fn insert(&mut self, key: SlotIndex, value: V) -> Option<V> {
        self.bits.set(key, self.bit);
        self.rows.insert(key, value)
    }

    /// `HashMap::entry`, with the key's bit set first (eagerly: an entry
    /// left vacant only leaves a stale bit). The entry can insert no other
    /// key.
    pub(crate) fn entry(
        &mut self,
        key: SlotIndex,
    ) -> std::collections::hash_map::Entry<'_, SlotIndex, V> {
        self.bits.set(key, self.bit);
        self.rows.entry(key)
    }

    /// `HashMap::values_mut`: changes values, never the key set.
    pub(crate) fn values_mut(&mut self) -> std::collections::hash_map::ValuesMut<'_, SlotIndex, V> {
        self.rows.values_mut()
    }

    /// `HashMap::get_mut`: changes a value, never the key set.
    pub(crate) fn get_mut(&mut self, key: &SlotIndex) -> Option<&mut V> {
        self.rows.get_mut(key)
    }

    /// `HashMap::remove`. The bit stays set (stale, which is harmless).
    pub(crate) fn remove(&mut self, key: &SlotIndex) -> Option<V> {
        self.rows.remove(key)
    }

    /// `HashMap::clear`. Dropped keys keep stale bits.
    #[cfg(test)]
    pub(crate) fn clear(&mut self) {
        self.rows.clear()
    }

    /// `HashMap::retain`. Dropped keys keep stale bits.
    pub(crate) fn retain(&mut self, keep: impl FnMut(&SlotIndex, &mut V) -> bool) {
        self.rows.retain(keep)
    }

    /// [`Tracked::retain_keys`]. Dropped keys keep stale bits.
    pub(crate) fn retain_keys(&mut self, keep: impl FnMut(&SlotIndex) -> bool) {
        self.rows.retain_keys(keep)
    }

    /// [`Tracked::update`]: changes a present value, never the key set.
    pub(crate) fn update<R>(
        &mut self,
        key: &SlotIndex,
        update: impl FnOnce(&mut V) -> R,
    ) -> Option<R> {
        self.rows.update(key, update)
    }

    /// [`Tracked::update_or_default`], with the key's bit set first.
    pub(crate) fn update_or_default<R>(
        &mut self,
        key: SlotIndex,
        update: impl FnOnce(&mut V) -> R,
    ) -> R
    where
        V: Default,
    {
        self.bits.set(key, self.bit);
        self.rows.update_or_default(key, update)
    }

    /// [`Tracked::update_values`]: changes values, never the key set.
    pub(crate) fn update_values(&mut self, update: impl FnMut(&mut V)) {
        self.rows.update_values(update)
    }

    /// Whether every key of this table has its bit set (the superset
    /// invariant), for the audit hook.
    pub(crate) fn bits_cover_keys(&self) -> bool {
        self.rows
            .keys()
            .all(|key| self.bits.word(*key) & self.bit != 0)
    }

    /// Contribute this table's keys to `rebuild`.
    pub(crate) fn reassert(&self, rebuild: &mut Rebuild<'_>) {
        if !Rc::ptr_eq(&self.bits, rebuild.bits) {
            return;
        }
        for key in self.rows.keys() {
            ExoticBits::set_in(&mut rebuild.words, &rebuild.high, *key, self.bit);
        }
        rebuild.covered |= self.bit;
    }
}

impl<K, V> Deref for ExoticTable<K, V> {
    type Target = IntMap<K, V>;
    fn deref(&self) -> &IntMap<K, V> {
        &self.rows
    }
}

impl<'a, K, V> IntoIterator for &'a ExoticTable<K, V> {
    type Item = (&'a K, &'a V);
    type IntoIter = std::collections::hash_map::Iter<'a, K, V>;
    fn into_iter(self) -> Self::IntoIter {
        self.rows.iter()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot_dirty::SnapshotSection;

    fn table(dirt: &SnapshotDirt, kind: ExoticKind) -> ExoticTable<SlotIndex, u8> {
        ExoticTable::new(dirt.clone(), SnapshotSection::Arrays.mask(), kind)
    }

    #[test]
    fn every_insertion_sets_the_bit_and_removal_leaves_a_superset() {
        let dirt = SnapshotDirt::default();
        let bits = dirt.exotic_bits();
        let mut a = table(&dirt, ExoticKind::Arrays);
        let mut f = table(&dirt, ExoticKind::Functions);
        assert_eq!(bits.word(SlotIndex(7)), 0);
        a.insert(SlotIndex(7), 1);
        f.update_or_default(SlotIndex(7), |v| *v = 2);
        f.insert(SlotIndex(DENSE_LIMIT + 3), 3);
        let both = ExoticKind::Arrays.bit() | ExoticKind::Functions.bit();
        assert_eq!(bits.word(SlotIndex(7)), both);
        assert_eq!(bits.word(SlotIndex(6)), 0);
        // Past the dense vector: the overflow word, conservatively shared.
        assert_eq!(
            bits.word(SlotIndex(DENSE_LIMIT + 3)),
            ExoticKind::Functions.bit()
        );
        assert_eq!(bits.word(SlotIndex(8)), ExoticKind::Functions.bit());
        a.remove(&SlotIndex(7));
        assert_eq!(bits.word(SlotIndex(7)), both, "removal keeps a stale bit");
        // A complete rebuild clears exactly what no table holds any more.
        let mut rebuild = bits.rebuild();
        a.reassert(&mut rebuild);
        f.reassert(&mut rebuild);
        rebuild.finish();
        assert_eq!(bits.word(SlotIndex(7)), ExoticKind::Functions.bit());
        assert_eq!(bits.word(SlotIndex(8)), ExoticKind::Functions.bit());
        f.retain_keys(|_| false);
        let mut rebuild = bits.rebuild();
        a.reassert(&mut rebuild);
        f.reassert(&mut rebuild);
        rebuild.finish();
        assert_eq!(bits.word(SlotIndex(7)), 0);
        assert_eq!(bits.word(SlotIndex(DENSE_LIMIT + 3)), 0);
    }

    #[test]
    #[cfg(not(debug_assertions))]
    fn an_incomplete_rebuild_clears_nothing() {
        let dirt = SnapshotDirt::default();
        let bits = dirt.exotic_bits();
        let mut a = table(&dirt, ExoticKind::Arrays);
        let f = table(&dirt, ExoticKind::Functions);
        a.insert(SlotIndex(1), 1);
        a.remove(&SlotIndex(1));
        let mut rebuild = bits.rebuild();
        f.reassert(&mut rebuild);
        rebuild.finish();
        assert_eq!(bits.word(SlotIndex(1)), ExoticKind::Arrays.bit());
    }

    #[test]
    #[cfg(debug_assertions)]
    #[should_panic(expected = "left out of the rebuild")]
    fn an_incomplete_rebuild_is_a_debug_failure() {
        let dirt = SnapshotDirt::default();
        let bits = dirt.exotic_bits();
        let mut a = table(&dirt, ExoticKind::Arrays);
        let f = table(&dirt, ExoticKind::Functions);
        a.insert(SlotIndex(1), 1);
        let mut rebuild = bits.rebuild();
        f.reassert(&mut rebuild);
        rebuild.finish();
    }

    #[test]
    #[should_panic]
    fn an_insert_during_a_rebuild_panics_rather_than_being_lost() {
        let dirt = SnapshotDirt::default();
        let bits = dirt.exotic_bits();
        let mut a = table(&dirt, ExoticKind::Arrays);
        let _rebuild = bits.rebuild();
        a.insert(SlotIndex(1), 1);
    }

    #[test]
    fn a_table_from_another_machine_does_not_count_as_coverage() {
        let dirt = SnapshotDirt::default();
        let other = SnapshotDirt::default();
        let bits = dirt.exotic_bits();
        let mut a = table(&dirt, ExoticKind::Arrays);
        let foreign = table(&other, ExoticKind::Arrays);
        a.insert(SlotIndex(2), 1);
        a.remove(&SlotIndex(2));
        let rebuild = bits.rebuild();
        let mut rebuild = rebuild;
        foreign.reassert(&mut rebuild);
        assert_eq!(rebuild.covered, 0);
        drop(rebuild);
        assert_eq!(bits.word(SlotIndex(2)), ExoticKind::Arrays.bit());
    }
}
