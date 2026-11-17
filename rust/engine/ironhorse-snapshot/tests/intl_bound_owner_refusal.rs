//! Two Intl bound-function rows for one owner are refused at decode.
//!
//! An Intl object has at most one bound `compare` or `format` function.
//! Restore used to keep both rows, and the `compare` getter then picked one
//! by `HashMap` iteration order, which differs from run to run natively and
//! between native and wasm32. This file stays free of compiler
//! dev-dependencies so `rust/engine/scripts/test-snapshot-wasi.py` can run it
//! on 32-bit WASI.
use ironhorse_snapshot::format::{Signature, CANONICAL_ATOM_ORDER, IBFN};
use ironhorse_snapshot::image::{
    read_machine, write_machine_unchecked, MachineImage, SymbolKeyImage,
};
use ironhorse_snapshot::{AtomReader, AtomWriter, SnapshotError};
use ironhorse_vm::{ChunkArena, SlotArena};

/// One `IBFN` row in its wire form: kind, function, owner, name, name chunk
/// and arity.
fn row(out: &mut Vec<u8>, function: u32, owner: u32) {
    out.push(0); // Collator `compare`
    out.extend_from_slice(&function.to_be_bytes());
    out.extend_from_slice(&owner.to_be_bytes());
    out.extend_from_slice(&7u32.to_be_bytes());
    out.extend_from_slice(b"compare");
    out.extend_from_slice(&u32::MAX.to_be_bytes()); // no name chunk
    out.extend_from_slice(&2u32.to_be_bytes());
}

/// An honest empty machine's container with `payload` inserted as its
/// `IBFN` atom, at its canonical position, decoded again.
fn read_with_ibfn(payload: &[u8]) -> Result<MachineImage, SnapshotError> {
    let signature = Signature::new("intl-bound-owner");
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
    let reader = AtomReader::parse(&bytes).unwrap();
    assert!(reader.find(IBFN).is_none(), "an empty machine has no IBFN");
    let rank = |tag| CANONICAL_ATOM_ORDER.iter().position(|t| *t == tag).unwrap();
    let mut writer = AtomWriter::new();
    let mut inserted = false;
    for atom in reader.atoms() {
        if !inserted && rank(atom.tag) > rank(IBFN) {
            writer.atom(IBFN, payload).unwrap();
            inserted = true;
        }
        writer.atom(atom.tag, atom.payload).unwrap();
    }
    if !inserted {
        writer.atom(IBFN, payload).unwrap();
    }
    read_machine(&writer.finish().unwrap(), &signature)
}

#[test]
fn a_second_row_for_one_owner_is_refused_at_decode() {
    let mut duplicate = 2u32.to_be_bytes().to_vec();
    row(&mut duplicate, 10, 20);
    row(&mut duplicate, 11, 20);
    assert_eq!(
        read_with_ibfn(&duplicate),
        Err(SnapshotError::Corrupt(
            "Intl bound-function state: owner has more than one row"
        ))
    );

    // The control: distinct owners pass decode and reach the gates, which
    // refuse these rows for naming slots the empty heap does not hold.
    let mut distinct = 2u32.to_be_bytes().to_vec();
    row(&mut distinct, 10, 20);
    row(&mut distinct, 11, 21);
    assert_eq!(
        read_with_ibfn(&distinct),
        Err(SnapshotError::Corrupt("slot index out of arena bounds"))
    );
}
