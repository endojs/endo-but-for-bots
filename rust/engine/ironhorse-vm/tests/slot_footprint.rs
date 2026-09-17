//! The slot arena's two size questions, kept apart (architecture finding
//! F121).
//!
//! `SlotArena` reports its capacity in XS's accounting unit — 32 bytes per
//! addressable record — because that is the number a like-for-like comparison
//! against XS's `currentHeapSize` needs. For a long time that was the *only*
//! number, it was called `byte_size`, it had no caller anywhere in either
//! workspace, and the design's "heap within 1.1x, the slot accounting is
//! identical by construction" bar was cited against it. Three things were
//! wrong with that at once: the engine's record is 24 bytes, not 32; `Slot`
//! carries no `repr` attribute, so even 24 is Rust's choice rather than a
//! contract; and the per-slot bookkeeping vectors the arena also holds were
//! outside the accounting entirely.
//!
//! So there are two methods with two names, and these tests hold them apart:
//! `xs_accounted_byte_size` answers "what would XS call this heap", and
//! `resident_byte_size` answers "what does this process actually hold".
//! Nothing here asserts a footprint *bar* — that is the stage-8 envelope's
//! job, and `benches/` owns it. This asserts that the instrument measures
//! what its name says.

use std::mem::size_of;

use ironhorse_vm::{Slot, SlotArena};

/// The premise the whole finding rests on. If `Slot` ever becomes 32 bytes
/// this test fails and the accounting note above needs rewriting rather
/// than silently becoming true by accident.
#[test]
fn the_record_is_not_the_size_xs_accounts_for() {
    assert_eq!(
        size_of::<Slot>(),
        24,
        "Slot's size changed; the XS-accounted/resident distinction's \
         premise moved with it"
    );
}

/// The XS-accounted number is capacity in XS's unit, and says so.
#[test]
fn xs_accounted_size_is_capacity_in_xs_units() {
    let mut arena = SlotArena::new();
    for _ in 0..100 {
        arena.alloc(Slot::undefined());
    }
    assert_eq!(
        arena.xs_accounted_byte_size(),
        arena.capacity() as usize * 32
    );
}

/// The resident number is a different number, and a specific one.
///
/// Asserted as an EQUALITY against an independently computed expectation
/// rather than as a floor. A floor is satisfied by almost any wrong answer:
/// with the previous `>` and `>=` assertions, changing the record term to
/// `capacity * 999` or dropping two of the four bookkeeping vectors both
/// left this file entirely green.
#[test]
fn resident_size_counts_the_bookkeeping_the_xs_unit_omits() {
    const SLOTS: usize = 1_000;
    let mut arena = SlotArena::new();
    for _ in 0..SLOTS {
        arena.alloc(Slot::undefined());
    }
    let capacity = arena.capacity() as usize;

    // What a detached arena holds, term by term, computed here from the
    // documented layout rather than from the implementation:
    //   records          capacity * size_of::<Slot>()
    //   free list        empty — nothing has been freed
    //   free marks       one byte per slot
    //   collector marks  one byte per slot
    //   dirty bits       one byte per page
    //   unbacked bits    one byte per page (detached: none)
    let pages = capacity.div_ceil(ironhorse_vm::SLOTS_PER_PAGE as usize);
    // The vectors report CAPACITY, not length, and a growing `Vec` rounds
    // up — so the band is the documented layout at the low end and twice it
    // at the high end, which is the most a doubling allocator can add. Wide
    // enough for allocator behaviour, narrow enough to catch the mutations
    // that used to pass: a record term of `capacity * 999` is 40x the low
    // bound, and dropping the two per-slot bitmaps falls below it.
    let layout = capacity * size_of::<Slot>() + 2 * capacity;
    let expected_low = layout;
    let expected_high = 2 * layout + 4 * pages + 64;
    let resident = arena.resident_byte_size();
    assert!(
        (expected_low..=expected_high).contains(&resident),
        "resident is {resident}, outside the {expected_low}..={expected_high} \
         the documented layout accounts for ({capacity} slots, {pages} pages). \
         Either a bookkeeping vector was added without being counted, or a \
         counted term is the wrong size."
    );
}

