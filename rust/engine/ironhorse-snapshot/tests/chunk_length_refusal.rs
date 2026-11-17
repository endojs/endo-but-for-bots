//! A manifest's `chunk_len` past the u32 chunk offset space is refused
//! before any reader narrows it to `usize`, alike on every target.
//!
//! Narrowed on a 32-bit host, `2^32 + 65536` reads as 65,536: a 64-bit
//! machine resuming the store would halt at every chunk allocation while a
//! wasm32 one resumed with a 64 KiB arena. This file stays free of compiler
//! dev-dependencies so `rust/engine/scripts/test-snapshot-wasi.py` can run it
//! on 32-bit WASI.
use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{begin_store_session, resume_from_store, resume_from_store_lazy};
use ironhorse_snapshot::store::{
    validate_store, CommitVerifier, HeapStore, MemoryStore, StoreError, StoreManifest,
};
use ironhorse_snapshot::{Signature, SnapshotError, CHUNK_EXTENT_BYTES};
use ironhorse_vm::{Interp, Opcode};

/// The audit's crafted length: a wasm32 `usize` truncates it to 65,536.
const CRAFTED_CHUNK_LEN: u64 = (1 << 32) + 65536;

const REFUSAL: StoreError = StoreError::Snapshot(SnapshotError::Corrupt(
    "store manifest chunk length exceeds the chunk offset space",
));

fn sig() -> Signature {
    Signature::new("chunk-length-refusal")
}

fn honest_store() -> MemoryStore {
    let mut machine = Interp::new();
    assert!(
        machine
            .run(&[
                Opcode::XS_CODE_OBJECT as u8,
                Opcode::XS_CODE_POP as u8,
                Opcode::XS_CODE_RETURN as u8,
            ])
            .completed
    );
    let mut store = MemoryStore::new();
    drop(
        begin_store_session(machine, &sig(), &mut store)
            .map_err(|(_, e)| e)
            .expect("the honest machine persists"),
    );
    store
}

/// A store that hands back a manifest it never encoded, as a host-imported
/// store may, with `chunk_len` replaced, and a chunk extent of the claimed
/// tail length so the tail-row check alone does not refuse it.
struct CraftedManifest {
    honest: MemoryStore,
    chunk_len: u64,
}

impl CraftedManifest {
    fn tail_extent(&self) -> u32 {
        u32::try_from(self.chunk_len.div_ceil(u64::from(CHUNK_EXTENT_BYTES)) - 1).unwrap()
    }
}

impl HeapStore for CraftedManifest {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        Ok(StoreManifest {
            chunk_len: self.chunk_len,
            ..self.honest.manifest()?
        })
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.honest.read_small_state()
    }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.honest.read_slot_page(page)
    }
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        let honest_len = self.honest.manifest()?.chunk_len;
        if self.chunk_len != honest_len && ext == self.tail_extent() {
            let per = u64::from(CHUNK_EXTENT_BYTES);
            let tail = self.chunk_len - u64::from(ext) * per;
            return Ok(vec![0; usize::try_from(tail).unwrap()]);
        }
        self.honest.read_chunk_extent(ext)
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        self.honest.inventory()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.honest.read_free_seg(seg)
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.honest.page_edges()
    }
    fn commit_verified(&mut self, _verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        panic!("the crafted store is read-only")
    }
}

#[test]
fn an_encoded_manifest_past_the_chunk_offset_space_is_refused_at_decode() {
    let manifest = StoreManifest {
        chunk_len: CRAFTED_CHUNK_LEN,
        ..honest_store().manifest().unwrap()
    };
    assert_eq!(StoreManifest::decode(&manifest.encode()), Err(REFUSAL));
}

#[test]
fn a_store_manifest_past_the_chunk_offset_space_is_refused_at_open() {
    let honest = honest_store();
    // The control: the same wrapper over the honest length opens.
    let chunk_len = honest.manifest().unwrap().chunk_len;
    let control = CraftedManifest { honest, chunk_len };
    validate_store(&control, &sig()).expect("the honest length validates");
    resume_from_store(&control, &sig()).expect("the honest length resumes");

    let crafted = CraftedManifest {
        honest: control.honest,
        chunk_len: CRAFTED_CHUNK_LEN,
    };
    assert_eq!(crafted.tail_extent(), 65536);
    assert_eq!(validate_store(&crafted, &sig()).err(), Some(REFUSAL));
    assert_eq!(resume_from_store(&crafted, &sig()).err(), Some(REFUSAL));
    let shared = Rc::new(RefCell::new(crafted));
    assert_eq!(resume_from_store_lazy(shared, &sig()).err(), Some(REFUSAL));
}
