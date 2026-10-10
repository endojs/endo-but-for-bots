//! Arena invariants hold for direct constructors as well as snapshot decoders.
use std::cell::Cell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use ironhorse_vm::value::{PageSource, SlotArenaImageError};
use ironhorse_vm::{Slot, SlotArena, SlotIndex};

struct Source {
    reads: Cell<usize>,
}
impl PageSource for Source {
    fn slot_page(&self, _: u32) -> Vec<Slot> {
        self.reads.set(self.reads.get() + 1);
        vec![Slot::integer(7); 3]
    }
    fn chunk_extent(&self, _: u32) -> Vec<u8> {
        panic!("slot-only fixture must not fetch chunks")
    }
}

#[test]
fn image_metadata_is_checked_by_both_arena_constructors() {
    let source = Rc::new(Source {
        reads: Cell::new(0),
    });
    for (free, live, expected) in [
        (vec![3], 2, SlotArenaImageError::FreeIndexOutOfRange),
        (vec![u32::MAX], 2, SlotArenaImageError::FreeIndexOutOfRange),
        (vec![1, 1], 1, SlotArenaImageError::DuplicateFreeIndex),
        (vec![1], 3, SlotArenaImageError::LiveFreeAccounting),
        (vec![1], 0, SlotArenaImageError::LiveFreeAccounting),
        (vec![], u32::MAX, SlotArenaImageError::LiveFreeAccounting),
    ] {
        assert_eq!(
            SlotArena::try_from_image(vec![Slot::integer(7); 3], free.clone(), live).err(),
            Some(expected)
        );
        assert_eq!(
            SlotArena::try_lazy_from_parts(3, free, live, source.clone(), 0).err(),
            Some(expected)
        );
    }
    assert_eq!(source.reads.get(), 0);
    // Empty images are valid; a free record's bytes are deliberately opaque.
    assert!(SlotArena::try_from_image(vec![], vec![], 0).is_ok());
    assert!(SlotArena::try_lazy_from_parts(0, vec![], 0, source, 0).is_ok());
}

#[test]
fn valid_restoration_preserves_free_order_and_distinct_allocations() {
    let source = Rc::new(Source {
        reads: Cell::new(0),
    });
    for mut arena in [
        SlotArena::try_from_image(vec![Slot::integer(7); 3], vec![2, 0], 1).unwrap(),
        SlotArena::try_lazy_from_parts(3, vec![2, 0], 1, source, 0).unwrap(),
    ] {
        assert_eq!(arena.free_list(), &[2, 0]);
        assert!(arena.dirty_pages().is_empty());
        assert_eq!(arena.alloc(Slot::integer(10)), SlotIndex(0));
        assert_eq!(arena.alloc(Slot::integer(20)), SlotIndex(2));
        assert_eq!(arena.get(SlotIndex(0)), Slot::integer(10));
        assert_eq!(arena.get(SlotIndex(1)), Slot::integer(7));
        assert_eq!(arena.get(SlotIndex(2)), Slot::integer(20));
        assert_eq!(arena.live_count(), 3);
    }
}

fn assert_panics_with(action: impl FnOnce(), expected: &str) {
    let error = catch_unwind(AssertUnwindSafe(action)).expect_err("must reject invalid access");
    let message = error
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| error.downcast_ref::<&str>().copied())
        .unwrap();
    assert!(
        message.contains(expected),
        "{message:?} must contain {expected:?}"
    );
}

#[test]
fn double_free_refuses_before_mutating_arena_in_every_profile() {
    let mut arena = SlotArena::new();
    let a = arena.alloc(Slot::integer(1));
    let b = arena.alloc(Slot::integer(2));
    arena.free(a);
    assert_panics_with(|| arena.free(a), "double free of slot");
    assert_eq!(arena.live_count(), 1);
    assert_eq!(arena.free_list(), &[a.0]);
    assert_eq!(arena.get(b), Slot::integer(2));
    assert_eq!(arena.alloc(Slot::integer(3)), a);
    let c = arena.alloc(Slot::integer(4));
    assert_ne!(a, c);
    assert_ne!(b, c);
    assert_eq!(arena.get(a), Slot::integer(3));
}

#[test]
fn infallible_constructor_also_refuses_invalid_metadata() {
    assert_panics_with(
        || {
            SlotArena::from_image(vec![Slot::integer(1)], vec![0, 0], 0);
        },
        "DuplicateFreeIndex",
    );
    assert_panics_with(
        || {
            SlotArena::lazy_from_parts(
                1,
                vec![1],
                0,
                Rc::new(Source {
                    reads: Cell::new(0),
                }),
                0,
            );
        },
        "FreeIndexOutOfRange",
    );
}

#[cfg(debug_assertions)]
#[test]
fn freed_access_refuses_before_faulting_or_dirtying() {
    let source = Rc::new(Source {
        reads: Cell::new(0),
    });
    for mut arena in [
        SlotArena::from_image(vec![Slot::integer(7); 3], vec![1], 2),
        SlotArena::lazy_from_parts(3, vec![1], 2, source.clone(), 0),
    ] {
        assert_panics_with(
            || {
                arena.get(SlotIndex(1));
            },
            "access to free slot",
        );
        assert_panics_with(
            || {
                arena.get_mut(SlotIndex(1));
            },
            "access to free slot",
        );
        assert_panics_with(
            || {
                arena.mark(SlotIndex(1));
            },
            "mark of free slot",
        );
        assert!(!arena.is_marked(SlotIndex(1)));
        assert!(arena.dirty_pages().is_empty());
        assert!(!arena.mark(SlotIndex::NULL));
    }
    assert_eq!(source.reads.get(), 0);
}

#[test]
fn compact_refuses_interior_offsets_before_changing_bytes() {
    use ironhorse_vm::{ChunkArena, ChunkOffset};
    let mut chunks = ChunkArena::new();
    // Interior zeros masquerade as a zero-sized block under the old check.
    let live = chunks.alloc(&[0; 16]);
    let tail = chunks.alloc(b"tail");
    chunks.clear_dirty();
    let original = chunks.raw_vec();
    for offset in [ChunkOffset(live.0 + 4), ChunkOffset(live.0 + 8)] {
        assert_panics_with(
            || {
                chunks.compact(&[live, offset, tail]);
            },
            "chunk offset is not a payload boundary",
        );
        assert_eq!(&chunks.raw_vec(), &original);
        assert!(chunks.dirty_extents().is_empty());
    }
    // Valid duplicates and NULL still work after the failed collection.
    let remap = chunks.compact(&[tail, live, live, ChunkOffset::NULL]);
    assert!(remap.is_empty());
    assert_eq!(&*chunks.payload(live), &[0; 16]);
    assert_eq!(&*chunks.payload(tail), b"tail");
}
