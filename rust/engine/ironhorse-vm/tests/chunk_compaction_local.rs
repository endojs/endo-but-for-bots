//! Extent-local reclamation preserves payloads, backing and deterministic reuse.
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use ironhorse_vm::value::{PageSource, CHUNK_EXTENT_BYTES};
use ironhorse_vm::{ChunkArena, ChunkOffset, Slot};

const PER: usize = CHUNK_EXTENT_BYTES as usize;

struct Source {
    bytes: RefCell<Vec<u8>>,
    reads: RefCell<Vec<u32>>,
    fail: RefCell<Option<(u32, usize)>>,
}
impl PageSource for Source {
    fn slot_page(&self, _: u32) -> Vec<Slot> {
        panic!("chunk-only test")
    }
    fn chunk_extent(&self, ext: u32) -> Vec<u8> {
        let mut reads = self.reads.borrow_mut();
        reads.push(ext);
        if let Some((failed, count)) = *self.fail.borrow() {
            assert!(
                ext != failed || reads.iter().filter(|&&e| e == ext).count() != count,
                "injected source failure"
            );
        }
        let bytes = self.bytes.borrow();
        let start = ext as usize * PER;
        bytes[start..bytes.len().min(start + PER)].to_vec()
    }
}
fn lazy(arena: &ChunkArena) -> (ChunkArena, Rc<Source>) {
    let source = Rc::new(Source {
        bytes: RefCell::new(arena.raw_vec()),
        reads: RefCell::new(Vec::new()),
        fail: RefCell::new(None),
    });
    (
        ChunkArena::lazy_from_parts(arena.byte_size(), source.clone()),
        source,
    )
}
fn block(arena: &mut ChunkArena, span: usize, value: u8) -> ChunkOffset {
    arena.alloc(&vec![value; span - 4])
}

#[test]
fn scattered_garbage_does_not_move_or_fault_a_clean_neighbor() {
    let mut plain = ChunkArena::new();
    block(&mut plain, PER / 4, 1);
    let moved = block(&mut plain, 3 * PER / 4, 2);
    let neighbor = block(&mut plain, PER, 3);
    block(&mut plain, 12, 4);
    let (mut chunks, source) = lazy(&plain);
    let remap = chunks.compact_local(&[moved, neighbor]);
    assert_eq!(remap.len(), 1);
    assert_eq!(remap[&moved], ChunkOffset(4));
    assert_eq!(chunks.byte_size(), 2 * PER);
    assert_eq!(chunks.dirty_extents(), vec![0]);
    assert_eq!(chunks.resident_extent_count(), 1);
    chunks.set_ceiling(2 * PER);
    assert!(chunks.can_allocate(PER / 4 - 4));
    assert_eq!(
        chunks.alloc(&vec![9; PER / 4 - 4]),
        ChunkOffset((3 * PER / 4 + 4) as u32)
    );
    assert_eq!(chunks.resident_extent_count(), 1);
    assert_eq!(&*chunks.payload(neighbor), vec![3; PER - 4]);
    // Publish the changed bytes, advance the backing, evict, then re-read both
    // relocated and unchanged payloads from their authenticated positions.
    let bytes = chunks.raw_vec();
    *source.bytes.borrow_mut() = bytes.clone();
    chunks.advance_backing();
    chunks.clear_dirty_after_commit(true);
    assert!(chunks.evict_extent(0));
    assert!(chunks.evict_extent(1));
    assert_eq!(chunks.resident_extent_count(), 0);
    assert_eq!(chunks.raw_vec(), bytes);
    assert_eq!(&*chunks.payload(ChunkOffset(4)), vec![2; 3 * PER / 4 - 4]);
}

