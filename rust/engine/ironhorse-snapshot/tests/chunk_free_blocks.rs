//! Persisted free-block markers survive every machine restore path. The
//! fixture installs format-17 bytes directly to test restore independently of GC.
use std::{cell::RefCell, rc::Rc};

use ironhorse_snapshot::{
    atom::{AtomReader, AtomWriter},
    format::{SnapshotError, Version, VERS},
    image::{read_validated_machine, write_machine},
    machine::{
        begin_store_session, from_snapshot_bytes, resume_from_store, resume_from_store_lazy,
        MachineSnapshot,
    },
    store::MemoryStore,
    Signature,
};
use ironhorse_vm::{ChunkArena, ChunkOffset, Interp};

fn with_free_block() -> (Interp, usize) {
    let mut machine = Interp::new();
    let mut bytes = machine.chunks.raw_vec();
    let free = bytes.len();
    bytes.extend_from_slice(&u32::MAX.to_le_bytes());
    bytes.extend_from_slice(&64u32.to_le_bytes());
    bytes.resize(free + 64, 0xa5);
    machine.chunks = ChunkArena::from_image(bytes);
    (machine, free)
}

#[test]
fn blob_eager_store_and_lazy_store_preserve_free_block_allocation_order() {
    let signature = Signature::new("chunk-free-blocks");
    let (machine, free) = with_free_block();
    assert!(machine.chunks.can_allocate(8)); // Build the uninterrupted index.
    let snapshot = machine.write_snapshot(&signature).unwrap();
    let blob = from_snapshot_bytes(&snapshot, &signature).unwrap();
    let mut store = MemoryStore::new();
    let continuous = begin_store_session(machine, &signature, &mut store)
        .map_err(|(_, error)| error)
        .unwrap();
    let eager = resume_from_store(&store, &signature).unwrap();
    let lazy = resume_from_store_lazy(Rc::new(RefCell::new(store)), &signature).unwrap();
    let mut expected = None;
    for mut machine in [
        continuous.into_machine(),
        blob,
        eager.into_machine(),
        lazy.into_machine(),
    ] {
        let mut offsets = Vec::new();
        for size in [8, 0, 20, 17, 1] {
            offsets.push(machine.chunks.alloc(&vec![size as u8; size]));
        }
        assert_eq!(offsets[0], ChunkOffset(u32::try_from(free + 4).unwrap()));
        let state = (offsets, machine.write_snapshot(&signature).unwrap());
        if let Some(expected) = &expected {
            assert_eq!(&state, expected);
        } else {
            expected = Some(state);
        }
    }
}

#[test]
fn republishing_cannot_advertise_free_markers_to_pre_17_readers() {
    let signature = Signature::new("chunk-free-blocks");
    let (machine, _) = with_free_block();
    let current = machine.write_snapshot(&signature).unwrap();
    let reader = AtomReader::parse(&current).unwrap();
    let restamp = |format_version| {
        let mut writer = AtomWriter::new();
        for atom in reader.atoms() {
            if atom.tag == VERS {
                let mut version = Version::decode(atom.payload).unwrap();
                version.format_version = format_version;
                writer.atom(VERS, &version.encode()).unwrap();
            } else {
                writer.atom(atom.tag, atom.payload).unwrap();
            }
        }
        writer.finish().unwrap()
    };
    for old in [15, 16] {
        let forged = restamp(old);
        // Old allocators cannot produce this fixture. Format16's exact-byte
        // rule refuses it; older permissive readers can admit its dead bytes,
        // but a normal writer must upgrade the stamp before republishing it.
        if old == 16 {
            assert!(matches!(
                read_validated_machine(&forged, &signature),
                Err(SnapshotError::Corrupt("non-canonical machine encoding"))
            ));
        } else {
            let gated = read_validated_machine(&forged, &signature)
                .unwrap()
                .into_gated();
            let published = write_machine(&gated).unwrap();
            let reader = AtomReader::parse(&published).unwrap();
            assert_eq!(
                Version::decode(reader.find(VERS).unwrap().payload)
                    .unwrap()
                    .format_version,
                18
            );
            // This fixture needs native-name format18, but no format19
            // saved handlers. Every byte except the version remains exact.
            assert_eq!(published, restamp(18));
        }
    }
}
