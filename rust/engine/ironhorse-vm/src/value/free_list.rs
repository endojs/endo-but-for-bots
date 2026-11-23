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

/// Kani harnesses for guarantees STR-1b and STR-1c
/// (`verification/proofs.d/store.toml`).
///
/// Each harness checks one operation from EVERY bookkeeping state that
/// satisfies the module invariant at a capacity of at most `MAX` records:
/// every capacity `cap <= MAX` and free-list length `n <= cap` in turn,
/// with any distinct in-range free entries, any marks and any low-water
/// mark at or below `n`. It applies the operation under its precondition
/// and checks the invariant and the operation's exact effect. Because
/// [`FreeList::new`] and [`FreeList::restored`] (on what
/// `image_free_marks` accepts, STR-1) establish the invariant, every state
/// that any sequence of operations reaches while the capacity stays within
/// the bound satisfies it too.
///
/// `cap` and `n` are concrete in each case, and states are compared
/// through fixed-size [`Snap`] copies: a vector of symbolic length
/// (`to_vec`, `clone` or pushes under a symbolic bound) ran CBMC out of
/// memory at this size.
#[cfg(kani)]
mod proofs {
    use super::*;
    use std::cell::Cell;

    /// The largest capacity a harness starts from.
    const MAX: usize = 4;
    /// Room for one growth past `MAX`.
    const W: usize = MAX + 1;

    /// Run `check(cap, n)` for every capacity `cap <= MAX` and free-list
    /// length `n <= cap`.
    fn every_shape(mut check: impl FnMut(usize, usize)) {
        for cap in 0..=MAX {
            for n in 0..=cap {
                check(cap, n);
            }
        }
    }

    /// Whether `x` is among `xs[..len]`. An index loop: `contains` and
    /// array `==` (a `memcmp`) needed deeper unwinding and more solver time.
    fn holds(xs: &[u32], len: usize, x: u32) -> bool {
        let mut found = false;
        for k in 0..len {
            found |= xs[k] == x;
        }
        found
    }

    /// Whether two snapshots agree on the free list (length and entries).
    fn same_free(a: &Snap, b: &Snap) -> bool {
        let mut same = a.n == b.n;
        for k in 0..W {
            same &= a.free[k] == b.free[k];
        }
        same
    }

    /// Whether two bit arrays agree.
    fn same_bits(a: &[bool; W], b: &[bool; W]) -> bool {
        let mut same = true;
        for k in 0..W {
            same &= a[k] == b[k];
        }
        same
    }

    /// Whether any bit is set.
    fn any_bit(bits: &[bool; W]) -> bool {
        let mut any = false;
        for k in 0..W {
            any |= bits[k];
        }
        any
    }

    /// Every state satisfying the invariant with `cap` records of which
    /// `n` are free (`cap` and `n` concrete).
    fn any_book(cap: usize, n: usize) -> FreeList {
        let entries: [u32; MAX] = kani::any();
        let bits: [bool; MAX] = kani::any();
        let mut free = Vec::with_capacity(W);
        let mut free_marks = Vec::with_capacity(W);
        let mut marks = Vec::with_capacity(W);
        for k in 0..n {
            kani::assume((entries[k] as usize) < cap);
            for j in 0..k {
                kani::assume(entries[j] != entries[k]);
            }
            free.push(entries[k]);
        }
        for i in 0..cap {
            free_marks.push(holds(&entries, n, i as u32));
            marks.push(bits[i]);
        }
        FreeList {
            free,
            free_low: kani::any_where(|&low| low <= n),
            free_marks,
            marks,
            live: (cap - n) as u32,
        }
    }

    /// A fixed-size copy of a state, for before/after comparisons.
    #[derive(Clone, Copy)]
    struct Snap {
        cap: usize,
        n: usize,
        free: [u32; W],
        free_marks: [bool; W],
        marks: [bool; W],
        free_low: usize,
        live: u32,
    }

    fn snap(book: &FreeList) -> Snap {
        let mut s = Snap {
            cap: book.marks.len(),
            n: book.free.len(),
            free: [0; W],
            free_marks: [false; W],
            marks: [false; W],
            free_low: book.free_low,
            live: book.live,
        };
        for k in 0..W {
            if k < s.n {
                s.free[k] = book.free[k];
            }
            if k < s.cap {
                s.free_marks[k] = book.free_marks[k];
                s.marks[k] = book.marks[k];
            }
        }
        s
    }