#[test]
fn threshold_is_exact_and_skipped_dead_blocks_do_not_enter_the_free_index() {
    for dead in [PER / 4 - 1, PER / 4] {
        let mut plain = ChunkArena::new();
        block(&mut plain, dead, 1);
        let live = block(&mut plain, PER - dead, 2);
        let neighbor = block(&mut plain, PER, 3);
        let (mut chunks, _) = lazy(&plain);
        chunks.set_ceiling(2 * PER);
        let remap = chunks.compact_local(&[live, neighbor]);
        if dead == PER / 4 - 1 {
            assert!(remap.is_empty());
            assert!(chunks.dirty_extents().is_empty());
            assert_eq!(chunks.resident_extent_count(), 0);
            assert!(!chunks.can_allocate(0));
            assert_eq!(chunks.raw_vec(), plain.raw_vec());
        } else {
            assert_eq!(remap[&live], ChunkOffset(4));
            assert_eq!(chunks.dirty_extents(), vec![0]);
            assert!(chunks.can_allocate(dead - 4));
        }
    }
}

#[test]
fn crossing_live_blocks_are_fixed_anchors_even_with_garbage_on_both_sides() {
    let mut plain = ChunkArena::new();
    block(&mut plain, PER - 12, 1);
    let anchor = block(&mut plain, PER + 28, 2); // Ends at 2*PER+16.
    block(&mut plain, PER / 4, 3);
    let moved = block(&mut plain, 3 * PER / 4 - 16, 4);
    let empty = block(&mut plain, 4, 5);
    let (mut chunks, source) = lazy(&plain);
    let remap = chunks.compact_local(&[empty, moved, anchor, moved, ChunkOffset::NULL]);
    assert_eq!(remap.len(), 1);
    assert_eq!(remap[&moved], ChunkOffset((2 * PER + 20) as u32));
    assert_eq!(chunks.byte_size(), 3 * PER + 4);
    assert_eq!(chunks.dirty_extents(), vec![0, 2]);
    assert_eq!(chunks.resident_extent_count(), 2);
    assert!(
        !source.reads.borrow().contains(&1),
        "the middle of the anchor was never read"
    );
    assert!(chunks.payload(empty).is_empty());
    assert_eq!(&*chunks.payload(anchor), vec![2; PER + 24]);
    assert_eq!(&*chunks.payload(remap[&moved]), vec![4; 3 * PER / 4 - 20]);
}

#[test]
fn tiny_holes_remain_valid_unreferenced_blocks_across_restore() {
    for dead in 4..=7 {
        let mut plain = ChunkArena::new();
        block(&mut plain, dead, 1);
        let moved = block(&mut plain, 8, 2);
        let anchor = block(&mut plain, PER, 3);
        let remap = plain.compact_local(&[moved, anchor]);
        assert_eq!(remap[&moved], ChunkOffset(4));
        let bytes = plain.raw_vec();
        assert_eq!(
            u32::from_le_bytes(bytes[8..12].try_into().unwrap()),
            (dead - 4) as u32
        );
        let mut resumed = ChunkArena::from_image(bytes);
        for chunks in [&mut plain, &mut resumed] {
            chunks.set_ceiling(chunks.byte_size());
            assert!(!chunks.can_allocate(0));
            assert!(chunks.compact_local(&[ChunkOffset(4), anchor]).is_empty());
            assert_eq!(&*chunks.payload(anchor), vec![3; PER - 4]);
        }
        assert_eq!(plain.raw_vec(), resumed.raw_vec());
    }
}

