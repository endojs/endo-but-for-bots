//! The slot arena's allocation bookkeeping: the LIFO free list, its
//! low-water mark, the `free_marks` twin bitmap, the collector's mark
//! bits and the live count.
//!
//! [`SlotArena`](super::SlotArena) owns one [`FreeList`] and is its only
//! client. Every write to these five fields goes through a method here, in
//! the same order the arena performed it before the extraction, with the
//! arena's own side effects (record writes, page faults, dirty bits, the
//! property index) left in the arena between the calls. Keeping the kernel
//! free of those (a `HashMap` and lazy page faults) is what lets the Kani
//! harnesses below (STR-1b, STR-1c) reason about every state of it.
//!
//! The invariant every method preserves, given its stated precondition,
//! where `capacity` is `marks.len()` (which the arena keeps equal to its
//! record count: every record push is paired with [`FreeList::append`]):
//!
//! - `free_marks.len() == marks.len()`;
//! - `free_marks[i]` iff `i` is on `free`, every entry of `free` is below
//!   `capacity`, and `free` has no duplicate;
//! - `live + free.len() == capacity`;
//! - `free_low <= free.len()`.
//!
//! A free slot may carry a stale mark between collections (a [`FreeList::release`]
//! after a sweep leaves the slot's mark set); [`FreeList::clear_marks`]
//! starts every collection, and [`FreeList::mark`] refuses free slots, so
//! no slot is both free and marked while a collection marks and sweeps.

/// See the module documentation.
pub(super) struct FreeList {
    /// The free list in LIFO reuse order, which the snapshot serializes.
    pub(super) free: Vec<u32>,
    /// The free list's low-water mark: the shortest `free` has been since
    /// the last [`FreeList::acknowledge`] or since the list was built.
    pub(super) free_low: usize,
    /// Twin of `free` as one bit per record.
    pub(super) free_marks: Vec<bool>,
    /// One mark bit per record, used by the mark-sweep collector.
    pub(super) marks: Vec<bool>,
    /// Count of live (non-free) records.
    pub(super) live: u32,
}

impl FreeList {
    /// The bookkeeping of an empty arena.
    pub(super) fn new() -> FreeList {
        FreeList {
            free: Vec::new(),
            free_low: 0,
            free_marks: Vec::new(),
            marks: Vec::new(),
            live: 0,
        }
    }

    /// The bookkeeping of a restored arena, from a free list and the free
    /// map `SlotArena::image_free_marks` accepted for it. Marks start
    /// clear and the low-water mark at the list's length.
    pub(super) fn restored(free: Vec<u32>, free_marks: Vec<bool>, live: u32) -> FreeList {
        FreeList {
            free_low: free.len(),
            free,
            marks: vec![false; free_marks.len()],
            free_marks,
            live,
        }
    }

    /// Whether record `i` is on the free list.
    #[inline]
    pub(super) fn is_free(&self, i: u32) -> bool {
        self.free_marks.get(i as usize).copied().unwrap_or(false)
    }

    /// Reserve room to [`FreeList::append`] one record; false when the
    /// host allocator refuses.
    pub(super) fn reserve_growth(&mut self) -> bool {
        self.free_marks.try_reserve(1).is_ok() && self.marks.try_reserve(1).is_ok()
    }

    /// Begin an allocation: count one more live record and pop the most
    /// recently freed record, if any, lowering the low-water mark. The
    /// caller then reuses the popped record and calls
    /// [`FreeList::claim`], or appends a record and calls
    /// [`FreeList::append`].
    pub(super) fn take(&mut self) -> Option<u32> {
        self.live += 1;
        let reused = self.free.pop();
        if reused.is_some() {
            self.free_low = self.free_low.min(self.free.len());
        }
        reused
    }

    /// Finish reusing record `i` that [`FreeList::take`] popped: it is no
    /// longer free, and its stale mark is cleared.
    pub(super) fn claim(&mut self, i: u32) {
        self.free_marks[i as usize] = false;
        self.marks[i as usize] = false;
    }

    /// Finish an allocation that appended a record: the new record is
    /// live and unmarked.
    pub(super) fn append(&mut self) {
        self.free_marks.push(false);
        self.marks.push(false);
    }

    /// Return live record `i` (below the capacity, which the caller
    /// checks) to the free list. `before` runs after the checks and
    /// before any write, where the arena drops `i`'s derived state.
    pub(super) fn release(&mut self, i: u32, before: impl FnOnce()) {
        assert!(!self.is_free(i), "double free of slot");
        let live = self.live.checked_sub(1).expect("slot live count underflow");
        before();
        self.free.push(i);
        self.free_marks[i as usize] = true;
        self.live = live;
    }

    /// Clear every mark bit. Called at the start of a collection.
    pub(super) fn clear_marks(&mut self) {
        for m in self.marks.iter_mut() {
            *m = false;
        }
    }

    /// Mark record `i` (below the capacity, which the caller checks)
    /// reachable; true if it was not already marked. A free record
    /// cannot be marked.
    #[inline]
    pub(super) fn mark(&mut self, i: u32) -> bool {
        assert!(!self.is_free(i), "mark of free slot");
        let i = i as usize;
        if self.marks[i] {
            false
        } else {
            self.marks[i] = true;
            true
        }
    }

    /// Sweep: every record below `capacity` that is neither marked nor
    /// free joins the free list, in ascending index order. `before(i)`
    /// runs before record `i`'s writes and `after(i)` after them. Returns
    /// the number reclaimed.
    pub(super) fn sweep_each(
        &mut self,
        capacity: u32,
        mut before: impl FnMut(u32),
        mut after: impl FnMut(u32),
    ) -> u32 {
        let mut reclaimed = 0u32;
        for i in 0..capacity {
            if !self.marks[i as usize] && !self.is_free(i) {
                before(i);
                self.free.push(i);
                self.free_marks[i as usize] = true;
                self.live -= 1;
                reclaimed += 1;
                after(i);
            }
        }
        reclaimed
    }

    /// Restart the low-water mark at the list's length.
    pub(super) fn acknowledge(&mut self) {
        self.free_low = self.free.len();
    }
}
