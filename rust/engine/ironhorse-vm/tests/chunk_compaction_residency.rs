//! Compaction retains lazy backing and only materializes changed extents.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use ironhorse_vm::value::{PageSource, CHUNK_EXTENT_BYTES};
use ironhorse_vm::{ChunkArena, ChunkOffset, Slot};

struct Source {
    bytes: RefCell<Vec<u8>>,
    reads: Cell<usize>,
}
impl PageSource for Source {
    fn slot_page(&self, _: u32) -> Vec<Slot> {
        panic!("chunk-only test")
    }
    fn chunk_extent(&self, ext: u32) -> Vec<u8> {
        self.reads.set(self.reads.get() + 1);
        let bytes = self.bytes.borrow();
        let start = ext as usize * CHUNK_EXTENT_BYTES as usize;
        bytes[start..bytes.len().min(start + CHUNK_EXTENT_BYTES as usize)].to_vec()
    }
}
fn fixture() -> (ChunkArena, Rc<Source>, Vec<ChunkOffset>) {
    let mut plain = ChunkArena::new();
    let offsets = (1..=4)
        .map(|value| plain.alloc(&vec![value; CHUNK_EXTENT_BYTES as usize - 4]))
        .collect();
    let source = Rc::new(Source {
        bytes: RefCell::new(plain.raw_vec()),
        reads: Cell::new(0),
    });
    let lazy = ChunkArena::lazy_from_parts(plain.byte_size(), source.clone());
    (lazy, source, offsets)
}

#[test]
fn no_op_compaction_reads_only_the_header_extent_of_a_large_live_block() {
    let mut plain = ChunkArena::new();
    let live = plain.alloc(&vec![7; 3 * CHUNK_EXTENT_BYTES as usize]);
    let source = Rc::new(Source {
        bytes: RefCell::new(plain.raw_vec()),
        reads: Cell::new(0),
    });
    let mut chunks = ChunkArena::lazy_from_parts(plain.byte_size(), source.clone());
    assert_eq!(chunks.compact(&[live])[&live], live);
    assert_eq!(source.reads.get(), 1);
    assert_eq!(chunks.resident_extent_count(), 0);
    assert!(chunks.dirty_extents().is_empty());
}

#[test]
fn append_and_repeat_compaction_before_advancing_backing() {
    let (mut chunks, source, offsets) = fixture();
    let remap = chunks.compact(&[offsets[0], offsets[2]]);
    let kept = remap[&offsets[2]];
    let payload = vec![9; CHUNK_EXTENT_BYTES as usize + 13];
    let appended = chunks.alloc(&payload);
    // The backing still contains the original four blocks, including bytes at
    // both the relocated block and the locally appended tail's destinations.
    let remap = chunks.compact(&[kept, appended]);
    assert_eq!(remap[&kept], ChunkOffset(4));
    assert_eq!(remap[&appended], ChunkOffset(CHUNK_EXTENT_BYTES + 4));
    assert_eq!(chunks.dirty_extents(), vec![0, 1, 2]);
    for ext in 0..3 {
        assert!(!chunks.evict_extent(ext));
    }
    let packed = chunks.raw_vec();
    assert_eq!(
        &*chunks.payload(remap[&kept]),
        &vec![3; CHUNK_EXTENT_BYTES as usize - 4]
    );
    assert_eq!(&*chunks.payload(remap[&appended]), &payload);
    *source.bytes.borrow_mut() = packed.clone();
    chunks.advance_backing();
    chunks.clear_dirty_after_commit(true);
    for ext in 0..3 {
        assert!(chunks.evict_extent(ext));
    }
    assert_eq!(chunks.resident_extent_count(), 0);
    assert_eq!(chunks.raw_vec(), packed);
}