#[test]
fn a_late_source_failure_leaves_prepared_edits_and_the_index_unpublished() {
    let mut plain = ChunkArena::new();
    block(&mut plain, PER / 2, 1);
    let first = block(&mut plain, PER / 2, 2);
    let neighbor = block(&mut plain, PER, 3);
    block(&mut plain, PER / 2, 4);
    let last = block(&mut plain, PER / 2, 5);
    let (mut chunks, source) = lazy(&plain);
    chunks.set_ceiling(3 * PER);
    assert!(!chunks.can_allocate(0));
    source.reads.borrow_mut().clear();
    *source.fail.borrow_mut() = Some((2, 2)); // Validation succeeds; later copy fails.
    assert!(catch_unwind(AssertUnwindSafe(
        || chunks.compact_local(&[first, neighbor, last])
    ))
    .is_err());
    assert_eq!(chunks.byte_size(), 3 * PER);
    assert_eq!(chunks.resident_extent_count(), 0);
    assert!(chunks.dirty_extents().is_empty());
    assert!(
        !chunks.can_allocate(0),
        "failed GC did not publish new holes"
    );
    *source.fail.borrow_mut() = None;
    assert_eq!(chunks.raw_vec(), plain.raw_vec());
    let remap = chunks.compact_local(&[first, neighbor, last]);
    assert_eq!(remap[&first], ChunkOffset(4));
    assert_eq!(remap[&last], ChunkOffset((2 * PER + 4) as u32));
    assert_eq!(chunks.dirty_extents(), vec![0, 2]);
    assert_eq!(chunks.byte_size(), 5 * PER / 2);
    assert!(chunks.can_allocate(PER / 2 - 4));
}

#[test]
fn no_op_large_block_reads_only_its_header_and_invalid_roots_fail_atomically() {
    let mut plain = ChunkArena::new();
    let live = block(&mut plain, 3 * PER, 0);
    let (mut chunks, source) = lazy(&plain);
    assert!(chunks.compact_local(&[live]).is_empty());
    assert_eq!(&*source.reads.borrow(), &[0]);
    assert_eq!(chunks.resident_extent_count(), 0);
    for invalid in [
        ChunkOffset(0),
        ChunkOffset(8),
        ChunkOffset((3 * PER + 4) as u32),
    ] {
        assert!(catch_unwind(AssertUnwindSafe(|| chunks.compact_local(&[live, invalid]))).is_err());
        assert!(chunks.dirty_extents().is_empty());
        assert_eq!(chunks.resident_extent_count(), 0);
        assert_eq!(chunks.byte_size(), 3 * PER);
    }
    chunks.compact_local(&[]);
    assert_eq!(chunks.byte_size(), 0);
    assert_eq!(chunks.resident_extent_count(), 0);
    assert_eq!(chunks.alloc(&[]), ChunkOffset(4));
}

#[test]
fn repeated_collection_and_reuse_match_a_payload_model_and_restored_allocators() {
    let mut chunks = ChunkArena::new();
    let mut live: Vec<(ChunkOffset, Vec<u8>)> = Vec::new();
    // A fixed-width PRNG seed makes the operation sequence portable.
    let mut seed = 0x853c_49e6u32;
    for round in 0..16 {
        for _ in 0..24 {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let size = match seed % 7 {
                0 => 0,
                1 => (seed % 8) as usize,
                2 => PER + 13,
                3 => PER / 2 - 4,
                _ => (seed % 1100) as usize,
            };
            let payload: Vec<_> = (0..size)
                .map(|i| (i as u8).wrapping_add(seed as u8))
                .collect();
            live.push((chunks.alloc(&payload), payload));
        }
        live = live
            .into_iter()
            .enumerate()
            .filter(|(i, _)| i % 3 != round % 3)
            .map(|(_, item)| item)
            .collect();
        let (mut cold, _) = lazy(&chunks);
        let offsets: Vec<_> = live.iter().map(|(off, _)| *off).collect();
        let expected_remap = chunks.compact_local(&offsets);
        let remap = cold.compact_local(&offsets);
        assert_eq!(remap, expected_remap);
        for (&old, &new) in &remap {
            assert_ne!(old, new);
            assert!(offsets.contains(&old));
            // Complete allocated blocks move only within their source extent.
            assert_eq!((old.0 as usize - 4) / PER, (new.0 as usize - 4) / PER);
        }
        for (off, payload) in &mut live {
            if let Some(&new) = remap.get(off) {
                *off = new;
            }
            assert_eq!(&*chunks.payload(*off), payload);
            assert_eq!(&*cold.payload(*off), payload);
        }
        assert_eq!(cold.raw_vec(), chunks.raw_vec());
        let mut restored = ChunkArena::from_image(chunks.raw_vec());
        for size in [0, 3, 17, PER / 3] {
            let payload = vec![round as u8; size];
            let off = chunks.alloc(&payload);
            assert_eq!(cold.alloc(&payload), off);
            assert_eq!(restored.alloc(&payload), off);
            live.push((off, payload));
        }
        assert_eq!(restored.raw_vec(), chunks.raw_vec());
        assert_eq!(cold.raw_vec(), chunks.raw_vec());
    }
}

