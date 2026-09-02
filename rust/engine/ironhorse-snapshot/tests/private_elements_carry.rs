//! Private value and accessor elements persist in `PRIV`
//! (store schema v19), keyed by receiver and lexical-brand slots.

mod common;

use common::TempDir;

use ironhorse_snapshot::image::{read_machine, write_machine};
use ironhorse_snapshot::machine::{
    begin_store_session, from_snapshot_bytes, resume_from_store, resume_from_store_lazy,
    MachineSnapshot,
};
use ironhorse_snapshot::store::{HeapStore, MemoryStore};
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

/// Relink and run one crank, returning `(completed, halt debug, result,
/// computrons)`. The COMPUTRON count is part of the observation: a
/// resumed machine that answers correctly while charging differently
/// has still diverged, and consensus is on the count as much as the
/// value. Every twin below therefore compares metering too.
fn crank(machine: &mut Interp, source: &str) -> (bool, String, String, u64) {
    let (bytecode, names) = compile(source);
    let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
    let outcome = machine.run(&bytecode);
    (outcome.completed, format!("{:?}", outcome.halt), outcome.result, outcome.computrons)
}

const FIRST: &str = "var A = 0; var a = 0; var t = 0; \
     A = class { \
       #x = 1; \
       get #double() { return this.#x * 2; } \
       set #double(value) { this.#x = value / 2; } \
       read() { return this.#double; } \
       write(value) { this.#double = value; } \
     }; \
     a = new A(); a.write(18); t = 7; t";
const OBSERVATION: &str = "var a; var t; t = a.read(); t";

fn twin(store: &mut dyn HeapStore) -> (bool, String, String, u64) {
    let (bytecode, names) = compile(FIRST);
    let mut continuous = Interp::new();
    continuous.link_intrinsics(&names);
    assert!(continuous.run(&bytecode).completed);
    let expected = crank(&mut continuous, OBSERVATION);

    let mut suspended = Interp::new();
    suspended.link_intrinsics(&names);
    assert!(suspended.run(&bytecode).completed);
    drop(
        begin_store_session(suspended, &sig(), store)
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut resumed = resume_from_store(store, &sig()).expect("resume");
    let actual = crank(resumed.machine_mut(), OBSERVATION);
    assert_eq!(actual, expected, "private state matches continuous");
    expected
}

#[test]
fn private_values_and_accessors_survive_memory_and_file_resume() {
    let mut memory = MemoryStore::new();
    assert_eq!(twin(&mut memory).2, "18");

    let dir = TempDir::new("ih-private-elements");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    assert_eq!(twin(&mut file).2, "18");
}

#[test]
fn lazy_and_blob_resume_preserve_private_elements() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, OBSERVATION).2, "18");

    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let store = Rc::new(RefCell::new(MemoryStore::new()));
    drop(
        begin_store_session(machine, &sig(), &mut *store.borrow_mut())
            .map_err(|(_, error)| error)
            .expect("begin"),
    );
    let mut lazy = resume_from_store_lazy(store, &sig()).expect("lazy restore");
    assert_eq!(crank(lazy.machine_mut(), OBSERVATION).2, "18");
}

#[test]
fn duplicate_private_element_rows_are_refused() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut image = read_machine(&bytes, &sig()).expect("read PRIV");
    assert!(!image.private_elements.values.is_empty());
    image
        .private_elements
        .values
        .push(image.private_elements.values[0].clone());
    match from_snapshot_bytes(&write_machine(&image), &sig()) {
        Err(SnapshotError::Corrupt(
            "private values: rows not strictly ascending",
        )) => {}
        Err(other) => panic!("wrong private-row refusal: {other:?}"),
        Ok(_) => panic!("duplicate private element rows must not restore"),
    }
}
