//! GC v1: exact, non-generational mark-and-sweep over the slot arena,
//! plus slide-compaction of the chunk arena (design § Value and heap
//! model; roadmap stage 2, "GC v1").
//!
//! XS's collector (`fxCollect` in `xsMemory.c`) marks from the machine
//! roots (stack, globals, keys, host roots), sweeps unmarked slots to
//! the free list, and compacts the chunk heap. This port keeps that
//! shape, re-expressed over index arenas so it is `forbid(unsafe_code)`
//! safe: the mark phase is a worklist trace over [`SlotArena`] edges,
//! the sweep returns unmarked records to the free list, and the chunk
//! compaction slides live blocks and rewrites the `ChunkOffset`s the
//! surviving string slots hold — exactly where XS rewrites pointers.
//!
//! Because the heap is index-based, a stale index reaching a
//! kind-checked accessor is a deterministic panic (a crashed crank),
//! never undefined behavior; there are no raw pointers to invalidate,
//! which is what makes the collector safe code (design § Memory-safety
//! confidence).

use crate::value::{ChunkArena, ChunkOffset, SlotArena, SlotIndex};

/// The machine heap: the slot arena and the chunk arena the collector
/// operates over together. The interpreter threads one of these as its
/// object heap; the collector is a method so the two arenas are
/// compacted consistently (a chunk offset is rewritten in the same slot
/// that keeps the chunk alive).
#[derive(Default)]
pub struct Heap {
    pub slots: SlotArena,
    pub chunks: ChunkArena,
}

/// What one collection reclaimed, for tests and heap-accounting parity.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct GcStats {
    /// Slots swept back onto the free list.
    pub slots_reclaimed: u32,
    /// Live slots remaining after the sweep.
    pub slots_live: u32,
    /// Chunk-arena bytes before compaction.
    pub chunk_bytes_before: usize,
    /// Chunk-arena bytes after compaction.
    pub chunk_bytes_after: usize,
}

impl Heap {
    pub fn new() -> Heap {
        Heap {
            slots: SlotArena::new(),
            chunks: ChunkArena::new(),
        }
    }