/// A lazily attached arena holds its records in the backing, not in the
/// dense vector — and residency is grow-only, so faulting pages in must
/// MOVE this number. It did not: the measurement read the dense vector's
/// capacity, which is zero on a lazy arena, and reported the same figure
/// before and after faulting every page of a 400,000-record heap.
#[test]
fn a_lazy_arena_reports_what_its_backing_holds() {
    let (arena, slots) = support::lazy_arena(4_000);
    let cold = arena.resident_byte_size();
    for index in 0..slots {
        let _ = arena.get(ironhorse_vm::SlotIndex(index));
    }
    let warm = arena.resident_byte_size();
    assert!(
        warm > cold,
        "faulting every page did not move the resident footprint: \
         {cold} then {warm}. Residency is grow-only, so this is the one \
         number that must move."
    );
    assert!(
        warm >= slots as usize * size_of::<Slot>(),
        "a lazy arena holding {slots} faulted records reports {warm} bytes, \
         below the records alone"
    );
}

mod support {
    use std::rc::Rc;

    use ironhorse_vm::value::PageSource;
    use ironhorse_vm::{Slot, SlotArena, SLOTS_PER_PAGE};

    /// A page source that serves a fixed record, so a fault installs real
    /// records rather than placeholders.
    struct Pages {
        count: u32,
    }

    impl PageSource for Pages {
        fn slot_page(&self, page: u32) -> Vec<Slot> {
            let start = page * SLOTS_PER_PAGE;
            let len = SLOTS_PER_PAGE.min(self.count.saturating_sub(start));
            vec![Slot::integer(7); len as usize]
        }
        fn chunk_extent(&self, _: u32) -> Vec<u8> {
            panic!("a slot-only fixture must not fetch chunks")
        }
    }

    /// A lazily attached arena of `slots` records, with no page faulted yet.
    pub(super) fn lazy_arena(slots: u32) -> (SlotArena, u32) {
        let source = Rc::new(Pages { count: slots });
        (
            SlotArena::lazy_from_parts(slots, Vec::new(), slots, source, 0),
            slots,
        )
    }
}

/// The two must not quietly become the same number. An alias would restore
/// exactly the confusion the rename was for.
#[test]
fn the_two_measurements_do_not_agree() {
    let mut arena = SlotArena::new();
    for _ in 0..1_000 {
        arena.alloc(Slot::undefined());
    }
    assert_ne!(
        arena.xs_accounted_byte_size(),
        arena.resident_byte_size(),
        "the XS-accounted and resident measurements collapsed into one \
         number; one of them is now lying"
    );
}

/// An empty arena holds nothing, in both units. Guards the `capacity()`
/// term against an off-by-one that would make the instrument report a
/// floor that is not there.
#[test]
fn an_empty_arena_is_empty_in_both_units() {
    let arena = SlotArena::new();
    assert_eq!(arena.xs_accounted_byte_size(), 0);
    assert_eq!(
        arena.resident_byte_size(),
        0,
        "a fresh arena reserves nothing"
    );
}

/// Freeing does not shrink either measurement, and GROWS the resident one:
/// a freed record keeps its address, and the free list it lands on is
/// itself resident. Asserted as a strict increase, not `>=`, because `>=`
/// is satisfied by a constant.
#[test]
fn freeing_retains_the_footprint_it_does_not_return() {
    let mut arena = SlotArena::new();
    let indices: Vec<_> = (0..500).map(|_| arena.alloc(Slot::undefined())).collect();
    let before = (arena.xs_accounted_byte_size(), arena.resident_byte_size());
    for index in indices {
        arena.free(index);
    }
    assert_eq!(arena.live_count(), 0);
    let after = (arena.xs_accounted_byte_size(), arena.resident_byte_size());
    assert_eq!(
        after.0, before.0,
        "XS-accounted capacity must not move on free"
    );
    assert!(
        after.1 > before.1,
        "freeing 500 records must GROW the resident footprint by the free \
         list that now holds them: {} then {}",
        before.1,
        after.1
    );
}