#[test]
fn already_compact_and_tail_only_collections_keep_cold_extents_cold() {
    let (mut chunks, source, offsets) = fixture();
    let remap = chunks.compact(&offsets);
    for offset in &offsets {
        assert_eq!(remap[offset], *offset);
    }
    assert_eq!(chunks.resident_extent_count(), 0);
    assert!(chunks.dirty_extents().is_empty());
    assert!(
        source.reads.get() > 0,
        "headers are validated against the backing"
    );

    chunks.compact(&offsets[..3]);
    assert_eq!(chunks.byte_size(), 3 * CHUNK_EXTENT_BYTES as usize);
    assert_eq!(chunks.resident_extent_count(), 0);
    assert!(chunks.dirty_extents().is_empty());
    assert_eq!(
        &*chunks.payload(offsets[2]),
        &vec![3; CHUNK_EXTENT_BYTES as usize - 4]
    );
    assert_eq!(chunks.resident_extent_count(), 1);
    assert!(
        chunks.evict_extent(2),
        "unchanged bytes still have valid backing"
    );
}

#[test]
fn moved_extents_remain_unbacked_until_their_own_checkpoint() {
    let (mut chunks, source, offsets) = fixture();
    let live = [offsets[0], offsets[2], offsets[3]];
    let remap = chunks.compact(&live);
    assert_eq!(chunks.resident_extent_count(), 2);
    assert_eq!(chunks.dirty_extents(), vec![1, 2]);
    assert!(!chunks.evict_extent(1));
    chunks.clear_dirty(); // A commit into a different store is insufficient.
    assert!(!chunks.evict_extent(1));
    assert!(!chunks.evict_extent(2));
    for (offset, value) in [(offsets[0], 1), (offsets[2], 3), (offsets[3], 4)] {
        assert_eq!(
            &*chunks.payload(remap[&offset]),
            &vec![value; CHUNK_EXTENT_BYTES as usize - 4]
        );
    }
    // Dirty the unbacked extents again to model the next own-store checkpoint.
    chunks.slice_mut(remap[&offsets[2]], 1)[0] = 3;
    chunks.slice_mut(remap[&offsets[3]], 1)[0] = 4;
    *source.bytes.borrow_mut() = chunks.raw_vec();
    chunks.advance_backing();
    chunks.clear_dirty_after_commit(true);
    assert!(chunks.evict_extent(1));
    assert!(chunks.evict_extent(2));
    assert_eq!(
        &*chunks.payload(remap[&offsets[3]]),
        &vec![4; CHUNK_EXTENT_BYTES as usize - 4]
    );
}

#[test]
fn compaction_preserves_preexisting_unbacked_bytes_even_when_unchanged() {
    let (mut chunks, _, offsets) = fixture();
    chunks.slice_mut(offsets[0], 1)[0] = 99;
    chunks.clear_dirty();
    chunks.compact(&offsets[..3]);
    assert!(chunks.dirty_extents().is_empty());
    assert_eq!(chunks.resident_extent_count(), 1);
    assert!(!chunks.evict_extent(0));
    assert_eq!(chunks.payload(offsets[0])[0], 99);
}

#[test]
fn shrinking_partial_tail_cannot_refault_old_longer_source_bytes() {
    let mut plain = ChunkArena::new();
    let live = plain.alloc(b"live");
    plain.alloc(b"dead trailing payload");
    let source = Rc::new(Source {
        bytes: RefCell::new(plain.raw_vec()),
        reads: Cell::new(0),
    });
    let mut chunks = ChunkArena::lazy_from_parts(plain.byte_size(), source.clone());
    chunks.compact(&[live]);
    assert_eq!(chunks.dirty_extents(), vec![0]);
    assert!(!chunks.evict_extent(0));
    assert_eq!(&*chunks.payload(live), b"live");
    *source.bytes.borrow_mut() = chunks.raw_vec();
    chunks.advance_backing();
    chunks.clear_dirty_after_commit(true);
    assert!(chunks.evict_extent(0));
    assert_eq!(&*chunks.payload(live), b"live");
}

