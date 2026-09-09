//! Persistence identities must describe the bytes and allocation they name.
mod common;

use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{
    from_snapshot_bytes, resume_from_cas, resume_from_store, resume_from_store_lazy,
    MachineSnapshot, MachineSnapshotError,
};
use ironhorse_snapshot::store::HeapStoreCommit;
use ironhorse_snapshot::store::{image_to_batch_unchecked, store_to_image, MemoryStore};
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_vm::Interp;
use std::cell::RefCell;
use std::rc::Rc;

fn signature() -> Signature {
    Signature::new("persistence-identity-v1")
}

fn ran(source: &str) -> Interp {
    let mut machine = Interp::new();
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    machine.link_intrinsics(&ironhorse_vm::parse_symbols(&symbols));
    assert!(machine.run(&code).completed);
    machine
}

#[test]
fn sealed_buffer_length_cannot_cross_or_shorten_its_allocation() {
    let machine = ran("var b = new ArrayBuffer(8); var adjacent = 'neighbor'; b.byteLength");
    let image = machine.snapshot_image_for_testing(&signature()).unwrap();
    for length in [7, 9] {
        let mut forged = image.clone();
        forged.buffers[0].length = length;
        let bytes = write_machine_unchecked(&forged);
        assert!(matches!(
            read_machine(&bytes, &signature()),
            Err(SnapshotError::Corrupt(
                "buffer length disagrees with chunk header"
            ))
        ));
        assert!(from_snapshot_bytes(&bytes, &signature()).is_err());
        let mut store = MemoryStore::new();
        store
            .commit(&image_to_batch_unchecked(&forged, 1, ""))
            .unwrap();
        assert!(store_to_image(&store).is_err());
        assert!(resume_from_store(&store, &signature()).is_err());
        assert!(resume_from_store_lazy(Rc::new(RefCell::new(store)), &signature()).is_err());
    }
}

#[test]
fn vm_restore_checks_buffer_header_and_mutable_slices_stop_at_block_end() {
    let machine = ran("var b = new ArrayBuffer(8); b.byteLength");
    let image = machine.snapshot_image_for_testing(&signature()).unwrap();
    let buffer = &image.buffers[0];
    for length in [7, 9] {
        let (slots, chunks) = image.to_arenas();
        let mut restored = Interp::new();
        restored.restore_snapshot_state(slots, chunks, vec![], vec![], image.meter.to_state());
        assert!(!restored.restore_typed_array_family(
            vec![(buffer.owner, buffer.data, length, 0)],
            vec![],
            vec![]
        ));
    }
    let (_, mut chunks) = image.to_arenas();
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        chunks.slice_mut(ironhorse_vm::ChunkOffset(buffer.data), 9);
    }))
    .is_err());
}

#[test]
fn cas_refuses_another_valid_snapshot_under_the_requested_digest() {
    let dir = common::TempDir::new("cas-wrong-identity");
    let first = ran("var x = 1; x");
    let hash = first.suspend_to_cas(&signature(), &dir).unwrap();
    let second = ran("var x = 2; x");
    std::fs::write(
        dir.join(&hash),
        second.write_snapshot(&signature()).unwrap(),
    )
    .unwrap();
    assert!(matches!(
        resume_from_cas(&dir, &hash, &signature()),
        Err(MachineSnapshotError::Snapshot(SnapshotError::Corrupt(
            "CAS content digest mismatch"
        )))
    ));
    for invalid in ["../outside", "abc", &"A".repeat(64)] {
        assert!(matches!(
            resume_from_cas(&dir, invalid, &signature()),
            Err(MachineSnapshotError::Snapshot(SnapshotError::Corrupt(
                "CAS digest is not canonical SHA-256"
            )))
        ));
    }
}

#[test]
fn concurrent_cas_publishers_keep_their_own_bytes() {
    let dir = common::TempDir::new("cas-concurrent-identity");
    let barrier = std::sync::Barrier::new(8);
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|n| {
                let dir = &dir;
                let barrier = &barrier;
                scope.spawn(move || {
                    let machine = ran(&format!("var n = {n}; n"));
                    let bytes = machine.write_snapshot(&signature()).unwrap();
                    barrier.wait();
                    let hash = machine.suspend_to_cas(&signature(), dir).unwrap();
                    assert_eq!(std::fs::read(dir.join(&hash)).unwrap(), bytes);
                    resume_from_cas(dir, &hash, &signature()).unwrap();
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
    });
    assert!(std::fs::read_dir(&*dir).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));
}

