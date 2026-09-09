//! Overflow guards need a 32-bit usize; the wire counts themselves are u32.
#![cfg(target_pointer_width = "32")]
use ironhorse_snapshot::format::{Signature, HEAP, STAC};
use ironhorse_snapshot::image::{
    read_machine, write_machine_unchecked, MachineImage, SymbolKeyImage,
};
use ironhorse_snapshot::{AtomReader, AtomWriter, SnapshotError};
use ironhorse_vm::{ChunkArena, SlotArena};

#[test]
fn wire_record_counts_refuse_32_bit_overflow() {
    let signature = Signature::new("record-overflow");
    let image = MachineImage::from_arenas(
        signature.clone(),
        &SlotArena::new(),
        &ChunkArena::new(),
        &[],
        vec![],
        vec![],
        SymbolKeyImage::default(),
    );
    let bytes = write_machine_unchecked(&image);
    assert_eq!(read_machine(&bytes, &signature).unwrap(), image);
    let reader = AtomReader::parse(&bytes).unwrap();
    let replace = |tag, payload: &[u8]| {
        let mut writer = AtomWriter::new();
        for atom in reader.atoms() {
            writer
                .atom(
                    atom.tag,
                    if atom.tag == tag {
                        payload
                    } else {
                        atom.payload
                    },
                )
                .unwrap();
        }
        read_machine(&writer.finish().unwrap(), &signature)
    };
    let mut heap = Vec::new();
    heap.extend_from_slice(&u32::MAX.to_be_bytes());
    heap.extend_from_slice(&0u32.to_be_bytes());
    heap.extend_from_slice(&0u32.to_be_bytes());
    assert_eq!(
        replace(HEAP, &heap),
        Err(SnapshotError::Corrupt("HEAP record count"))
    );
    assert_eq!(
        replace(STAC, &u32::MAX.to_be_bytes()),
        Err(SnapshotError::Corrupt("STAC record count"))
    );
}

#[test]
fn manifest_parent_length_refuses_32_bit_overflow() {
    use ironhorse_snapshot::store::{image_to_batch_unchecked, StoreError, StoreManifest};
    let image = MachineImage::from_arenas(
        Signature::new("manifest-overflow"),
        &SlotArena::new(),
        &ChunkArena::new(),
        &[],
        vec![],
        vec![],
        SymbolKeyImage::default(),
    );
    let manifest = image_to_batch_unchecked(&image, 1, "").manifest;
    let mut bytes = manifest.encode();
    assert_eq!(StoreManifest::decode(&bytes).unwrap(), manifest);
    assert!(manifest.parent_seal.is_empty());
    let length_at = bytes.len() - 4;
    assert_eq!(&bytes[length_at..], &[0; 4]);
    bytes[length_at..].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(
        StoreManifest::decode(&bytes),
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "manifest parent seal length"
        )))
    );
}