#[test]
fn payload_read_failure_during_relocation_leaves_the_arena_intact() {
    struct FailingSource {
        source: Rc<Source>,
        fail: Cell<bool>,
    }
    impl PageSource for FailingSource {
        fn slot_page(&self, _: u32) -> Vec<Slot> {
            panic!("chunk-only test")
        }
        fn chunk_extent(&self, ext: u32) -> Vec<u8> {
            assert!(
                !(ext == 1 && self.fail.get()),
                "injected payload read failure"
            );
            self.source.chunk_extent(ext)
        }
    }
    let mut original = ChunkArena::new();
    original.alloc(b"dead");
    // Both headers are in extent zero. Extent one is only read when copying
    // payload bytes, after validation and allocation of the new output.
    let live = original.alloc(&vec![7; 3 * CHUNK_EXTENT_BYTES as usize]);
    let bytes = original.raw_vec();
    let source = Rc::new(FailingSource {
        source: Rc::new(Source {
            bytes: RefCell::new(bytes.clone()),
            reads: Cell::new(0),
        }),
        fail: Cell::new(true),
    });
    let mut chunks = ChunkArena::lazy_from_parts(bytes.len(), source.clone());
    let error = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| chunks.compact(&[live])));
    let error = error.expect_err("payload fetch must fail");
    assert!(
        error
            .downcast_ref::<String>()
            .is_some_and(|s| s.contains("injected payload read failure"))
            || error
                .downcast_ref::<&str>()
                .is_some_and(|s| s.contains("injected payload read failure"))
    );
    assert_eq!(chunks.byte_size(), bytes.len());
    assert_eq!(chunks.resident_extent_count(), 0);
    assert!(chunks.dirty_extents().is_empty());
    source.fail.set(false);
    assert_eq!(chunks.raw_vec(), bytes);
}

#[test]
fn repeated_cross_extent_compactions_match_packed_model_and_checkpoint_twins() {
    let mut plain = ChunkArena::new();
    let per = CHUNK_EXTENT_BYTES as usize;
    let mut records: Vec<_> = [0, per - 5, 3, per + 7, 17, 2 * per, 0]
        .into_iter()
        .enumerate()
        .map(|(i, length)| {
            let payload = vec![i as u8; length];
            (plain.alloc(&payload), payload)
        })
        .collect();
    let source = Rc::new(Source {
        bytes: RefCell::new(plain.raw_vec()),
        reads: Cell::new(0),
    });
    let mut lazy = ChunkArena::lazy_from_parts(plain.byte_size(), source.clone());
    plain.clear_dirty();
    for round in 0..8 {
        // Include one mutation and a new local tail before each collection.
        if let Some((offset, bytes)) = records.iter_mut().find(|(_, bytes)| !bytes.is_empty()) {
            bytes[0] ^= 0x5a;
            plain.slice_mut(*offset, 1)[0] = bytes[0];
            lazy.slice_mut(*offset, 1)[0] = bytes[0];
        }
        let bytes = vec![round; per / 2 + usize::from(round)];
        let offset = plain.alloc(&bytes);
        assert_eq!(lazy.alloc(&bytes), offset);
        records.push((offset, bytes));
        records = records
            .into_iter()
            .enumerate()
            .filter(|(i, _)| (i + usize::from(round)) % 3 != 0)
            .map(|(_, record)| record)
            .collect();
        let mut live: Vec<_> = records.iter().map(|(offset, _)| *offset).rev().collect();
        if let Some(offset) = live.first().copied() {
            live.push(offset);
        }
        live.push(ChunkOffset::NULL);
        let expected_remap = plain.compact(&live);
        let remap = lazy.compact(&live);
        assert_eq!(remap, expected_remap);
        assert_eq!(lazy.dirty_extents(), plain.dirty_extents());
        let mut packed_len = 0;
        for (offset, payload) in &mut records {
            packed_len += 4;
            let next = ChunkOffset(packed_len as u32);
            assert_eq!(remap[offset], next);
            assert_eq!(&*lazy.payload(next), payload);
            packed_len += payload.len();
            *offset = next;
        }
        assert_eq!(lazy.byte_size(), packed_len);
        assert_eq!(lazy.raw_vec(), plain.raw_vec());
        *source.bytes.borrow_mut() = plain.raw_vec();
        lazy.advance_backing();
        lazy.clear_dirty_after_commit(true);
        plain.clear_dirty();
        for ext in 0..packed_len.div_ceil(per) as u32 {
            assert!(lazy.evict_extent(ext));
        }
        assert_eq!(lazy.resident_extent_count(), 0);
    }
}
