//! Declared widths and the growth policy for guest-sized side storage.
//!
//! Array items, index properties, Map/Set/WeakMap/WeakSet entries and
//! `Intl.Segmenter` results live in host side tables, not in the chunk
//! arena. They are charged against the chunk ceiling all the same, through
//! [`crate::value::ChunkArena`]'s side-storage ledger, so a guest that keeps
//! large arrays or collections halts with an uncatchable `HeapExhausted` at
//! the ceiling instead of exhausting host memory (`WASM-BLOCKERS.md` B7's
//! "Unadmitted host allocations" and B8).
//!
//! Whether a charge fits decides where a crank halts, so the charge is
//! consensus state. It therefore follows two rules:
//!
//! - **Declared widths.** Each storage kind is charged a fixed width per
//!   element, the audited 64-bit layout of the record that holds it, never
//!   `size_of` on the running target (wasm32's pointers are half as wide).
//!   The widths are declared with scratch admission's
//!   ([`crate::interp::ScratchElement`]), whose 64-bit build asserts each one
//!   against the layout, so a record that grows fails to compile until its
//!   width is re-declared, which is a release change.
//! - **A pure growth policy.** Growable tables are charged by capacity
//!   class, [`capacity_class`] of their element count: zero when empty,
//!   then [`MIN_CLASS`], then each power of two. The class is a function of
//!   the count alone, not of the order of operations, so a machine restored
//!   from a snapshot (whose tables are rebuilt in one pass) charges exactly
//!   what the machine that built the same heap charges. Charging by class
//!   means a push loop touches the ledger once per doubling.
//!
//! The ledger is never persisted. It is derived from the tables on restore
//! and after collection (`Interp::rederive_side_reserved`), the same points
//! at which [`crate::value::ChunkArena`]'s reclaimed chunks become reusable,
//! and after a crank that ends in a resource stop, whose unwind can drop
//! storage a native had charged but not yet installed in a table.

use crate::bulk::{CollEntry, CollKey};
use crate::interp::ScratchElement;
use crate::value::Slot;

/// The declared width of one `T`, in bytes.
const fn width<T: ScratchElement>() -> u64 {
    T::CHARGE as u64
}

/// One array item or index property: its `(u32, Slot)` record.
pub(crate) const ARRAY_ITEM_BYTES: u64 = width::<(u32, Slot)>();
/// One Map/Set/WeakMap/WeakSet entry in the insertion-ordered list.
pub(crate) const COLLECTION_ENTRY_BYTES: u64 = width::<CollEntry>();
/// The same entry's lookup index: its `Option<CollKey>` position record and
/// its `(CollKey, usize)` hash-table bucket.
pub(crate) const COLLECTION_INDEX_BYTES: u64 =
    width::<Option<CollKey>>() + width::<(CollKey, usize)>();
/// One UTF-16 code unit of the input a `%Segments%` object retains.
pub(crate) const SEGMENT_UNIT_BYTES: u64 = width::<u16>();
/// One `(start, end, is_word_like)` segment record.
pub(crate) const SEGMENT_BYTES: u64 = width::<(usize, usize, bool)>();

/// One `Slot` in a transient host list a built-in collects (a typed-array
/// `filter`'s kept values, a Set method's result, a `groupBy` bucket).
pub(crate) const SLOT_BYTES: u64 = width::<Slot>();
/// One `groupBy` bucket record: its key and the vector of its values.
pub(crate) const GROUP_BUCKET_BYTES: u64 = width::<(Slot, Vec<Slot>)>();

/// The smallest nonzero capacity class.
pub(crate) const MIN_CLASS: u64 = 4;

/// The capacity charged for `count` elements: 0, then [`MIN_CLASS`], then
/// the next power of two.
#[inline]
pub(crate) const fn capacity_class(count: u64) -> u64 {
    if count == 0 {
        0
    } else if count <= MIN_CLASS {
        MIN_CLASS
    } else {
        count.next_power_of_two()
    }
}

/// Whether `count` elements fill their class exactly, so one more crosses
/// into the next (and one fewer may fall back). Only these counts touch
/// the ledger.
#[inline]
pub(crate) const fn at_class_boundary(count: u64) -> bool {
    capacity_class(count) == count
}

/// The bytes charged for `count` elements of `width` bytes each.
#[inline]
pub(crate) const fn class_charge(count: u64, width: u64) -> u64 {
    capacity_class(count) * width
}

/// What array items or index properties holding `count` items are charged.
#[inline]
pub(crate) const fn array_items_charge(count: u64) -> u64 {
    class_charge(count, ARRAY_ITEM_BYTES)
}

/// What a collection holding `live` entries is charged: the entry list and
/// its index. Tombstones left by deletes are not charged; the list compacts
/// them before they outnumber the live entries (`CollectionData`).
#[inline]
pub(crate) const fn collection_charge(live: u64) -> u64 {
    class_charge(live, COLLECTION_ENTRY_BYTES + COLLECTION_INDEX_BYTES)
}

/// What a `%Segments%` object retaining `units` code units and `segments`
/// segment records is charged. It never grows after `segment()` builds it,
/// so it is charged its exact length.
#[inline]
pub(crate) const fn segments_charge(units: u64, segments: u64) -> u64 {
    units * SEGMENT_UNIT_BYTES + segments * SEGMENT_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classes_are_zero_then_a_floor_then_powers_of_two() {
        let classes: Vec<u64> = [0, 1, 4, 5, 8, 9, 1 << 20, (1 << 20) + 1]
            .into_iter()
            .map(capacity_class)
            .collect();
        assert_eq!(classes, [0, 4, 4, 8, 8, 16, 1 << 20, 1 << 21]);
        let boundaries: Vec<u64> = (0..=17).filter(|&n| at_class_boundary(n)).collect();
        assert_eq!(boundaries, [0, 4, 8, 16]);
        assert_eq!(array_items_charge(5), 8 * 32);
        assert_eq!(collection_charge(1), 4 * 96);
        assert_eq!(segments_charge(10, 3), 20 + 72);
        assert_eq!((SLOT_BYTES, GROUP_BUCKET_BYTES), (24, 48));
    }
}
