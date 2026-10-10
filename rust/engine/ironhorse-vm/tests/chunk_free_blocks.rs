//! Format-17 reusable blocks carry all allocator state in the chunk bytes.
use std::cell::{Cell, RefCell};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use ironhorse_vm::value::{PageSource, CHUNK_EXTENT_BYTES};
use ironhorse_vm::{ChunkArena, ChunkOffset, Slot};

fn hole(span: usize) -> Vec<u8> {
    assert!(span >= 8);
    let mut bytes = vec![0xa5; span];
    bytes[..4].copy_from_slice(&u32::MAX.to_le_bytes());
    bytes[4..8].copy_from_slice(&u32::try_from(span).unwrap().to_le_bytes());
    bytes
}

struct Source {
    bytes: RefCell<Vec<u8>>,
    reads: Cell<usize>,
    fail_at: Cell<Option<u32>>,
}
impl PageSource for Source {
    fn slot_page(&self, _: u32) -> Vec<Slot> {
        panic!("chunk-only fixture")
    }
    fn chunk_extent(&self, ext: u32) -> Vec<u8> {
        assert_ne!(self.fail_at.get(), Some(ext), "injected source failure");
        self.reads.set(self.reads.get() + 1);
        let bytes = self.bytes.borrow();
        let start = ext as usize * CHUNK_EXTENT_BYTES as usize;
        bytes[start..bytes.len().min(start + CHUNK_EXTENT_BYTES as usize)].to_vec()
    }
}
fn lazy(bytes: Vec<u8>) -> (ChunkArena, Rc<Source>) {
    let source = Rc::new(Source {
        bytes: RefCell::new(bytes),
        reads: Cell::new(0),
        fail_at: Cell::new(None),
    });
    let chunks = ChunkArena::lazy_from_parts(source.bytes.borrow().len(), source.clone());
    (chunks, source)
}

#[test]
fn splits_preserve_the_chain_and_allocation_choices_across_restore() {
    for rest in 0..=16 {
        let mut chunks = ChunkArena::from_image(hole(32));
        let payload = vec![9; 28 - rest];
        let first = chunks.alloc(&payload);
        if (1..=3).contains(&rest) {
            assert_eq!(first, ChunkOffset(36), "unsplittable remainder {rest}");
        } else {
            assert_eq!(first, ChunkOffset(4), "remainder {rest}");
            assert_eq!(chunks.byte_size(), 32);
        }
        assert_eq!(&*chunks.payload(first), payload);
        // Reset the index through both restore paths after the split. Ordinary
        // 4–7 byte remnants must not appear in only the uninterrupted index.
        let bytes = chunks.raw_vec();
        let mut eager = ChunkArena::from_image(bytes.clone());
        let (mut resumed, _) = lazy(bytes);
        let mut live = vec![first];
        for size in [0, 1, 4, 7, 16] {
            let payload = vec![size as u8; size];
            let off = chunks.alloc(&payload);
            assert_eq!(eager.alloc(&payload), off, "eager remainder {rest}");
            assert_eq!(resumed.alloc(&payload), off, "lazy remainder {rest}");
            live.push(off);
            assert_eq!(eager.raw_vec(), chunks.raw_vec());
            assert_eq!(resumed.raw_vec(), chunks.raw_vec());
        }
        // Walking/removing free markers and tiny ordinary remnants leaves
        // every allocated payload intact, including zero-length allocations.
        let expected: Vec<_> = live
            .iter()
            .map(|&off| chunks.payload(off).to_vec())
            .collect();
        let remap = chunks.compact(&live);
        for (off, payload) in live.into_iter().zip(expected) {
            assert_eq!(&*chunks.payload(*remap.get(&off).unwrap_or(&off)), payload);
        }
    }
}

#[test]
fn best_fit_then_address_order_reuses_space_at_the_ceiling() {
    let bytes: Vec<_> = [24, 16, 16].into_iter().flat_map(hole).collect();
    let mut chunks = ChunkArena::from_image(bytes);
    chunks.set_ceiling(56);
    assert!(chunks.can_allocate(12));
    assert_eq!(chunks.alloc(&[1; 12]), ChunkOffset(28));
    assert_eq!(chunks.alloc(&[2; 12]), ChunkOffset(44));
    assert_eq!(chunks.alloc(&[3; 20]), ChunkOffset(4));
    assert!(!chunks.can_allocate(0));
    assert_eq!(chunks.byte_size(), 56);
}

#[test]
fn free_markers_are_not_payloads_or_live_compaction_roots() {
    for off in [ChunkOffset(4), ChunkOffset(8), ChunkOffset(12)] {
        let mut chunks = ChunkArena::from_image(hole(32));
        let before = chunks.raw_vec();
        assert!(catch_unwind(AssertUnwindSafe(|| chunks.compact(&[off]))).is_err());
        assert_eq!(chunks.raw_vec(), before);
        assert!(chunks.dirty_extents().is_empty());
    }
    let chunks = ChunkArena::from_image(hole(8));
    assert!(catch_unwind(AssertUnwindSafe(|| chunks.len_of(ChunkOffset(4)))).is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| chunks.slice(ChunkOffset(4), 1))).is_err());
}