    /// The module invariant. Reads the vectors once, through [`snap`], and
    /// checks the copy: indexing a vector whose length is symbolic (after
    /// a sweep's conditional pushes) once per comparison ran CBMC out of
    /// memory.
    fn assert_invariant(book: &FreeList) {
        assert!(book.free_marks.len() == book.marks.len());
        assert!(book.marks.len() <= W && book.free.len() <= W);
        let s = snap(book);
        assert!(s.live as usize + s.n == s.cap);
        assert!(s.free_low <= s.n);
        for k in 0..W {
            if k < s.n {
                let entry = s.free[k];
                assert!((entry as usize) < s.cap && s.free_marks[entry as usize]);
                for j in 0..k {
                    assert!(s.free[j] != entry);
                }
            }
        }
        for i in 0..W {
            if i < s.cap {
                assert!(s.free_marks[i] == holds(&s.free, s.n, i as u32));
            }
        }
    }

    /// No slot is both free and marked (the collection-phase property).
    fn disjoint(s: &Snap) -> bool {
        let mut disjoint = true;
        for i in 0..W {
            disjoint &= !(s.free_marks[i] && s.marks[i]);
        }
        disjoint
    }

    /// `SlotArena::alloc`'s bookkeeping sequence, after the ceiling
    /// admitted the allocation: reserve when growing, `take`, then
    /// `claim` the reused record or `append` a new one.
    fn alloc(book: &mut FreeList) -> Option<u32> {
        let cap = book.marks.len() as u32;
        if book.free.is_empty() && !book.reserve_growth() {
            return None;
        }
        Some(match book.take() {
            Some(i) => {
                book.claim(i);
                i
            }
            None => {
                book.append();
                cap
            }
        })
    }