#[test]
fn refused_cas_publication_removes_its_temporary() {
    let dir = common::TempDir::new("cas-refused-cleanup");
    let mut machine = ran("1");
    assert!(!machine.run(&[255]).completed);
    assert!(machine.suspend_to_cas(&signature(), &dir).is_err());
    assert_eq!(std::fs::read_dir(&*dir).unwrap().count(), 0);
}

#[test]
fn detached_buffer_keeps_backing_allocation_but_exposes_zero_length() {
    let machine = ran("var b = new ArrayBuffer(8); var c = b.transfer(); b.byteLength");
    let image = machine.snapshot_image_for_testing(&signature()).unwrap();
    let detached = image.buffers.iter().find(|b| b.flags & 1 != 0).unwrap();
    assert_eq!(detached.length, 0);
    let start = detached.data as usize;
    assert_eq!(
        u32::from_le_bytes(image.chunks[start - 4..start].try_into().unwrap()),
        8
    );
    let bytes = write_machine_unchecked(&image);
    let resumed = from_snapshot_bytes(&bytes, &signature()).unwrap();
    assert_eq!(
        resumed
            .snapshot_image_for_testing(&signature())
            .unwrap()
            .buffers,
        image.buffers
    );
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch_unchecked(&image, 1, ""))
        .unwrap();
    let lazy = resume_from_store_lazy(Rc::new(RefCell::new(store)), &signature()).unwrap();
    assert_eq!(
        lazy.machine()
            .snapshot_image_for_testing(&signature())
            .unwrap()
            .buffers,
        image.buffers
    );
}

#[test]
fn first_relink_establishes_current_layout_before_suspension() {
    let mut machine = Interp::new();
    for source in [
        "var b = new ArrayBuffer(8); var c = b.transfer(); b.byteLength",
        "delete Array.prototype.join; var a = [1]; a.length",
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let code = machine
            .relink_crank(&code, &ironhorse_vm::parse_symbols(&symbols))
            .unwrap();
        assert!(machine.run(&code).completed);
        let before = machine.write_snapshot(&signature()).unwrap();
        let resumed = from_snapshot_bytes(&before, &signature()).unwrap();
        assert_eq!(resumed.write_snapshot(&signature()).unwrap(), before);
        machine = resumed;
    }
}

#[test]
fn first_relink_preserves_tagged_template_cache_ids_across_cranks() {
    let mut machine = Interp::new();
    for source in [
        "var saved; function tag(a) { if (saved === undefined) saved = a; return saved === a; } function f() { return tag`hello`; } f()",
        "f()",
    ] {
        let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
        let code = machine.relink_crank(&code, &ironhorse_vm::parse_symbols(&symbols)).unwrap();
        let outcome = machine.run(&code);
        assert!(outcome.completed, "{:?}", outcome.halt);
        assert_eq!(outcome.result, "true");
        let bytes = machine.write_snapshot(&signature()).unwrap();
        machine = from_snapshot_bytes(&bytes, &signature()).unwrap();
        assert_eq!(machine.write_snapshot(&signature()).unwrap(), bytes);
    }
}

#[test]
fn normal_writers_accept_live_and_decoded_proofs() {
    let machine = ran("var x = 1; x");
    let proof = machine.snapshot_image(&signature()).unwrap();
    let bytes = ironhorse_snapshot::write_machine(&proof).unwrap();
    let decoded = ironhorse_snapshot::read_validated_machine(&bytes, &signature())
        .unwrap()
        .into_gated();
    assert_eq!(ironhorse_snapshot::write_machine(&decoded).unwrap(), bytes);
    let mut store = MemoryStore::new();
    store
        .commit(&ironhorse_snapshot::image_to_batch(&proof, 1, ""))
        .unwrap();
    assert_eq!(
        ironhorse_snapshot::store::export_to_container(&store).unwrap(),
        bytes
    );
}

#[test]
fn store_export_cannot_mint_proof_for_unregistered_property_keys() {
    let machine = ran("var x = 1; x");
    let mut image = machine.snapshot_image_for_testing(&signature()).unwrap();
    let slot = image.slots.iter_mut().find(|slot| slot.id != 0).unwrap();
    slot.id = 60000;
    assert_eq!(image.stored_unregistered_key_id(), Some(60000));
    let mut store = MemoryStore::new();
    store
        .commit(&image_to_batch_unchecked(&image, 1, ""))
        .unwrap();
    assert!(matches!(
        ironhorse_snapshot::store::export_to_container(&store),
        Err(ironhorse_snapshot::StoreError::Snapshot(
            SnapshotError::Corrupt("stored property id outside the name and symbol-key tables")
        ))
    ));
}
