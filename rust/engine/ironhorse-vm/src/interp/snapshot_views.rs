//! Borrowed views of the bulk side tables for the streaming snapshot writer
//! (WASM-BLOCKERS.md B7): what the owned rows of [`super::snapshot_rows`]
//! copy out, read in place. Not persisted row schemas: the wire layout is
//! the owned rows', and these never travel.
use super::*;

/// One `arrays` or `index_props` row read IN PLACE: what an
/// [`ArraySnapshot`] / [`IndexPropsSnapshot`] copies out, borrowed from the
/// live table for the streaming snapshot writer (WASM-BLOCKERS.md B7). The
/// middle field is the array's spec length or the index store's high-water
/// mark, exactly as the owned rows carry it.
pub struct ArrayRowView<'a> {
    pub owner: u32,
    pub length: u32,
    pub(crate) items: &'a crate::bulk::ArrayItems,
}

impl ArrayRowView<'_> {
    /// How many items [`Self::items`] yields.
    pub fn item_count(&self) -> usize {
        self.items.len()
    }

    /// The present items ascending by index, as the owned row orders them.
    pub fn items(&self) -> impl ExactSizeIterator<Item = (u32, Slot)> + '_ {
        self.items.iter().map(|(index, value)| (index, *value))
    }
}

impl Interp {
    /// How many `arrays` rows and how many `index_props` rows hold their
    /// items in the dense representation. A diagnostic for the
    /// representation differential test, which must see both forms; the
    /// representation is not part of any row.
    #[doc(hidden)]
    pub fn dense_item_store_counts(&self) -> (usize, usize) {
        let arrays = self.arrays.values();
        let index_props = self.index_props.values();
        (
            arrays.filter(|row| row.items().is_dense()).count(),
            index_props.filter(|row| row.items().is_dense()).count(),
        )
    }
}

/// One `collections` row read IN PLACE: what a [`CollectionSnapshot`]
/// copies out, borrowed from the live table for the streaming snapshot
/// writer. Tombstones are compacted out of [`Self::entries`] exactly as
/// [`Interp::collections_snapshot`] compacts them.
pub struct CollectionRowView<'a> {
    pub owner: u32,
    pub kind: u8,
    pub table_length: u32,
    pub(crate) data: &'a crate::bulk::CollectionData,
}

impl CollectionRowView<'_> {
    /// How many entries [`Self::entries`] yields (the spec `size`).
    pub fn entry_count(&self) -> usize {
        self.data.live_len()
    }

    /// The live entries in insertion order.
    pub fn entries(&self) -> impl Iterator<Item = (Slot, Slot)> + '_ {
        self.data.live_entries().copied()
    }
}