    /// STR-1b: the empty and the restored bookkeeping satisfy the
    /// invariant, with every mark clear and the low-water mark at the
    /// list's length.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1b_new_and_restored_establish() {
        assert_invariant(&FreeList::new());
        every_shape(|cap, n| {
            let image = any_book(cap, n);
            // `restored` on exactly what `image_free_marks` accepts
            // (STR-1): distinct in-range entries, the free map of exactly
            // them, and free.len() + live == count.
            let restored = FreeList::restored(image.free, image.free_marks, image.live);
            assert_invariant(&restored);
            assert!(restored.marks.len() == cap && !any_bit(&snap(&restored).marks));
            assert!(restored.free_low == n);
            kani::cover!(cap == MAX && n == 2, "a restored image with two free slots");
        });
    }

    /// STR-1b: an allocation never returns a live record, leaves the
    /// returned record live and unmarked, counts one more live record,
    /// changes no other record's bits, and preserves the invariant and the
    /// collection-phase disjointness.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1b_alloc_preserves() {
        every_shape(|cap, n| {
            let mut book = any_book(cap, n);
            let b = snap(&book);
            let Some(got) = alloc(&mut book) else { return };
            let got = got as usize;
            assert!(got == cap || (got < cap && b.free_marks[got]));
            assert!(!book.is_free(got as u32) && !book.marks[got]);
            assert!(book.live == b.live + 1);
            let a = snap(&book);
            for k in 0..W {
                if k != got {
                    assert!(a.marks[k] == b.marks[k] && a.free_marks[k] == b.free_marks[k]);
                }
            }
            assert_invariant(&book);
            assert!(!disjoint(&b) || disjoint(&a));
            kani::cover!(got == MAX, "growth past a full arena of MAX");
            kani::cover!(
                got < cap && b.marks[got],
                "reuse of a free slot with a stale mark"
            );
        });
    }

    /// STR-1b: freeing a live record makes it, and only it, free, counts
    /// one fewer live record, runs `before` exactly once, leaves every mark
    /// as it was, and preserves the invariant.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1b_release_preserves() {
        every_shape(|cap, n| {
            if n == cap {
                return;
            }
            let mut book = any_book(cap, n);
            let b = snap(&book);
            let i: u32 = kani::any_where(|&i| (i as usize) < cap);
            if book.is_free(i) {
                return;
            }
            let mut calls = 0;
            book.release(i, || calls += 1);
            assert!(calls == 1);
            assert!(book.is_free(i));
            assert!(book.live + 1 == b.live);
            let a = snap(&book);
            for k in 0..W {
                assert!(a.marks[k] == b.marks[k]);
                assert!(a.free_marks[k] == (b.free_marks[k] || k == i as usize));
            }
            assert_invariant(&book);
            kani::cover!(cap == MAX && book.live == 0, "the last live slot freed");
            // Not a collection-phase operation: a slot freed while marked
            // keeps its mark (the module documentation's stale mark).
            kani::cover!(book.marks[i as usize], "a freed slot keeps a stale mark");
        });
    }

    /// STR-1b: marking a live record sets its bit and reports whether it
    /// was clear; clearing resets every bit; neither touches the free list,
    /// the free map, the low-water mark or the live count, and both
    /// preserve the invariant. Clearing establishes, and marking
    /// preserves, the collection-phase disjointness.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1b_mark_and_clear_preserve() {
        every_shape(|cap, n| {
            let mut book = any_book(cap, n);
            let b = snap(&book);
            if kani::any() {
                book.clear_marks();
                let a = snap(&book);
                assert!(a.cap == cap && !any_bit(&a.marks));
                assert!(disjoint(&a));
                kani::cover!(any_bit(&b.marks), "marks cleared");
            } else {
                if n == cap {
                    return;
                }
                let i: u32 = kani::any_where(|&i| (i as usize) < cap);
                if book.is_free(i) {
                    return;
                }
                let fresh = book.mark(i);
                assert!(fresh == !b.marks[i as usize]);
                let a = snap(&book);
                for k in 0..W {
                    assert!(a.marks[k] == (b.marks[k] || k == i as usize));
                }
                assert!(!disjoint(&b) || disjoint(&a));
                kani::cover!(fresh && cap == MAX, "a fresh mark");
                kani::cover!(!fresh, "an already-marked slot");
            }
            let a = snap(&book);
            assert!(same_free(&a, &b) && same_bits(&a.free_marks, &b.free_marks));
            assert!(a.free_low == b.free_low && a.live == b.live);
            assert_invariant(&book);
        });
    }

    /// STR-1b at one shape: the sweep frees exactly the unmarked records
    /// that were not already free and returns how many, calls `before(i)`
    /// and then `after(i)` once per reclaimed record, in ascending `i` and
    /// never interleaved, leaves every mark as it was, and preserves the
    /// invariant and the collection-phase disjointness.
    fn check_sweep(cap: usize, n: usize) {
        let mut book = any_book(cap, n);
        let b = snap(&book);
        let swept =
            |i: u32| (i as usize) < cap && !b.marks[i as usize] && !b.free_marks[i as usize];
        // The record `before` opened and `after` has not closed, the last
        // record closed, and the number of calls of each.
        let open = Cell::new(None::<u32>);
        let last = Cell::new(None::<u32>);
        let calls = Cell::new((0u32, 0u32));
        let reclaimed = book.sweep_each(
            cap as u32,
            |i| {
                assert!(open.get().is_none() && swept(i));
                assert!(last.get().is_none_or(|l| l < i));
                open.set(Some(i));
                calls.set((calls.get().0 + 1, calls.get().1));
            },
            |i| {
                assert!(open.get() == Some(i));
                open.set(None);
                last.set(Some(i));
                calls.set((calls.get().0, calls.get().1 + 1));
            },
        );
        let a = snap(&book);
        let mut expected = 0u32;
        for k in 0..W {
            let gone = swept(k as u32);
            expected += gone as u32;
            assert!(a.free_marks[k] == (b.free_marks[k] || gone));
        }
        assert!(reclaimed == expected && calls.get() == (expected, expected));
        assert!(open.get().is_none());
        assert!(a.live + reclaimed == b.live);
        assert!(same_bits(&a.marks, &b.marks));
        assert_invariant(&book);
        assert!(!disjoint(&b) || disjoint(&a));
        kani::cover!(
            reclaimed >= 2 && a.live > 0,
            "a sweep reclaiming two and keeping one"
        );
    }

    /// STR-1b: [`check_sweep`] at every capacity up to 3.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1b_sweep_frees_exactly_unmarked_cap_0_to_3() {
        for cap in 0..=3 {
            for n in 0..=cap {
                check_sweep(cap, n);
            }
        }
    }

    /// STR-1b: [`check_sweep`] at capacity 4, free lists of 1 and 2 (the
    /// capacity-4 shapes are split in two to keep each harness's solver
    /// memory down).
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1b_sweep_frees_exactly_unmarked_cap_4_free_1_2() {
        check_sweep(MAX, 1);
        check_sweep(MAX, 2);
    }

    /// STR-1b: [`check_sweep`] at capacity 4, free lists of 0, 3 and 4.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1b_sweep_frees_exactly_unmarked_cap_4_free_0_3_4() {
        check_sweep(MAX, 0);
        check_sweep(MAX, 3);
        check_sweep(MAX, 4);
    }

    /// STR-1c: an allocation that reuses pops the most recently freed
    /// record (LIFO) and leaves the rest of the list as it was; one that
    /// grows leaves the list empty. The low-water mark becomes the shortest
    /// length seen, and every entry below it is unchanged.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1c_alloc_pops_last() {
        every_shape(|cap, n| {
            let mut book = any_book(cap, n);
            let b = snap(&book);
            let Some(got) = alloc(&mut book) else { return };
            let a = snap(&book);
            if n > 0 {
                assert!(got == b.free[n - 1] && a.n == n - 1);
                assert!(a.free_low == b.free_low.min(n - 1));
            } else {
                assert!(got as usize == cap && a.n == 0 && a.free_low == 0);
            }
            for k in 0..a.n {
                assert!(a.free[k] == b.free[k]);
            }
            kani::cover!(n >= 3, "a pop from a list of three");
            kani::cover!(a.free_low < b.free_low, "the low-water mark falls");
        });
    }

    /// STR-1c: freeing appends the record at the end of the list and keeps
    /// the low-water mark; acknowledging restarts the mark at the length
    /// and leaves the list as it was.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1c_release_appends_and_acknowledge() {
        every_shape(|cap, n| {
            let mut book = any_book(cap, n);
            let b = snap(&book);
            if kani::any() {
                if n == cap {
                    return;
                }
                let i: u32 = kani::any_where(|&i| (i as usize) < cap);
                if book.is_free(i) {
                    return;
                }
                book.release(i, || {});
                let a = snap(&book);
                assert!(a.n == n + 1 && a.free[n] == i && a.free_low == b.free_low);
                for k in 0..n {
                    assert!(a.free[k] == b.free[k]);
                }
                kani::cover!(n == 2, "a push onto a list of two");
            } else {
                book.acknowledge();
                let a = snap(&book);
                assert!(same_free(&a, &b) && a.free_low == n);
                kani::cover!(b.free_low < n, "an acknowledgement raises the mark");
            }
        });
    }

    /// STR-1c at one shape: the sweep keeps the list's existing entries
    /// and the low-water mark, and appends the reclaimed records in
    /// ascending index order (the order the snapshot then serializes).
    fn check_sweep_order(cap: usize, n: usize) {
        let mut book = any_book(cap, n);
        let b = snap(&book);
        let reclaimed = book.sweep_each(cap as u32, |_| {}, |_| {});
        let a = snap(&book);
        assert!(a.n == n + reclaimed as usize && a.free_low == b.free_low);
        let mut at = n;
        for k in 0..W {
            if k < n {
                assert!(a.free[k] == b.free[k]);
            }
            if k < cap && !b.marks[k] && !b.free_marks[k] {
                assert!(at < W && a.free[at] == k as u32);
                at += 1;
            }
        }
        kani::cover!(reclaimed >= 2 && n >= 1, "two appended behind a free entry");
    }

    /// STR-1c: [`check_sweep_order`] at every capacity up to 3.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1c_sweep_appends_ascending_cap_0_to_3() {
        for cap in 0..=3 {
            for n in 0..=cap {
                check_sweep_order(cap, n);
            }
        }
    }

    /// STR-1c: [`check_sweep_order`] at capacity 4.
    #[kani::proof]
    #[kani::unwind(6)]
    fn str1c_sweep_appends_ascending_cap_4() {
        for n in 0..=MAX {
            check_sweep_order(MAX, n);
        }
    }
}