#[test]
fn failed_reuse_fault_preserves_bytes_index_and_dirt_for_retry() {
    let per = CHUNK_EXTENT_BYTES as usize;
    let bytes = hole(3 * per);
    let (mut chunks, source) = lazy(bytes.clone());
    let data = vec![7; per + 16];
    assert!(chunks.can_allocate(data.len()));
    source.fail_at.set(Some(1));
    assert!(catch_unwind(AssertUnwindSafe(|| chunks.alloc(&data))).is_err());
    assert!(chunks.dirty_extents().is_empty());
    assert_eq!(chunks.byte_size(), bytes.len());
    assert_eq!(
        chunks.resident_extent_count(),
        1,
        "the first successful fault is retained"
    );
    source.fail_at.set(None);
    assert_eq!(chunks.raw_vec(), bytes);
    assert_eq!(
        chunks.alloc(&data),
        ChunkOffset(4),
        "the free index was not consumed"
    );
    assert_eq!(&*chunks.payload(ChunkOffset(4)), data);
    assert_eq!(chunks.dirty_extents(), vec![0, 1]);
}

#[test]
fn malformed_free_chains_do_not_publish_a_partial_index() {
    for bad in [
        u32::MAX.to_le_bytes().to_vec(),
        [u32::MAX.to_le_bytes(), 0u32.to_le_bytes()].concat(),
        [u32::MAX.to_le_bytes(), 7u32.to_le_bytes()].concat(),
        [u32::MAX.to_le_bytes(), 9u32.to_le_bytes()].concat(),
        [u32::MAX.to_le_bytes(), u32::MAX.to_le_bytes()].concat(),
    ] {
        let mut bytes = hole(16);
        bytes.extend_from_slice(&bad);
        let (mut chunks, source) = lazy(bytes.clone());
        // A usable first block must not hide corruption later in the chain.
        for _ in 0..2 {
            assert!(catch_unwind(AssertUnwindSafe(|| chunks.can_allocate(4))).is_err());
            assert_eq!(chunks.resident_extent_count(), 0);
            assert!(chunks.dirty_extents().is_empty());
            assert_eq!(*source.bytes.borrow(), bytes);
        }
        // Repair the same backing without replacing the arena. A failed build
        // cannot leave an index that omits this later, better-fitting block.
        let tail = bad.len();
        let replacement = if tail >= 8 { hole(tail) } else { vec![0; 4] };
        source.bytes.borrow_mut()[16..].copy_from_slice(&replacement);
        assert!(chunks.can_allocate(4));
        assert_eq!(
            chunks.alloc(&[7; 4]),
            ChunkOffset(if tail >= 8 { 20 } else { 4 })
        );
    }
}

#[test]
fn index_rebuild_is_streaming_and_reuse_faults_only_written_extents() {
    let per = CHUNK_EXTENT_BYTES as usize;
    let (mut chunks, source) = lazy(hole(3 * per));
    assert!(chunks.can_allocate(0));
    assert_eq!(source.reads.get(), 1, "only the free header is read");
    assert_eq!(chunks.resident_extent_count(), 0);
    assert!(chunks.can_allocate(0));
    assert_eq!(source.reads.get(), 1, "the complete index is cached");
    assert_eq!(chunks.alloc(&[]), ChunkOffset(4));
    assert_eq!(chunks.dirty_extents(), vec![0]);
    assert_eq!(chunks.resident_extent_count(), 1);
    assert_eq!(chunks.byte_size(), 3 * per);
    assert_eq!(chunks.alloc(&[1; 5]), ChunkOffset(8));
    assert_eq!(chunks.resident_extent_count(), 1);
}

#[test]
fn a_split_header_crossing_an_extent_preserves_both_neighbors() {
    let per = CHUNK_EXTENT_BYTES as usize;
    let mut prefix = ChunkArena::new();
    let first = prefix.alloc(&vec![6; per - 10]);
    let mut bytes = prefix.raw_vec();
    assert_eq!(bytes.len(), per - 6);
    bytes.extend(hole(24));
    let (mut chunks, _) = lazy(bytes);
    // The free header straddles the boundary. Its replacement ordinary header
    // and the new split marker touch both extents, which must both be dirty.
    assert!(chunks.can_allocate(0));
    assert_eq!(chunks.resident_extent_count(), 0);
    assert_eq!(chunks.alloc(&[]), ChunkOffset((per - 2) as u32));
    assert_eq!(chunks.dirty_extents(), vec![0, 1]);
    assert_eq!(chunks.resident_extent_count(), 2);
    assert_eq!(&*chunks.payload(first), vec![6; per - 10]);
    let bytes = chunks.raw_vec();
    let mut resumed = ChunkArena::from_image(bytes);
    assert_eq!(chunks.alloc(&[3; 16]), resumed.alloc(&[3; 16]));
    assert_eq!(chunks.raw_vec(), resumed.raw_vec());
}
