//! Restore refuses corrupt chunk coordinates; interrupted GC cannot checkpoint.
use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::rc::Rc;

use ironhorse_snapshot::image::write_machine_unchecked;
use ironhorse_snapshot::machine::{
    from_snapshot_bytes, resume_from_store, resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::store::{image_to_batch_unchecked, HeapStoreCommit, MemoryStore};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{ChunkArena, Interp, SlotArena};

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

#[test]
fn a_failed_collection_cannot_be_published_even_after_another_run() {
    let sig = Signature::new("gc-failed-checkpoint");
    let mut machine = Interp::new();
    let mut image = machine.snapshot_image_for_testing(&sig).unwrap();
    // The low-level arena installer deliberately bypasses the image gate.
    // Model corruption discovered by GC after slots may already be swept.
    image.chunks[..4].copy_from_slice(&(u32::MAX - 1).to_le_bytes());
    machine.restore_snapshot_state(
        SlotArena::from_image(image.slots, image.slot_free, image.slot_live),
        ChunkArena::from_image(image.chunks),
        image.stack,
        image.names,
        image.meter.to_state(),
    );
    assert!(machine.is_quiescent());
    assert!(catch_unwind(AssertUnwindSafe(|| machine.collect_garbage())).is_err());
    assert!(machine.write_snapshot(&sig).is_err());
    let outcome = machine.run(&[ironhorse_vm::Opcode::XS_CODE_RETURN as u8]);
    assert!(!outcome.completed);
    assert!(machine.write_snapshot(&sig).is_err());
}