    /// Collect: mark everything reachable from `roots`, sweep the rest,
    /// then slide-compact the chunk arena and rewrite the surviving
    /// string slots' offsets.
    pub fn collect(&mut self, roots: &[SlotIndex]) -> GcStats {
        let chunk_bytes_before = self.chunks.byte_size();

        // --- mark (worklist trace, cycle-safe via the mark bit) ---
        self.slots.clear_marks();
        let mut worklist: Vec<SlotIndex> = Vec::new();
        for &r in roots {
            if self.slots.mark(r) {
                worklist.push(r);
            }
        }
        while let Some(idx) = worklist.pop() {
            // Collect edges first (immutable borrow), then mark (mutable).
            let mut edges: Vec<SlotIndex> = Vec::new();
            self.slots.get(idx).each_ref_slot(|e| edges.push(e));
            for e in edges {
                if self.slots.mark(e) {
                    worklist.push(e);
                }
            }
        }

        // --- sweep ---
        let slots_reclaimed = self.slots.sweep();

        // --- compact chunks: gather the offsets the surviving string
        // slots hold, slide them down, and rewrite each survivor. ---
        let mut live_offsets: Vec<ChunkOffset> = Vec::new();
        for i in 0..self.slots.capacity() {
            let idx = SlotIndex(i);
            if self.slots.is_marked(idx) {
                if let Some(off) = self.slots.get(idx).chunk_ref() {
                    live_offsets.push(off);
                }
            }
        }
        let remap = self.chunks.compact(&live_offsets);
        for i in 0..self.slots.capacity() {
            let idx = SlotIndex(i);
            if self.slots.is_marked(idx) {
                if let Some(off) = self.slots.get(idx).chunk_ref() {
                    if let Some(&new_off) = remap.get(&off) {
                        self.slots.get_mut(idx).set_chunk_ref(new_off);
                    }
                }
            }
        }

        GcStats {
            slots_reclaimed,
            slots_live: self.slots.live_count(),
            chunk_bytes_before,
            chunk_bytes_after: self.chunks.byte_size(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::{Kind, Payload, Slot};

    fn str_slot(off: ChunkOffset) -> Slot {
        Slot::of(Kind::String, Payload::String(off))
    }

    #[test]
    fn sweeps_unreachable_slots() {
        let mut h = Heap::new();
        let root = h.slots.alloc(Slot::integer(1));
        let _garbage_a = h.slots.alloc(Slot::integer(2));
        let _garbage_b = h.slots.alloc(Slot::integer(3));
        assert_eq!(h.slots.live_count(), 3);

        let stats = h.collect(&[root]);
        assert_eq!(stats.slots_reclaimed, 2, "two unreachable slots swept");
        assert_eq!(stats.slots_live, 1, "only the root survives");
        // The root is still addressable and intact.
        assert_eq!(h.slots.get(root).as_integer(), Some(1));
    }

    #[test]
    fn keeps_transitively_reachable_slots() {
        // root -> a (via next) -> b (via Reference payload)
        let mut h = Heap::new();
        let b = h.slots.alloc(Slot::integer(99));
        let a = h.slots.alloc(Slot::of(Kind::Reference, Payload::Reference(b)));
        let mut root_slot = Slot::integer(0);
        root_slot.next = a;
        let root = h.slots.alloc(root_slot);
        let _garbage = h.slots.alloc(Slot::integer(7));

        let stats = h.collect(&[root]);
        assert_eq!(stats.slots_reclaimed, 1, "only the garbage is swept");
        assert_eq!(stats.slots_live, 3);
        assert!(h.slots.is_marked(b), "transitively reachable slot kept");
    }

    #[test]
    fn tolerates_reference_cycles() {
        // a <-> b cycle, both reachable from root; the mark bit must
        // stop the trace from looping.
        let mut h = Heap::new();
        let a = h.slots.alloc(Slot::of(Kind::Reference, Payload::Reference(SlotIndex::NULL)));
        let b = h.slots.alloc(Slot::of(Kind::Reference, Payload::Reference(a)));
        h.slots.get_mut(a).value = Payload::Reference(b);
        let stats = h.collect(&[a]);
        assert_eq!(stats.slots_reclaimed, 0, "the whole cycle is live");
        assert_eq!(stats.slots_live, 2);
    }

    #[test]
    fn frees_are_reused_after_sweep() {
        let mut h = Heap::new();
        let root = h.slots.alloc(Slot::integer(1));
        h.slots.alloc(Slot::integer(2));
        h.collect(&[root]);
        let before_cap = h.slots.capacity();
        // The freed record is reused rather than growing the arena.
        let reused = h.slots.alloc(Slot::integer(5));
        assert_eq!(h.slots.get(reused).as_integer(), Some(5));
        assert_eq!(h.slots.capacity(), before_cap, "swept record reused");
    }

    #[test]
    fn compacts_chunks_and_rewrites_offsets() {
        let mut h = Heap::new();
        // Three strings; only the middle one stays reachable.
        let _dead0 = h.chunks.alloc(b"hello");
        let keep_off = h.chunks.alloc(b"world!");
        let _dead1 = h.chunks.alloc(b"gone");
        let keep = h.slots.alloc(str_slot(keep_off));

        let before = h.chunks.byte_size();
        let stats = h.collect(&[keep]);
        assert!(
            stats.chunk_bytes_after < before,
            "compaction reclaimed dead chunk bytes ({} -> {})",
            before,
            stats.chunk_bytes_after
        );
        // The surviving slot's offset was rewritten and still reads the
        // same bytes.
        let new_off = h.slots.get(keep).chunk_ref().unwrap();
        assert_eq!(h.chunks.payload(new_off), b"world!");
    }

    #[test]
    fn compacts_bigint_digit_chunks_and_rewrites_offsets() {
        // A BigInt's digit chunk (`[sign: u8][LE u32 limbs]`) relocates in the
        // slide-compactor exactly like a String's, through the same
        // `chunk_ref`/`set_chunk_ref` edge — dead BigInt chunks are reclaimed
        // and the surviving BigInt slot's offset is rewritten to still read the
        // same sign+magnitude bytes.
        let mut h = Heap::new();
        let _dead = h.chunks.alloc(&[0u8, 7, 0, 0, 0]); // dead `7n`
        // keep `-4294967297n` = 0x1_0000_0001, two limbs, negative.
        let keep_bytes = [1u8, 0x01, 0, 0, 0, 0x01, 0, 0, 0];
        let keep_off = h.chunks.alloc(&keep_bytes);
        let _dead2 = h.chunks.alloc(&[0u8, 9, 0, 0, 0]); // dead `9n`
        let keep = h.slots.alloc(Slot::of(Kind::BigInt, Payload::BigInt(keep_off)));

        let before = h.chunks.byte_size();
        let stats = h.collect(&[keep]);
        assert!(
            stats.chunk_bytes_after < before,
            "compaction reclaimed the dead BigInt chunk bytes ({} -> {})",
            before,
            stats.chunk_bytes_after
        );
        let new_off = h.slots.get(keep).chunk_ref().unwrap();
        assert_eq!(h.chunks.payload(new_off), &keep_bytes, "BigInt digits survive relocation");
    }

    #[test]
    fn traces_an_instance_property_chain() {
        // The stage-2b object-heap shape: an instance whose `next` chains
        // Property slots, one holding a Reference to a second instance.
        // Everything reachable from the root instance survives; a
        // detached instance + property are swept.
        let mut h = Heap::new();
        let inner = h.slots.alloc(Slot::instance(SlotIndex::NULL));
        // root instance -> prop "a" (Reference to inner) -> prop "b" (=7)
        let pa = h.slots.alloc(Slot::property(1, Payload::Reference(inner)));
        // fix up the property kind (property() defaults to Property kind
        // with a Reference payload, which is what we want here).
        assert_eq!(h.slots.get(pa).kind, Kind::Property);
        let pb = h.slots.alloc(Slot::property(2, Payload::Integer(7)));
        h.slots.get_mut(pa).next = pb;
        let root = h.slots.alloc(Slot::instance(SlotIndex::NULL));
        h.slots.get_mut(root).next = pa;
        // Detached garbage: an unreachable instance with a property.
        let dead_inst = h.slots.alloc(Slot::instance(SlotIndex::NULL));
        let dead_prop = h.slots.alloc(Slot::property(9, Payload::Integer(0)));
        h.slots.get_mut(dead_inst).next = dead_prop;

        let stats = h.collect(&[root]);
        assert_eq!(stats.slots_reclaimed, 2, "the detached instance + its property are swept");
        assert!(h.slots.is_marked(inner), "Reference-held instance kept");
        assert!(h.slots.is_marked(pa) && h.slots.is_marked(pb), "the property chain is kept");
        assert!(!h.slots.is_marked(dead_inst) && !h.slots.is_marked(dead_prop));
        // The chain is intact after the collection.
        assert_eq!(h.slots.get(root).next, pa);
        assert_eq!(h.slots.get(pa).next, pb);
    }

    #[test]
    fn traces_instance_prototype_edge() {
        // An instance's prototype (its payload Reference) is a GC edge:
        // a prototype-only-reachable instance survives.
        let mut h = Heap::new();
        let proto = h.slots.alloc(Slot::instance(SlotIndex::NULL));
        let obj = h.slots.alloc(Slot::instance(proto));
        let _garbage = h.slots.alloc(Slot::instance(SlotIndex::NULL));
        let stats = h.collect(&[obj]);
        assert_eq!(stats.slots_reclaimed, 1, "only the unrelated instance is swept");
        assert!(h.slots.is_marked(proto), "the prototype is kept through the instance edge");
    }

    #[test]
    fn empty_root_set_reclaims_everything() {
        let mut h = Heap::new();
        h.slots.alloc(Slot::integer(1));
        h.slots.alloc(Slot::integer(2));
        let stats = h.collect(&[]);
        assert_eq!(stats.slots_reclaimed, 2);
        assert_eq!(stats.slots_live, 0);
    }
}
