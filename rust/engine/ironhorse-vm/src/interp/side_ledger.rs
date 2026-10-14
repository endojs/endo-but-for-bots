//! The side-storage ledger seen from the interpreter: deriving it from the
//! tables, and admitting guest-amplified host copies before they grow.
//!
//! [`crate::side_storage`] declares what each retained table costs. The
//! counted mutations in [`crate::bulk`] keep [`ChunkArena`]'s ledger in step
//! as tables grow and shrink. This module re-derives the ledger wholesale
//! where tables are rebuilt or dropped in bulk (a restore, a collection), and
//! bounds the temporary host copies a built-in assembles from guest strings
//! (a `join` with a long separator, a `Function` source) by the same
//! ceiling, before they are allocated.
use super::*;

impl Interp {
    /// The side storage every retained table holds, at declared widths: what
    /// the ledger must equal whenever no collection is running.
    pub(crate) fn side_storage_charge(&self) -> u64 {
        let arrays: u64 = self.arrays.values().map(ArrayData::side_charge).sum();
        let index_props: u64 = self.index_props.values().map(ArrayData::side_charge).sum();
        let collections: u64 = self
            .collections
            .values()
            .map(CollectionData::side_charge)
            .sum();
        let segments: u64 = self
            .segments
            .values()
            .map(|data| {
                crate::side_storage::segments_charge(
                    data.units.len() as u64,
                    data.segments.len() as u64,
                )
            })
            .sum();
        arrays + index_props + collections + segments
    }

    /// Replace the ledger with the charge derived from the tables. Run after
    /// a restore rebuilds them and after a collection drops rows, so the
    /// ledger depends on the heap, never on how it was built.
    pub(crate) fn rederive_side_reserved(&mut self) {
        let charge = self.side_storage_charge();
        self.chunks.set_side_reserved(charge);
    }

    /// The side-storage bytes charged against the chunk ceiling: array
    /// items, index properties, collection entries and `Intl.Segmenter`
    /// results, at their declared widths.
    pub fn side_storage_bytes(&self) -> u64 {
        self.chunks.side_reserved()
    }

    /// The ledger and the charge derived from the tables, for tests that
    /// check the incremental accounting never drifts from the heap.
    #[doc(hidden)]
    pub fn side_storage_parity(&self) -> (u64, u64) {
        (self.chunks.side_reserved(), self.side_storage_charge())
    }

    /// Segment `units` for a `%Segments%` object, charging what it retains:
    /// the input copy first, then the segment list as it grows, one capacity
    /// class at a time. The list is grown to each class exactly, so its
    /// storage follows one policy on every target, and is trimmed to its
    /// final length, which is what the object is charged for as long as it
    /// lives (and what a restore re-derives). A refused charge halts the
    /// crank with `HeapExhausted`; growth the host allocator refuses, with
    /// `HostAllocationFailed`.
    pub(super) fn admitted_segments(
        &mut self,
        granularity: &str,
        mut units: Vec<u16>,
    ) -> Result<(Vec<u16>, Vec<(usize, usize, bool)>), Step> {
        use crate::side_storage::{capacity_class, segments_charge, SEGMENT_BYTES};
        let input = segments_charge(units.len() as u64, 0);
        if !self.chunks.try_reserve_side(input) {
            return Err(Step::Host(Halt::HeapExhausted));
        }
        units.shrink_to_fit();
        let mut segments: Vec<(usize, usize, bool)> = Vec::new();
        // The capacity class charged so far, independent of what the host
        // allocator reports for the vector.
        let mut class = 0u64;
        let mut host_refused = false;
        let chunks = &mut self.chunks;
        let complete = segment_units(granularity, &units, |segment| {
            let len = segments.len() as u64;
            if len == class {
                let next = capacity_class(len + 1);
                if !chunks.try_reserve_side((next - class) * SEGMENT_BYTES) {
                    return false;
                }
                class = next;
                if segments.try_reserve_exact((next - len) as usize).is_err() {
                    host_refused = true;
                    return false;
                }
            }
            segments.push(segment);
            true
        });
        let reserved = class * SEGMENT_BYTES;
        if !complete {
            self.chunks.release_side(input + reserved);
            return Err(Step::Host(if host_refused {
                Halt::HostAllocationFailed
            } else {
                Halt::HeapExhausted
            }));
        }
        // Settle the class reservation down to the exact list retained.
        self.chunks
            .release_side(reserved - segments_charge(0, segments.len() as u64));
        segments.shrink_to_fit();
        Ok((units, segments))
    }

    /// Append `addition` to a host copy that will become one string, once
    /// its complete new length fits under the chunk ceiling as a string
    /// payload. The copy is bounded before it grows, so it can never outrun
    /// the result it is building. This is a ceiling check only: the result's
    /// chunk is metered when it is allocated, and no meter checkpoint is
    /// added, so a program below the ceiling meters exactly as before.
    pub(super) fn extend_admitted_copy(
        &self,
        output: &mut Vec<u16>,
        addition: &[u16],
    ) -> Result<(), Step> {
        self.admit_copy_units(output.len() as u64 + addition.len() as u64)?;
        output
            .try_reserve(addition.len())
            .map_err(|_| Step::Host(Halt::HostAllocationFailed))?;
        output.extend_from_slice(addition);
        Ok(())
    }

    /// Refuse a transient host list of `bytes` (counted at declared widths)
    /// that could not be allocated under the chunk ceiling. Built-ins that
    /// collect one record per guest callback or iterator step call this
    /// before each push. A ceiling check only, with no meter checkpoint.
    pub(super) fn admit_transient(&self, bytes: u64) -> Result<(), Step> {
        let fits = usize::try_from(bytes).is_ok_and(|bytes| self.chunks.can_allocate(bytes));
        if fits {
            Ok(())
        } else {
            Err(Step::Host(Halt::HeapExhausted))
        }
    }

    /// Refuse a host copy of `units` UTF-16 code units that could not be
    /// allocated as a string under the chunk ceiling.
    pub(super) fn admit_copy_units(&self, units: u64) -> Result<(), Step> {
        let fits = units
            .checked_mul(2)
            .and_then(|bytes| usize::try_from(bytes).ok())
            .is_some_and(|bytes| self.chunks.can_allocate(bytes));
        if fits {
            Ok(())
        } else {
            Err(Step::Host(Halt::HeapExhausted))
        }
    }
}