#[test]
fn dead_crossing_blocks_become_reusable_without_relocating_their_neighbors() {
    let mut plain = ChunkArena::new();
    let prefix = block(&mut plain, PER - 6, 1);
    block(&mut plain, PER + 20, 2);
    let suffix = block(&mut plain, PER - 14, 3);
    let (mut chunks, _) = lazy(&plain);
    assert!(chunks.compact_local(&[prefix, suffix]).is_empty());
    assert_eq!(
        chunks.dirty_extents(),
        vec![0, 1],
        "the free marker straddles the boundary"
    );
    assert_eq!(chunks.resident_extent_count(), 2);
    assert_eq!(chunks.byte_size(), 3 * PER);
    chunks.set_ceiling(3 * PER);
    assert!(chunks.can_allocate(PER + 16));
    assert_eq!(chunks.resident_extent_count(), 2);
    let mut restored = ChunkArena::from_image(chunks.raw_vec());
    let payload = vec![4; PER + 16];
    let reused = chunks.alloc(&payload);
    assert_eq!(reused, ChunkOffset((PER - 2) as u32));
    assert_eq!(restored.alloc(&payload), reused);
    assert_eq!(restored.raw_vec(), chunks.raw_vec());
    assert_eq!(&*chunks.payload(prefix), vec![1; PER - 10]);
    assert_eq!(&*chunks.payload(suffix), vec![3; PER - 18]);
}

#[test]
fn local_collection_preserves_unbacked_bytes_and_appends_before_checkpoint() {
    let mut plain = ChunkArena::new();
    let first = block(&mut plain, PER, 1);
    block(&mut plain, PER, 2);
    let third = block(&mut plain, PER, 3);
    let (mut chunks, source) = lazy(&plain);
    chunks.slice_mut(first, 1)[0] = 9;
    chunks.clear_dirty_after_commit(false);
    assert!(
        !chunks.evict_extent(0),
        "the original source lacks the mutation"
    );
    assert!(chunks.compact_local(&[first, third]).is_empty());
    assert_eq!(chunks.dirty_extents(), vec![1]);
    assert!(!chunks.evict_extent(0));
    assert!(!chunks.evict_extent(1));
    let payload = vec![7; PER + 5];
    let appended = chunks.alloc(&payload); // Larger than the interior hole.
    assert_eq!(appended, ChunkOffset((3 * PER + 4) as u32));
    assert!(chunks.compact_local(&[first, third, appended]).is_empty());
    assert_eq!(chunks.dirty_extents(), vec![1, 3, 4]);
    chunks.clear_dirty_after_commit(false);
    assert!(chunks.compact_local(&[first, third, appended]).is_empty());
    assert!(chunks.dirty_extents().is_empty());
    for ext in [0, 1, 3, 4] {
        assert!(!chunks.evict_extent(ext));
    }
    assert_eq!(
        source.bytes.borrow().len(),
        3 * PER,
        "the backing is still the original checkpoint"
    );
    assert_eq!(source.bytes.borrow()[first.0 as usize], 1);
    assert_eq!(chunks.payload(first)[0], 9);
    assert_eq!(&*chunks.payload(third), vec![3; PER - 4]);
    assert_eq!(&*chunks.payload(appended), payload);
}
