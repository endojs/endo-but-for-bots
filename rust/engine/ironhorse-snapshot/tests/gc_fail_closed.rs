//! Restore refuses corrupt chunk coordinates through every snapshot path.
use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::image::write_machine_unchecked;
use ironhorse_snapshot::machine::{
    from_snapshot_bytes, resume_from_store, resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::store::{image_to_batch_unchecked, HeapStoreCommit, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::Interp;

#[test]
fn native_names_must_reference_complete_allocated_chunks_on_every_restore_path() {
    let sig = Signature::new("gc-fail-closed");
    let image = Interp::new().snapshot_image_for_testing(&sig).unwrap();
    let name: Vec<_> = "revocable"
        .encode_utf16()
        .flat_map(u16::to_be_bytes)
        .collect();
    for damage in ["interior", "free", "truncated"] {
        let mut bad = image.clone();
        let row = bad
            .function_state
            .native_names
            .as_mut()
            .unwrap()
            .iter_mut()
            .find(|(_, offset)| bad.chunks[*offset as usize..].starts_with(&name))
            .unwrap();
        let offset = row.1 as usize;
        if damage == "interior" {
            row.1 += 1;
        } else {
            let length = u32::from_le_bytes(bad.chunks[offset - 4..offset].try_into().unwrap());
            let header = if damage == "free" {
                u32::MAX
            } else {
                u32::MAX - 1
            };
            bad.chunks[offset - 4..offset].copy_from_slice(&header.to_le_bytes());
            if damage == "free" {
                bad.chunks[offset..offset + 4].copy_from_slice(&(length + 4).to_le_bytes());
            }
        }
        let bytes = write_machine_unchecked(&bad);
        assert!(
            from_snapshot_bytes(&bytes, &sig).is_err(),
            "container: {damage}"
        );
        // Authenticate the corrupted image so these checks exercise semantic
        // admission, rather than merely detecting a mismatched content hash.
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&bad, 1, ""))
            .unwrap();
        assert!(resume_from_store(&store, &sig).is_err(), "eager: {damage}");
        assert!(
            resume_from_store_lazy(Rc::new(RefCell::new(store)), &sig).is_err(),
            "lazy: {damage}"
        );
    }
}
