//! Oversized wire counts are refused alike on every target.
//!
//! A u32 record count times the record width overflows a 32-bit usize but
//! not a 64-bit one, so a decoder that sized it in usize refused it with a
//! different message on each. The decoders size it in u64, and these crafted
//! inputs must give exactly the same error natively and on 32-bit WASI
//! (`rust/engine/scripts/test-snapshot-wasi.py` runs this file there).
use ironhorse_snapshot::format::{Signature, HEAP, STAC};
use ironhorse_snapshot::image::{
    read_machine, write_machine_unchecked, MachineImage, SymbolKeyImage,
};
use ironhorse_snapshot::CommitToken;
use ironhorse_snapshot::{AtomReader, AtomWriter, SnapshotError};
use ironhorse_vm::{ChunkArena, SlotArena};

#[test]
fn oversized_record_counts_refuse_alike_on_every_target() {
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
        Err(SnapshotError::Corrupt("HEAP records truncated"))
    );
    assert_eq!(
        replace(STAC, &u32::MAX.to_be_bytes()),
        Err(SnapshotError::Corrupt("STAC records truncated"))
    );
}

#[test]
fn oversized_manifest_parent_length_refuses_alike_on_every_target() {
    use ironhorse_snapshot::store::{image_to_batch_unchecked, StoreError, StoreManifest};
    // The parent seal is a field of the layouts before store schema 36,
    // which migration still reads.
    let image = MachineImage::from_arenas(
        Signature::new("manifest-overflow"),
        &SlotArena::new(),
        &ChunkArena::new(),
        &[],
        vec![],
        vec![],
        SymbolKeyImage::default(),
    );
    let manifest = StoreManifest {
        store_schema: 35,
        ..image_to_batch_unchecked(&image, 1, CommitToken::ZERO).manifest
    };
    let mut bytes = manifest.encode();
    assert_eq!(StoreManifest::decode(&bytes).unwrap(), manifest);
    // This build writes the legacy layout with an empty parent seal, last.
    let length_at = bytes.len() - 4;
    assert_eq!(&bytes[length_at..], &[0; 4]);
    bytes[length_at..].copy_from_slice(&u32::MAX.to_be_bytes());
    assert_eq!(
        StoreManifest::decode(&bytes),
        Err(StoreError::Snapshot(SnapshotError::Corrupt(
            "manifest parent seal truncated"
        )))
    );
}
