//! Corrupt strong and conditional references must stop GC before sweeping.
use std::panic::{catch_unwind, AssertUnwindSafe};

use ironhorse_vm::gc::{collect_full, GcHooks};
use ironhorse_vm::{ChunkArena, ChunkOffset, Slot, SlotArena, SlotIndex};

struct Hooks {
    edge: SlotIndex,
    conditional: bool,
    swept: usize,
}

impl GcHooks for Hooks {
    fn extra_edges(&self, _: SlotIndex, visit: &mut dyn FnMut(SlotIndex)) {
        if !self.conditional {
            visit(self.edge);
        }
    }
    fn ephemeron_edges(&self, _: &SlotArena, visit: &mut dyn FnMut(SlotIndex)) {
        if self.conditional {
            visit(self.edge);
        }
    }
    fn swept(&mut self, _: SlotIndex) {
        self.swept += 1;
    }
    fn external_chunk_refs(&mut self, _: &mut dyn FnMut(&mut ChunkOffset)) {}
}

#[test]
fn invalid_roots_and_edges_are_refused_in_release_too() {
    for out_of_bounds in [false, true] {
        for source in ["root", "arena", "side table", "ephemeron"] {
            let mut slots = SlotArena::new();
            let freed = slots.alloc(Slot::integer(42));
            let root = slots.alloc(Slot::integer(7));
            slots.alloc(Slot::integer(99)); // Must not be swept after refusal.
            slots.free(freed);
            let bad = if out_of_bounds {
                SlotIndex(slots.capacity())
            } else {
                freed
            };
            if source == "arena" {
                slots.get_mut(root).next = bad;
            }
            let mut hooks = Hooks {
                edge: if matches!(source, "side table" | "ephemeron") {
                    bad
                } else {
                    SlotIndex::NULL
                },
                conditional: source == "ephemeron",
                swept: 0,
            };
            let before_free = slots.free_list().to_vec();
            let before_live = slots.live_count();
            let result = catch_unwind(AssertUnwindSafe(|| {
                collect_full(
                    &mut slots,
                    &mut ChunkArena::new(),
                    &[if source == "root" { bad } else { root }],
                    &mut hooks,
                )
            }));
            let error = result.expect_err(source);
            let message = error
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| error.downcast_ref::<&str>().copied())
                .unwrap();
            assert!(
                message.contains(if out_of_bounds {
                    "mark of out-of-arena slot"
                } else {
                    "mark of free slot"
                }),
                "{source}: {message}"
            );
            assert_eq!(hooks.swept, 0);
            assert_eq!(slots.free_list(), before_free);
            assert_eq!(slots.live_count(), before_live);
        }
    }
}
