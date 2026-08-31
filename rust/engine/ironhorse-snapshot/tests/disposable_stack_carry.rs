//! Explicit resource-management stack records persist in `DISP`
//! (store schema v20), preserving LIFO disposal across resume.

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

const FIRST: &str = "var log = ''; var stack = 0; var t = 0; \
     stack = new DisposableStack(); \
     stack.defer(function () { log += 'a'; }); \
     stack.defer(function () { log += 'b'; }); t = 7; t";
const OBSERVATION: &str = "var log; var stack; var t; stack.dispose(); t = log; t";

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
    assert_eq!(actual, expected, "resumed disposal matches continuous");
    expected
}

#[test]
fn pending_disposal_records_survive_memory_and_file_resume() {
    let mut memory = MemoryStore::new();
    assert_eq!(twin(&mut memory).2, "ba");

    let dir = TempDir::new("ih-disposable-stack");
    let mut file = FileStore::open(dir.join("heap.ihstore")).expect("open");
    assert_eq!(twin(&mut file).2, "ba");
}

#[test]
fn lazy_and_blob_resume_preserve_disposal_records() {
    use std::cell::RefCell;
    use std::rc::Rc;

    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut blob = from_snapshot_bytes(&bytes, &sig()).expect("blob restore");
    assert_eq!(crank(&mut blob, OBSERVATION).2, "ba");

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
    assert_eq!(crank(lazy.machine_mut(), OBSERVATION).2, "ba");
}

#[test]
fn disposed_stack_cannot_retain_records_in_snapshot() {
    let (bytecode, names) = compile(FIRST);
    let mut machine = Interp::new();
    machine.link_intrinsics(&names);
    assert!(machine.run(&bytecode).completed);
    let bytes = machine.write_snapshot(&sig()).expect("snapshot");
    let mut image = read_machine(&bytes, &sig()).expect("read DISP");
    image.disposable_stacks[0].disposed = true;
    match from_snapshot_bytes(&write_machine(&image), &sig()) {
        Err(SnapshotError::Corrupt(
            "disposable stacks: disposed stack retains records",
        )) => {}
        Err(other) => panic!("wrong disposed-stack refusal: {other:?}"),
        Ok(_) => panic!("disposed stack with records must not restore"),
    }
}
