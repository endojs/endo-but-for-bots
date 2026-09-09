//! An ordinary object's integer-indexed properties persist in `IDXP`
//! (format 14 / store schema 25).
//!
//! These properties used to be ordinary named slots, so they travelled with
//! the slot arena and needed no atom of their own. Storing them by index —
//! which is what stops `var o = {}; for (…) o[i] = i` from minting a `u16`
//! per index and poisoning the machine — moves them into a side table, and a
//! side table that does not travel is silent data loss on resume.
//!
//! The ledger's own reconciliation test refuses to let the field exist without
//! a classification; these are the behavioural half of that claim.

#[path = "common/twin.rs"]
mod carry;
mod common;
use carry::{compile, crank, sig, twin};

use common::TempDir;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::store::MemoryStore;
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_vm::Interp;

const FIRST: &str = "var o = 0; var t = 0; o = {}; o[0] = 'a'; o[7] = 'b'; \
     o.named = 'n'; o[3] = {inner: 1}; t = 7; t";

#[test]
fn index_properties_survive_memory_and_file_resume() {
    let observations = [
        "var o; var t; t = o[0] + '|' + o[7]; t",
        "var o; var t; t = Object.keys(o).join(','); t",
        "var o; var t; t = String(o[3].inner); t",
        "var o; var t; t = String(o.named); t",
        // The store is not a shadow: the property answers by name too.
        "var o; var t; t = String(Object.getOwnPropertyDescriptor(o, '0').value); t",
    ];
    let mut memory = MemoryStore::new();
    let seen = twin(FIRST, &observations, &mut memory);
    assert_eq!(
        seen.iter().map(|row| row.2.as_str()).collect::<Vec<_>>(),
        ["a|b", "0,3,7,named", "1", "n", "a"]
    );

    let dir = TempDir::new("ih-index-props-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin(FIRST, &observations, &mut file);
}

/// Attributes live in the item's flag bits, so a frozen or non-enumerable
/// element has to come back frozen or non-enumerable — not merely present.
#[test]
fn index_property_attributes_survive_resume() {
    let mut store = MemoryStore::new();
    let seen = twin(
        "var o = 0; var t = 0; o = {}; o[0] = 1; o[1] = 2; \
         Object.defineProperty(o, '1', {enumerable: false}); \
         Object.freeze(o); t = 7; t",
        &[
            "var o; var t; t = Object.keys(o).join(','); t",
            "var o; var t; o[0] = 99; t = String(o[0]); t",
            "var o; var t; t = String(delete o[0]) + '|' + String(o[0]); t",
            "var o; var t; t = String(Object.isFrozen(o)); t",
        ],
        &mut store,
    );
    assert_eq!(
        seen.iter().map(|row| row.2.as_str()).collect::<Vec<_>>(),
        ["0", "1", "false|1", "true"]
    );
}

#[test]
fn index_properties_survive_a_blob_round_trip() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(
        crank(&mut blob, "var o; var t; t = o[0] + '|' + o[7]; t").2,
        "a|b"
    );
    assert_eq!(
        crank(&mut blob, "var o; var t; t = Object.keys(o).join(','); t").2,
        "0,3,7,named"
    );
}

/// `import ∘ export` is the identity the CAS key rests on: a machine written,
/// read back and written again must produce the same bytes.
#[test]
fn writing_a_resumed_machine_reproduces_its_bytes() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let first = machine.write_snapshot(&sig()).expect("snapshot");
    let restored = from_snapshot_bytes(&first, &sig()).expect("blob restore");
    let second = restored.write_snapshot(&sig()).expect("re-snapshot");
    assert_eq!(first, second, "resume-then-re-snapshot is byte-identical");
}

/// A machine holding NO index property must not emit the atom at all, so a
/// store that never used one keeps its exact pre-`IDXP` bytes.
#[test]
fn a_machine_without_index_properties_emits_no_atom() {
    let (bytecode, names) = compile("var o = {a: 1}; var t = 7; t");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    assert!(
        !bytes.windows(4).any(|w| w == b"IDXP"),
        "the atom is emitted only when the table is non-empty"
    );
}
