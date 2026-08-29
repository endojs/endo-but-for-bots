//! Date `[[DateValue]]` records persist in `DATE` (store schema v14).
//! Values travel as raw IEEE-754 bits, and a guest-mutated
//! `%Date.prototype%` travels while its untouched NaN seed is rebuilt
//! by boot.

mod common;

use common::TempDir;

use ironhorse_snapshot::image::{read_machine, write_machine};
use ironhorse_snapshot::machine::{
    begin_store_session, checkpoint_to_store, from_snapshot_bytes, resume_from_store,
    resume_from_store_lazy, MachineSnapshot,
};
use ironhorse_snapshot::store::{validate_store, HeapStore, MemoryStore};
use ironhorse_snapshot::store_file::FileStore;
use ironhorse_snapshot::{Signature, SnapshotError};
use ironhorse_vm::{parse_symbols, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<String>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

fn crank(m: &mut Interp, source: &str) -> (bool, String, String) {
    let (bytecode, names) = compile(source);
    let bytecode = m.relink_crank(&bytecode, &names).expect("relink");
    let outcome = m.run(&bytecode);
    (outcome.completed, format!("{:?}", outcome.halt), outcome.result)
}

fn twin(
    crank1: &str,
    observations: &[&str],
    store: &mut dyn HeapStore,
) -> Vec<(bool, String, String)> {
    let (bytecode, names) = compile(crank1);

    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert!(continuous.run(&bytecode).completed);
    let expected: Vec<_> = observations
        .iter()
        .map(|source| crank(&mut continuous, source))
        .collect();

    let mut suspended = Interp::new();
    suspended.link_intrinsics(&names);
    assert!(suspended.run(&bytecode).completed);
    drop(
        begin_store_session(suspended, &sig(), store)
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut resumed = resume_from_store(store, &sig()).expect("resume");
    let actual: Vec<_> = observations
        .iter()
        .map(|source| crank(resumed.machine_mut(), source))
        .collect();
    assert_eq!(actual, expected, "resumed Date state matches continuous");
    checkpoint_to_store(&mut resumed, &sig(), store).expect("checkpoint");
    validate_store(store, &sig()).expect("validates");
    expected
}

#[test]
fn resumed_date_values_and_mutations_match_uninterrupted() {
    let crank1 = "var d = 0; var invalid = 0; var t = 0; \
         d = new Date(86400000); invalid = new Date(NaN); t = 7; t";
    let observations = [
        "var d; var t; t = d.getTime() + ':' + d.toISOString(); t",
        "var invalid; var t; t = invalid.getTime() !== invalid.getTime(); t",
        "var d; var t; d.setTime(42); t = d.getTime(); t",
    ];
    let expected = ["86400000:1970-01-02T00:00:00.000Z", "true", "42"];

    let mut memory = MemoryStore::new();
    let seen = twin(crank1, &observations, &mut memory);
    assert_eq!(
        seen.iter().map(|(_, _, value)| value.as_str()).collect::<Vec<_>>(),
        expected,
    );

    let dir = TempDir::new("ih-date-carry");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    twin(crank1, &observations, &mut file);
}

#[test]
fn guest_mutated_date_prototype_value_persists() {
    let mut store = MemoryStore::new();
    let seen = twin(
        "var t = 0; Date.prototype.setTime(1234); t = 7; t",
        &["var t; t = Date.prototype.getTime(); t"],
        &mut store,
    );
    assert_eq!(seen[0].2, "1234");
}

#[test]
fn lazy_resume_carries_date_values() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile("var d = 0; var t = 0; d = new Date(99); t = 7; t");
    let observation = "var d; var t; t = d.getTime(); t";

    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert!(continuous.run(&bytecode).completed);
    let expected = crank(&mut continuous, observation);

    let mut suspended = Interp::new();
    suspended.link_intrinsics(&names);
    assert!(suspended.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(suspended, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut resumed = resume_from_store_lazy(store, &sig()).expect("lazy resume");
    assert_eq!(crank(resumed.machine_mut(), observation), expected);
}

#[test]
fn blob_snapshot_carries_date_values() {
    let (bytecode, names) = compile("var d = 0; var t = 0; d = new Date(123); t = 7; t");
    let observation = "var d; var t; t = d.toISOString(); t";

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let image = read_machine(&bytes, &sig()).expect("read DATE atom");
    assert_eq!(image.dates.len(), 1, "the guest Date emits one row");
    let mut resumed = from_snapshot_bytes(&bytes, &sig()).expect("restore");
    assert_eq!(
        crank(&mut resumed, observation).2,
        "1970-01-01T00:00:00.123Z",
    );
}

#[test]
fn duplicate_date_owners_are_refused() {
    let (bytecode, names) = compile("var d = 0; var t = 0; d = new Date(1); t = 7; t");
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut image = read_machine(&bytes, &sig()).expect("read");
    let row = image.dates[0].clone();
    image.dates.push(row);
    match from_snapshot_bytes(&write_machine(&image), &sig()) {
        Err(SnapshotError::Corrupt("date side table: owners not strictly ascending")) => {}
        Err(other) => panic!("wrong duplicate-owner refusal: {other:?}"),
        Ok(_) => panic!("duplicate Date owners must not restore"),
    }
}
